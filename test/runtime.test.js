import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runRequest } from '../cli/client.mjs';
import { startCloud } from '../src/http.js';

const packageInfo = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const runtimeSource = new URL('../src/runtime.js', import.meta.url);
const run = promisify(execFile);
const cleanups = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-runtime-')));
  const closers = [];
  cleanups.set(root, closers);
  t.after(async () => {
    const results = await Promise.allSettled(closers.map(close => close()));
    try { await fs.rm(root, { recursive: true, force: true }); } finally { cleanups.delete(root); }
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
  return root;
}
async function stdio(t, root, actor) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { ...process.env, PROJECT_ROOT: root, CURSODEX_AGENT: actor }, stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'runtime-regression-' + actor, version: packageInfo.version });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await client.close(); } finally { await transport.close(); }
  };
  cleanups.get(root).push(close);
  await client.connect(transport, { timeout: 5000 });
  return { client, close };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name: 'cursodex_' + name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true);
  return result.structuredContent.data;
}
function identity(runtime) {
  assert.deepEqual(Object.keys(runtime).sort(), ['instance_id', 'package_name', 'package_version']);
  assert.equal(runtime.package_name, packageInfo.name);
  assert.equal(runtime.package_version, packageInfo.version);
  assert.match(runtime.instance_id, uuid);
}
async function copiedHelper(root, version) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.copyFile(runtimeSource, path.join(root, 'src', 'runtime.js'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runtime-fixture', version, type: 'module' }));
  return pathToFileURL(path.join(root, 'src', 'runtime.js')).href;
}
async function script(code, cwd) {
  return run(process.execPath, ['--input-type=module', '--eval', code], { cwd, timeout: 5000, maxBuffer: 65536 });
}

test('real stdio initialization, status and context agree while roles/schema/tool count stay unchanged', { timeout: 15000 }, async t => {
  const root = await project(t);
  const ids = [];
  for (const actor of ['codex', 'cursor']) {
    const { client } = await stdio(t, root, actor);
    assert.deepEqual(client.getServerVersion(), { name: 'cursodex-mcp-server', version: packageInfo.version });
    const status = await call(client, 'status');
    identity(status.runtime);
    assert.equal(status.agent, actor);
    assert.equal(status.project_root, root);
    assert.equal(status.schema, 1);
    assert.equal(status.latest_event, 0);
    assert.equal((await client.listTools()).tools.length, 17);
    const context = await client.readResource({ uri: 'cursodex://context' });
    assert.deepEqual(JSON.parse(context.contents[0].text), status);
    assert.deepEqual((await call(client, 'status')).runtime, status.runtime);
    ids.push(status.runtime.instance_id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('a restarted stdio child has a new identity and keeps durable shared records', { timeout: 15000 }, async t => {
  const root = await project(t);
  const first = await stdio(t, root, 'codex');
  const before = await call(first.client, 'status');
  const sent = await call(first.client, 'send_message', { recipient: 'cursor', key: 'retained-version-check', body: 'Retain this message across process replacement.' });
  await first.close();
  const next = await stdio(t, root, 'codex');
  const after = await call(next.client, 'status');
  identity(after.runtime);
  assert.notEqual(after.runtime.instance_id, before.runtime.instance_id);
  assert.equal(after.schema, before.schema);
  const messages = await call(next.client, 'list_messages', { direction: 'sent' });
  assert.equal(messages.items[0].id, sent.id);
  assert.equal(messages.items[0].body, sent.body);
});

test('bounded CLI receipt carries actual initialized server version without extra public calls', { timeout: 15000 }, async t => {
  const root = await project(t);
  const { receipt, exitCode } = await runRequest({ actor: 'codex', projectRoot: root,
    calls: [{ name: 'cursodex_status', arguments: {} }], deadlineMs: 10000 });
  assert.equal(exitCode, 0, JSON.stringify(receipt));
  assert.deepEqual(receipt.serverVersion, { name: 'cursodex-mcp-server', version: packageInfo.version });
  assert.equal(receipt.results.length, 1);
  const status = receipt.results[0].result.structuredContent.data;
  assert.equal(receipt.serverVersion.version, status.runtime.package_version);
  assert.equal(status.latest_event, 0);
  identity(status.runtime);
});

test('HTTP sessions share loaded runtime identity while preserving authenticated roles', { timeout: 15000 }, async t => {
  const root = await project(t);
  const env = { CURSODEX_CODEX_TOKEN: 'c'.repeat(48), CURSODEX_CURSOR_TOKEN: 'u'.repeat(48) };
  const cloud = await startCloud({ projectRoot: root, host: '127.0.0.1', port: 0, env, log: false, signalHandlers: false });
  const clients = [];
  cleanups.get(root).push(async () => { await Promise.allSettled(clients.map(c => c.close())); await cloud.close(); });
  const identities = [];
  for (const actor of ['codex', 'cursor']) {
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + cloud.address.port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + env['CURSODEX_' + actor.toUpperCase() + '_TOKEN'] } } });
    const client = new Client({ name: 'runtime-http-' + actor, version: packageInfo.version });
    clients.push(client);
    await client.connect(transport, { timeout: 5000 });
    assert.equal(client.getServerVersion().version, packageInfo.version);
    const status = await call(client, 'status');
    assert.equal(status.agent, actor);
    identity(status.runtime);
    const context = await client.readResource({ uri: 'cursodex://context' });
    assert.deepEqual(JSON.parse(context.contents[0].text).runtime, status.runtime);
    identities.push(status.runtime);
  }
  assert.deepEqual(identities[0], identities[1]);
});

test('package metadata stays cached after a disk edit and changes only in a fresh process', { timeout: 15000 }, async t => {
  const root = await project(t);
  const url = await copiedHelper(root, '12.34.56');
  const code = 'const first = await import(' + JSON.stringify(url) + ');' +
    'const fs = await import("node:fs/promises");' +
    'await fs.writeFile(' + JSON.stringify(path.join(root, 'package.json')) + ', JSON.stringify({name:"runtime-fixture",version:"12.34.57",type:"module"}));' +
    'const second = await import(' + JSON.stringify(url) + ');' +
    'console.log(JSON.stringify({before:first.RUNTIME,after:second.RUNTIME,frozen:Object.isFrozen(first.RUNTIME),same:first.RUNTIME===second.RUNTIME}));';
  const result = JSON.parse((await script(code, root)).stdout);
  assert.equal(result.before.package_version, '12.34.56');
  assert.deepEqual(result.after, result.before);
  assert.equal(result.frozen, true);
  assert.equal(result.same, true);
  const fresh = JSON.parse((await script('console.log(JSON.stringify((await import(' + JSON.stringify(url) + ')).RUNTIME));', root)).stdout);
  assert.equal(fresh.package_version, '12.34.57');
  assert.notEqual(fresh.instance_id, result.before.instance_id);
});

test('relocated runtime helper uses its copied package after original installation removal', { timeout: 10000 }, async t => {
  const root = await project(t), original = path.join(root, 'original'), relocated = path.join(root, 'relocated');
  await copiedHelper(original, '7.8.9');
  await fs.cp(original, relocated, { recursive: true });
  await fs.rm(original, { recursive: true });
  const url = pathToFileURL(path.join(relocated, 'src', 'runtime.js')).href;
  const runtime = JSON.parse((await script('console.log(JSON.stringify((await import(' + JSON.stringify(url) + ')).RUNTIME));', root)).stdout);
  assert.equal(runtime.package_name, 'runtime-fixture');
  assert.equal(runtime.package_version, '7.8.9');
  assert.match(runtime.instance_id, uuid);
});

test('missing, malformed and unbounded package metadata fails instead of advertising a fallback', { timeout: 20000 }, async t => {
  const root = await project(t);
  const url = await copiedHelper(root, '1.2.3'), file = path.join(root, 'package.json');
  for (const value of [null, '{', JSON.stringify({ name: 'fixture', version: '' }),
    JSON.stringify({ name: 'fixture', version: 'x'.repeat(129) })]) {
    if (value === null) await fs.rm(file); else await fs.writeFile(file, value);
    await assert.rejects(script('await import(' + JSON.stringify(url) + ');', root), error =>
      error.code !== 0 && /ENOENT|ERR_INVALID_PACKAGE_CONFIG|SyntaxError|Cursodex package metadata/.test(error.stderr));
  }
});
