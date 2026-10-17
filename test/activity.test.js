import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { isValidActorSlug } from '../src/identity.js';

async function stores(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-activity-'));
  const opened = [];
  t.after(async () => { for (const s of opened) s.close(); await rm(root, { recursive: true, force: true }); });
  const open = actor => {
    const s = new Store(root, actor); opened.push(s);
    return Object.assign(s, { closeForReopen() { s.close(); opened.splice(opened.indexOf(s), 1); } });
  };
  return { root, open };
}

test('actor slugs support named collaborators while preserving recipient-scoped messages and replies', async t => {
  const { open } = await stores(t);
  assert.equal(isValidActorSlug('codex'), true);
  assert.equal(isValidActorSlug('cursor'), true);
  assert.equal(isValidActorSlug('claude'), true);
  assert.equal(isValidActorSlug('research-1'), true);
  for (const invalid of ['', '1research', 'Research', 'a'.repeat(65), 'a/slash', 'a.b']) assert.equal(isValidActorSlug(invalid), false);
  const codex = open('codex'), claude = open('claude'), research = open('research-1');
  const message = codex.send({ recipient: 'claude', key: 'ask-1', body: 'Review this summary.' });
  assert.equal(claude.messages({}).items[0].id, message.id);
  assert.equal(research.messages({}).count, 0);
  assert.throws(() => research.ack({ id: message.id }), e => e.code === 'FORBIDDEN');
  claude.ack({ id: message.id });
  const reply = claude.send({ recipient: 'codex', key: 'reply-1', body: 'Reviewed.', reply_to: message.id });
  assert.equal(reply.reply_to, message.id);
  assert.equal(codex.messages({}).items[0].body, 'Reviewed.');
  assert.equal(research.createTask({ key: 'task-1', assignee: 'claude', title: 'Read-only review' }).assignee, 'claude');
});

test('activity publication is durable, actor-key idempotent, and conflict leaves no partial event', async t => {
  const { root, open } = await stores(t);
  const codex = open('codex');
  const input = { key: 'progress-1', kind: 'progress', summary: 'Updated local draft.', paths: ['Notes/draft.md'], evidence: 'review:source-only' };
  const first = codex.publishActivity(input);
  const retry = codex.publishActivity(input);
  assert.equal(retry.id, first.id);
  assert.deepEqual(codex.listActivity({}).items, [first]);
  const beforeEvents = codex.events({}).count;
  assert.throws(() => codex.publishActivity({ ...input, summary: 'Different payload.' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(codex.events({}).count, beforeEvents);
  const claude = open('claude');
  const ownKey = claude.publishActivity({ ...input, summary: 'Independent actor record.' });
  assert.notEqual(ownKey.id, first.id);
  codex.closeForReopen();
  const reopened = open('codex');
  assert.equal(reopened.listActivity({ actor: 'codex' }).items[0].id, first.id);
  assert.equal(reopened.listActivity({ actor: 'claude' }).items[0].actor, 'claude');
  const processRecord = reopened.publishActivity({ key: 'process-1', kind: 'process', summary: 'Self-reported process exit.', process: { pid: 123, state: 'exited', exit_code: 0 } });
  assert.deepEqual(processRecord.process, { pid: 123, state: 'exited', exit_code: 0 });
});

test('activity validates metadata paths and process assertions before any writes', async t => {
  const { open } = await stores(t), store = open('codex');
  const valid = store.publishActivity({ key: 'paths-1', kind: 'file', summary: 'Nonexistent relative path remains metadata.', paths: ['future/output.json'] });
  assert.deepEqual(valid.paths, ['future/output.json']);
  const baseline = store.events({}).count;
  const invalidPaths = ['/tmp/secret', '../escape', 'a/../b', 'a//b', 'a/./b', 'C:/secret', 'a\\b', 'bad\npath'];
  for (const [index, bad] of invalidPaths.entries())
    assert.throws(() => store.publishActivity({ key: `bad-${index}`, kind: 'file', summary: 'Rejected.', paths: [bad] }));
  assert.throws(() => store.publishActivity({ key: 'many', kind: 'file', summary: 'Rejected.', paths: Array.from({ length: 17 }, (_, i) => `p${i}`) }));
  assert.throws(() => store.publishActivity({ key: 'bad-process', kind: 'process', summary: 'Rejected.', process: { pid: 0, state: 'started', exit_code: null } }));
  assert.throws(() => store.publishActivity({ key: 'bad-transition', kind: 'process', summary: 'Rejected.', process: { pid: 4, state: 'started', exit_code: 1 } }));
  assert.equal(store.events({}).count, baseline);
  assert.equal(store.listActivity({}).count, 1);
});

test('activity listing is ascending, bounded, cursorable, and optionally actor-filtered', async t => {
  const { open } = await stores(t), a = open('codex'), b = open('cursor');
  for (let i = 0; i < 3; i++) a.publishActivity({ key: `a-${i}`, kind: 'checkpoint', summary: `A${i}` });
  b.publishActivity({ key: 'b-0', kind: 'decision', summary: 'B0' });
  const first = a.listActivity({ limit: 2 });
  assert.deepEqual(first.items.map(x => x.summary), ['A0', 'A1']);
  assert.equal(first.has_more, true);
  const second = a.listActivity({ after: first.next_cursor, limit: 2 });
  assert.deepEqual(second.items.map(x => x.summary), ['A2', 'B0']);
  assert.equal(second.has_more, false);
  assert.deepEqual(a.listActivity({ actor: 'cursor' }).items.map(x => x.actor), ['cursor']);
});

test('additive activity table opens a legacy schema-1 database and preserves its records', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursodex-activity-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.cursodex'));
  const db = new DatabaseSync(path.join(root, '.cursodex', 'state.sqlite'));
  const createdAt = Date.now() - 10000, now = Date.now();
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL,recipient TEXT NOT NULL,idem_key TEXT NOT NULL,payload TEXT NOT NULL,body TEXT NOT NULL,evidence TEXT NOT NULL,reply_to INTEGER,created_at INTEGER NOT NULL,ack_at INTEGER,UNIQUE(sender,idem_key),FOREIGN KEY(reply_to) REFERENCES messages(id));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,creator TEXT NOT NULL,assignee TEXT NOT NULL,idem_key TEXT NOT NULL,payload TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(creator,idem_key));
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,idem_key TEXT NOT NULL,payload TEXT NOT NULL,resources TEXT NOT NULL,token TEXT NOT NULL,expires_at INTEGER NOT NULL,released_at INTEGER,UNIQUE(actor,idem_key));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,actor TEXT NOT NULL,entity_id INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,body TEXT NOT NULL,evidence TEXT NOT NULL,revision INTEGER NOT NULL,author TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO meta VALUES (?,?)').run('project', realpathSync(root));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('schema', '1');
  const insertMessage = db.prepare('INSERT INTO messages(id,sender,recipient,idem_key,payload,body,evidence,reply_to,created_at,ack_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insertMessage.run(1, 'codex', 'cursor', 'ask-1', JSON.stringify({ recipient: 'cursor', body: 'Please inspect.', evidence: 'parent:a', reply_to: null }), 'Please inspect.', 'parent:a', null, createdAt, createdAt + 1);
  insertMessage.run(2, 'cursor', 'codex', 'reply-1', JSON.stringify({ recipient: 'codex', body: 'Reviewed.', evidence: '', reply_to: 1 }), 'Reviewed.', '', 1, createdAt + 2, null);
  db.prepare('INSERT INTO tasks(id,creator,assignee,idem_key,payload,title,summary,evidence,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(7, 'codex', 'cursor', 'goal-1', JSON.stringify({ assignee: 'cursor', title: 'Review', summary: 'Keep this revision.', evidence: 'task-parent' }), 'Review', 'Keep this revision.', 'task-parent', 'active', 2, createdAt, createdAt + 3);
  db.prepare('INSERT INTO memories(id,name,body,evidence,revision,author,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(3, 'shared-goal', 'Exact retained note.', 'note-parent', 3, 'cursor', createdAt + 4);
  const insertClaim = db.prepare('INSERT INTO claims(id,actor,idem_key,payload,resources,token,expires_at,released_at) VALUES (?,?,?,?,?,?,?,?)');
  insertClaim.run(5, 'codex', 'claim-active', JSON.stringify({ resources: ['path:notes'], ttl_ms: 60000 }), JSON.stringify(['path:notes']), 'private-active-token', now + 120000, null);
  insertClaim.run(6, 'cursor', 'claim-released', JSON.stringify({ resources: ['path:archive'], ttl_ms: 60000 }), JSON.stringify(['path:archive']), 'private-released-token', now - 1000, now - 500);
  const insertEvent = db.prepare('INSERT INTO events(id,kind,actor,entity_id,created_at) VALUES (?,?,?,?,?)');
  insertEvent.run(11, 'message.sent', 'codex', 1, createdAt);
  insertEvent.run(12, 'message.sent', 'cursor', 2, createdAt + 2);
  insertEvent.run(13, 'task.created', 'codex', 7, createdAt + 3);
  insertEvent.run(14, 'memory.updated', 'cursor', 3, createdAt + 4);
  insertEvent.run(15, 'claim.acquired', 'codex', 5, now);
  insertEvent.run(16, 'claim.released', 'cursor', 6, now);
  const legacyRows = Object.fromEntries(['messages', 'tasks', 'memories', 'claims'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const legacyEvents = db.prepare('SELECT * FROM events ORDER BY id').all();
  db.close();

  const codex = new Store(root, 'codex'), cursor = new Store(root, 'cursor');
  try {
    assert.equal(codex.db.prepare('SELECT value FROM meta WHERE key=?').get('schema').value, '1');
    assert.deepEqual(codex.messages({ direction: 'sent' }).items.map(x => x.id), [1]);
    assert.equal(codex.send({ recipient: 'cursor', key: 'ask-1', body: 'Please inspect.', evidence: 'parent:a' }).id, 1, 'legacy exact-key retry remains idempotent');
    assert.equal(codex.messages({ direction: 'inbox' }).items[0].reply_to, 1);
    assert.equal(codex.getTask({ id: 7 }).revision, 2);
    assert.equal(codex.getTask({ id: 7 }).state, 'active');
    assert.deepEqual({ ...codex.getMemory({ name: 'shared-goal' }) }, {
      id: 3, name: 'shared-goal', body: 'Exact retained note.', evidence: 'note-parent', revision: 3,
      author: 'cursor', updated_at: createdAt + 4
    });
    const codexClaims = codex.claims({ limit: 10 }).items;
    assert.equal(codexClaims.find(x => x.id === 5).active, true);
    assert.equal(codexClaims.find(x => x.id === 5).token, 'private-active-token');
    assert.equal(codexClaims.find(x => x.id === 6).token, undefined, 'other actor token remains private');
    const cursorClaims = cursor.claims({ limit: 10 }).items;
    assert.equal(cursorClaims.find(x => x.id === 6).active, false);
    assert.equal(cursorClaims.find(x => x.id === 6).token, 'private-released-token');

    assert.equal(codex.publishActivity({ key: 'new', kind: 'plan', summary: 'Added table without migration bump.' }).id, 1);
    for (const [table, original] of Object.entries(legacyRows))
      assert.deepEqual(codex.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), original, `${table} rows remain byte-for-byte equivalent as SQLite values`);
    assert.deepEqual(codex.db.prepare('SELECT * FROM events WHERE id<=? ORDER BY id').all(legacyEvents.at(-1).id), legacyEvents);
    assert.equal(codex.db.prepare('SELECT value FROM meta WHERE key=?').get('schema').value, '1');
  } finally { codex.close(); cursor.close(); }
});
