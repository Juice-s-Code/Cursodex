// Disposable Ubuntu Docker proof only; never connect to a production endpoint or volume.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(source, 'verification-receipts', 'container.json');
const execute = promisify(execFile), started = Date.now(), totalMs = 420000;
const finalDeadline = started + totalMs, workDeadline = finalDeadline - 120000;
const controller = new AbortController(), children = new Map(), commands = [], connections = [];
const identity = randomUUID(), label = 'io.cursodex.verification';
const image = 'cursodex-proof:' + identity, container = 'cursodex-proof-' + identity, volume = container + '-state';
const tokens = { codex: randomBytes(32).toString('hex'), cursor: randomBytes(32).toString('hex') };
let root, proof, failure, containerCreated = false, volumeCreated = false, imageCreated = false;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const workTimer = setTimeout(() => controller.abort(), workDeadline - Date.now());
const hardTimer = setTimeout(() => {
  for (const child of children.keys()) child.kill('SIGKILL');
  process.stderr.write('Container proof exceeded total deadline; owned Docker cleanup is unverified.\n');
  process.exit(1);
}, totalMs);
function remaining(maximum = 10000, cleanup = false) {
  const left = (cleanup ? finalDeadline - 1000 : workDeadline) - Date.now();
  assert(left > 0 && (cleanup || !controller.signal.aborted), 'Container deadline reached');
  return Math.min(left, maximum);
}
async function bounded(action, maximum = 10000, cleanup = false) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Container operation deadline')), remaining(maximum, cleanup));
  })]); } finally { clearTimeout(timer); }
}
async function docker(args, maximum = 10000, cleanup = false) {
  const pending = execute('docker', args, { cwd: source, timeout: remaining(maximum, cleanup),
    maxBuffer: 1000000, ...(cleanup ? {} : { signal: controller.signal }) });
  const child = pending.child;
  const item = { operation: args.slice(0, 2).join(' '), pid: child.pid ?? null, cleanup,
    mutating: ['build', 'run', 'start', 'stop'].includes(args[0]) || ['create', 'rm'].includes(args[1]),
    completed: false, closed: false, uncertainMutation: false, code: null, signal: null };
  let observedClose;
  item.actualClose = new Promise(resolve => { observedClose = resolve; });
  commands.push(item); children.set(child, item);
  child.once('close', (code, signal) => {
    item.closed = true; item.code = code; item.signal = signal;
    children.delete(child); observedClose();
  });
  try {
    const result = await pending;
    item.completed = true;
    await bounded(() => item.actualClose, 3000, cleanup);
    return result.stdout.trim();
  } catch (error) {
    // A killed/failed mutation may have reached the daemon. Child close alone cannot certify rollback.
    item.uncertainMutation = item.mutating;
    throw Error('Docker ' + args[0] + ' failed (' + (error.code ?? 'deadline') + ')');
  }
}
async function reapPendingCommands() {
  const results = await Promise.allSettled([...children].map(async ([child, item]) => {
    if (item.closed) return;
    if (item.mutating && !item.completed) item.uncertainMutation = true;
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (!item.closed) child.kill('SIGKILL'); }, 500);
    force.unref();
    try { await bounded(() => item.actualClose, 3000, true); }
    finally { clearTimeout(force); }
  }));
  const rejected = results.find(x => x.status === 'rejected');
  if (rejected) throw rejected.reason;
  assert(children.size === 0, 'Owned Docker command close was not confirmed');
}
async function inspect(kind, name, cleanup = false) {
  return JSON.parse(await docker([kind, 'inspect', name], 10000, cleanup))[0];
}
async function owned(kind, name, cleanup = false) {
  const data = await inspect(kind, name, cleanup);
  assert((data.Config?.Labels ?? data.Labels)?.[label] === identity, 'Docker ownership label mismatch');
  return data;
}
function options() {
  const timeout = remaining();
  return { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, signal: controller.signal };
}
async function tool(client, name, args = {}) {
  const response = await bounded(() => client.callTool({ name: 'cursodex_' + name, arguments: args }, undefined, options()));
  assert(!response.isError && response.structuredContent?.ok, 'HTTP tool failed: ' + name);
  return response.structuredContent.data;
}
async function destination() {
  const data = await owned('container', container);
  const binding = data.NetworkSettings?.Ports?.['8787/tcp']?.[0];
  assert(data.State.Running && binding?.HostIp === '127.0.0.1' && /^\d+$/.test(binding.HostPort), 'Docker loopback destination mismatch');
  return 'http://127.0.0.1:' + binding.HostPort;
}
async function ready(base) {
  const deadline = Math.min(workDeadline, Date.now() + 30000);
  while (Date.now() < deadline && !controller.signal.aborted) {
    try {
      if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Owned container did not become healthy');
}
async function connect(base, actor) {
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer ' + tokens[actor] } } });
  const client = new Client({ name: 'cursodex-container-' + actor, version: '1' });
  const entry = { client, transport, closed: false }; connections.push(entry);
  await bounded(() => client.connect(transport, options()));
  return client;
}
async function closeClients() {
  const results = await Promise.allSettled(connections.map(async entry => {
    if (entry.closed) return;
    let error;
    try { await bounded(() => entry.transport.terminateSession(), 5000, true); } catch (e) { error = e; }
    try { await bounded(() => entry.client.close(), 5000, true); } catch (e) { error ??= e; }
    try { await bounded(() => entry.transport.close(), 5000, true); } catch (e) { error ??= e; }
    entry.closed = !error;
    if (error) throw error;
  }));
  const rejected = results.find(x => x.status === 'rejected');
  if (rejected) throw rejected.reason;
}
async function ack(recipient, sender, message) {
  const row = await tool(recipient, 'ack_message', { id: message.id });
  assert(row.id === message.id && row.sender === message.sender && row.recipient === message.recipient && row.ack_at > 0, 'Returned HTTP ACK mismatch');
  const retained = (await tool(sender, 'list_messages', { direction: 'sent', after: message.id - 1, limit: 1 })).items[0];
  assert(retained?.id === row.id && retained.ack_at === row.ack_at, 'HTTP ACK was not retained');
  return { id: row.id, ack_at: row.ack_at };
}
async function stop(cleanup = false) {
  await owned('container', container, cleanup);
  await docker(['stop', '--time', '10', container], 15000, cleanup);
  const state = (await owned('container', container, cleanup)).State;
  assert(!state.Running && state.ExitCode === 0 && !state.OOMKilled, 'Container did not stop gracefully');
  return { running: state.Running, exitCode: state.ExitCode, oomKilled: state.OOMKilled };
}

try {
  assert(process.platform === 'linux', 'Container proof is intended for the Ubuntu Docker CI job');
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const dockerfileSha256 = hash(await fs.readFile(path.join(source, 'Dockerfile')));
  const lockSha256 = hash(await fs.readFile(path.join(source, 'package-lock.json')));
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cursodex-container-proof-')));
  const envFile = path.join(root, 'private.env');
  await fs.writeFile(envFile, 'CURSODEX_CODEX_TOKEN=' + tokens.codex + '\nCURSODEX_CURSOR_TOKEN=' + tokens.cursor +
    '\nCURSODEX_ALLOWED_HOSTS=localhost,127.0.0.1\n', { flag: 'wx', mode: 0o600 });
  await docker(['build', '--label', label + '=' + identity, '--tag', image, '.'], 200000); imageCreated = true;
  const built = await owned('image', image);
  await docker(['volume', 'create', '--label', label + '=' + identity, volume]); volumeCreated = true;
  await owned('volume', volume);
  await docker(['run', '--detach', '--name', container, '--label', label + '=' + identity, '--read-only',
    '--tmpfs', '/tmp:size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', 'type=volume,src=' + volume + ',dst=/workspace', '--publish', '127.0.0.1::8787', '--env-file', envFile, image]);
  containerCreated = true;
  const configuration = await owned('container', container);
  assert(configuration.HostConfig.ReadonlyRootfs && configuration.Config.User === 'node', 'Container safety settings mismatch');
  let base = await destination(); await ready(base);
  assert((await fetch(base + '/mcp', { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) })).status === 401, 'Unauthenticated container request was accepted');
  const a = await connect(base, 'codex'), b = await connect(base, 'cursor');
  const statuses = await Promise.all([tool(a, 'status'), tool(b, 'status')]);
  assert(statuses[0].agent === 'codex' && statuses[1].agent === 'cursor' &&
    statuses.every(x => x.project_root === '/workspace' && x.runtime?.package_version === pkg.version), 'Container identity/version mismatch');
  assert([a, b].every(x => x.getServerVersion()?.version === pkg.version), 'HTTP initialization version mismatch');
  for (const client of [a, b]) assert((await bounded(() => client.listTools(undefined, options()))).tools.length === 19, 'HTTP tool catalogue mismatch');
  const challenge = randomUUID();
  const sent = await tool(a, 'send_message', { recipient: 'cursor', key: 'container-challenge', body: challenge });
  const delivered = (await tool(b, 'list_messages')).items.find(x => x.id === sent.id);
  assert(delivered?.body === challenge && delivered.sender === 'codex', 'Container challenge missing');
  const firstAck = await ack(b, a, sent);
  const reply = await tool(b, 'send_message', { recipient: 'codex', key: 'container-reply', reply_to: sent.id, body: challenge });
  const returned = (await tool(a, 'list_messages')).items.find(x => x.id === reply.id);
  assert(returned?.body === challenge && returned.reply_to === sent.id && returned.sender === 'cursor', 'Container reply missing');
  const secondAck = await ack(a, b, reply);
  await tool(a, 'put_memory', { name: 'container-proof', expected_revision: 0, body: challenge });
  const initial = await tool(b, 'get_memory', { name: 'container-proof' });
  assert(initial.body === challenge && initial.revision === 1, 'Initial container memory mismatch');
  await tool(b, 'put_memory', { name: 'container-proof', expected_revision: initial.revision, body: 'retained:' + challenge });
  const activity = await tool(b, 'publish_activity', { key: 'container-activity', kind: 'file', summary: 'Container activity persists across restart.', paths: ['src/example.js'] });
  assert((await tool(a, 'list_activity')).items[0]?.id === activity.id, 'Container activity was not shared');
  const finalMemory = await tool(a, 'get_memory', { name: 'container-proof' });
  assert(finalMemory.revision === 2 && finalMemory.body === 'retained:' + challenge, 'Container CAS update mismatch');
  const conflict = await bounded(() => a.callTool({ name: 'cursodex_put_memory',
    arguments: { name: 'container-proof', expected_revision: 1, body: 'stale' } }, undefined, options()));
  assert(conflict.isError && conflict.structuredContent?.error?.code === 'REVISION_CONFLICT', 'Container stale CAS was accepted');
  assert((await tool(b, 'get_memory', { name: 'container-proof' })).body === finalMemory.body, 'Rejected container CAS changed retained state');
  await closeClients();
  const firstStop = await stop();
  await docker(['start', container]);
  base = await destination(); await ready(base);
  const reopened = await connect(base, 'codex'), peer = await connect(base, 'cursor');
  const reopenedStatuses = await Promise.all([tool(reopened, 'status'), tool(peer, 'status')]);
  assert(reopenedStatuses[0].agent === 'codex' && reopenedStatuses[1].agent === 'cursor' &&
    reopenedStatuses.every(x => x.project_root === '/workspace' && x.runtime?.package_version === pkg.version), 'Restarted container identity mismatch');
  const recoveredActivity = (await tool(reopened, 'list_activity')).items.find(x => x.id === activity.id);
  assert(recoveredActivity?.summary === activity.summary && recoveredActivity.actor === 'cursor', 'Restart lost shared activity');
  const recoveredMemory = await tool(reopened, 'get_memory', { name: 'container-proof' });
  assert(recoveredMemory.body === finalMemory.body && recoveredMemory.revision === finalMemory.revision, 'Memory did not persist across restart');
  const oldMessage = (await tool(reopened, 'list_messages', { direction: 'sent', after: sent.id - 1, limit: 1 })).items[0];
  assert(oldMessage?.id === sent.id && oldMessage.body === challenge && oldMessage.ack_at === firstAck.ack_at, 'Acknowledged message did not persist');
  const oldReply = (await tool(peer, 'list_messages', { direction: 'sent', after: reply.id - 1, limit: 1 })).items[0];
  assert(oldReply?.id === reply.id && oldReply.reply_to === sent.id && oldReply.ack_at === secondAck.ack_at, 'Acknowledged reply did not persist');
  await closeClients();
  const finalStop = await stop();
  proof = { version: pkg.version, imageId: built.Id, dockerfileSha256, lockSha256, node: process.version,
    tools: 19, actors: statuses.map(x => x.agent), acknowledgements: [firstAck, secondAck], memoryCas: true, activitySharedAndRetained: true,
    persistenceAfterRestart: true, unauthenticatedRequestRefused: true, firstStop, finalStop,
    actualAIHosts: false, externalDeployment: false, containerOnlyLoopback: true };
} catch (error) { failure = error; }
finally {
  clearTimeout(workTimer); controller.abort();
  const cleanupErrors = [];
  let commandsReaped = false, finalAbsenceVerified = false;
  // Abort and observe every pending work child closed BEFORE reconciling any Docker object.
  try { await reapPendingCommands(); commandsReaped = true; }
  catch (error) { cleanupErrors.push(error.message); }
  try { await closeClients(); } catch (error) { cleanupErrors.push(error.message); }
  // Reconcile partial Docker writes by their unique names AND labels; never remove unrelated objects.
  if (commandsReaped) for (const [kind, name] of [['container', container], ['volume', volume], ['image', image]]) {
    try {
      let data;
      try { data = await inspect(kind, name, true); }
      catch { continue; } // A failed inspect is unverified, not absence; successful removal is checked below.
      assert((data.Config?.Labels ?? data.Labels)?.[label] === identity, 'Refusing cleanup of unrelated Docker object');
      if (kind === 'container') {
        if (data.State.Running) { try { await stop(true); } catch (e) { cleanupErrors.push(e.message); } }
        await docker(['container', 'rm', '--force', name], 15000, true);
      } else await docker([kind, 'rm', name], 10000, true);
    } catch (error) { cleanupErrors.push(error.message); }
  }
  // Cleanup commands may themselves have timed out. Settle those children before the final proof.
  try {
    await reapPendingCommands();
    assert(commandsReaped, 'Pending work prevented object reconciliation');
    // Each successful listing also awaits its actual command close. There is no later mutating command.
    for (const args of [['container', 'ls', '--all', '--filter', 'label=' + label + '=' + identity, '--quiet'],
      ['volume', 'ls', '--filter', 'label=' + label + '=' + identity, '--quiet'],
      ['image', 'ls', '--filter', 'label=' + label + '=' + identity, '--quiet']])
      assert((await docker(args, 10000, true)) === '', 'Owned Docker object remains');
    assert(children.size === 0, 'Docker listing child remains');
    finalAbsenceVerified = true;
  } catch (error) {
    // A failed listing is not an absence proof. Reaping after failure leaves this flag false.
    cleanupErrors.push(error.message);
    try { await reapPendingCommands(); } catch (e) { cleanupErrors.push(e.message); }
  }
  const uncertainMutations = commands.filter(x => x.uncertainMutation).map(x => ({ operation: x.operation,
    pid: x.pid, cleanup: x.cleanup, closeEventObserved: x.closed, code: x.code, signal: x.signal }));
  if (uncertainMutations.length) cleanupErrors.push('Daemon-side completion of a failed or cancelled Docker mutation is unverified');
  try {
    if (root) {
      await bounded(() => fs.rm(root, { recursive: true, force: true }), 5000, true);
      try { await fs.lstat(root); throw Error('Private owned temporary directory remains'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { cleanupErrors.push(error.message); }
  if (cleanupErrors.length) failure ??= Error('Container cleanup failed');
  const receipt = { ...proof, success: !failure,
    cleanupVerified: cleanupErrors.length === 0 && commandsReaped && finalAbsenceVerified && children.size === 0 && uncertainMutations.length === 0,
    commandsReapedBeforeObjectCleanup: commandsReaped, finalAbsenceVerified, uncertainMutations,
    commandChildren: commands.map(x => ({ operation: x.operation, pid: x.pid, cleanup: x.cleanup,
      mutating: x.mutating, completed: x.completed, closeEventObserved: x.closed, code: x.code, signal: x.signal })),
    cleanupErrors, connectionsClosed: connections.every(x => x.closed), totalBudgetMs: totalMs,
    elapsedMs: Date.now() - started, created: { container: containerCreated, volume: volumeCreated, image: imageCreated },
    ...(failure ? { error: String(failure.message).replaceAll(tokens.codex, '[redacted]').replaceAll(tokens.cursor, '[redacted]').slice(0, 600) } : {}) };
  try {
    const rendered = JSON.stringify(receipt, null, 2).replaceAll(tokens.codex, '[redacted]').replaceAll(tokens.cursor, '[redacted]');
    await bounded(async () => { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, rendered + '\n'); }, 3000, true);
    console.log(rendered);
  } catch { failure ??= Error('Container receipt write failed'); }
  clearTimeout(hardTimer);
}
if (failure) process.exitCode = 1;
