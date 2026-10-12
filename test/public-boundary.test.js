import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/index.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const storeURL = new URL('../src/store.js', import.meta.url).href;
const codeIs = code => error => error?.code === code;

async function fixture(t) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-public-'));
  const root = path.join(outer, 'Project with spaces \u00fc');
  await fs.mkdir(root);
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await fs.rm(outer, { recursive: true, force: true });
  });
  return { outer, root, cleanup };
}

function rawChild(f, overrides = {}) {
  const env = { ...process.env, PROJECT_ROOT: f.root, CURSODEX_AGENT: 'codex', ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const child = spawn(process.execPath, [entry], { cwd: f.outer, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [], waiters = new Set();
  let buffer = Buffer.alloc(0), stderr = '', totalOutput = 0, frameError;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const notify = () => { for (const fn of [...waiters]) fn(); };
  child.stdout.on('data', chunk => {
    totalOutput += chunk.length;
    if (totalOutput > 524288) {
      frameError = new Error('Unexpected unbounded test stdout');
      child.kill(); notify(); return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(line);
        assert.equal(frame.jsonrpc, '2.0', 'stdout must contain only JSON-RPC');
        frames.push(frame);
      } catch (error) { frameError = error; }
    }
    notify();
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  // A deliberate fatal input rejection may close stdin before a queued barrier write.
  child.stdin.on('error', () => {});
  f.cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await closed; } finally { clearTimeout(timer); }
  });
  function response(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Missing bounded JSON-RPC response ' + id)), 5000);
      const inspect = () => {
        if (frameError) return finish(frameError);
        const frame = frames.find(x => x.id === id);
        if (frame) finish(null, frame);
      };
      function finish(error, value) {
        clearTimeout(timer); waiters.delete(inspect);
        if (error) reject(error); else resolve(value);
      }
      waiters.add(inspect); inspect();
      closed.then(() => inspect(), error => finish(error));
    });
  }
  const write = message => child.stdin.write(Buffer.from(JSON.stringify(message) + '\n'));
  return {
    child, closed, frames, response, write,
    raw: bytes => child.stdin.write(bytes),
    stderr: () => stderr,
    assertClean: () => { if (frameError) throw frameError; assert.equal(buffer.length, 0, 'no partial/log stdout'); },
    async initialize() {
      write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'public-boundary', version: '1.0.0' }
      } });
      const reply = await response(1);
      assert.ok(reply.result?.serverInfo, JSON.stringify(reply));
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    request(id, method, params) {
      write({ jsonrpc: '2.0', id, method, params });
      return response(id);
    }
  };
}

function structured(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  return reply.result.structuredContent ?? JSON.parse(reply.result.content[0].text);
}

test('three clients concurrently first-open an empty project and retain every committed message', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const workers = Array.from({ length: 3 }, (_, index) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.storeURL).then(({ Store }) => {
      parentPort.postMessage({ kind: 'ready' });
      parentPort.once('message', () => {
        let store;
        try {
          const actor = workerData.index % 2 ? 'cursor' : 'codex';
          store = new Store(workerData.root, actor);
          const message = store.send({ recipient: actor === 'codex' ? 'cursor' : 'codex',
            key: 'first-open-' + workerData.index, body: 'Client ' + workerData.index });
          parentPort.postMessage({ kind: 'done', ok: true, id: message.id });
        } catch (error) { parentPort.postMessage({ kind: 'done', ok: false, code: error.code, message: error.message }); }
        finally { if (store) store.close(); parentPort.close(); }
      });
    }).catch(error => { parentPort.postMessage({ kind: 'failed', message: error.message }); parentPort.close(); });
  `, { eval: true, workerData: { root: f.root, storeURL, index } }));
  f.cleanup.push(async () => { await Promise.all(workers.map(w => w.terminate())); });
  const ready = workers.map(w => new Promise((resolve, reject) => {
    w.on('message', m => { if (m.kind === 'ready') resolve(); if (m.kind === 'failed') reject(new Error(m.message)); });
    w.once('error', reject);
  }));
  const done = workers.map(w => new Promise((resolve, reject) => {
    w.on('message', m => { if (m.kind === 'done') resolve(m); if (m.kind === 'failed') reject(new Error(m.message)); });
    w.once('error', reject);
  }));
  await Promise.all(ready);
  await assert.rejects(fs.stat(path.join(f.root, '.cursodex')), codeIs('ENOENT'));
  workers.forEach(w => w.postMessage('open'));
  const results = await Promise.all(done);
  assert.ok(results.every(x => x.ok), JSON.stringify(results));
  assert.equal(new Set(results.map(x => x.id)).size, 3);
  const codex = new Store(f.root, 'codex'), cursor = new Store(f.root, 'cursor');
  try {
    const messages = [...codex.messages({ direction: 'sent', limit: 10 }).items,
      ...cursor.messages({ direction: 'sent', limit: 10 }).items];
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map(x => x.body).sort(), ['Client 0', 'Client 1', 'Client 2']);
  } finally { codex.close(); cursor.close(); }
});

test('invalid required configuration fails startup with empty stdout and no project state', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const file = path.join(f.outer, 'regular-file');
  await fs.writeFile(file, 'sentinel');
  for (const overrides of [
    { PROJECT_ROOT: undefined }, { PROJECT_ROOT: 'relative-project' },
    { PROJECT_ROOT: file }, { CURSODEX_AGENT: undefined }, { CURSODEX_AGENT: 'impersonator' }
  ]) {
    const p = rawChild(f, overrides);
    p.child.stdin.end();
    const exit = await p.closed;
    assert.equal(exit.code, 1, p.stderr());
    assert.equal(p.frames.length, 0);
    p.assertClean();
    assert.match(p.stderr(), /Cursodex startup failed/);
  }
  await assert.rejects(fs.stat(path.join(f.root, '.cursodex')), codeIs('ENOENT'));
  assert.equal(await fs.readFile(file, 'utf8'), 'sentinel');
});

test('valid UTF-8 split inside a multibyte character survives actual stdio with clean stdout', { timeout: 12000 }, async t => {
  const f = await fixture(t), p = rawChild(f);
  await p.initialize();
  const body = 'Split compass \ud83e\udded';
  const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'cursodex_send_message', arguments: { recipient: 'cursor', key: 'split-utf8', body }
  } }) + '\n');
  const firstByte = frame.indexOf(Buffer.from('\ud83e\udded'));
  assert.ok(firstByte > 0);
  p.raw(frame.subarray(0, firstByte + 2));
  await delay(20);
  p.raw(frame.subarray(firstByte + 2));
  assert.equal(structured(await p.response(2)).data.body, body);
  const status = structured(await p.request(3, 'tools/call', { name: 'cursodex_status', arguments: {} }));
  assert.equal(status.data.project_root, realpathSync(f.root));
  p.assertClean();
});

test('malformed JSON frame cannot mutate state and does not corrupt the next valid response', { timeout: 12000 }, async t => {
  const f = await fixture(t), p = rawChild(f);
  await p.initialize();
  p.raw(Buffer.from('{"jsonrpc":"2.0","id":2,"method":\n'));
  const status = structured(await p.request(3, 'tools/call', { name: 'cursodex_status', arguments: {} }));
  assert.equal(status.ok, true);
  assert.equal(status.data.latest_event, 0);
  assert.equal(status.data.unread_messages, 0);
  p.assertClean();
});

test('invalid UTF-8 in a valid-looking tool frame cannot become a replacement-character message', { timeout: 12000 }, async t => {
  const f = await fixture(t), p = rawChild(f);
  await p.initialize();
  const invalid = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cursodex_send_message","arguments":{"recipient":"cursor","key":"invalid-wire","body":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}}}\n')
  ]);
  p.raw(invalid);
  const exit = await p.closed;
  assert.equal(exit.code, 1, p.stderr());
  assert.equal(p.frames.some(x => x.id === 2 && x.result?.structuredContent?.ok === true), false);
  p.assertClean();
  const reopened = new Store(f.root, 'codex');
  try { assert.equal(reopened.messages({ direction: 'sent' }).count, 0); assert.equal(reopened.status().latest_event, 0); }
  finally { reopened.close(); }
});

test('input frame budget is enforced across chunks without forwarding an oversized partial frame', { timeout: 12000 }, async t => {
  const f = await fixture(t), p = rawChild(f);
  await p.initialize();
  p.raw(Buffer.alloc(32768, 32));
  await delay(20);
  p.raw(Buffer.alloc(32768, 32));
  await delay(20);
  p.raw(Buffer.from(' '));
  const exit = await p.closed;
  assert.equal(exit.code, 1, p.stderr());
  assert.match(p.stderr(), /65536/);
  p.assertClean();
});

test('committed newer clock evidence prevents expired tokens reviving across connections and reopen', async t => {
  const f = await fixture(t);
  let time = 10000;
  const codex = new Store(f.root, 'codex', { clock: () => time });
  const cursor = new Store(f.root, 'cursor', { clock: () => time });
  let reopened;
  try {
    const old = codex.acquire({ key: 'before-rollback', resources: ['path:src/A.js'], ttl_ms: 1000 });
    time = 12000;
    cursor.send({ recipient: 'codex', key: 'later-commit', body: 'Persist later clock evidence' });
    time = 9000;
    assert.equal(codex.claims({}).items.find(x => x.id === old.id).active, false);
    assert.throws(() => codex.renew({ id: old.id, token: old.token }), codeIs('EXPIRED'));
    codex.close(); cursor.close();
    reopened = new Store(f.root, 'codex', { clock: () => time });
    assert.equal(reopened.claims({}).items.find(x => x.id === old.id).active, false);
    assert.throws(() => reopened.renew({ id: old.id, token: old.token }), codeIs('EXPIRED'));
    const replacement = reopened.acquire({ key: 'after-rollback', resources: ['path:src/A.js'], ttl_ms: 1000 });
    assert.notEqual(replacement.id, old.id);
    assert.notEqual(replacement.token, old.token);
  } finally {
    if (reopened) reopened.close();
    for (const store of [codex, cursor]) { try { store.close(); } catch {} }
  }
});

test('external SQLite sidecar aliases and a hard-linked database are rejected without changing targets', async t => {
  const f = await fixture(t);
  const cases = [['state.sqlite-wal', 'symlink'], ['state.sqlite-shm', 'symlink'], ['state.sqlite', 'hardlink']];
  let checked = 0;
  for (const [filename, kind] of cases) {
    const root = path.join(f.outer, kind + '-' + filename);
    const dir = path.join(root, '.cursodex');
    const outside = path.join(f.outer, 'external-' + filename);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outside, 'external sentinel');
    try {
      if (kind === 'symlink') await fs.symlink(outside, path.join(dir, filename), 'file');
      else await fs.link(outside, path.join(dir, filename));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
        t.diagnostic(kind + ' unavailable on this platform: ' + error.code);
        continue;
      }
      throw error;
    }
    assert.throws(() => new Store(root, 'codex'), codeIs('CONFIG'));
    assert.equal(await fs.readFile(outside, 'utf8'), 'external sentinel');
    checked += 1;
  }
  if (checked === 0) t.skip('No symlink or hardlink capability on this platform');
  else t.diagnostic('Checked ' + checked + ' of 3 external alias cases');
});

test('actual createServer works for a portable Unicode project and keeps generated POSIX state private', async t => {
  const f = await fixture(t), store = new Store(f.root, 'codex');
  const server = createServer(store), client = new Client({ name: 'portable-public', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  f.cleanup.push(async () => { await client.close(); await server.close(); store.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const reply = await client.callTool({ name: 'cursodex_status', arguments: {} });
  assert.equal(reply.structuredContent.data.project_root, realpathSync(f.root));
  assert.equal(reply.structuredContent.data.agent, 'codex');
  if (process.platform === 'win32') {
    t.diagnostic('POSIX mode assertions do not measure Windows ACLs');
    return;
  }
  for (const name of ['.cursodex', '.cursodex/state.sqlite', '.cursodex/state.sqlite-wal', '.cursodex/state.sqlite-shm']) {
    const metadata = await fs.stat(path.join(f.root, name));
    assert.equal(metadata.mode & 0o077, 0, name + ' must not grant group/other permissions');
  }
});
