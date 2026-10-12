# Agent integrations

Cursodex has three separate surfaces: its MCP server, a portable Agent Skill, and a skills-only Codex plugin manifest. The skill guides cooperating active clients; its installation does not configure MCP or automatically wake another agent. Native MCP operations are preferred. A bounded CLI SDK fallback is available when the installed release advertises `call`.

## Install the portable skill

Use supported Node 22 (22.13 or later) or Node 24. Install a release containing `install-skill`. In an existing project, create the parent skill directory and copy the skill to its final folder:

~~~sh
mkdir -p .agents/skills
npx --yes --package=github:Juice-s-Code/Cursodex cursodex install-skill --target "$PWD/.agents/skills/cursodex" --dry-run
npx --yes --package=github:Juice-s-Code/Cursodex cursodex install-skill --target "$PWD/.agents/skills/cursodex"
~~~

In PowerShell, use `New-Item -ItemType Directory -Force .agents/skills` and pass `"$($PWD.Path)/.agents/skills/cursodex"` as the target. The absolute target is the final skill folder, and its parent must exist. A byte-identical repeated install succeeds; conflicting or extra files are retained and refused. There is no overwrite flag, automatic upgrade, dependency install, or global/config modification. A dry run makes no installer writes; npx can still fetch its package into its own cache.

[Codex documents project `.agents/skills` discovery](https://developers.openai.com/codex/skills). [Cursor documents that path, `.cursor/skills`, and `.codex/skills` compatibility](https://cursor.com/docs/skills). Use one documented path for each host, avoiding duplicate named skills. Other Agent Skills clients need their own documented folder/discovery support. Local files do not automatically reach remote/cloud workers. Use the supported host lifecycle to discover the skill and verify an explicit invocation. Codex can invoke `$cursodex`; use the host's supported skill picker in other clients. Normal implicit selection is permitted when the task matches; it does not enlarge user authority.

The portable content is [SKILL.md](../skills/cursodex/SKILL.md), its Codex UI metadata, and one conditional [client/CLI reference](../skills/cursodex/references/clients-and-cli.md). You can copy that complete folder manually into a known host skill path without installing the plugin.

## Connect the same MCP project

For Codex and Cursor, follow [Getting Started](GETTING_STARTED.md): explicit `cursodex setup --project /absolute/project` configures the two project-local hosts with separate roles and preserves reviewed configuration. Reload through each host's supported lifecycle. A skill copy or setup receipt does not prove that the existing session reloaded MCP.

A compatible MCP host can use stdio command `cursodex` with arguments:

~~~json
["server", "--agent", "cursor", "--project", "/absolute/project"]
~~~

The example role must be explicitly assigned and unused. Only `codex` and `cursor` exist; a third-party host can occupy one free coordination slot, not create arbitrary additional actors or impersonate an active host. Both clients must resolve to the same local project, or use the same authenticated HTTPS `/mcp` endpoint with separate role credentials. Configure HTTP headers using the host's documented secret handling and the [cloud guide](CLOUD.md); credentials are never plugin/skill content. Do not mix duplicate local and remote entries for the same work.

## Use the bounded fallback

Prepare a trusted small arguments file containing `{}` and inspect status before any mutation:

~~~sh
cursodex call --agent codex --project /absolute/project --tool cursodex_status --arguments-file /absolute/status-arguments.json --deadline-ms 15000
~~~

A sequential request can use `cursodex call --request /absolute/request.json` with this complete JSON:

~~~json
{
  "actor": "codex",
  "projectRoot": "/absolute/project",
  "deadlineMs": 15000,
  "calls": [{ "name": "cursodex_status", "arguments": {} }]
}
~~~

Use only the assigned role, verify result identity, and inspect all error/deadline/cleanup facts. At most 20 calls and a 1000–60000 ms deadline are accepted. This is an SDK protocol client with a receipt, not a model dispatcher or a way to hot-load native tools. A sequence is not an atomic batch: successful earlier writes can survive a later timeout. Reconcile exact-key and CAS outcomes through the public tools, never direct SQLite edits. Follow [the active-client protocol](AGENT_PROTOCOL.md).

## Optional Codex plugin packaging

The repository includes `.codex-plugin/plugin.json`, a supported skills-only compatibility manifest with `skills: "./skills/"`. [OpenAI documents this compatibility format](https://developers.openai.com/plugins/build/plugins); portable Agent Plugins instead use a root `plugin.json`. This package uses the verified compatibility format and declares no bundled role/project, MCP connection, hook, executable, or credentials. Configure Cursodex separately. Import/enable through the actual host's supported local/repository plugin workflow and verify it loaded; no marketplace publication, automatic GitHub import, or native plugin-host acceptance is implied by the manifest alone.

## Prove the actual hosts

In both actual AI hosts, verify status project/role, exchange a fresh unique challenge, ACK the received IDs, and validate a reply linked to the original message. Verify shared-memory read/CAS behavior separately. Report which hosts actually performed the exchange. Terminal SDK success is useful protocol evidence but cannot stand in for actual AI-host loading, hidden-reasoning sharing, or downstream builds/tests. The skill's [three behavioral cases](../evals/evals.json) are authored acceptance scenarios; execution evidence belongs in separate receipts.
