import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const MAX_REQUEST_BYTES = 65536;
const publicTools = new Set([
  'cursodex_status', 'cursodex_send_message', 'cursodex_list_messages', 'cursodex_ack_message',
  'cursodex_create_task', 'cursodex_get_task', 'cursodex_list_tasks', 'cursodex_update_task',
  'cursodex_put_memory', 'cursodex_get_memory', 'cursodex_list_memories',
  'cursodex_acquire_claim', 'cursodex_list_claims', 'cursodex_renew_claim', 'cursodex_release_claim',
  'cursodex_list_events', 'cursodex_wait_events',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error(label + ' must be an object containing only ' + allowed.join(', ') + '.');
}
function jsonValue(value, depth = 0) {
  if (depth > 64) throw new Error('JSON nesting exceeds 64 levels.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.isWellFormed()) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) jsonValue(child, depth + 1); return; }
  if (object(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !key.isWellFormed() || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error('Request must contain plain JSON values.');
      jsonValue(descriptor.value, depth + 1);
    }
    return;
  }
  throw new Error('Request must contain well-formed JSON values.');
}
export function parseJSON(text, label = 'JSON') {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error(label + ' must be valid UTF-8 JSON.');
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new Error(label + ' exceeds 65536 bytes.');
  try { return JSON.parse(text); }
  catch { throw new Error(label + ' must be valid JSON.'); }
}
/** Size-check and read only a bounded regular file before any SDK child starts. */
export function readJSONFile(filename, label = 'Request') {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error(label + ' file must be absolute.');
  const prior = fs.lstatSync(filename);
  if (!prior.isFile()) throw new Error(label + ' must be a regular JSON file.');
  if (prior.size > MAX_REQUEST_BYTES) throw new Error(label + ' exceeds 65536 bytes.');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filename, flags);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || current.dev !== prior.dev || current.ino !== prior.ino)
      throw new Error(label + ' file changed before reading.');
    if (current.size > MAX_REQUEST_BYTES) throw new Error(label + ' exceeds 65536 bytes.');
    const bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > MAX_REQUEST_BYTES) throw new Error(label + ' exceeds 65536 bytes.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)); }
    catch { throw new Error(label + ' must be valid UTF-8 JSON.'); }
    return parseJSON(text, label);
  } finally { fs.closeSync(fd); }
}
export function validateRequest(request) {
  jsonValue(request);
  fields(request, ['actor', 'projectRoot', 'deadlineMs', 'calls'], 'Request');
  if (!['codex', 'cursor'].includes(request.actor)) throw new Error('actor must be codex or cursor.');
  if (typeof request.projectRoot !== 'string' || !path.isAbsolute(request.projectRoot)) throw new Error('projectRoot must be absolute.');
  if (!fs.statSync(request.projectRoot).isDirectory()) throw new Error('projectRoot must be an existing directory.');
  if (!Array.isArray(request.calls) || request.calls.length > 20) throw new Error('Provide at most 20 calls.');
  const deadlineMs = request.deadlineMs ?? 60000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 60000)
    throw new Error('deadlineMs must be an integer from 1000 to 60000.');
  for (const call of request.calls) {
    fields(call, ['name', 'arguments'], 'Call');
    if (typeof call.name !== 'string' || !publicTools.has(call.name)) throw new Error('Only advertised public cursodex_ tools are allowed.');
    if (!object(call.arguments)) throw new Error('Each call requires an arguments object.');
  }
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw new Error('Request exceeds 65536 bytes.');
  return { actor: request.actor, projectRoot: request.projectRoot, deadlineMs,
    calls: request.calls.map(call => ({ name: call.name, arguments: JSON.parse(JSON.stringify(call.arguments)) })) };
}

// Bounded protocol calls only: no shell, agent dispatch, remote credentials or retries.
export async function runRequest(input) {
  const request = validateRequest(input);
  const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: request.projectRoot,
    env: { ...process.env, PROJECT_ROOT: request.projectRoot, CURSODEX_AGENT: request.actor }, stderr: 'pipe' });
  let stderrBytes = 0;
  transport.stderr.on('data', chunk => {
    if (stderrBytes < 65536) process.stderr.write(chunk.subarray(0, 65536 - stderrBytes));
    stderrBytes += chunk.length;
  });
  const client = new Client({ name: 'cursodex-bounded-client', version: '0.1.0' });
  const receipt = { actor: request.actor, projectRoot: request.projectRoot, startedAt: new Date().toISOString(), results: [] };
  const abort = new AbortController();
  let expired = false, deadline, exitCode = 0;
  const expiry = new Promise((_, reject) => {
    deadline = setTimeout(() => {
      expired = true; receipt.deadlineReached = true;
      reject(new Error('Cursodex client deadline reached.'));
      abort.abort();
    }, request.deadlineMs);
  });
  try {
    await Promise.race([expiry, (async () => {
      await client.connect(transport, { timeout: 10000, signal: abort.signal });
      if (expired) return;
      const catalog = await client.listTools(undefined, { signal: abort.signal });
      if (expired) return;
      receipt.tools = catalog.tools.map(tool => tool.name);
      for (const call of request.calls) {
        if (expired) return;
        if (!receipt.tools.includes(call.name)) throw new Error('Tool unavailable: ' + call.name);
        const result = await client.callTool(call, undefined, { timeout: 25000, resetTimeoutOnProgress: false, maxTotalTimeout: 25000, signal: abort.signal });
        if (expired) return;
        receipt.results.push({ name: call.name, result });
        if (result.isError) { exitCode = 1; break; }
      }
    })()]);
  } catch (error) {
    receipt.error = expired ? 'Cursodex client deadline reached.' : String(error.message).slice(0, 1000); exitCode = 1;
  } finally {
    clearTimeout(deadline); abort.abort();
    try { await client.close(); }
    catch (error) { receipt.cleanupError = String(error.message).slice(0, 1000); exitCode = 1; }
    try { await transport.close(); }
    catch (error) { receipt.cleanupError = String(error.message).slice(0, 1000); exitCode = 1; }
    receipt.endedAt = new Date().toISOString();
  }
  return { receipt, exitCode };
}
/** Preserve the standalone request-file interface, including relative filepath use. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error('Usage: node cli/client.mjs /absolute/request.json');
  const result = await runRequest(readJSONFile(path.resolve(argv[0])));
  process.stdout.write(JSON.stringify(result.receipt) + '\n');
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}
let invokedPath = null;
try { if (process.argv[1]) invokedPath = fs.realpathSync(process.argv[1]); } catch { /* Imported from a non-file entrypoint. */ }
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(error => { process.stderr.write('Cursodex client: ' + String(error.message).slice(0, 1000) + '\n'); process.exitCode = 1; });
}
