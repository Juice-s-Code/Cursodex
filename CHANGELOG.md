# Changelog

## 0.1.2 — 2026-10-12

- Expose caller-supplied task and message keys on read, retry, update and acknowledgement results, so active hosts can match assignments and receipts. Retain per-actor key namespaces and hide internal retry payloads.
- Add paired SDK regression coverage for key lookup, pagination, CAS, acknowledgement, exact retries and reconnect.
- Keep machine-local Obsidian UI state out of source publication alongside generated host configurations.

## 0.1.1 — 2026-10-12

- Correct two Windows test assertions to use the same canonical filesystem path form as the server; retain Unicode, UTF-8 and private-state checks. Runtime behavior is unchanged.
- Keep the initial v0.1.0 release and its checksums intact.

## 0.1.0 — 2026-10-12

Initial public Cursodex release under Juice Code.

- Local project-scoped MCP stdio servers for Codex and Cursor, sharing SQLite messages, tasks, named memory notes, claims and events.
- Seventeen tools, two resources and one handoff prompt; strict schemas and bounded UTF-8 payloads/pages/responses.
- Exact-key message retries, revision-fenced task/note updates, recipient acknowledgements and expiring advisory path claims.
- Portable CLI setup that preserves existing host entries, retains backups and copies a content-addressed production runtime independent of an ephemeral npx installation.
- Authenticated Streamable HTTP with separate actor tokens, session fencing, Host/Origin checks, bounded request/session capacity and shutdown handling.
- Docker/Compose source for a single instance with persistent local storage, plus HTTPS reverse-proxy documentation.
- Focused runtime tests and fictional read-only MCP evaluation fixtures. CI targets Node22/24 on Linux, macOS and Windows.

The bridge shares explicitly stored project context. It does not run inference, merge private model reasoning or automatically wake idle hosts. Cloud support is self-hostable software, not an externally deployed service.
