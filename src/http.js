import { createServer as httpServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { Store } from './store.js';

const MAX_BODY = 65536, MAX_SESSIONS = 16, MAX_INFLIGHT = 32, IDLE_MS = 1800000;
const digest = value => createHash('sha256').update(value).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const json = (res, status, error) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error }));
};
function credentials(env) {
  const codex = env.CURSODEX_CODEX_TOKEN, cursor = env.CURSODEX_CURSOR_TOKEN;
  const valid = value => typeof value === 'string' && /^[!-~]{32,512}$/.test(value);
  if (!valid(codex) || !valid(cursor) || same(codex, cursor))
    throw Error('Set distinct CURSODEX_CODEX_TOKEN and CURSODEX_CURSOR_TOKEN credentials of 32–512 printable non-space ASCII bytes.');
  return { codex, cursor };
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
  const origins = new Set((env.CURSODEX_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean));
  const configuredHosts = (env.CURSODEX_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const hostnames = new Set((configuredHosts.length ? configuredHosts : ['localhost', '127.0.0.1', '[::1]']).map(h => h.toLowerCase()));
  async function closeSession(record) {
    if (record.closed) return;
    record.closed = true;
    records.delete(record);
    if (record.transport.sessionId) sessions.delete(record.transport.sessionId);
    try { await record.mcp.close(); } finally { record.store.close(); }
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
        for (const name of ['codex', 'cursor']) if (same(supplied, tokens[name])) actor = name;
      }
      if (!actor) { res.setHeader('WWW-Authenticate', 'Bearer realm="Cursodex"'); return json(res, 401, 'Bearer credential required.'); }
      if (closing) return json(res, 503, 'Server is shutting down.');
      if (!['POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'POST, DELETE'); return json(res, 405, 'Use MCP POST or DELETE.'); }
      if (inflight >= MAX_INFLIGHT) return json(res, 429, 'Request capacity reached.');
      inflight++;
      try {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) return json(res, 400, 'Invalid session.');
        let record = sessionId ? sessions.get(sessionId) : null;
        if (sessionId && !record) return json(res, 404, 'Session expired or unknown; initialize again.');
        if (record && record.actor !== actor) return json(res, 403, 'Session belongs to another actor.');
        const parsed = req.method === 'POST' ? await body(req, res) : undefined;
        if (req.method === 'POST' && parsed === null) return;
        if (closing || record?.closed) return json(res, 503, 'Server is shutting down.');
        if (!record) {
          if (req.method !== 'POST' || !isInitializeRequest(parsed)) return json(res, 400, 'Initialize an MCP session first.');
          if (records.size >= MAX_SESSIONS) return json(res, 429, 'Session capacity reached.');
          const store = new Store(projectRoot, actor);
          const mcp = createServer(store);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
          record = { actor, store, mcp, transport, updatedAt: Date.now(), busy: 0, closed: false };
          records.add(record);
          try { await mcp.connect(transport); }
          catch (error) { records.delete(record); store.close(); throw error; }
          mcp.server.onclose = () => { void closeSession(record); };
          if (closing || record.closed) { await closeSession(record); return json(res, 503, 'Server is shutting down.'); }
          record.busy++;
          try {
            await transport.handleRequest(req, res, parsed);
            if (!record.closed && transport.sessionId) sessions.set(transport.sessionId, record);
            else await closeSession(record);
          } catch (error) { await closeSession(record); throw error; }
          finally { record.busy--; }
        } else {
          record.updatedAt = Date.now(); record.busy++;
          try { await record.transport.handleRequest(req, res, parsed); }
          finally { record.busy--; if (req.method === 'DELETE') await closeSession(record); }
        }
      } finally { inflight--; }
    } catch { json(res, 500, 'Request failed; retain state and review server health.'); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  server.keepAliveTimeout = 5000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const record of sessions.values()) if (!record.busy && now - record.updatedAt >= IDLE_MS) void closeSession(record);
  }, 60000).unref();
  let shutdown;
  const close = () => {
    if (shutdown) return shutdown;
    closing = true;
    clearInterval(sweep);
    if (signalHandlers) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
    shutdown = (async () => {
      // Abort active waits through the MCP transport before closing their DB connection.
      await Promise.allSettled([...records].map(closeSession));
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
