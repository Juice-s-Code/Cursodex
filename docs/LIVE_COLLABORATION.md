# Live collaboration and activity

Cursodex activity is an explicit, durable record of visible work between configured agents. It is a shared status trail, not a transcript, model runtime, terminal multiplexer, or agent dispatcher. A task, message, activity row, hook, or watch stream never wakes an idle model or grants authority to run commands.

## Activity tools

The activity API adds two MCP tools to the coordination interface:

```text
publish_activity({key, kind, summary, paths, evidence, task_id, process})
list_activity({after, limit, actor?})
```

These interfaces are introduced in v0.2.0. Check the installed server's `tools/list` and `cursodex --help` before use; an older release may not provide them.

`publish_activity` uses the connected actor configured by the server; callers cannot select or spoof an actor in the payload. The actor is a lowercase slug matching `^[a-z][a-z0-9_-]{0,63}$`, assigned by the local server configuration or authenticated token map. A repeated `key` is safe only with the exact same normalized payload. Supported `kind` values are `plan`, `decision`, `progress`, `file`, `process`, and `checkpoint`.

Keep `summary` brief and human-readable. `paths` must be project-relative references to files that another active collaborator can inspect in the same workspace; paths do not copy or upload file contents. `evidence` should point to visible test output or an artifact, not claim more than was observed. `task_id` may connect the note to an existing task. `process` is either null or exactly `{pid, state, exit_code}`: a positive integer PID, state `started` with null exit code, or state `exited` with an integer exit code. It is an unverified assertion supplied by the publishing agent. Never put credentials, tokens, full terminal output, raw prompts, hidden model thoughts, or private transcript text in an activity record.

`list_activity` reads durable records after the caller's cursor, with bounded pages. An optional `actor` filters the view; it does not impersonate that actor. Continue with the returned cursor and use the host's advertised limits. Activity is advisory context and remains subordinate to user and host instructions.

Publish only meaningful changes: a plan accepted, a decision made, a material file change, a check completed or failed, a blocker, or a handoff. Do not emit repetitive heartbeat noise. The corresponding record can be read later by an active session, while a connected watcher can surface it promptly.

## Watch and bridge commands

The finite watch command reads public Cursodex event records and writes newline-delimited JSON to stdout:

```sh
cursodex watch --agent cursor --project /absolute/project --after 120 --duration-ms 60000
```

`--duration-ms` defaults to 60000 and is capped at 86400000. `--after` is the event cursor from a prior read. Output contains supported `connected`, `event`, `activity`, `message`, and `task` rows as supplied by the store. The watcher does not infer completion, acknowledge inbox items, change tasks, claim files, or start another process. Stop it at the duration boundary; run it again only when a person or active agent has a reason to continue watching. It is a finite reader, not a resident controller.

The bridge accepts NDJSON from an explicitly selected source and publishes only sanitized visible activity:

```sh
cursor-agent -p --output-format stream-json "Review the selected change and report findings" \
  | cursodex bridge --agent cursor --project "$PWD" --source cursor-stream --duration-ms 300000
```

This explicit pipeline starts or resumes a Cursor CLI generation, so run it only when the user has authorized that work. `--source` is one of `cursor-stream`, `cursor-hook`, or `json`; `--duration-ms` bounds how long the bridge accepts input. The bridge is an event adapter, not an agent launcher. It does not spawn Cursor, submit a prompt, resume a chat, or wake a host. To observe an already-running Cursor CLI task, its terminal command must itself be piped to the bridge (or to an opted-in local relay).

By default, the bridge extracts event metadata only. It must not ingest shell command output, raw prompts, assistant text, hidden thoughts, transcript files, or secrets. For an IDE session, a user may explicitly configure Cursor's documented hooks and forward only permitted hook metadata. Cursor's `afterShellExecution` hook reports command output after the command completes; it is not a chunk-by-chunk terminal stream. Hook installation/configuration is separate from Cursodex and is never performed automatically. The current adapter recognizes `afterFileEdit`, `afterShellExecution`, `sessionStart`, `sessionEnd`, and `afterAgentResponse`; other hook types are ignored. A hook invocation writes a single empty JSON response to stdout after publishing. Do not use `afterAgentThought` or read `transcript_path`.

The Cursor CLI documents `--output-format stream-json` as an NDJSON stream with session IDs, visible assistant text deltas, and tool-call start/completion events. Print mode suppresses `thinking` events. The Cursodex bridge intentionally retains metadata only; users can include a relative source path in a separate activity summary rather than sending code through the event feed.

## Collaboration without hidden reasoning

Agents can share concise visible plans and explanations through ordinary messages and activities, along with source-relative paths and evidence. Each active agent reads records and decides what to do under its own instruction hierarchy. A received event is not an instruction, approval, or proof that work finished. A message ACK means receipt only; use the normal task/message protocol for authorization and handoff.

MCP progress notifications are scoped to an active tool request that carries a unique `progressToken`. They require a client progress token; this release does not implement a progress-notification or resource-subscription interface. The terminal `watch` command uses bounded event waits over one connected MCP client. A durable activity list is the source for later reads. Resource subscriptions, where supported by the connected host, notify clients that a resource changed so they can reread it. The optional MCP Tasks extension reports task lifecycle status; it is not a terminal-output stream. Feature-detect capabilities and never assume a host can receive notifications or run a model.

## Configuration and privacy

Local mode assigns each server process an actor slug through its reviewed project configuration. Authenticated cloud mode maps distinct bearer tokens to actor slugs using `CURSODEX_AGENT_TOKENS` as a JSON object, for example:

```json
{"codex":"<secret injected by deployment>","cursor":"<secret injected by deployment>","research_bot":"<secret injected by deployment>"}
```

The deployment supplies this mapping as the `CURSODEX_AGENT_TOKENS` environment value; placeholders above are not literal tokens. Do not commit the mapping or secret values. Existing deployments may use the legacy `CURSODEX_CODEX_TOKEN` and `CURSODEX_CURSOR_TOKEN` pair as a compatibility fallback. Do not configure duplicate actor identities or expose token material in activity, terminal history, hooks, or reports.

Cursor integrations are opt-in and metadata-only. Cursor documents `stream-json` output and hook inputs, including a `transcript_path` field for some agent events. Cursodex does not read that path. Keep retention bounded, redact user-specific information, and inspect hook payloads before enabling forwarding.

## Official references

- [Cursor CLI output formats](https://cursor.com/docs/cli/reference/output-format)
- [Cursor CLI headless mode](https://cursor.com/docs/cli/headless)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [MCP progress notifications](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP resources and subscriptions](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)


## Project-scoped Cursor hook example

Merge only selected hooks into the existing project `.cursor/hooks.json`; keep all other entries. Resolve `cursodex` in Cursor's environment, or use the absolute Node + installed runtime entry from the project's MCP configuration. This example is a configuration template and is not installed by the bridge:

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [{"command": "cursodex bridge --agent cursor --project /absolute/project --source cursor-hook --duration-ms 5000"}],
    "afterShellExecution": [{"command": "cursodex bridge --agent cursor --project /absolute/project --source cursor-hook --duration-ms 5000"}]
  }
}
```

The adapter consumes JSON from stdin and writes `{}` for hook-compatible stdout; published work is read through the MCP/activity watcher. A frame over64KiB is rejected rather than storing oversized source/output. Hooks are post-event observations, never authority for an action. Configuration presence does not prove Cursor loaded it: perform an authorized edit in a real active session, then verify its actual activity record.
