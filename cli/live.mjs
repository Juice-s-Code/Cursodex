import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_VERSION } from '../src/runtime.js';
import { isValidActorSlug } from '../src/identity.js';

const MAX_FRAME = 65536;
/** Parse only a deliberately supplied stream. Never open a transcript or inspect another process. */
export async function* frames(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of input) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) throw Error('Input frame exceeds 65536 bytes.');
      if (line.trim()) yield JSON.parse(line);
    }
    if (Buffer.byteLength(pending) > MAX_FRAME) throw Error('Input frame exceeds 65536 bytes.');
  }
  pending += decoder.decode();
  if (Buffer.byteLength(pending) > MAX_FRAME) throw Error('Input frame exceeds 65536 bytes.');
  if (pending.trim()) yield JSON.parse(pending);
}
function relativeFile(value, project) {
  if (typeof value !== 'string' || !value) return null;
  const name = path.isAbsolute(value) ? path.relative(project, value) : value;
  const portable = name.split(path.sep).join('/');
  if (!portable || /^[A-Za-z]:/.test(portable) || portable.startsWith('/') || portable.includes('\\') || /[\x00-\x1f\x7f]/.test(portable) || portable.split('/').some(x => !x || x === '.' || x === '..')) return null;
  return portable;
}
/** Deliberately allowlist metadata: ignore prompts, output, command arguments and thinking. */
export function normalizeActivity(record, source, project) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('Activity input must be a JSON object.');
  if (source === 'json') {
    const allowed = ['key', 'kind', 'summary', 'paths', 'evidence', 'task_id', 'process'];
    if (Object.keys(record).some(k => !allowed.includes(k))) throw Error('Explicit JSON activity has unknown fields.');
    return { ...record };
  }
  const base = { paths: [], evidence: '', task_id: null, process: null };
  if (source === 'cursor-hook') {
    switch (record.hook_event_name) {
      case 'afterFileEdit': {
        const file = relativeFile(record.file_path, project);
        return { ...base, kind: 'file', summary: 'Cursor reported a file edit.', paths: file ? [file] : [] };
      }
      case 'afterShellExecution': return { ...base, kind: 'process', summary: 'Cursor reported a completed shell command (command and output omitted).' };
      case 'sessionStart': return { ...base, kind: 'checkpoint', summary: 'Cursor reported session start.' };
      case 'sessionEnd': return { ...base, kind: 'checkpoint', summary: 'Cursor reported session end.' };
      case 'afterAgentResponse': return { ...base, kind: 'progress', summary: 'Cursor published an assistant response (text omitted).' };
      default: return null;
    }
  }
  if (record.type === 'system' && record.subtype === 'init')
    return { ...base, kind: 'checkpoint', summary: 'Cursor structured terminal stream started.' };
  if (record.type === 'result')
    return { ...base, kind: 'checkpoint', summary: record.is_error === true ? 'Cursor reported a failed terminal result.' : 'Cursor reported a terminal result.' };
  if (record.type !== 'tool_call' || !['started', 'completed'].includes(record.subtype)) return null;
  const call = record.tool_call;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  // Tool labels are a known constant, never a tool-supplied arbitrary name/command.
  const write = call.writeToolCall, read = call.readToolCall;
  const file = relativeFile(write?.args?.path ?? read?.args?.path, project);
  return { ...base, kind: write ? 'file' : 'progress',
    summary: 'Cursor terminal ' + (write ? 'file write' : read ? 'file read' : 'tool call') + ' ' + record.subtype + '.',
    paths: file ? [file] : [] };
}
export function parseLiveArguments(command, argv) {
  const options = new Map(), allowed = ['--agent', '--project', '--duration-ms', ...(command === 'watch' ? ['--after'] : ['--source'])];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (!allowed.includes(flag) || options.has(flag) || !value || value.startsWith('--')) throw Error('Invalid or duplicate live option: ' + flag);
    options.set(flag, value);
  }
  const actor = options.get('--agent'), project = options.get('--project');
  if (!isValidActorSlug(actor) || !project || !path.isAbsolute(project)) throw Error('Live commands require --agent NAME and --project ABS.');
  if (!fs.statSync(project).isDirectory()) throw Error('Project must be an existing directory.');
  const number = (name, fallback, max) => {
    const raw = options.get(name);
    if (raw === undefined) return fallback;
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw Error('Invalid ' + name);
    return Number(raw);
  };
  const durationMs = number('--duration-ms', 60000, 86400000);
  if (durationMs < 100) throw Error('--duration-ms must be 100–86400000.');
  const source = options.get('--source');
  if (command === 'bridge' && !['cursor-stream', 'cursor-hook', 'json'].includes(source)) throw Error('Choose --source cursor-stream, cursor-hook or json.');
  return { actor, projectRoot: fs.realpathSync(project), durationMs, after: number('--after', 0, Number.MAX_SAFE_INTEGER), source };
}
async function session(options, work, signal, transportFactory) {
  const client = new Client({ name: 'cursodex-live-client', version: PACKAGE_VERSION });
  const transport = transportFactory ? transportFactory() : new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], cwd: options.projectRoot,
    env: { ...process.env, PROJECT_ROOT: options.projectRoot, CURSODEX_AGENT: options.actor }, stderr: 'pipe' });
  // Do not stream unrelated child diagnostics into the activity channel.
  transport.stderr?.on('data', () => {});
  // Every close path (abort, SDK/client, finally) joins the same operation.
  // The SDK clears its child reference before awaiting exit; a concurrent
  // second close otherwise returns while the first child still owns its cwd.
  let closing, cleanupFailure, closeObserved = false, markClosed;
  const closed = new Promise(resolve => { markClosed = resolve; });
  const previousOnClose = transport.onclose;
  transport.onclose = () => { closeObserved = true; markClosed(); previousOnClose?.(); };
  const rawClose = transport.close.bind(transport);
  transport.close = () => closing ??= Promise.resolve().then(async () => {
    const childWasStarted = transport.pid !== null && transport.pid !== undefined;
    try {
      await rawClose();
      if (childWasStarted && !closeObserved) {
        let timer;
        try {
          await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('SDK child close was not observed.')), 3000);
          })]);
        } finally { clearTimeout(timer); }
      }
    } catch (cause) {
      const error = new Error('Live MCP cleanup failed.', { cause });
      // SDK initialization calls close() without awaiting its rejection.
      // Keep close joinable/resolved for the SDK, then surface the captured
      // failure from our awaited session cleanup below.
      error.code = 'CLEANUP_FAILED'; cleanupFailure = error;
    }
  });
  const closeOnAbort = () => { void transport.close().catch(() => {}); };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name: 'cursodex_' + name, arguments: args }, undefined, { signal, timeout: 30000 });
    if (result.isError || result.structuredContent?.ok !== true) throw Error('Cursodex ' + name + ' failed: ' + (result.structuredContent?.error?.code ?? 'INVALID_RESPONSE'));
    return result.structuredContent.data;
  };
  try {
    await client.connect(transport, { signal, timeout: Math.min(30000, options.durationMs) });
    const status = await call('status');
    if (status.agent !== options.actor || status.project_root !== options.projectRoot) throw Error('Live identity/project mismatch.');
    return await work(call, status);
  } finally { signal.removeEventListener('abort', closeOnAbort); try { await client.close(); } finally { await transport.close(); if (cleanupFailure) throw cleanupFailure; } }
}
export async function runLive(command, options, { input = process.stdin, emit = value => process.stdout.write(JSON.stringify(value) + '\n'), signal, transportFactory } = {}) {
  const controller = new AbortController(), started = performance.now();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.durationMs);
  let stop;
  const stopped = new Promise(resolve => { stop = () => resolve(); controller.signal.addEventListener('abort', stop, { once: true }); if (controller.signal.aborted) stop(); });
  try {
    const work = session(options, async (call, status) => {
      emit({ type: 'connected', agent: status.agent, project_root: status.project_root, latest_event: status.latest_event });
      if (command === 'bridge') {
        let sequence = 0; const stream = randomUUID();
        for await (const raw of frames(input)) {
          if (controller.signal.aborted) break;
          const event = normalizeActivity(raw, options.source, options.projectRoot);
          if (!event) continue;
          const data = await call('publish_activity', { ...event, key: event.key ?? ('bridge-' + stream + '-' + (++sequence)) });
          emit({ type: 'published', activity: data });
        }
      } else {
        let after = options.after;
        while (!controller.signal.aborted) {
          const page = await call('wait_events', { after, limit: 10, wait_ms: Math.min(20000, Math.max(0, Math.floor(options.durationMs - (performance.now() - started)))) });
          for (const event of page.items) {
            emit({ type: 'event', event }); after = event.id;
            if (event.kind === 'activity.published') {
              const p = await call('list_activity', { after: event.entity_id - 1, limit: 1 });
              if (p.items[0]?.id === event.entity_id) emit({ type: 'activity', activity: p.items[0] });
            } else if (event.kind === 'message.sent') {
              const p = await call('list_messages', { direction: 'inbox', after: event.entity_id - 1, limit: 1 });
              if (p.items[0]?.id === event.entity_id) emit({ type: 'message', message: p.items[0] });
            } else if (event.kind === 'task.created' || event.kind === 'task.updated') {
              emit({ type: 'task', task: await call('get_task', { id: event.entity_id }) });
            }
          }
        }
      }
    }, controller.signal, transportFactory);
    // Attach immediately: cancellation/closed input may reject after the deadline wins.
    await Promise.race([work, stopped]);
    if (controller.signal.aborted && command === 'bridge') input.destroy();
    await work.catch(error => { if (!controller.signal.aborted || error.code === 'CLEANUP_FAILED') throw error; });
    return { stopped: controller.signal.aborted, durationReached: timedOut };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', stop);
  }
}
export async function main(command, argv) {
  const options = parseLiveArguments(command, argv), controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runLive(command, options, { signal: controller.signal, ...(options.source === 'cursor-hook' ? { emit: () => {} } : {}) });
    if (options.source === 'cursor-hook') process.stdout.write('{}\n');
    return result;
  }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
