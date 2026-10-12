import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../cli/client.mjs', import.meta.url));
async function run(t, request) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'request.json');
  await fs.writeFile(file, JSON.stringify({ actor: 'codex', projectRoot: root, calls: [], ...request }));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const started = Date.now();
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI cleanup exceeded test bound')); }, 10000);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, elapsed: Date.now() - started }); });
  });
}
test('bounded CLI calls advertised actor status and returns its structured receipt', { timeout: 15000 }, async t => {
  const result = await run(t, { calls: [{ name: 'cursodex_status', arguments: {} }] });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.actor, 'codex');
  assert.equal(receipt.tools.length, 17);
  assert.equal(receipt.results[0].result.structuredContent.data.agent, 'codex');
  assert.equal(receipt.deadlineReached, undefined);
});
test('bounded CLI closes a waiting server and records deadline failure', { timeout: 15000 }, async t => {
  const result = await run(t, { deadlineMs: 1000, calls: [{ name: 'cursodex_wait_events', arguments: { after: 0, wait_ms: 20000 } }] });
  assert.equal(result.code, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.deadlineReached, true);
  assert.match(receipt.error, /deadline reached/);
  assert.equal(receipt.results.length, 0);
  assert.ok(result.elapsed < 7000);
});
test('bounded CLI rejects actor spoofing before launching a server', { timeout: 15000 }, async t => {
  const result = await run(t, { actor: 'other' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /actor must be codex or cursor/);
  assert.equal(result.stdout, '');
});
