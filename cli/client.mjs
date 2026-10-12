import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A bounded protocol client for environments that cannot reload MCP tools live.
// It invokes Cursodex tools only; it never invokes an agent or an app build.
const requestPath = process.argv[2];
if (!requestPath) throw new Error('Usage: node cli/client.mjs /absolute/request.json');
const bytes = fs.readFileSync(requestPath);
if (bytes.length > 65536) throw new Error('Request exceeds 65536 bytes.');
const request = JSON.parse(bytes.toString('utf8'));
if (!['codex', 'cursor'].includes(request.actor)) throw new Error('actor must be codex or cursor.');
if (typeof request.projectRoot !== 'string' || !path.isAbsolute(request.projectRoot)) throw new Error('projectRoot must be absolute.');
if (!Array.isArray(request.calls) || request.calls.length > 20) throw new Error('Provide at most 20 calls.');
const deadlineMs = request.deadlineMs ?? 60000;
if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 60000) throw new Error('deadlineMs must be an integer from 1000 to 60000.');
for (const call of request.calls) {
  if (typeof call?.name !== 'string' || !call.name.startsWith('cursodex_')) throw new Error('Only public cursodex_ tools are allowed.');
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Each call requires an arguments object.');
}
const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: request.projectRoot,
  env: { ...process.env, PROJECT_ROOT: request.projectRoot, CURSODEX_AGENT: request.actor },
  stderr: 'pipe',
});
let stderrBytes = 0;
transport.stderr.on('data', chunk => {
  if (stderrBytes < 65536) process.stderr.write(chunk.subarray(0, 65536 - stderrBytes));
  stderrBytes += chunk.length;
});
const client = new Client({ name: 'cursodex-bounded-client', version: '0.1.0' });
const receipt = { actor: request.actor, projectRoot: request.projectRoot, startedAt: new Date().toISOString(), results: [] };
let expired = false;
let deadline;
const expiry = new Promise((_, reject) => {
  deadline = setTimeout(() => {
    expired = true;
    receipt.deadlineReached = true;
    reject(new Error('Cursodex client deadline reached.'));
  }, deadlineMs);
});
try {
  await Promise.race([expiry, (async () => {
    await client.connect(transport, { timeout: 10000 });
    const catalog = await client.listTools();
    if (expired) return;
    receipt.tools = catalog.tools.map(tool => tool.name);
    for (const call of request.calls) {
      if (expired) return;
      if (!receipt.tools.includes(call.name)) throw new Error('Tool unavailable: ' + call.name);
      const result = await client.callTool(call, undefined, { timeout: 25000, resetTimeoutOnProgress: false, maxTotalTimeout: 25000 });
      if (expired) return;
      receipt.results.push({ name: call.name, result });
      if (result.isError) { process.exitCode = 1; break; }
    }
  })()]);
} catch (error) {
  receipt.error = String(error.message).slice(0, 1000);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { await client.close(); }
  catch (error) { receipt.cleanupError = String(error.message).slice(0, 1000); process.exitCode = 1; }
  receipt.endedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
