import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { runLive, normalizeActivity, frames, parseLiveArguments } from '../cli/live.mjs';
import { runRequest } from '../cli/client.mjs';
import { credentials } from '../src/http.js';

async function fixture(t) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-live-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}
test('Cursor metadata omits user text, shell/output, arbitrary tool names and thinking', () => {
  const root = '/fictional/project';
  for (const type of ['user', 'assistant', 'thinking']) assert.equal(normalizeActivity({ type, message: { content: 'secret' } }, 'cursor-stream', root), null);
  const call = normalizeActivity({ type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'src/app.js', fileText: 'SECRET' }, result: { output: 'SECRET' } } } }, 'cursor-stream', root);
  assert.deepEqual(call.paths, ['src/app.js']); assert.equal(JSON.stringify(call).includes('SECRET'), false);
  assert.equal(normalizeActivity({ hook_event_name: 'afterAgentThought', text: 'SECRET' }, 'cursor-hook', root), null);
  const shell = normalizeActivity({ hook_event_name: 'afterShellExecution', command: 'SECRET', output: 'SECRET' }, 'cursor-hook', root);
  assert.equal(JSON.stringify(shell).includes('SECRET'), false);
  for (const file_path of ['../outside', '/outside', 'C:\\outside', 'bad\nfile'])
    assert.deepEqual(normalizeActivity({ hook_event_name: 'afterFileEdit', file_path }, 'cursor-hook', root).paths, []);
});
test('frame parser bounds each record, rejects malformed UTF8 and handles split multibyte data', async () => {
  const bytes = Buffer.from('{"value":"🙂"}\n');
  const result = [];
  for await (const f of frames(Readable.from([bytes.subarray(0, 12), bytes.subarray(12)]))) result.push(f);
  assert.deepEqual(result, [{ value: '🙂' }]);
  await assert.rejects(async () => { for await (const f of frames(Readable.from([Buffer.alloc(65537, 32)]))) void f; }, /exceeds/);
  await assert.rejects(async () => { for await (const f of frames(Readable.from([Buffer.from([0xff])]))) void f; }, /encoded data|encoding/);
});
test('cloud named credentials are distinct and trusted config only', () => {
  const map = { codex: 'a'.repeat(32), cursor: 'b'.repeat(32), claude: 'c'.repeat(32) };
  assert.deepEqual(credentials({ CURSODEX_AGENT_TOKENS: JSON.stringify(map) }), map);
  assert.throws(() => credentials({ CURSODEX_AGENT_TOKENS: JSON.stringify({ codex: map.codex, claude: map.codex }) }), /distinct/);
  assert.throws(() => credentials({ CURSODEX_AGENT_TOKENS: '{' }), /valid JSON/);
  assert.throws(() => credentials({ CURSODEX_AGENT_TOKENS: JSON.stringify({ 'bad actor': map.codex, claude: map.claude }) }), /credentials/);
});
test('live options require a fixed agent/project and a finite duration', async t => {
  const root = await fixture(t);
  assert.equal(parseLiveArguments('watch', ['--agent', 'claude', '--project', root]).actor, 'claude');
  assert.throws(() => parseLiveArguments('watch', ['--agent', 'claude', '--project', root, '--duration-ms', '0']), /duration/);
  assert.throws(() => parseLiveArguments('bridge', ['--agent', 'claude', '--project', root, '--source', 'terminal-scrape']), /source/);
});
test('real SDK live watcher observes bridged Cursor metadata and private inbox without acknowledging', { timeout: 15000 }, async t => {
  const projectRoot = await fixture(t), output = [];
  const controller = new AbortController();
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const watch = runLive('watch', { actor: 'claude', projectRoot, durationMs: 8000, after: 0 }, { signal: controller.signal, emit: value => { output.push(value); if (value.type === 'connected') connected(); } });
  t.after(() => controller.abort());
  await ready;
  await runLive('bridge', { actor: 'cursor', projectRoot, durationMs: 5000, source: 'cursor-stream' }, {
    input: Readable.from([Buffer.from(JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'src/app.js', fileText: 'SECRET' } } } }) + '\n')]), emit() {} });
  const receipt = await runRequest({ actor: 'codex', projectRoot, deadlineMs: 5000, calls: [{ name: 'cursodex_send_message', arguments: { recipient: 'claude', key: 'watch-message', body: 'Review the shared change.' } }] });
  assert.equal(receipt.exitCode, 0);
  const end = performance.now() + 2500;
  while (performance.now() < end && !(output.some(x => x.type === 'activity') && output.some(x => x.type === 'message'))) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(); await watch;
  assert.equal(output.find(x => x.type === 'activity')?.activity.actor, 'cursor');
  assert.equal(output.find(x => x.type === 'message')?.message.ack_at, null);
  assert.equal(JSON.stringify(output).includes('SECRET'), false);
});
test('bridge cancels while input is idle and reaps the SDK child', { timeout: 5000 }, async t => {
  const projectRoot = await fixture(t), input = new PassThrough();
  const result = await runLive('bridge', { actor: 'cursor', projectRoot, durationMs: 350, source: 'cursor-hook' }, { input, emit() {} });
  assert.equal(result.durationReached, true); assert.equal(input.destroyed, true);
});
test('duration and external cancellation stop an unresponsive MCP initialization', { timeout: 5000 }, async t => {
  const projectRoot = await fixture(t);
  for (const external of [false, true]) {
    let closed = 0;
    const controller = new AbortController();
    const transportFactory = () => ({
      async start() {}, async send() {},
      async close() { closed++; this.onclose?.(); }
    });
    const timer = external ? setTimeout(() => controller.abort(), 150) : null;
    try {
      const result = await runLive('watch', { actor: 'claude', projectRoot, durationMs: external ? 3000 : 150, after: 0 }, { signal: controller.signal, emit() {}, transportFactory });
      assert.equal(result.stopped, true); assert.ok(closed > 0);
    } finally { clearTimeout(timer); }
  }
});

test('cancellation joins the first close until the transport actually finishes', { timeout: 5000 }, async t => {
  const projectRoot = await fixture(t), controller = new AbortController();
  let startClose, releaseClose, closeCalls = 0, settled = false;
  const closing = new Promise(resolve => { startClose = resolve; });
  const gate = new Promise(resolve => { releaseClose = resolve; });
  const transportFactory = () => ({
    pid: 123,
    async start() {},
    async send(message) {
      if (message.method === 'initialize') queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'close-fixture', version: '1' } } }));
      if (message.method === 'tools/call' && message.params.name === 'cursodex_status') queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id,
        result: { content: [], structuredContent: { ok: true, data: { agent: 'claude', project_root: projectRoot, latest_event: 0 } } } }));
    },
    async close() {
      closeCalls++;
      if (this.pid === null) return;
      this.pid = null; startClose(); await gate; this.onclose?.();
    }
  });
  const work = runLive('watch', { actor: 'claude', projectRoot, durationMs: 3000, after: 0 }, {
    signal: controller.signal, transportFactory, emit(value) { if (value.type === 'connected') controller.abort(); }
  }).then(result => { settled = true; return result; });
  try {
    await closing;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a stop receipt must not precede actual transport cleanup');
    assert.equal(closeCalls, 1, 'concurrent SDK/finally close calls must join the first operation');
  } finally { releaseClose(); await work; }
  assert.equal(settled, true); assert.equal(closeCalls, 1);
});

test('cancellation propagates cleanup failure instead of reporting a clean stop', { timeout: 5000 }, async t => {
  const projectRoot = await fixture(t), controller = new AbortController();
  const transportFactory = () => ({
    async start() {}, async send() {},
    async close() { throw Error('fixture close failure'); }
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(runLive('watch', { actor: 'claude', projectRoot, durationMs: 3000, after: 0 }, {
      signal: controller.signal, transportFactory, emit() {}
    }), error => error.code === 'CLEANUP_FAILED');
  } finally { clearTimeout(timer); }
});
