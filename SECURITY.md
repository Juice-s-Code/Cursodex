# Security

## Scope

Cursodex coordinates two configured actors through local stdio or a single authenticated HTTP deployment. It does not authenticate cloud accounts, sandbox local programs or enforce filesystem ownership against an attacker. Shared message/task/memory text is untrusted input and must remain below each host's existing instructions. Read [the full trust contract](docs/TRUST.md).

Important boundaries include actor-scoped inbox/acknowledgement behavior, exact-payload retries, task/shared-memory revision checks, claim owner/token/expiry checks, project path validation, private generated-state permissions and bounded protocol inputs/waits. A regression that crosses one of those boundaries is a security issue even when normal cooperation appears to work.

Cloud mode must use distinct high-entropy actor tokens and production HTTPS; bearer possession grants the configured role rather than account authentication. Keep its internal HTTP listener private, run one instance and do not log Authorization. Do not expose the stdio server through an unreviewed network wrapper. Keep the local store on a local filesystem, avoid manual database edits and preserve unrelated host configurations. Shared memory is visible to both configured roles and is not encrypted private storage. Keep machine paths, message/note contents, SQLite state, backups, tokens and credentials out of public reports.

## Report a vulnerability

Use this repository's private vulnerability reporting channel if it is available. If no private reporting channel is offered, open a minimal issue asking maintainers for a private contact; do not include an exploit, token, confidential message or machine-specific configuration in that public issue.

A useful private report includes the affected commit/version, Node/OS versions, the boundary crossed, a small disposable-project reproduction, expected versus observed behavior and a redacted result. Use fictional paths/content and preserve uncertainty where a transaction may have committed. Never reproduce a report against another person's project or production store.

This repository does not promise an incident response time or support lifetime. Dependency advisories, current Node support and fixes should be assessed against the version you actually run. Passing protocol tests does not certify the security of host configuration, model behavior or external tools.


## Opt-in activity sharing

Named stdio identities are trusted process configuration, not account authentication. Cloud credentials map to fixed identities; request payloads never choose their sender. Activity is append-only self-report, not proof of live processes, file ownership, source integrity or native admission. The Cursor stream/hook adapters allowlist metadata and project-relative paths, dropping command text, raw output, prompts, transcripts and hidden thoughts. Explicit `json` activity and MCP messages publish the text their caller supplies: keep secrets out. `watch` displays untrusted records without executing them or automatically acknowledging instructions. Stop a live client with Ctrl-C or its finite duration. No feature attaches to an arbitrary existing terminal, reads a transcript, starts an AI model or bypasses a host's approval controls.
