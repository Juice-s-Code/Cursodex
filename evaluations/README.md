# Fictional Cedar evaluation

This frozen fixture supports ten independent read-only questions about messages, tasks and shared memory notes. It reuses fictional Cedar review facts; it contains no production receipt, credential, live database or geographic capture. All expected answers are stable fixture facts, not statements about a real application or delivery.

Only seed a **new, empty, disposable real directory** that you created for this evaluation. Never set PROJECT_ROOT to a production project, an existing worktree or a directory containing retained state. The seed rejects nonempty directories, symlink roots and noncanonical aliases. It requires an explicit --disposable-fixture flag and never deletes or overwrites existing state. A partial failure may leave a partially seeded disposable directory; preserve the error and create another new directory rather than resetting or reusing the failed one.

Create a disposable directory portably and print its canonical absolute path:

~~~sh
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'); console.log(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cursodex-evaluation-'))))"
~~~

Set PROJECT_ROOT to that printed path using your shell's environment syntax, then run from this package checkout or installation:

~~~sh
node evaluations/seed-evaluation.js --disposable-fixture
~~~

The helper imports the package's actual Store, creates six tasks and six messages, applies the recorded acknowledgement flags, and creates two explicit shared notes: cedar-baseline and cedar-validation. Initial setup intentionally mutates only that disposable project's .cursodex state. There are no claims, model calls, host configuration changes or installs. Stop all clients before removing only the disposable directory you created.

Connect a Cursodex MCP client to that same directory as codex. Answer evaluations.xml through read-only tools, using each question independently and returning exactly its expected answer form. Read tasks and inbox/sent messages through bounded pagination; when a question references an application key such as e06, locate its task by title, summary and evidence because internal idempotency keys are not exposed by read views. Two questions additionally require cursodex_get_memory for the named shared note and corroboration from its referenced tasks. Notes can also be discovered with cursodex_list_memories. Do not use send, ack, create/update, put-memory or claim mutations while answering.

The ten answers, in question order, are parser-r1, codex, 0, cedar-current-43, cedar-parent-42, 56, 0, gate-7, cursor and planned. Each question is self-contained and does not depend on earlier answers or writes. Task states, authored assertions and execution/install evidence are deliberately separate.

This evaluation measures retrieval, pagination and tool usability against a fictional frozen dataset. Authored XML and a source-level fixture check do not prove that an evaluation model ran. A passing terminal or SDK evaluation does not prove Codex and Cursor loaded the tools, exchanged messages in actual AI hosts, performed native work or installed an app. Record those outcomes separately with exact run identity.
