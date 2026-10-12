// Run with npm run verify:package. This proves protocol clients, not AI-host loading.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'smol-toml';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(source, 'verification-receipts', 'package.json');
const execute = promisify(execFile), started = Date.now(), totalMs = 300000;
const finalDeadline = started + totalMs, workDeadline = finalDeadline - 45000;
const controller = new AbortController(), children = new Set(), clients = [];
let root, proof, failure;
const assert = (condition, label) => { if (!condition) throw Error(label); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Match absolute private locations in payload text; escaped regex syntax cannot match itself.
const privateAbsolutePath = /(?:^|[\s"'`(=:])(?:file:\/\/\/(?=[A-Za-z]:)|(?:file:\/\/)?)(?:\/(?:Users|home)\/[^/\s"'`]+(?:\/|(?=[\s"'`]|$))|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`]+(?:[\\/]|(?=[\s"'`]|$))|\/Library\/Obsidian(?:\/|(?=[\s"'`]|$)))/m;
const workTimer = setTimeout(() => controller.abort(), workDeadline - Date.now());
const hardTimer = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const item of clients) if (!item.exited && item.pid) {
    try { process.kill(item.pid, 'SIGKILL'); } catch {}
  }
  process.stderr.write('Package proof exceeded total deadline; cleanup is unverified.\n');
  process.exit(1);
}, totalMs);
function timeout(maximum = 10000) {
  const left = workDeadline - Date.now();
  assert(left > 0 && !controller.signal.aborted, 'Package work deadline reached');
  return Math.min(left, maximum);
}
const options = () => ({ timeout: timeout(), maxTotalTimeout: timeout(), resetTimeoutOnProgress: false, signal: controller.signal });
async function bounded(action, milliseconds = 10000, cleanup = false) {
  const limit = cleanup ? Math.min(milliseconds, finalDeadline - Date.now() - 1000) : timeout(milliseconds);
  assert(limit > 0, 'No time remains for cleanup');
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(cleanup ? 'Cleanup deadline' : 'Work deadline')), limit);
  })]); } finally { clearTimeout(timer); }
}
async function run(command, args, configuration = {}) {
  const pending = execute(command, args, { maxBuffer: 1000000, ...configuration,
    timeout: timeout(configuration.timeout ?? 10000), signal: controller.signal });
  const child = pending.child; children.add(child);
  child.once('close', () => children.delete(child));
  return pending;
}
async function tool(client, name, args = {}) {
  const result = await bounded(() => client.callTool({ name: 'cursodex_' + name, arguments: args }, undefined, options()));
  assert(!result.isError && result.structuredContent?.ok, 'Tool failed: ' + name);
  return result.structuredContent.data;
}
async function connect(config) {
  const client = new Client({ name: 'cursodex-clean-consumer', version: '1' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const item = { client, transport, started: false, rejected: false, pid: null, exited: false, closed: false };
  let observedClose;
  item.actualClose = new Promise(resolve => { observedClose = resolve; });
  transport.onclose = () => { item.exited = true; observedClose(); };
  const start = transport.start.bind(transport);
  transport.start = () => {
    item.started = true;
    const pending = start();
    if (Number.isInteger(transport.pid) && transport.pid > 0) item.pid = transport.pid;
    return pending.catch(error => { item.rejected = true; throw error; });
  };
  clients.push(item);
  await bounded(() => client.connect(transport, options()));
  assert(item.pid, 'SDK child identity was not captured');
  return client;
}
async function closeClients() {
  const outcomes = await Promise.allSettled(clients.map(async item => {
    if (item.closed || !item.started || (item.rejected && !item.pid)) return;
    let error;
    try { await bounded(() => item.client.close(), 8000, true); } catch (e) { error = e; }
    try { await bounded(() => item.transport.close(), 8000, true); } catch (e) { error ??= e; }
    await bounded(() => item.actualClose, 8000, true);
    item.closed = true;
    if (error) throw error;
  }));
  const failed = outcomes.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;
}
async function acknowledge(recipient, sender, message) {
  const row = await tool(recipient, 'ack_message', { id: message.id });
  assert(row.id === message.id && row.sender === message.sender && row.recipient === message.recipient &&
    Number.isFinite(row.ack_at) && row.ack_at > 0, 'Returned ACK mismatch');
  const retained = (await tool(sender, 'list_messages', { direction: 'sent', after: message.id - 1, limit: 1 })).items[0];
  assert(retained?.id === message.id && retained.ack_at === row.ack_at, 'ACK was not retained');
  return { id: row.id, ack_at: row.ack_at };
}

try {
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const npm = process.env.npm_execpath;
  assert(npm && path.isAbsolute(npm) && path.basename(npm) === 'npm-cli.js', 'Run this verifier through npm run verify:package');
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cursodex-package-proof-')));
  const consumer = path.join(root, 'clean consumer'), project = path.join(root, 'shared project');
  await fs.mkdir(consumer); await fs.mkdir(project);
  const npmEnv = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_logs_dir: path.join(root, 'npm-logs') };
  const npmRun = (args, cwd, maximum) => run(process.execPath, [npm, ...args], { cwd, env: npmEnv, timeout: maximum });
  const packed = JSON.parse((await npmRun(['pack', '--json', '--ignore-scripts', '--pack-destination', root], source, 30000)).stdout)[0];
  assert(packed.name === pkg.name && packed.version === pkg.version, 'Packed identity/version mismatch');
  for (const required of ['bin/cursodex.mjs', 'cli/call.mjs', 'skills/cursodex/SKILL.md', '.codex-plugin/plugin.json',
    'Dockerfile', 'compose.yaml', '.env.example', 'npm-shrinkwrap.json', '.dockerignore'])
    assert(packed.files.some(f => f.path === required), 'Package is missing ' + required);
  for (const file of packed.files) {
    assert(!/(^|\/)(?:\.cursodex|\.obsidian|\.codex|\.cursor|state\.sqlite|node_modules)(\/|$)/.test(file.path), 'Private package path');
    assert(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'), 'Unsafe package path');
    const original = path.join(source, file.path), stat = await fs.lstat(original);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2000000, 'Unexpected package member');
    const text = await fs.readFile(original, 'utf8');
    assert(!privateAbsolutePath.test(text), 'Private absolute path in package');
  }
  const archive = path.join(root, packed.filename), packageSha256 = sha(await fs.readFile(archive));
  await npmRun(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', archive], root, 120000);
  const bin = path.join(consumer, 'node_modules', pkg.name, 'bin/cursodex.mjs');
  assert((await run(process.execPath, [bin, '--version'])).stdout.trim() === pkg.version, 'Installed CLI version mismatch');
  const setup = JSON.parse((await run(process.execPath, [bin, 'setup', '--project', project], { timeout: 30000 })).stdout);
  const codex = parse(await fs.readFile(path.join(project, '.codex/config.toml'), 'utf8')).mcp_servers.cursodex;
  const cursor = JSON.parse(await fs.readFile(path.join(project, '.cursor/mcp.json'), 'utf8')).mcpServers.cursodex;
  assert(setup.runtime && setup.runtime_bytes > 0, 'Durable runtime was not created');
  for (const config of [codex, cursor]) {
    assert(config.command === process.execPath && config.args[0].startsWith(setup.runtime + path.sep), 'Generated runtime is not durable');
  }
  await fs.rm(consumer, { recursive: true });
  await assertAbsent(consumer);
  const a = await connect(codex), b = await connect(cursor);
  const statuses = await Promise.all([tool(a, 'status'), tool(b, 'status')]);
  assert(statuses[0].agent === 'codex' && statuses[1].agent === 'cursor' &&
    statuses.every(x => x.project_root === project && x.runtime?.package_version === pkg.version), 'Installed status identity mismatch');
  assert([a, b].every(x => x.getServerVersion()?.version === pkg.version), 'Initialized server version mismatch');
  for (const client of [a, b]) assert((await bounded(() => client.listTools(undefined, options()))).tools.length === 17, 'Tool catalogue mismatch');
  const challenge = randomUUID();
  const sent = await tool(a, 'send_message', { recipient: 'cursor', key: 'package-challenge', body: challenge });
  const received = (await tool(b, 'list_messages')).items.find(x => x.id === sent.id);
  assert(received?.body === challenge && received.sender === 'codex', 'Challenge was not received');
  const firstAck = await acknowledge(b, a, sent);
  const reply = await tool(b, 'send_message', { recipient: 'codex', key: 'package-reply', body: challenge, reply_to: sent.id });
  const actualReply = (await tool(a, 'list_messages')).items.find(x => x.id === reply.id);
  assert(actualReply?.body === challenge && actualReply.reply_to === sent.id && actualReply.sender === 'cursor', 'Reply was not received');
  const secondAck = await acknowledge(a, b, reply);
  await tool(a, 'put_memory', { name: 'package-proof', expected_revision: 0, body: 'first' });
  const memory = await tool(b, 'get_memory', { name: 'package-proof' });
  assert(memory.body === 'first' && memory.revision === 1, 'Memory was not shared');
  await tool(b, 'put_memory', { name: 'package-proof', expected_revision: memory.revision, body: 'second' });
  const updated = await tool(a, 'get_memory', { name: 'package-proof' });
  assert(updated.body === 'second' && updated.revision === 2, 'CAS update was not retained');
  const conflict = await bounded(() => a.callTool({ name: 'cursodex_put_memory',
    arguments: { name: 'package-proof', expected_revision: 1, body: 'stale' } }, undefined, options()));
  assert(conflict.isError && conflict.structuredContent?.error?.code === 'REVISION_CONFLICT', 'Stale CAS was accepted');
  assert((await tool(b, 'get_memory', { name: 'package-proof' })).body === 'second', 'Failed CAS changed retained memory');
  await closeClients();
  proof = { version: pkg.version, packageSha256, packageIntegrity: packed.integrity, fileCount: packed.files.length,
    node: process.version, platform: process.platform, sourceInstallationRemoved: true, tools: 17,
    actors: statuses.map(x => x.agent), acknowledgements: [firstAck, secondAck], sharedMemoryCas: true,
    snapshotCliFallbackProof: false, runtimeBytes: setup.runtime_bytes, actualAIHosts: false, externalDeployment: false };
} catch (error) { failure = error; }
finally {
  clearTimeout(workTimer); controller.abort();
  const cleanupErrors = [];
  try { await closeClients(); } catch (error) { cleanupErrors.push(error.message); }
  await Promise.all([...children].map(async child => {
    child.kill('SIGTERM');
    try { await bounded(() => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve);
      const force = setTimeout(() => child.kill('SIGKILL'), 500); force.unref();
      child.once('close', () => clearTimeout(force));
    }), 2000, true); } catch (error) { cleanupErrors.push(error.message); }
  }));
  const sdkChildren = clients.map(x => ({ pid: x.pid, closeEventObserved: x.exited, closed: x.closed }));
  const sdkClosed = clients.every(x => !x.started || (x.rejected && !x.pid) || (x.closed && x.exited));
  if (!sdkClosed) cleanupErrors.push('SDK child close was not confirmed');
  try { if (root) { await bounded(() => fs.rm(root, { recursive: true, force: true }), 10000, true); await assertAbsent(root); } }
  catch (error) { cleanupErrors.push(error.message); }
  if (cleanupErrors.length) failure ??= Error('Package cleanup failed');
  const receipt = { ...proof, success: !failure, cleanupVerified: cleanupErrors.length === 0 && sdkClosed,
    cleanupErrors, sdkChildren, elapsedMs: Date.now() - started, totalBudgetMs: totalMs,
    ...(failure ? { error: String(failure.message).slice(0, 600) } : {}) };
  try {
    await bounded(async () => { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); }, 3000, true);
    console.log(JSON.stringify(receipt));
  } catch { failure ??= Error('Package receipt write failed'); }
  clearTimeout(hardTimer);
}
if (failure) process.exitCode = 1;
async function assertAbsent(target) {
  try { await fs.lstat(target); throw Error('Owned temporary path remains'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
