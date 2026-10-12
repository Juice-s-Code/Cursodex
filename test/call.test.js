import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cursodex.mjs', import.meta.url));
async function fixture(t) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-call-'));
  const root = path.join(outer, 'Cedar project \u00fc');
  await fs.mkdir(root);
  t.after(() => fs.rm(outer, { recursive: true, force: true }));
  return { outer, root };
}
function run(f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'call', ...args], { cwd: f.outer, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0;
    const started = Date.now();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Call cleanup exceeded test bound')); }, 10000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 6 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      stdout += chunk;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, elapsed: Date.now() - started }); });
  });
}
const flags = (f, actor, tool) => ['--agent', actor, '--project', f.root, '--tool', tool];
function receipt(result, exit = 0) {
  assert.equal(result.code, exit, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(value.startedAt && value.endedAt);
  return value;
}
async function requestFile(f, request, name = 'request.json') {
  const file = path.join(f.outer, name);
  await fs.writeFile(file, JSON.stringify(request));
  return file;
}
async function noState(f) {
  await assert.rejects(fs.stat(path.join(f.root, '.cursodex')), error => error.code === 'ENOENT');
}

test('public call defaults to empty arguments and reports both configured roles through real stdio', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const actor of ['codex', 'cursor']) {
    const value = receipt(await run(f, flags(f, actor, 'cursodex_status')));
    assert.equal(value.actor, actor);
    assert.equal(value.tools.length, 17);
    assert.equal(value.results.length, 1);
    const status = value.results[0].result.structuredContent.data;
    assert.equal(status.agent, actor);
    assert.equal(status.project_root, realpathSync(f.root));
    assert.equal(value.deadlineReached, undefined);
  }
});

test('public request mode preserves empty catalog-only and ordered batch calls', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const empty = await requestFile(f, { actor: 'codex', projectRoot: f.root, calls: [] });
  const catalog = receipt(await run(f, ['--request', empty]));
  assert.equal(catalog.results.length, 0);
  assert.equal(catalog.tools.length, 17);
  const file = await requestFile(f, { actor: 'cursor', projectRoot: f.root, calls: [
    { name: 'cursodex_status', arguments: {} }, { name: 'cursodex_list_tasks', arguments: { limit: 1 } },
  ] });
  const value = receipt(await run(f, ['--request', file]));
  assert.deepEqual(value.results.map(row => row.name), ['cursodex_status', 'cursodex_list_tasks']);
  assert.equal(value.results[0].result.structuredContent.data.agent, 'cursor');
  assert.equal(value.results[1].result.structuredContent.data.count, 0);
});

test('inline and file arguments support a durable message and recipient ACK across separate calls', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const input = { recipient: 'cursor', key: 'portable-message', body: 'Fictional Cedar handoff \ud83e\udded' };
  const sent = receipt(await run(f, [...flags(f, 'codex', 'cursodex_send_message'), '--arguments', JSON.stringify(input)])).results[0].result.structuredContent.data;
  const file = path.join(f.outer, 'ack-arguments.json');
  await fs.writeFile(file, JSON.stringify({ id: sent.id }));
  const ack = receipt(await run(f, [...flags(f, 'cursor', 'cursodex_ack_message'), '--arguments-file', file])).results[0].result.structuredContent.data;
  assert.equal(ack.id, sent.id);
  assert.ok(ack.ack_at > 0);
  const inbox = receipt(await run(f, flags(f, 'cursor', 'cursodex_list_messages'))).results[0].result.structuredContent.data;
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].body, input.body);
  assert.equal(inbox.items[0].ack_at, ack.ack_at);
});

test('a batch CAS error retains the earlier commit and stops before a later message', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const input = { key: 'portable-task', assignee: 'cursor', title: 'Fictional review' };
  const task = receipt(await run(f, [...flags(f, 'codex', 'cursodex_create_task'), '--arguments', JSON.stringify(input)])).results[0].result.structuredContent.data;
  const file = await requestFile(f, { actor: 'cursor', projectRoot: f.root, calls: [
    { name: 'cursodex_update_task', arguments: { id: task.id, expected_revision: task.revision, state: 'active', summary: 'First commit stays.' } },
    { name: 'cursodex_update_task', arguments: { id: task.id, expected_revision: task.revision, state: 'done', summary: 'Stale revision must fail.' } },
    { name: 'cursodex_send_message', arguments: { recipient: 'codex', key: 'must-not-run', body: 'Must not execute.' } },
  ] });
  const value = receipt(await run(f, ['--request', file]), 1);
  assert.equal(value.results.length, 2);
  assert.equal(value.results[0].result.structuredContent.ok, true);
  assert.equal(value.results[1].result.structuredContent.error.code, 'REVISION_CONFLICT');
  const retained = receipt(await run(f, [...flags(f, 'codex', 'cursodex_get_task'), '--arguments', JSON.stringify({ id: task.id })])).results[0].result.structuredContent.data;
  assert.equal(retained.state, 'active');
  assert.equal(retained.summary, 'First commit stays.');
  assert.equal(retained.revision, task.revision + 1);
  assert.equal(receipt(await run(f, flags(f, 'codex', 'cursodex_list_messages'))).results[0].result.structuredContent.data.count, 0);
});

test('public call deadline returns a nonzero receipt and terminates its waiting stdio child', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const result = await run(f, [...flags(f, 'codex', 'cursodex_wait_events'), '--arguments', '{"after":0,"wait_ms":20000}', '--deadline-ms', '1000']);
  const value = receipt(result, 1);
  assert.equal(value.deadlineReached, true);
  assert.match(value.error, /deadline reached/);
  assert.equal(value.results.length, 0);
  assert.ok(result.elapsed < 7000);
});

test('invalid public call forms fail before project state is created', { timeout: 30000 }, async t => {
  const f = await fixture(t), base = flags(f, 'codex', 'cursodex_status');
  const file = await requestFile(f, { actor: 'codex', projectRoot: f.root, calls: [] });
  const cases = [
    [], ['--unknown', 'x'], [...base, '--agent', 'cursor'], ['--request', file, '--request', file],
    ['--request', file, '--agent', 'codex'], [...base, '--arguments', '{}', '--arguments-file', file],
    flags(f, 'other', 'cursodex_status'), ['--agent', 'codex', '--project', 'relative', '--tool', 'cursodex_status'],
    flags(f, 'codex', 'shell'), flags(f, 'codex', 'cursodex_not_a_tool'),
    [...base, '--deadline-ms', '999'], [...base, '--deadline-ms', '60001'], [...base, '--deadline-ms', '1e3'],
    [...base, '--arguments', '{'], [...base, '--arguments', '[]'],
    [...base, '--arguments', JSON.stringify({ body: '\u20ac'.repeat(21846) })], [...base, '--arguments'],
  ];
  for (const args of cases) {
    const result = await run(f, args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    await noState(f);
  }
});

test('bounded request files reject malformed UTF-8, shape errors, oversized bytes and nonfiles before launch', { timeout: 30000 }, async t => {
  const f = await fixture(t), valid = { actor: 'codex', projectRoot: f.root, calls: [] };
  const invalid = [
    Buffer.from('{'), Buffer.from([123, 34, 0xff, 34, 58, 49, 125]), Buffer.alloc(65537, 32),
    JSON.stringify({ ...valid, remoteToken: 'not-supported' }), JSON.stringify({ ...valid, actor: 'other' }),
    JSON.stringify({ ...valid, deadlineMs: 1000.5 }),
    JSON.stringify({ ...valid, calls: Array.from({ length: 21 }, () => ({ name: 'cursodex_status', arguments: {} })) }),
    JSON.stringify({ ...valid, calls: [{ name: 'cursodex_status', arguments: {}, actor: 'cursor' }] }),
    JSON.stringify({ ...valid, calls: [{ name: 'cursodex_status', arguments: null }] }),
  ];
  const file = path.join(f.outer, 'invalid.json');
  for (const bytes of invalid) {
    await fs.writeFile(file, bytes);
    const result = await run(f, ['--request', file]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    await noState(f);
  }
  for (const target of [f.root, 'relative.json']) {
    const result = await run(f, ['--request', target]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    await noState(f);
  }
});
