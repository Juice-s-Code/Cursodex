import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
async function connect(root, actor) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, PROJECT_ROOT: root, CURSODEX_AGENT: actor }, stderr: 'pipe' });
  const client = new Client({ name: 'memory-' + actor, version: '1' });
  try { await client.connect(transport); return client; }
  catch (error) { await transport.close(); throw error; }
}
const call = async (c, name, args = {}) => (await c.callTool({ name: 'cursodex_' + name, arguments: args })).structuredContent;
test('two clients share a durable note; racing revisions preserve exactly one winner', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-memory-'));
  const a = await connect(root, 'codex'), b = await connect(root, 'cursor');
  t.after(async () => { await Promise.allSettled([a.close(), b.close()]); await rm(root, { recursive: true, force: true }); });
  const initial = await call(a, 'put_memory', { name: 'project-goal', expected_revision: 0, body: 'Ship a reviewed map, preserving source evidence.' });
  assert.equal(initial.ok, true); assert.equal(initial.data.revision, 1);
  assert.equal((await call(b, 'get_memory', { name: 'project-goal' })).data.body, initial.data.body);
  const outcomes = await Promise.all([
    call(a, 'put_memory', { name: 'project-goal', expected_revision: 1, body: 'Codex bounded integration.', evidence: 'review:complete' }),
    call(b, 'put_memory', { name: 'project-goal', expected_revision: 1, body: 'Cursor bounded implementation.', evidence: 'source:complete' })
  ]);
  assert.equal(outcomes.filter(x => x.ok).length, 1);
  assert.equal(outcomes.filter(x => x.error?.code === 'REVISION_CONFLICT').length, 1);
  const third = await connect(root, 'codex');
  try {
    const retained = (await call(third, 'get_memory', { name: 'project-goal' })).data;
    assert.equal(retained.revision, 2); assert.equal(retained.body, outcomes.find(x => x.ok).data.body);
    assert.equal((await call(third, 'list_memories')).data.count, 1);
    const events = (await call(third, 'list_events', { limit: 10 })).data.items;
    assert.equal(events.filter(x => x.kind === 'memory.updated').length, 2);
  } finally { await third.close(); }
});
test('shared memory refuses invalid notes and stale create without an event or overwrite', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-memory-bounds-'));
  const a = new Store(root, 'codex'), b = new Store(root, 'cursor');
  t.after(async () => { a.close(); b.close(); await rm(root, { recursive: true, force: true }); });
  for (const input of [{name:'bad/name',body:'valid'}, {name:'a',body:'🙂'.repeat(1025)}, {name:'b',body:'\ud800'}, {name:'c',body:'ok',evidence:'x'.repeat(2049)}])
    assert.throws(() => a.putMemory({ expected_revision: 0, ...input }), e => e.code === 'INVALID_INPUT');
  assert.equal(a.events({}).count, 0);
  a.putMemory({name:'Goal',expected_revision:0,body:'exact bytes'});
  assert.throws(() => b.putMemory({name:'Goal',expected_revision:0,body:'replacement'}), e => e.code === 'REVISION_CONFLICT');
  assert.equal(a.getMemory({name:'Goal'}).body, 'exact bytes');
  assert.equal(a.events({}).count, 1);
  assert.throws(() => a.getMemory({name:'goal'}), e => e.code === 'NOT_FOUND');
});
