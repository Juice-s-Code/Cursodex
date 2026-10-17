import { createServer as httpServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CancelledNotificationSchema, isInitializeRequest, isJSONRPCNotification, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { Store } from './store.js';
import { isValidActorSlug } from './identity.js';

const MAX_BODY = 65536, MAX_SESSIONS = 16, MAX_INFLIGHT = 32, IDLE_MS = 1800000;
const digest = value => createHash('sha256').update(value).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const json = (res, status, error) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error }));
};
export function credentials(env) {
  const valid = value => typeof value === 'string' && /^[!-~]{32,512}$/.test(value);
  let configured;
  if (env.CURSODEX_AGENT_TOKENS !== undefined) {
    if (typeof env.CURSODEX_AGENT_TOKENS !== 'string' || Buffer.byteLength(env.CURSODEX_AGENT_TOKENS) > 65536)
      throw Error('CURSODEX_AGENT_TOKENS must be a bounded JSON object.');
    try { configured = JSON.parse(env.CURSODEX_AGENT_TOKENS); } catch { throw Error('CURSODEX_AGENT_TOKENS must be valid JSON.'); }
    if (!configured || Array.isArray(configured) || typeof configured !== 'object')
      throw Error('CURSODEX_AGENT_TOKENS must map agent names to distinct credentials.');
  } else configured = { codex: env.CURSODEX_CODEX_TOKEN, cursor: env.CURSODEX_CURSOR_TOKEN };
  const entries = Object.entries(configured);
  if (entries.length < 2 || entries.length > 64 || entries.some(([name, token]) => !isValidActorSlug(name) || !valid(token)))
    throw Error('Set distinct CURSODEX_CODEX_TOKEN and CURSODEX_CURSOR_TOKEN credentials or CURSODEX_AGENT_TOKENS with 2–64 agent names and 32–512 printable non-space ASCII byte credentials.');
  for (let i = 0; i < entries.length; i++) for (let j = 0; j < i; j++)
    if (same(entries[i][1], entries[j][1])) throw Error('Agent credentials must be distinct.');
  return Object.fromEntries(entries);
}
async function body(req, res) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY) { json(res, 413, 'Request exceeds 65536 bytes.'); req.resume(); return null; }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) { json(res, 413, 'Request exceeds 65536 bytes.'); req.resume(); return null; }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (parsed === null) { json(res, 400, 'Body must be a JSON-RPC object.'); return null; }
    return parsed;
  }
  catch { json(res, 400, 'Body must be valid UTF-8 JSON.'); return null; }
}

/** Single project, single SQLite instance. Credentials determine actor before MCP dispatch. */
export async function startCloud({ projectRoot, host = '127.0.0.1', port = 8787, env = process.env, log = true, signalHandlers = true } = {}) {
  if (typeof host !== 'string' || !host || host.length > 253 || !Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('Invalid cloud bind host or port.');
  const tokens = credentials(env);
  process.umask(0o077);
  // Validate/open the durable project before binding; do not infer identity from a request.
  const probe = new Store(projectRoot, 'codex'); probe.close();
  const sessions = new Map(), records = new Set(); let inflight = 0, closing = false;
  const dispatchContext = new AsyncLocalStorage();
  const origins = new Set((env.CURSODEX_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean));
  const configuredHosts = (env.CURSODEX_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const hostnames = new Set((configuredHosts.length ? configuredHosts : ['localhost', '127.0.0.1', '[::1]']).map(h => h.toLowerCase()));
  const cleanupFailure = () => {
    process.exitCode = 1;
    if (log) process.stderr.write('Cursodex session cleanup failed; retain state and review server health.\n');
  };
  async function closeSession(record, preserveResponse = null) {
    if (record.closed) return;
    record.closed = true;
    records.delete(record);
    if (record.transport.sessionId) sessions.delete(record.transport.sessionId);
    // SDK JSON-response promises do not settle on cancellation/transport close.
    // End the actual outstanding responses before dropping their session state.
    for (const exchange of record.exchanges) if (exchange !== preserveResponse) exchange.end(503);
    try { await record.mcp.close(); } finally { record.store.close(); }
  }
  function beginExchange(req, res) {
    let resolveEnded;
    const exchange = { record: null, ids: [], method: req.method, settled: false,
      ended: new Promise(resolve => { resolveEnded = resolve; }),
      end(status) {
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        if (status === 202) { res.writeHead(202); res.end(); }
        else json(res, status, 'MCP session closed; initialize a new session.');
      } };
    const settle = () => {
      if (exchange.settled) return;
      exchange.settled = true;
      inflight--;
      res.removeListener('finish', settle); res.removeListener('close', onClose);
      const record = exchange.record;
      if (record) {
        record.busy--; record.exchanges.delete(exchange);
        for (const id of exchange.ids) {
          const owners = record.requests.get(id);
          owners?.delete(exchange);
          if (owners?.size === 0) record.requests.delete(id);
        }
      }
      resolveEnded();
    };
    const onClose = () => {
      const unfinished = !res.writableFinished, record = exchange.record;
      settle();
      // A disconnected pending call must not retain SDK JSON stream mappings.
      if (unfinished && record && !record.closed) void closeSession(record).catch(cleanupFailure);
    };
    inflight++;
    res.once('finish', settle); res.once('close', onClose);
    return exchange;
  }
  async function dispatch(record, exchange, req, res, parsed) {
    if (exchange.settled) return;
    exchange.record = record; record.busy++; record.exchanges.add(exchange);
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isJSONRPCRequest(message) || message.method === 'initialize') continue;
      exchange.ids.push(message.id);
      if (!record.requests.has(message.id)) record.requests.set(message.id, new Set());
      record.requests.get(message.id).add(exchange);
    }
    // The HTTP lifecycle, not an unresolved SDK promise, owns admission/busy slots.
    await Promise.race([dispatchContext.run(exchange, () => record.transport.handleRequest(req, res, parsed)), exchange.ended]);
  }
  function ownCancellation(record) {
    const receive = record.transport.onmessage;
    record.transport.onmessage = (message, extra) => {
      receive?.(message, extra);
      if (!isJSONRPCNotification(message)) return;
      const cancellation = CancelledNotificationSchema.safeParse(message);
      if (!cancellation.success || cancellation.data.params.requestId === undefined) return;
      const targets = [...(record.requests.get(cancellation.data.params.requestId) ?? [])].filter(exchange => !exchange.settled);
      if (!targets.length) return; // late/unknown cancellation must not retire a usable session
      for (const target of targets) target.end(202); // no fabricated JSON-RPC result
      const control = dispatchContext.getStore();
      // Let the genuine SDK acknowledge this validated control POST before closing.
      // A batch that cancels itself also ends above, so it cannot retain this promise.
      void (control?.record === record ? control.ended : Promise.resolve()).then(() => closeSession(record)).catch(cleanupFailure);
    };
  }
  const server = httpServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // Check Host independently of proxies; configure the public DNS name explicitly.
      const rawHost = req.headers.host ?? '';
      const hostname = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost.split(':')[0];
      if (!hostnames.has(hostname.toLowerCase())) return json(res, 403, 'Host is not allowed.');
      if (req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, 'Origin is not allowed.');
      if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      if (req.url !== '/mcp') return json(res, 404, 'Not found.');
      const auth = req.headers.authorization;
      let actor;
      if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length <= 519) {
        const supplied = auth.slice(7);
        for (const name of Object.keys(tokens)) if (same(supplied, tokens[name])) actor = name;
      }
      if (!actor) { res.setHeader('WWW-Authenticate', 'Bearer realm="Cursodex"'); return json(res, 401, 'Bearer credential required.'); }
      if (closing) return json(res, 503, 'Server is shutting down.');
      if (!['POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'POST, DELETE'); return json(res, 405, 'Use MCP POST or DELETE.'); }
      if (inflight >= MAX_INFLIGHT) return json(res, 429, 'Request capacity reached.');
      const exchange = beginExchange(req, res);
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) return json(res, 400, 'Invalid session.');
      let record = sessionId ? sessions.get(sessionId) : null;
      if (sessionId && !record) return json(res, 404, 'Session expired or unknown; initialize again.');
      if (record && record.actor !== actor) return json(res, 403, 'Session belongs to another actor.');
      const parsed = req.method === 'POST' ? await body(req, res) : undefined;
      if (req.method === 'POST' && parsed === null) return;
      if (exchange.settled) return;
      if (closing || record?.closed) return json(res, 503, 'Server is shutting down.');
      if (!record) {
        if (req.method !== 'POST' || !isInitializeRequest(parsed)) return json(res, 400, 'Initialize an MCP session first.');
        if (records.size >= MAX_SESSIONS) return json(res, 429, 'Session capacity reached.');
        const store = new Store(projectRoot, actor);
        const mcp = createServer(store);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
        record = { actor, store, mcp, transport, updatedAt: Date.now(), busy: 0, closed: false, exchanges: new Set(), requests: new Map() };
        records.add(record);
        try { await mcp.connect(transport); }
        catch (error) { records.delete(record); store.close(); throw error; }
        ownCancellation(record);
        mcp.server.onclose = () => {
          const current = dispatchContext.getStore();
          // DELETE must keep its own genuine SDK response while other calls close.
          void closeSession(record, current?.record === record && current.method === 'DELETE' ? current : null).catch(cleanupFailure);
        };
        if (closing || record.closed) { await closeSession(record); return json(res, 503, 'Server is shutting down.'); }
        try {
          await dispatch(record, exchange, req, res, parsed);
          if (!record.closed && transport.sessionId) sessions.set(transport.sessionId, record);
          else await closeSession(record);
        } catch (error) { await closeSession(record); throw error; }
      } else {
        record.updatedAt = Date.now();
        try { await dispatch(record, exchange, req, res, parsed); }
        finally { if (req.method === 'DELETE') await closeSession(record, exchange); }
      }
    } catch { json(res, 500, 'Request failed; retain state and review server health.'); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  server.keepAliveTimeout = 5000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const record of sessions.values()) if (!record.busy && now - record.updatedAt >= IDLE_MS) void closeSession(record).catch(cleanupFailure);
  }, 60000).unref();
  let shutdown;
  const close = () => {
    if (shutdown) return shutdown;
    closing = true;
    clearInterval(sweep);
    if (signalHandlers) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
    shutdown = (async () => {
      // Abort active waits through the MCP transport before closing their DB connection.
      await Promise.allSettled([...records].map(record => closeSession(record)));
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    })();
    return shutdown;
  };
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  if (signalHandlers) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { clearInterval(sweep); if (signalHandlers) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); } throw error; }
  const address = server.address();
  if (log) process.stderr.write('Cursodex cloud listening on port ' + address.port + '; actor credentials required.\n');
  return { server, address, close };
}
