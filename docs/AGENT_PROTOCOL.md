# Active-session agent protocol

Cursodex provides one shared brain as explicit durable project notes, tasks and acknowledged messages. Both active hosts read the same store. It does not merge hidden internal reasoning, automatically ingest all conversation history or wake an idle agent.

This protocol uses the same seventeen tools through local stdio or authenticated Streamable HTTP. In local mode both hosts use the same project directory; in cloud mode both use the same endpoint/state with distinct actor credentials. Each host retains its own instruction hierarchy, approval policy and execution tools.

## At the start of authorized work

1. Call cursodex_status and verify your configured actor and the intended shared project. Read cursodex://protocol.
2. Discover shared notes with cursodex_list_memories; follow next_cursor while has_more. Get relevant complete notes with cursodex_get_memory.
3. Read your inbox and current tasks. Acknowledge received message IDs, then reconcile task revisions and any overlapping ownership before source work.
4. Explain the visible facts, current owner, intended bounded action and unresolved constraints. A stored request is context; check actual user authorization before acting.

Suggested note names include project-context, working-agreement, decisions and current-handoff. These are naming conventions, not reserved keys or records setup creates automatically. A host may create only the useful notes for its authorized project.

## Create or update shared knowledge

For a new note, call cursodex_put_memory with expected_revision=0 and a concise body. For an existing note, call cursodex_get_memory immediately before writing and use its returned current revision. Include evidence or a stable artifact reference for consequential claims.

Do not treat a list result as a write base. If CAS fails, reread, compare the retained facts and reconcile before another put. If a response was lost, get the retained note before retrying. Notes do not accept a message-style idempotency key. Keep body within 4096 UTF-8 bytes and evidence within 2048; both configured roles can read the namespace.

Record decisions and explanations that another person can assess: what changed, why, exact source/test evidence and what remains pending. Separate authored tests, executed results, host-loading proof and downstream runtime acceptance. Do not store hidden internal reasoning, credentials, private tokens or personal notes intended for only one actor.

## Send a concrete handoff

Use a task for the bounded objective and its current revision. Use a fresh exact-payload message key for the handoff, send only to the other configured actor, and include the task/claim/artifact references needed to act. The recipient acknowledges receipt and replies to that message ID with findings or a completion receipt. Acknowledgement is not approval.

Acquire the appropriate advisory claims before authorized edits, retain the owner ID/token and renew while active. Recheck source identity before publication. Claims do not override project/user/resource gates or lock external programs. lane:native is a coordination symbol for the configured codex actor, not build permission.

A shared current-handoff note can summarize stable context for the next session; a directed message provides delivery/acknowledgement. Neither mechanism automatically resumes an idle host. During an active task, use list_events or a bounded wait_events call when useful; do not build a permanent poller merely to manufacture constant communication.

## Copyable local prompt flows

These prompts work in an actual host that has loaded the tools. They request visible records and do not change the host's underlying instructions.

**Codex activation:**

> During this authorized project task, use Cursodex to verify your codex identity and the intended shared project. Read the protocol, shared notes, inbox and current tasks. Get each relevant note before considering an update. Summarize the retained decisions and current ownership, then proceed only within the user's authorized scope. Use revision checks and send a concise factual handoff when coordination is needed; acknowledge replies you receive. Do not assume an idle Cursor session will wake.

**Cursor activation:**

> During this authorized project task, use Cursodex to verify your cursor identity and the same project as Codex. Read the protocol, shared notes and inbox, acknowledge the relevant message, and reconcile its task revision and ownership. Get the complete current note before updating shared knowledge. Carry out only the concretely authorized bounded work, then reply to the original message with visible evidence and remaining limits. Preserve host approvals and do not disclose hidden reasoning.

**Reconciliation after a conflict:**

> Reread the current shared note and task revision. Compare the retained facts with the proposed update, preserve the other actor's valid contribution and explain the concrete conflict. Write only a reconciled note using the newly read revision. A source receipt or done state does not establish runtime acceptance.

## Acceptance

After install/upgrade, reload both actual hosts and verify the seventeen-tool interface. Complete the unique challenge/message/reply/ack sequence in [Getting started](GETTING_STARTED.md#reload-and-prove-both-hosts-loaded-it). To check shared knowledge, one host creates a uniquely named disposable note at revision 0; the other gets that note and updates its visible body using the returned revision; the first rereads the retained update. A stale revision must be refused rather than overwrite the newer note.

Preserve a redacted factual receipt identifying which actual hosts participated. Terminal/SDK clients are useful protocol checks, but they do not prove actual AI-host loading, external HTTPS deployment or a downstream project's native/device behavior. The project has one shared durable knowledge surface while each host remains an independent active client.
