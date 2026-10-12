# Contributing

Changes should keep Cursodex small, local and explicit. Discuss new execution, remote access, authentication or background behavior before adding it; those features change the trust contract.

## Development

Use Node 22.13+ within Node 22, or Node 24 and install the checked-in dependency lock in a local checkout:

~~~sh
npm ci --ignore-scripts
npm test
~~~

Keep dependencies pinned and include the lockfile when an intentional dependency change is accepted. The runtime is JavaScript ESM with built-in SQLite. Do not replace SQLite or add install/build hooks to hide an unsupported Node runtime.

Tests must use disposable project directories. Do not point seed scripts or integration tests at a real workspace. The fixture seed in evaluations/seed-evaluation.js --disposable-fixture is explicit setup for fictional evaluations, not a production migration. A test client must close its stdio children and release temporary resources on success and failure.

## What a change needs

- A concrete trigger and expected behavior, with meaningful regression cases for any changed boundary.
- Actual commands/results for the checks you ran, distinguished from authored or reviewed tests.
- Coverage for concurrent mutation/event atomicity, actor scoping, exact retry keys, task/shared-memory revision conflicts, claim overlap/tokens/expiry and bounded cancellation where relevant.
- Shared-note tests for same-name create races, stale update refusal, reread/reconciliation, persistence across restart and actor visibility; schema1 additive compatibility must preserve prior records.
- Setup tests for unrelated-entry preservation, conflicts, backups, invalid/symlink configs, dry runs and a runtime snapshot that remains usable after the temporary package location disappears.
- Cloud tests for missing/wrong actor tokens, identity isolation, input/cancellation bounds, restart persistence and a single-instance store; HTTPS/host deployment acceptance stays separate.
- Documentation matching the implemented CLI and tool schemas. Do not invent doctor/status/message subcommands or imply a protocol client is an AI host.

The intended CI matrix covers Node 22 and 24 on Linux, macOS and Windows. Review each actual job result for the supported combinations. A matrix declaration is not evidence that all jobs passed. Windows path/shell behavior, macOS alias handling and Linux filesystem behavior need their own actual results when affected.

Use concise public examples with fictional project paths. Do not commit generated .cursodex state/runtime copies, node_modules, local host configs, backups, private receipts, device data, credentials or tokens. Avoid broad formatting changes that obscure a boundary fix.

## Acceptance claims

Keep source review, protocol/SQLite tests, CLI/setup tests, actual Codex/Cursor loading and the two-host message/reply/ack challenge separate. Shared-memory notes are explicit project knowledge, not higher-priority instructions or hidden reasoning. Validate portable active-client prompt flows in [AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).

Cursodex cannot certify a downstream project's native build, device install or field behavior. A task's done state remains a submitter assertion until independently checked.

Existing hosts must reload through their supported lifecycle before integration can be credited. No change should promise hidden-reasoning merging, automatic idle-agent wakeup, destructive cleanup or account authentication from local actor labels.

For a suspected vulnerability, follow [SECURITY.md](SECURITY.md) instead of publishing sensitive details in a normal issue.
