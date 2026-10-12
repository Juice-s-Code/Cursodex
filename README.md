# Cursodex

Cursodex is an open-source MCP bridge that lets active Codex and Cursor sessions share project knowledge, exchange messages, share tasks and coordinate file ownership inside one project. Local mode gives each host a small stdio server sharing a transactional SQLite store. Optional authenticated Streamable HTTP mode serves the same coordination tools from one shared endpoint. Cursodex does not run models, edit your files or wake an idle agent.

## Get started

Use Node.js 22.13 or later within Node 22, or Node 24, with npm available. Open a terminal in the project both hosts will use, then run:

~~~sh
npx --yes --package=github:Juice-s-Code/Cursodex cursodex setup --project "$PWD"
~~~

Setup creates project-local MCP entries for Codex and Cursor and a durable runtime snapshot under .cursodex/runtime. The generated entries use an absolute Node executable and the snapshot, so hosts do not depend on a temporary npx cache. Existing unrelated MCP entries are preserved. Changed configuration files receive backups; conflicting cursodex entries require an explicit --force choice.

Reload both hosts through their supported MCP lifecycle. Open the same project in each; launch terminal-based Cursor from that project's directory. Confirm cursodex_status in each host and complete the unique message/reply/ack check in [Getting started](docs/GETTING_STARTED.md). A setup success or a terminal protocol-client result does not prove that both AI hosts loaded the tools.

## What it provides

- Seventeen tools for actor/project status, durable messages, acknowledgements, tasks, shared memory notes, advisory claims and event reads/waits.
- Two resources: cursodex://context and cursodex://protocol.
- One prompt: cursodex-handoff, for a visible factual handoff.
- SQLite transactions that commit each mutation with its event; exact retry keys and task revision checks preserve uncertainty after a lost response.
- Project-scoped path claims with owner tokens, expiry and ancestor/descendant conflict checks.
- UTF-8/input/response/page limits and request-scoped waits. There is no permanent polling controller; local stdio needs no network listener.

## One shared brain

Both actors use one project-scoped namespace of durable named memory notes. Write visible project facts, decisions, agreements and current handoffs there so the next active session can read the same context. Notes use revision comparison: create with expected_revision=0, then read the current note before each update. A stale revision fails instead of silently replacing the other actor's work.

This shared brain is explicit stored knowledge, not merged model internals or continuous awareness. Use [the agent protocol](docs/AGENT_PROTOCOL.md) to combine notes, task revisions and acknowledged messages during active authorized work.

## Commands

~~~sh
cursodex --help
cursodex --version
cursodex setup --project /absolute/path/to/project --dry-run
cursodex server --agent codex --project /absolute/path/to/project
cursodex cloud --project /absolute/path/to/state-project --host 127.0.0.1 --port 8787
~~~

These commands are available through the package bin. For one-off use, prepend the npx --yes --package=github:Juice-s-Code/Cursodex prefix. The server command speaks MCP on stdio and is normally launched by your host; it is not a separate background service to start alongside the host entry. There are no doctor, status or message CLI subcommands; those operations are MCP tools.

## Cloud mode

Cloud mode requires distinct actor bearer tokens, one server instance, persistent local SQLite storage and a production HTTPS reverse proxy. Setup still configures local stdio; merge remote URL/header entries explicitly. See [cloud setup](docs/GETTING_STARTED.md#cloud-mode) for verified host configuration syntax and deployment limits. No hosted account, paid plan or externally deployed endpoint is supplied by this repository.

## Boundaries

Configured codex/cursor identities are local process labels, not account authentication. Shared messages and task text are untrusted data under each host's existing instructions. Acknowledgement means received, not approved. Claims coordinate cooperating tools but cannot stop other programs writing files. The native lane conveys no build or user approval.

Cursodex exchanges plans, decisions, concise explanations and evidence. It does not merge hidden internal reasoning or automatically resume an idle AI session. An active authorized host must read its inbox/events and decide what to do.

Read [the trust contract](docs/TRUST.md), [security guidance](SECURITY.md) and [contributing instructions](CONTRIBUTING.md) before deploying changes. Host loading, actual two-host communication and your project's build/device acceptance are separate checks.

## Validation and license

The v0.1.0 local validation passed 39 focused Node tests on macOS with Node22.23.2, including real stdio and loopback HTTP SDK clients, concurrent SQLite startup, CAS races, UTF-8 boundaries, HTTP actor/session fencing, shutdown and installer preservation. A packed npm consumer installation also proved that both generated stdio entries and the cloud module run after the original npm installation is removed. These are protocol/runtime tests, not proof that your actual AI sessions loaded MCP.

CI is configured for Node22/24 on Linux, macOS and Windows. Container, external HTTPS and host integration acceptance depend on those actual environments; no managed cloud service is included. See the [changelog](CHANGELOG.md) and [evaluation fixtures](evaluations/README.md).

MIT licensed. No AI subscription or API key is needed by the bridge itself; your Codex/Cursor use remains under your existing accounts.
