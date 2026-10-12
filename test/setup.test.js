import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseTOML } from 'smol-toml';
import { setup, mergeCodex, mergeCursor } from '../bin/cursodex.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cursodex-setup-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'installed package');
  const project = path.join(base, 'project with spaces');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, 'bin'));
  await fs.mkdir(project);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture-cursodex', version: '1.0.0', type: 'module', dependencies: {} }));
  await fs.writeFile(path.join(source, 'src', 'index.js'), 'export async function main() {}\n');
  await fs.writeFile(path.join(source, 'bin', 'cursodex.mjs'), '// Stable fictional runtime fixture; never executed.\n');
  return { base, source, project };
}
async function configs(project) {
  return {
    codex: parseTOML(await fs.readFile(path.join(project, '.codex', 'config.toml'), 'utf8')),
    cursor: JSON.parse(await fs.readFile(path.join(project, '.cursor', 'mcp.json'), 'utf8'))
  };
}
const desired = { command: '/durable/node', args: ['/durable/server', 'server', '--agent', 'codex', '--project', '/project'] };

test('dry run writes no runtime, configs, backups or state', async t => {
  const f = await fixture(t);
  const result = await setup({ project: f.project, dryRun: true }, f.source);
  assert.equal(result.dry_run, true);
  assert.equal(result.configurations.length, 2);
  assert.deepEqual(await fs.readdir(f.project), []);
});

test('setup copies a durable runtime, preserves existing servers, and shares the exact project', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, '.codex'));
  await fs.mkdir(path.join(f.project, '.cursor'));
  await fs.mkdir(path.join(f.project, '.cursodex'));
  const database = Buffer.from('existing protected database bytes');
  await fs.writeFile(path.join(f.project, '.cursodex', 'state.sqlite'), database);
  const toml = '# Retain this comment\nmodel = "example"\n[mcp_servers.existing]\ncommand = "existing-tool"\nargs = ["unchanged"]\n';
  const json = JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'existing-tool', env: { KEEP: 'yes' } } } });
  await fs.writeFile(path.join(f.project, '.codex', 'config.toml'), toml);
  await fs.writeFile(path.join(f.project, '.cursor', 'mcp.json'), json);
  const result = await setup({ project: f.project }, f.source);
  const current = await configs(f.project);
  assert.equal(current.codex.model, 'example');
  assert.equal(current.codex.mcp_servers.existing.command, 'existing-tool');
  assert.equal(current.cursor.theme, 'dark');
  assert.equal(current.cursor.mcpServers.existing.env.KEEP, 'yes');
  assert.equal(result.backups.length, 2);
  const backedUp = await Promise.all(result.backups.map(p => fs.readFile(p, 'utf8')));
  assert.ok(backedUp.includes(toml)); assert.ok(backedUp.includes(json));
  for (const [actor, entry] of [['codex', current.codex.mcp_servers.cursodex], ['cursor', current.cursor.mcpServers.cursodex]]) {
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args.slice(1), ['server', '--agent', actor, '--project', f.project]);
    assert.ok(entry.args[0].startsWith(result.runtime + path.sep));
    assert.equal(await fs.readFile(entry.args[0], 'utf8'), '// Stable fictional runtime fixture; never executed.\n');
  }
  assert.deepEqual(await fs.readFile(path.join(f.project, '.cursodex', 'state.sqlite')), database);
  await fs.rm(f.source, { recursive: true });
  assert.ok((await fs.stat(current.codex.mcp_servers.cursodex.args[0])).isFile());
});

test('repeat setup is idempotent and creates no extra backups', async t => {
  const f = await fixture(t);
  const first = await setup({ project: f.project }, f.source);
  const before = await fs.readFile(path.join(f.project, '.codex', 'config.toml'));
  const second = await setup({ project: f.project }, f.source);
  assert.equal(first.runtime, second.runtime);
  assert.ok(second.configurations.every(c => !c.changed));
  assert.deepEqual(second.backups, []);
  assert.deepEqual(await fs.readFile(path.join(f.project, '.codex', 'config.toml')), before);
});

test('conflict is refused before mutation; force replaces only the named entries with exact backups', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, '.codex'));
  await fs.mkdir(path.join(f.project, '.cursor'));
  const oldTOML = '# retain\n[mcp_servers.cursodex]\ncommand="old"\n[mcp_servers.cursodex.env]\nOLD="value"\n[mcp_servers.other]\ncommand="other"\n';
  const oldJSON = '{"mcpServers":{"cursodex":{"command":"old"},"other":{"command":"other"}},"keep":42}';
  await fs.writeFile(path.join(f.project, '.codex', 'config.toml'), oldTOML);
  await fs.writeFile(path.join(f.project, '.cursor', 'mcp.json'), oldJSON);
  await assert.rejects(setup({ project: f.project }, f.source), /Conflicting/);
  assert.equal(await fs.readFile(path.join(f.project, '.codex', 'config.toml'), 'utf8'), oldTOML);
  await assert.rejects(fs.stat(path.join(f.project, '.cursodex')), { code: 'ENOENT' });
  const result = await setup({ project: f.project, force: true }, f.source);
  const current = await configs(f.project);
  assert.equal(current.codex.mcp_servers.other.command, 'other');
  assert.equal(current.cursor.mcpServers.other.command, 'other');
  assert.equal(current.cursor.keep, 42);
  assert.equal(current.codex.mcp_servers.cursodex.env, undefined);
  assert.equal(result.backups.length, 2);
});

test('TOML quoted tables and apparent headers in multiline strings preserve unrelated bytes', () => {
  const input = 'note = """\n[mcp_servers.fake]\nnot a table\n"""\n["mcp_servers"."cursodex"]\ncommand="old"\n[other]\nx=7\n';
  const output = mergeCodex(input, desired, true);
  assert.equal(parseTOML(output).note, parseTOML(input).note);
  assert.equal(parseTOML(output).other.x, 7);
  assert.ok(output.includes('[other]\nx=7'));
  assert.deepEqual(parseTOML(output).mcp_servers.cursodex.args, desired.args);
  assert.throws(() => mergeCodex('mcp_servers={cursodex={command="old"}}\n', desired, true), /Inline\/dotted/);
});

test('malformed and wrong-shaped configs fail without rewriting unrelated data', () => {
  assert.throws(() => mergeCodex('[broken', desired), /./);
  assert.throws(() => mergeCodex('mcp_servers="wrong"\n', desired), /table/);
  assert.throws(() => mergeCursor('{bad', desired), /./);
  assert.throws(() => mergeCursor('{"mcpServers":[]}', desired), /objects/);
  assert.throws(() => mergeCursor('{"mcpServers":{"cursodex":{"command":"other"}}}', desired), /Conflicting/);
});

test('symlinked configs and nonfile targets are refused without runtime writes', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, '.codex'));
  const outside = path.join(f.base, 'outside.toml');
  await fs.writeFile(outside, '# protected\n');
  await fs.symlink(outside, path.join(f.project, '.codex', 'config.toml'));
  await assert.rejects(setup({ project: f.project, force: true }, f.source), /symlink/);
  assert.equal(await fs.readFile(outside, 'utf8'), '# protected\n');
  await fs.unlink(path.join(f.project, '.codex', 'config.toml'));
  await fs.mkdir(path.join(f.project, '.codex', 'config.toml'));
  await assert.rejects(setup({ project: f.project }, f.source), /path type/);
  await assert.rejects(fs.stat(path.join(f.project, '.cursodex')), { code: 'ENOENT' });
});

test('tampered durable runtime is retained and refused; setup does not touch database or configs', async t => {
  const f = await fixture(t);
  await setup({ project: f.project }, f.source);
  const current = await configs(f.project);
  const entry = current.codex.mcp_servers.cursodex.args[0];
  await fs.writeFile(entry, '// unexpected edit\n');
  const prior = await fs.readFile(path.join(f.project, '.codex', 'config.toml'));
  await assert.rejects(setup({ project: f.project, force: true }, f.source), /runtime file differs/);
  assert.equal(await fs.readFile(entry, 'utf8'), '// unexpected edit\n');
  assert.deepEqual(await fs.readFile(path.join(f.project, '.codex', 'config.toml')), prior);
});

test('absolute config overrides work without altering default locations or accepting same-path aliases', async t => {
  const f = await fixture(t);
  const codexConfig = path.join(f.project, 'configs', 'codex.toml');
  const cursorConfig = path.join(f.project, 'configs', 'cursor.json');
  await setup({ project: f.project, codexConfig, cursorConfig }, f.source);
  assert.ok(parseTOML(await fs.readFile(codexConfig, 'utf8')).mcp_servers.cursodex);
  assert.ok(JSON.parse(await fs.readFile(cursorConfig, 'utf8')).mcpServers.cursodex);
  await assert.rejects(fs.stat(path.join(f.project, '.codex')), { code: 'ENOENT' });
  await assert.rejects(setup({ project: f.project, codexConfig, cursorConfig: codexConfig.toUpperCase() }, f.source), /must differ/);
  await assert.rejects(setup({ project: 'relative' }, f.source), /absolute/);
});

test('missing declared production dependency fails before project mutation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'cursodex-nonexistent-fixture-dependency': '0.0.0' } }));
  await assert.rejects(setup({ project: f.project }, f.source), /Missing production dependency/);
  assert.deepEqual(await fs.readdir(f.project), []);
});

test('npm-style symlinked bin invokes help and version without setup side effects', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const shim = path.join(f.base, 'cursodex');
  await fs.symlink(fileURLToPath(new URL('../bin/cursodex.mjs', import.meta.url)), shim);
  const run = promisify(execFile);
  const help = await run(process.execPath, [shim, '--help'], { timeout: 5000 });
  assert.match(help.stdout, /cursodex setup --project ABS/);
  assert.match(help.stdout, /cursodex cloud --project ABS/);
  const version = await run(process.execPath, [shim, '--version'], { timeout: 5000 });
  assert.match(version.stdout.trim(), /^[0-9]+\.[0-9]+\.[0-9]+/);
  assert.deepEqual(await fs.readdir(f.project), []);
});

test('hoisted npm sibling and transitive dependencies remain executable after the installation is removed', async t => {
  const f = await fixture(t);
  const install = path.join(f.base, 'npx-cache');
  const modules = path.join(install, 'node_modules');
  const source = path.join(modules, 'fixture-cursodex');
  const dependency = path.join(modules, 'fixture-dependency');
  const transitive = path.join(modules, 'fixture-transitive');
  for (const dir of [path.join(source, 'bin'), path.join(source, 'src'), dependency, transitive]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'fixture-cursodex', version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' }
  }));
  await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({
    name: 'fixture-dependency', version: '1.0.0', type: 'module', main: './index.js',
    dependencies: { 'fixture-transitive': '1.0.0' }
  }));
  await fs.writeFile(path.join(transitive, 'package.json'), JSON.stringify({
    name: 'fixture-transitive', version: '1.0.0', type: 'module', main: './index.js'
  }));
  await fs.writeFile(path.join(transitive, 'index.js'), 'export const word = "transitive";\n');
  await fs.writeFile(path.join(dependency, 'index.js'),
    'import { word } from "fixture-transitive"; export const message = "durable " + word;\n');
  await fs.writeFile(path.join(source, 'src', 'index.js'), 'export async function main() {}\n');
  await fs.writeFile(path.join(source, 'src', 'http.js'),
    'import { message } from "fixture-dependency"; export const cloudFixture = message;\n');
  await fs.writeFile(path.join(source, 'bin', 'cursodex.mjs'),
    'import { message } from "fixture-dependency"; import { cloudFixture } from "../src/http.js"; process.stdout.write(message + "|" + cloudFixture);\n');
  const result = await setup({ project: f.project }, source);
  const current = await configs(f.project);
  const executable = current.codex.mcp_servers.cursodex.args[0];
  assert.ok(executable.startsWith(result.runtime + path.sep));
  assert.ok(executable.includes(path.join('tree', 'node_modules', 'fixture-cursodex')));
  await fs.rm(install, { recursive: true });
  const run = promisify(execFile);
  const executed = await run(process.execPath, [executable], { timeout: 5000, cwd: f.project });
  assert.equal(executed.stdout, 'durable transitive|durable transitive');
});
