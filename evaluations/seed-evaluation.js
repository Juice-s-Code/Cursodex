// Explicit fictional fixture preparation only. Never point at a production project.
import { lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';

if (process.argv.length !== 3 || process.argv[2] !== '--disposable-fixture')
  throw Error('Pass --disposable-fixture only for a NEW empty disposable PROJECT_ROOT.');
const root = process.env.PROJECT_ROOT;
if (!root || !path.isAbsolute(root)) throw Error('PROJECT_ROOT must be an absolute new disposable real directory.');
const target = path.resolve(root);
const metadata = lstatSync(target);
if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(target) !== target || readdirSync(target).length !== 0)
  throw Error('Refusing non-real, aliased or nonempty directory; seed only a NEW empty disposable project.');
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
if (fixture.version !== 'cursodex-fixture-v2-memory') throw Error('Unexpected fixture version.');
let a, b;
try {
  a = new Store(target, 'codex');
  b = new Store(target, 'cursor');
  for (const spec of fixture.tasks) {
    const { state, ...input } = spec;
    const row = a.createTask(input);
    a.updateTask({ id: row.id, expected_revision: row.revision, state, summary: input.summary, evidence: input.evidence });
  }
  for (const spec of fixture.messages) {
    const from = spec.sender === 'codex' ? a : b, to = from === a ? b : a;
    const row = from.send({ recipient: to.actor, key: spec.key, body: spec.body, evidence: spec.evidence });
    if (spec.ack) to.ack({ id: row.id });
  }
  for (const spec of fixture.memories) {
    const from = spec.author === 'codex' ? a : b;
    from.putMemory({ name: spec.name, expected_revision: 0, body: spec.body, evidence: spec.evidence });
  }
} finally {
  try { b?.close(); } finally { a?.close(); }
}
process.stderr.write('Seeded fictional cursodex-fixture-v2-memory; evaluate read-only as codex.\n');
