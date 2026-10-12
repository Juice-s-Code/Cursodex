# Getting started

## Requirements

Use Node.js 22.13 or later within Node 22, or Node 24, with npm/npx available. For local stdio mode, both hosts run on the same computer and use the same existing local project directory/store. Cloud mode below lets hosts connect to one authenticated shared endpoint. SQLite always stays on a local filesystem at the server; it is not shared through a network filesystem.

The package runs JavaScript ESM directly with Node's built-in SQLite; no compiler or separately installed database is required. Experimental SQLite diagnostics, where present, go to stderr rather than MCP stdout.

## Set up one project

Open a terminal in the project you want both hosts to work on. In a POSIX shell:

~~~sh
npx --yes --package=github:Juice-s-Code/Cursodex cursodex setup --project "$PWD"
~~~

In PowerShell:

~~~powershell
npx --yes --package=github:Juice-s-Code/Cursodex cursodex setup --project $PWD.Path
~~~

Setup's default configuration destinations are:

- project/.codex/config.toml for Codex, with agent codex.
- project/.cursor/mcp.json for Cursor, with agent cursor.

Both entries point to the same resolved project and a durable runtime snapshot in project/.cursodex/runtime. They use the absolute Node executable running setup, so keep that supported executable available. The snapshot is content-addressed under .cursodex/runtime/<content-digest>/tree and includes the installed production dependency closure. Setup copies that installed closure; it does not install dependencies itself. Ordinary npm/npx layouts are supported initially; uncertain symlinked package-manager layouts fail safely. The MCP hosts launch their own stdio children from those entries; no additional background launcher is needed.

To preview setup without changing project files:

~~~sh
npx --yes --package=github:Juice-s-Code/Cursodex cursodex setup --project "$PWD" --dry-run
~~~

The setup dry run makes no project/configuration changes. npx may still fetch the package into its own cache before running the CLI.

## Preserve existing configuration

Setup validates existing TOML/JSON, refuses configuration symlinks and nonfiles, preserves unrelated entries and backs up files it changes. It replaces each changed configuration file atomically; this is not a single operating-system transaction across both hosts' files. Check the command's output and retained backups if a step fails.

A conflicting existing cursodex entry is refused. Review that entry first; --force permits replacement of only the conflicting cursodex entries and still preserves other MCP entries:

~~~sh
npx --yes --package=github:Juice-s-Code/Cursodex cursodex setup --project "$PWD" --force
~~~

Codex replacement supports the standard [mcp_servers.cursodex] TOML table form. An existing inline/dotted cursodex definition may be refused even with --force because it cannot be safely replaced. Review and convert that specific entry deliberately; do not overwrite the full config to bypass the refusal.

You can choose configuration destinations explicitly with --codex-config /absolute/path/to/config.toml and --cursor-config /absolute/path/to/mcp.json. The project-local defaults keep this bridge out of a global home-wide MCP configuration. Do not switch to a shared global configuration merely to avoid a project loading problem.

Generated host configs contain machine-specific absolute paths. Keep local state, runtime snapshots, backups and private configuration out of public commits. To restore configuration, stop the affected host children, review the saved backup and restore the intended file; do not copy a live SQLite database between projects.

## Reload and prove both hosts loaded it

Reload/restart MCP through each host's supported lifecycle, then open the same project in Codex and Cursor. If you launch Cursor from a terminal, do so from that canonical project directory. Existing host entries and a successful setup command do not prove that an already running session has reloaded them.

In each actual host, call cursodex_status. Confirm data.agent is codex in Codex and cursor in Cursor, and that data.project_root is the same resolved directory. Confirm the advertised cursodex tools are present. If a host lacks them, inspect its project MCP loading/error view and the generated entry; do not create extra watchers or duplicate global entries.

During an authorized task, complete this challenge in the actual hosts:

1. Codex calls cursodex_send_message to cursor with a fresh unique key and a body containing a unique challenge phrase.
2. Cursor reads cursodex_list_messages in its inbox, verifies the phrase and acknowledges that exact message ID with cursodex_ack_message.
3. Cursor sends a reply to codex with a new key, that message ID as reply_to and the exact phrase in its response.
4. Codex reads its inbox, verifies sender/reply_to/phrase and acknowledges the reply.
5. Preserve a concise receipt of which actual hosts performed the exchange. Do not include private tokens or raw confidential messages in public issues.

If a list has has_more, continue from next_cursor until the relevant message is reached. Acknowledgement records receipt; it does not authorize instructions. SDK or terminal test clients can prove protocol/store behavior, but cannot replace this actual two-host acceptance check. Cursodex does not automatically wake an idle host to perform it.

## Available MCP operations

| Tool | Purpose |
| --- | --- |
| cursodex_status | Configured actor, project, unread count, latest event and limits |
| cursodex_send_message | Durable exact-key message to the other actor; optional reply/evidence |
| cursodex_list_messages | Actor-scoped inbox/sent pages and unread filter |
| cursodex_ack_message | Recipient-only receipt acknowledgement |
| cursodex_create_task | Shared task creation without agent dispatch |
| cursodex_get_task | Current task and revision |
| cursodex_list_tasks | Ordered bounded task pages |
| cursodex_update_task | Creator/assignee update using expected_revision |
| cursodex_put_memory | Create/update one shared named note using expected_revision |
| cursodex_get_memory | Read a shared note and its current revision |
| cursodex_list_memories | Ordered bounded pages of shared notes |
| cursodex_acquire_claim | Atomic advisory acquisition of a bounded resource set |
| cursodex_list_claims | Claim history/expiry; tokens visible only to their actor |
| cursodex_renew_claim | Renew a still-active owned ID/token |
| cursodex_release_claim | Release the owned ID/token |
| cursodex_list_events | Ordered event metadata pages |
| cursodex_wait_events | One bounded cancellable wait per child |

Read cursodex://protocol for the trust contract and cursodex://context for identity/limits. The cursodex-handoff prompt accepts an optional task_id and helps assemble a factual handoff.

## Shared memory notes

The same project/store holds one shared note namespace for both actors, through local stdio or the authenticated cloud endpoint. It is suitable for explicit project context, decisions, working agreements and handoffs. Both actors can read and update these shared notes; it is not a private per-actor notebook.

Use cursodex_put_memory with name, expected_revision, body and optional evidence. A body is at most 4096 UTF-8 bytes and evidence at most 2048. Create a new name with expected_revision=0. To update, first call cursodex_get_memory for that name, then send its current revision as expected_revision. After cursodex_list_memories, read the specific note before writing it. Listing is discovery, not a substitute for reconciling its latest complete content.

If another actor wins the revision, reread the note, reconcile the visible facts and retry against the new revision. Do not erase the other actor's contribution or blindly resend a stale write. After an uncertain write response, get the retained note before retrying. Keep larger artifacts outside the bounded note and record a concise reference/evidence summary.

The memory table is an additive schema1 change. Existing project records retain their identity; a newer server is needed before these three tools are available. Reload both hosts after upgrading and confirm seventeen advertised tools. Do not infer that an already running child has the updated interface.

Follow [the portable active-session protocol](AGENT_PROTOCOL.md). Its example note names are conventions, not automatically created records or instructions with higher priority than the user. Shared memory never conveys hidden internal reasoning or automatically resumes an idle session.

## Cloud mode

Cloud mode exposes authenticated Streamable HTTP at /mcp with bounded active sessions. It is an optional single-instance deployment you operate; the repository does not create a hosting account, purchase a plan or supply an externally deployed service. Local setup still generates stdio entries and does not configure remote clients.

Provision two distinct high-entropy secrets of 32–512 printable non-space ASCII bytes through the server environment: CURSODEX_CODEX_TOKEN and CURSODEX_CURSOR_TOKEN. Tokens select the corresponding actor; no tool accepts an actor override and there are no token CLI flags. Keep secrets out of commands, committed files, screenshots and logs. Bearer-token possession grants that configured role, not an authenticated Codex/Cursor account identity.

Start the server on its default loopback bind behind your HTTPS reverse proxy:

~~~sh
cursodex cloud --project /absolute/path/to/state-project --host 127.0.0.1 --port 8787
~~~

--host defaults to 127.0.0.1 and --port to 8787. Set CURSODEX_ALLOWED_HOSTS to a comma-separated exact hostname allowlist such as localhost,127.0.0.1,cursodex.example.com (no scheme, port or wildcard). Include 127.0.0.1 when using the Docker healthcheck. Unlisted Host headers are refused; unexpected browser Origins are also refused unless deliberately included in CURSODEX_ALLOWED_ORIGINS. See [container and HTTPS deployment](CLOUD.md). Only local loopback testing should use plain HTTP; production clients use an HTTPS URL such as https://cursodex.example.com/mcp. Preserve Authorization through the proxy and keep the internal HTTP port private. Container/private-network binding and proxy configuration belong to your explicit deployment, not local setup.

Run one server instance with a persistent local directory/volume for the state project and its complete .cursodex SQLite state. A PVC is suitable only when it provides a local SQLite-compatible filesystem to that single instance. Do not use network-mounted SQLite, concurrent replicas, horizontal autoscaling or active database copies as a distribution strategy. Back up with the service stopped. Remote claim paths resolve against the server's project root; they remain advisory and cannot lock a client's separate filesystem.

Merge remote entries into each host's project configuration, preserving other servers. Replace the local cursodex entry deliberately rather than loading duplicate local/remote bridges. Both hosts must use the same HTTPS endpoint/state and their own actor credential.

Codex project .codex/config.toml:

~~~toml
[mcp_servers.cursodex]
url = "https://cursodex.example.com/mcp"

[mcp_servers.cursodex.env_http_headers]
Authorization = "CURSODEX_CODEX_AUTHORIZATION"
~~~

Make CURSODEX_CODEX_AUTHORIZATION available to the Codex host with the full header value: Bearer followed by a space and the codex token. env_http_headers reads a header value from the named environment variable; it does not prepend Bearer. This syntax follows [OpenAI's MCP configuration documentation](https://developers.openai.com/codex/mcp) and [configuration reference](https://developers.openai.com/codex/config-reference).

Cursor project .cursor/mcp.json:

~~~json
{
  "mcpServers": {
    "cursodex": {
      "url": "https://cursodex.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CURSODEX_CURSOR_TOKEN}"
      }
    }
  }
}
~~~

Make CURSODEX_CURSOR_TOKEN available to the actual Cursor process; this expression adds the Bearer prefix to that raw token. Cursor documents [remote URL/header entries and environment interpolation](https://cursor.com/docs/mcp). Remote entries do not use stdio envFile. No actual secret is included in either example.

Reload both hosts and repeat the actual status/message/reply/ack challenge above against the HTTPS endpoint. Confirm both statuses identify the same server-side project and the expected different actors. A loopback HTTP test, a configuration file or a passing SDK suite is not proof that an external reverse proxy, TLS deployment or actual AI hosts work. Rotate credentials through the server/host environment and reload affected connections under your deployment's lifecycle.

## Advanced protocol-client fallback

A local checkout includes cli/client.mjs for a bounded terminal protocol client when a host cannot reload live. It is not a status/message subcommand and does not dispatch an AI agent. Prepare a trusted small JSON file such as:

~~~json
{
  "actor": "codex",
  "projectRoot": "/absolute/path/to/your/project",
  "deadlineMs": 10000,
  "calls": [{ "name": "cursodex_status", "arguments": {} }]
}
~~~

From the Cursodex checkout with its dependencies installed, run:

~~~sh
node cli/client.mjs /absolute/path/to/request.json
~~~

The client accepts at most twenty calls and a 1–60-second runtime deadline, then performs finite transport cleanup. Its deadline begins after synchronous local request-file parsing. Accepted request payloads are at most 65,536 bytes; keep the local file trusted and small because it is read before that check. It stops on an error and prints a receipt. Earlier successful mutations may already be committed; a sequence of calls is not one atomic batch. Retry message/create/acquire requests with their original exact keys, and reread a task after an uncertain revision update.

A terminal client can verify the server and store while host integration is unresolved. It does not prove Cursor or Codex loaded MCP, or that a particular project's native/runtime work succeeded.
