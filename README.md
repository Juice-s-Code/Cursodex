# Cursodex

Cursodex is an open-source MCP bridge for active AI collaborators to share project knowledge, exchange messages, share tasks, coordinate file ownership, and publish visible activity inside one project. Local mode gives each host a small stdio server sharing a transactional SQLite store. Optional authenticated Streamable HTTP mode serves the same coordination tools from one shared endpoint. Cursodex does not run models, edit your files or wake an idle agent.

## Get started

Use Node.js 22.13 or later within Node 22, or Node 24, with npm available. The versioned release package installs without Git. Open a terminal in the project both hosts will use, then run:

~~~sh
npx --yes --package=https://github.com/Juice-s-Code/Cursodex/releases/download/v0.2.0/cursodex-mcp-0.2.0.tgz cursodex setup --project "$PWD"
~~~

On Windows PowerShell, pass `$PWD.Path` instead of `"$PWD"`; on Command Prompt, pass `"%CD%"`. See [Getting started](docs/GETTING_STARTED.md) for complete copyable commands and upgrades.

Setup creates project-local MCP entries for Codex and Cursor and a durable runtime snapshot under .cursodex/runtime. The generated entries use an absolute Node executable and the snapshot, so hosts do not depend on a temporary npx cache. Existing unrelated MCP entries are preserved. Changed configuration files receive backups; conflicting cursodex entries require an explicit --force choice.

Reload both hosts through their supported MCP lifecycle. Open the same project in each; launch terminal-based Cursor from that project's directory. Confirm cursodex_status in each host and complete the unique message/reply/ack check in [Getting started](docs/GETTING_STARTED.md). A setup success or a terminal protocol-client result does not prove that both AI hosts loaded the tools.

## What it provides

- MCP tools for actor/project status, durable messages, acknowledgements, tasks, shared memory notes, advisory claims, event reads/waits, and explicit activity publication/listing.
- Two resources: cursodex://context and cursodex://protocol.
- One prompt: cursodex-handoff, for a visible factual handoff.
- SQLite transactions that commit each mutation with its event; exact retry keys and task revision checks preserve uncertainty after a lost response.
- Project-scoped path claims with owner tokens, expiry and ancestor/descendant conflict checks.
- UTF-8/input/response/page limits and request-scoped waits. There is no permanent polling controller; local stdio needs no network listener.

## One shared brain

Both actors use one project-scoped namespace of durable named memory notes. Write visible project facts, decisions, agreements and current handoffs there so the next active session can read the same context. Notes use revision comparison: create with expected_revision=0, then read the current note before each update. A stale revision fails instead of silently replacing the other actor's work.

This shared brain is explicit stored knowledge, not merged model internals or continuous awareness. Use [the agent protocol](docs/AGENT_PROTOCOL.md) to combine notes, task revisions, acknowledged messages and visible progress during active authorized work. See [live collaboration](docs/LIVE_COLLABORATION.md) for activity records, Cursor event sources, privacy limits, and finite watch/bridge commands.

## Live collaboration

`publish_activity` and `list_activity` provide durable, human-readable progress records. `cursodex watch` is a finite NDJSON reader; `cursodex bridge` adapts explicitly supplied Cursor CLI, hook, or JSON events. These surfaces report events; they never wake or command an AI host. See [Live collaboration](docs/LIVE_COLLABORATION.md) for the supported workflow and privacy boundaries.

## Commands

~~~sh
cursodex --help
cursodex --version
cursodex setup --project /absolute/path/to/project --dry-run
cursodex call --agent codex --project /absolute/path/to/project --tool cursodex_status --deadline-ms 15000
cursodex install-skill --target /absolute/path/to/project/.agents/skills/cursodex --dry-run
cursodex server --agent codex --project /absolute/path/to/project
cursodex cloud --project /absolute/path/to/state-project --host 127.0.0.1 --port 8787
~~~

These commands are available through the package bin. For one-off use, prepend the npx --yes --package=https://github.com/Juice-s-Code/Cursodex/releases/download/v0.2.0/cursodex-mcp-0.2.0.tgz prefix. The server command speaks MCP on stdio and is normally launched by your host; it is not a separate background service to start alongside the host entry. Use `cursodex call` to invoke the public MCP tools from a terminal or an agent whose native MCP catalogue cannot be reloaded during a running chat. Each invocation starts one bounded protocol client and closes it afterward; it does not launch an AI model. See [agent integrations](docs/AGENT_INTEGRATIONS.md) for the portable skill and Codex plugin.

## Cloud mode

Cloud mode requires distinct actor bearer tokens, one server instance, persistent local SQLite storage and a production HTTPS reverse proxy. Setup still configures local stdio; merge remote URL/header entries explicitly. See [cloud setup](docs/GETTING_STARTED.md#cloud-mode) for verified host configuration syntax and deployment limits. No hosted account, paid plan or externally deployed endpoint is supplied by this repository.

## Boundaries

Configured codex/cursor identities are local process labels, not account authentication. Shared messages and task text are untrusted data under each host's existing instructions. Acknowledgement means received, not approved. Claims coordinate cooperating tools but cannot stop other programs writing files. The native lane conveys no build or user approval.

Cursodex exchanges plans, decisions, concise explanations and evidence. It does not merge hidden internal reasoning or automatically resume an idle AI session. An active authorized host must read its inbox/events and decide what to do.

Read [the trust contract](docs/TRUST.md), [security guidance](SECURITY.md) and [contributing instructions](CONTRIBUTING.md) before deploying changes. Host loading, actual two-host communication and your project's build/device acceptance are separate checks.

## Validation and license

The test suite uses actual stdio and authenticated HTTP SDK clients to cover messages, acknowledgements, shared-note/task revisions, ownership, cancellation, reconnect and installer preservation. Distribution checks install the packed release in a clean consumer project and verify its durable runtime after the original installation is removed. CI receipts and immutable release assets are published with each verified release; authored tests and a setup receipt are separate from actual AI-host loading.

CI targets Node22/24 on Linux, macOS and Windows, with clean-package consumer verification and a Linux container smoke workflow. The container check verifies the packaged cloud service; an external HTTPS deployment and your actual AI-host connection still need their own acceptance. No managed cloud service is included. See the [changelog](CHANGELOG.md) and [evaluation fixtures](evaluations/README.md).

MIT licensed. No AI subscription or API key is needed by the bridge itself; your Codex/Cursor use remains under your existing accounts.
