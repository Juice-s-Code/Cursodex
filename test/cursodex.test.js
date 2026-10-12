import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
async function client(root, actor) {
  const c = new Client({ name: 'cursodex-test-' + actor, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { ...process.env, PROJECT_ROOT: root, CURSODEX_AGENT: actor }, stderr: 'pipe' });
  try { await c.connect(transport); return c; }
  catch (error) { await transport.close(); throw error; }
}
async function call(c, name, args = {}) {
  const r = await c.callTool({ name: 'cursodex_' + name, arguments: args });
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}
async function pair(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-test-'));
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(c => c.close())); await rm(root, { recursive: true, force: true }); });
  // Sequential startup isolates request races from optional first-open WAL contention.
  const a = await client(root, 'codex'); clients.push(a);
  const b = await client(root, 'cursor'); clients.push(b);
  return { root, a, b };
}

test('two real stdio clients exchange durable scoped messages and exact-key retries', { timeout: 15000 }, async t => {
  const { root, a, b } = await pair(t);
  const request = { recipient: 'cursor', key: 'req-1', body: 'Please review only Shared/A.swift', evidence: 'parent:abc' };
  const sent = await call(a, 'send_message', request);
  assert.equal(sent.ok, true);
  const duplicate = await call(a, 'send_message', request);
  assert.equal(duplicate.data.id, sent.data.id);
  const changed = await call(a, 'send_message', { ...request, body: request.body + '!' });
  assert.equal(changed.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call(a, 'list_messages')).data.items.length, 0);
  const inbox = await call(b, 'list_messages');
  assert.equal(inbox.data.items.length, 1);
  assert.equal(inbox.data.items[0].sender, 'codex');
  assert.equal((await call(a, 'ack_message', { id: sent.data.id })).error.code, 'FORBIDDEN');
  const ack = await call(b, 'ack_message', { id: sent.data.id });
  assert.ok(ack.data.ack_at > 0);
  assert.equal((await call(b, 'ack_message', { id: sent.data.id })).data.ack_at, ack.data.ack_at);
  const reply = await call(b, 'send_message', { recipient: 'codex', key: 'reply-1', body: 'Review saved; no native result.', reply_to: sent.data.id });
  assert.equal(reply.data.reply_to, sent.data.id);
  const secondCodex = await client(root, 'codex');
  try { assert.equal((await call(secondCodex, 'list_messages')).data.items[0].body, 'Review saved; no native result.'); }
  finally { await secondCodex.close(); }
});

test('two-client overlapping path race has exactly one winner; fencing and native policy hold', { timeout: 15000 }, async t => {
  const { a, b } = await pair(t);
  const results = await Promise.all([
    call(a, 'acquire_claim', { key: 'race-a', resources: ['path:Shared'], ttl_ms: 30000 }),
    call(b, 'acquire_claim', { key: 'race-b', resources: ['path:shared/A.swift'], ttl_ms: 30000 })
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.error?.code === 'CLAIM_CONFLICT').length, 1);
  const owner = results[0].ok ? a : b, other = owner === a ? b : a, won = results.find(r => r.ok).data;
  assert.equal((await call(other, 'release_claim', { id: won.id, token: won.token })).error.code, 'STALE_TOKEN');
  assert.equal((await call(owner, 'renew_claim', { id: won.id, token: 'wrong', ttl_ms: 30000 })).error.code, 'STALE_TOKEN');
  assert.equal((await call(other, 'list_claims')).data.items[0].token, undefined);
  assert.equal((await call(owner, 'release_claim', { id: won.id, token: won.token })).data.active, false);
  assert.equal((await call(b, 'acquire_claim', { key: 'native-no', resources: ['lane:native'] })).error.code, 'FORBIDDEN');
  const native = await call(a, 'acquire_claim', { key: 'native-yes', resources: ['lane:native'] });
  assert.equal(native.ok, true);
  assert.equal((await call(a, 'acquire_claim', { key: 'native-duplicate', resources: ['lane:native'] })).error.code, 'CLAIM_CONFLICT');
});

test('two clients race the same task revision; stale CAS does not overwrite the winner', { timeout: 15000 }, async t => {
  const { a, b } = await pair(t);
  const task = (await call(a, 'create_task', { key: 'goal-1', assignee: 'cursor', title: 'Exact source review' })).data;
  const outcomes = await Promise.all([
    call(a, 'update_task', { id: task.id, expected_revision: 1, state: 'blocked', summary: 'Needs current parent.' }),
    call(b, 'update_task', { id: task.id, expected_revision: 1, state: 'active', summary: 'Claimed exact parent.' })
  ]);
  assert.equal(outcomes.filter(x => x.ok).length, 1);
  assert.equal(outcomes.filter(x => x.error?.code === 'REVISION_CONFLICT').length, 1);
  const current = (await call(a, 'get_task', { id: task.id })).data;
  assert.equal(current.revision, 2);
  assert.equal(current.summary, outcomes.find(x => x.ok).data.summary);
});

test('expiry uses distinct claim IDs/tokens and exact-boundary renewal is refused', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-expiry-'));
  let now = 100000;
  const a = new Store(root, 'codex', { clock: () => now });
  const b = new Store(root, 'cursor', { clock: () => now });
  t.after(async () => { a.close(); b.close(); await rm(root, { recursive: true, force: true }); });
  const old = a.acquire({ key: 'old', resources: ['path:src/A.swift'], ttl_ms: 1000 });
  now = old.expires_at;
  assert.throws(() => a.renew({ id: old.id, token: old.token }), e => e.code === 'EXPIRED');
  const replacement = b.acquire({ key: 'new', resources: ['path:src/A.swift'] });
  assert.notEqual(replacement.id, old.id); assert.notEqual(replacement.token, old.token);
  assert.throws(() => a.release({ id: old.id, token: old.token }), e => e.code === 'EXPIRED');
  assert.equal(b.claims({}).items.find(x => x.id === replacement.id).active, true);
});

test('UTF-8 bounds, traversal, symlink escapes and dangling aliases are rejected without records', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'cursodex-outside-'));
  const a = new Store(root, 'codex');
  t.after(async () => { a.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  assert.throws(() => a.send({ recipient: 'cursor', key: 'utf8', body: '🙂'.repeat(1025) }), e => e.code === 'INVALID_INPUT');
  assert.equal(a.messages({ direction: 'sent' }).items.length, 0);
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(outside, 'absent'), path.join(root, 'dangling'));
  for (const resource of ['path:../outside', 'path:escape/a', 'path:dangling/a', 'path:.CURSODEX/x']) {
    assert.throws(() => a.acquire({ key: 'bad-' + resource.length, resources: [resource] }), e => e.code === 'INVALID_PATH');
  }
  await mkdir(path.join(root, 'src'));
  await symlink(path.join(root, 'src'), path.join(root, 'alias'));
  a.acquire({ key: 'actual', resources: ['path:src/A.swift'] });
  assert.throws(() => a.acquire({ key: 'alias', resources: ['path:alias/A.swift'] }), e => e.code === 'CLAIM_CONFLICT');
});

test('event pagination and bounded wait observe the other real client without dropping cursor', { timeout: 15000 }, async t => {
  const { a, b } = await pair(t);
  const cursor = (await call(b, 'status')).data.latest_event;
  const pending = call(b, 'wait_events', { after: cursor, limit: 1, wait_ms: 2000 });
  await call(a, 'send_message', { recipient: 'cursor', key: 'wake', body: 'A visible handoff.' });
  const first = (await pending).data;
  assert.equal(first.items.length, 1); assert.equal(first.items[0].kind, 'message.sent');
  await call(a, 'send_message', { recipient: 'cursor', key: 'wake2', body: 'A second handoff.' });
  const second = (await call(b, 'list_events', { after: first.next_cursor, limit: 1 })).data;
  assert.ok(second.items[0].id > first.items[0].id);
  const empty = await call(b, 'wait_events', { after: second.next_cursor, wait_ms: 0 });
  assert.equal(empty.data.items.length, 0);
});

test('tools/resources/prompts advertise modern scoped capabilities and reject actor impersonation', { timeout: 15000 }, async t => {
  const { a } = await pair(t);
  assert.equal((await a.listTools()).tools.length, 17);
  assert.ok((await a.listResources()).resources.some(x => x.uri === 'cursodex://protocol'));
  assert.ok((await a.listPrompts()).prompts.some(x => x.name === 'cursodex-handoff'));
  const spoof = await a.callTool({ name: 'cursodex_send_message', arguments: { sender: 'cursor', recipient: 'cursor', key: 'spoof', body: 'no' } });
  assert.equal(spoof.isError, true);
});
