# Cloud deployment

Cursodex can run on a Linux VM or container service that supports a single long-lived Node process and a persistent local filesystem. The package does not provision a hosting account. SQLite is not suitable for a horizontally scaled multi-instance service or a network filesystem. Serverless/edge runtimes without Node's SQLite and durable local storage need a separate backend; this release does not claim that support.

## Docker Compose

From a checkout of this repository:

```sh
cp .env.example .env
```

Generate **two different** random credentials using this command twice, then put the values in the corresponding entries of your private `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `CURSODEX_ALLOWED_HOSTS=localhost,127.0.0.1,cursodex.example.com`, substituting your actual DNS name. Tokens must be 32–512 printable non-space ASCII bytes. An API key for an AI provider is unnecessary and should not be used as a bridge credential. Keep `.env` private; it is excluded from both Git and the Docker build context.

```sh
docker compose up --build -d
docker compose ps
```

The Compose service binds the host port to **127.0.0.1:8787**, runs as the unprivileged Node user and keeps state in the `cursodex-data` volume mounted at `/workspace`. The container root filesystem is read-only. Do not change its project path after creating state; state is bound to the canonical project root. A Docker build and Compose deployment still need to be verified on your own Docker host.

Do not use `docker compose down --volumes` on a deployment with retained work. To stop the service while retaining state, use `docker compose stop`.

## HTTPS reverse proxy

Point your DNS name at the server and place an HTTPS reverse proxy in front of the private port. For example, a host-installed Caddy reverse proxy can use:

```caddyfile
cursodex.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Preserve `Host`, `Authorization`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and the request body. Allow POST and DELETE at `/mcp` and a timeout longer than the tool's maximum 20-second event wait. Keep the internal HTTP port inaccessible from the public network. If your proxy is in a separate container, use a private Docker network and its internal service address rather than the example loopback address; do not expose an unauthenticated public port.

The server explicitly checks Host and browser Origin. The public hostname must be in `CURSODEX_ALLOWED_HOSTS`, without a scheme or port. Keep `127.0.0.1` in that list for the local container healthcheck. `CURSODEX_ALLOWED_ORIGINS` is an optional comma-separated list of complete origins for an explicitly authorized browser client. It does not add permissive CORS behavior; ordinary Codex/Cursor clients do not need a browser origin.

Configure both hosts against `https://cursodex.example.com/mcp` with their separate credentials as shown in [Getting started](GETTING_STARTED.md#cloud-mode). The credential fixes the actor for the entire session. The Cursor token cannot access a Codex session, and a tool cannot override its actor. Possession of a role credential grants that role; this is not OAuth or proof of a user's Codex/Cursor account.

## Limits and recovery

The HTTP process allows at most 16 active/initializing sessions and 32 in-flight requests. Idle sessions expire after 30 minutes; clients initialize a new session when needed. POST bodies are limited to 65,536 bytes and malformed UTF-8 is rejected. Event waits last at most 20 seconds. The transport uses JSON responses and refuses standalone GET event streams; clients read the persistent event log through bounded tools.

When a validated cancellation targets an outstanding request, or a client disconnects before its response completes, the server retires that affected transport session and closes its pending exchanges. This releases request/session capacity and prevents abandoned SDK response correlations from accumulating. Initialize a fresh MCP session before continuing; same-session continuation after such an interruption is not promised. Cancellation and DELETE control responses retain their normal transport status, and no fabricated JSON-RPC tool result is supplied for an abandoned request. A lost response may still have committed a durable write: reconcile the exact message key or current task/note revision before retrying.

After restarting the service, transport sessions are new while SQLite messages, tasks, notes, claims and events remain. Always reread task/note revisions and reconcile live claims. An uncertain response may have committed a write: use the same exact message key for retries or reread a CAS record before modifying it.

Back up the complete `.cursodex` directory while the service is stopped. Retain WAL/SHM files if present; do not take an arbitrary live file copy or move state to a different project root. Rotate both environment credentials through the service and host lifecycle if exposed. Stop the service before maintaining its state. Never include private messages, credentials or database contents in a public issue.


## Named agents and live work activity (0.2.0)

`--agent` accepts distinct lowercase names such as `claude` or `research-1`; identity is fixed when the stdio server starts. For cloud use, `CURSODEX_AGENT_TOKENS` is a JSON object mapping 2–64 agent names to distinct 32–512 byte non-space ASCII credentials. The existing `CURSODEX_CODEX_TOKEN` and `CURSODEX_CURSOR_TOKEN` pair remains supported when that map is absent. Never put a credential in a tool argument, shared note or terminal feed. See [Live collaboration](LIVE_COLLABORATION.md) for the 19-tool protocol, finite `watch`, opt-in Cursor stream/hook connectors and their acceptance boundaries.
