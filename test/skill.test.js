import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../cli/skill.mjs';

const bin = fileURLToPath(new URL('../bin/cursodex.mjs', import.meta.url));
const run = promisify(execFile);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cursodex-skill-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(path.join(source, 'agents'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: cursodex\ndescription: Coordinate a shared project over Cursodex MCP.\n---\n');
  await fs.writeFile(path.join(source, 'agents/openai.yaml'), 'interface:\n  display_name: "Cursodex"\n');
  return { root, source, target };
}
test('skill dry run is write-free; explicit install is byte-exact and idempotent', async t => {
  const f = await fixture(t);
  const dry = await installSkill({ target: f.target, dryRun: true }, f.source);
  assert.equal(dry.dry_run, true);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const first = await installSkill({ target: f.target }, f.source);
  assert.equal(first.changed, true);
  for (const file of first.files) assert.deepEqual(await fs.readFile(path.join(f.target, file.name)), await fs.readFile(path.join(f.source, file.name)));
  const second = await installSkill({ target: f.target }, f.source);
  assert.equal(second.changed, false);
  assert.deepEqual(second.files, first.files);
});
test('skill installation retains changed or additional existing files', async t => {
  const f = await fixture(t);
  await installSkill({ target: f.target }, f.source);
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'User-maintained skill');
  await assert.rejects(installSkill({ target: f.target }, f.source), /retained unchanged/);
  assert.equal(await fs.readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'User-maintained skill');
  await fs.copyFile(path.join(f.source, 'SKILL.md'), path.join(f.target, 'SKILL.md'));
  await fs.writeFile(path.join(f.target, 'private.txt'), 'Preserve me');
  await assert.rejects(installSkill({ target: f.target, dryRun: true }, f.source), /retained unchanged/);
  assert.equal(await fs.readFile(path.join(f.target, 'private.txt'), 'utf8'), 'Preserve me');
});
test('skill installation refuses missing parents, aliases and non-files before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(installSkill({ target: 'relative' }, f.source), /absolute/);
  await assert.rejects(installSkill({ target: path.join(f.root, 'missing', 'skill') }, f.source), /already exist/);
  await fs.mkdir(path.join(f.source, 'nonfile'));
  await fs.rm(path.join(f.source, 'SKILL.md'));
  await fs.mkdir(path.join(f.source, 'SKILL.md'));
  await assert.rejects(installSkill({ target: f.target }, f.source), /lacks SKILL.md/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});
test('skill symlinks and hard-linked content are refused without changing their targets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await fs.symlink(f.source, f.target);
  await assert.rejects(installSkill({ target: f.target }, f.source), /symlink/);
  await fs.unlink(f.target);
  await fs.symlink(path.join(f.source, 'agents/openai.yaml'), path.join(f.source, 'alias.yaml'));
  await assert.rejects(installSkill({ target: f.target }, f.source), /symlinked/);
  await fs.unlink(path.join(f.source, 'alias.yaml'));
  await fs.link(path.join(f.source, 'SKILL.md'), path.join(f.source, 'alias.md'));
  await assert.rejects(installSkill({ target: f.target }, f.source), /hard-linked/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});
test('public bin installs the bundled skill without host configuration or project-state side effects', async t => {
  const f = await fixture(t);
  const result = await run(process.execPath, [bin, 'install-skill', '--target', f.target], { timeout: 10000 });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.changed, true);
  assert.ok(receipt.files.some(file => file.name === 'SKILL.md'));
  const text = await fs.readFile(path.join(f.target, 'SKILL.md'), 'utf8');
  assert.match(text, /name: cursodex/);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['source', 'target']);
  await assert.rejects(run(process.execPath, [bin, 'install-skill', '--target', f.target, '--force']), /Unknown option/);
});
