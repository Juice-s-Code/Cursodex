#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseTOML } from 'smol-toml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CONFIG = 262144;
const hash = value => createHash('sha256').update(value).digest('hex');
const die = message => { throw Error(message); };
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
async function optionalStat(name) { try { return await fs.lstat(name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
/** Refuse symlinks at every existing ancestor, including the leaf. */
async function safePath(name, leaf = 'file') {
  if (!path.isAbsolute(name)) die('Use an absolute path: ' + name);
  const parsed = path.parse(name);
  let cursor = parsed.root;
  const parts = name.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const st = await optionalStat(cursor);
    if (!st) continue;
    if (st.isSymbolicLink()) die('Refusing symlink: ' + cursor);
    const directory = i < parts.length - 1 || leaf === 'directory';
    if (directory ? !st.isDirectory() : !st.isFile()) die('Unexpected path type: ' + cursor);
  }
}
async function readConfig(name) {
  await safePath(name);
  const st = await optionalStat(name);
  if (!st) return null;
  if (st.size > MAX_CONFIG) die('Configuration exceeds 256 KiB: ' + name);
  const bytes = await fs.readFile(name);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes, text, mode: st.mode & 0o777 };
}
function tomlEntry(entry) {
  return '[mcp_servers.cursodex]\ncommand = ' + JSON.stringify(entry.command) +
    '\nargs = ' + JSON.stringify(entry.args) + '\n';
}
function tablePath(header) {
  const probe = parseTOML(header + '\n__cursodex_probe = true\n');
  function walk(v, prefix = []) {
    if (object(v) && v.__cursodex_probe === true) return prefix;
    if (!object(v)) return null;
    for (const [k, child] of Object.entries(v)) { const found = walk(child, [...prefix, k]); if (found) return found; }
    return null;
  }
  return walk(probe);
}
export function mergeCodex(text, entry, force = false) {
  const parsed = parseTOML(text);
  if (parsed.mcp_servers !== undefined && !object(parsed.mcp_servers)) die('Codex mcp_servers must be a table.');
  const previous = parsed.mcp_servers?.cursodex;
  if (previous !== undefined && equal(previous, entry)) return text;
  if (previous !== undefined && !force) die('Conflicting Codex cursodex entry; use --force to replace only that entry.');
  const sections = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const candidate = line.trim();
    if (/^\[.+\]\s*(?:#.*)?$/.test(candidate)) {
      // Prefix validation excludes apparent headers inside unfinished arrays/multiline strings.
      try {
        parseTOML(text.slice(0, offset) + line);
        sections.push({ start: offset, path: tablePath(candidate) });
      } catch { /* Not an independently completed TOML table header. */ }
    }
    offset += line.length;
  }
  if (sections.length > 512) die('Too many TOML tables.');
  const selected = sections.filter(s => s.path?.[0] === 'mcp_servers' && s.path?.[1] === 'cursodex');
  if (previous !== undefined && !selected.length) die('Inline/dotted Cursodex entries cannot be safely replaced; use a [mcp_servers.cursodex] table.');
  let next = text;
  for (const s of selected.reverse()) {
    const index = sections.indexOf(s);
    const end = sections[index + 1]?.start ?? text.length;
    next = next.slice(0, s.start) + next.slice(end);
  }
  next = next.replace(/\s*$/, '') + (next.trim() ? '\n\n' : '') + tomlEntry(entry);
  const check = parseTOML(next);
  const beforeOther = structuredClone(parsed), afterOther = structuredClone(check);
  if (beforeOther.mcp_servers) delete beforeOther.mcp_servers.cursodex;
  if (afterOther.mcp_servers) delete afterOther.mcp_servers.cursodex;
  if (!beforeOther.mcp_servers && afterOther.mcp_servers && !Object.keys(afterOther.mcp_servers).length) delete afterOther.mcp_servers;
  if (!equal(beforeOther, afterOther) || !equal(check.mcp_servers?.cursodex, entry)) die('TOML preservation check failed.');
  return next;
}
export function mergeCursor(text, entry, force = false) {
  const parsed = JSON.parse(text || '{}');
  if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers))) die('Cursor config and mcpServers must be JSON objects.');
  const previous = parsed.mcpServers?.cursodex;
  if (previous !== undefined && equal(previous, entry)) return text;
  if (previous !== undefined && !force) die('Conflicting Cursor cursodex entry; use --force to replace only that entry.');
  parsed.mcpServers = { ...parsed.mcpServers, cursodex: entry };
  return JSON.stringify(parsed, null, 2) + '\n';
}
async function packageAt(name, from) {
  if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) die('Invalid dependency name.');
  const search = createRequire(path.join(from, 'package.json')).resolve.paths(name) ?? [];
  const localSearch = new Set();
  for (let ancestor = from; ; ancestor = path.dirname(ancestor)) {
    localSearch.add(path.join(ancestor, 'node_modules'));
    if (path.dirname(ancestor) === ancestor) break;
  }
  for (const base of search) {
    if (!localSearch.has(base)) continue; // Never depend on NODE_PATH/global fallback state.
    const candidate = path.join(base, name);
    if (!(await optionalStat(candidate))) continue;
    await safePath(candidate, 'directory');
    return candidate;
  }
  return null;
}
/** Preserve the installed npm resolution layout; do not install or execute packages. */
async function runtimePlan(root) {
  const nodes = new Map();
  async function visit(dir) {
    dir = path.resolve(dir);
    if (nodes.has(dir)) return;
    if (nodes.size >= 256) die('Production dependency graph exceeds 256 packages.');
    await safePath(dir, 'directory');
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    nodes.set(dir, pkg);
    const dependencies = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = await packageAt(name, dir);
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name) || pkg.peerDependenciesMeta?.[name]?.optional === true;
      if (!resolved) { if (optional) continue; die('Missing production dependency ' + name + '; install this package normally first.'); }
      await visit(resolved);
    }
  }
  await visit(root);
  let base = root;
  for (const dir of nodes.keys()) {
    while (true) {
      const rel = path.relative(base, dir);
      if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) break;
      const parent = path.dirname(base);
      if (parent === base) die('Dependencies on separate filesystem roots cannot be snapshotted.');
      base = parent;
    }
  }
  // Keep the node_modules directory itself when packages are hoisted siblings.
  // Renaming that ancestor to tree would break Node's package lookup.
  for (let ancestor = base; ; ancestor = path.dirname(ancestor)) {
    if (path.basename(ancestor).toLowerCase() === 'node_modules') {
      base = path.dirname(ancestor);
      break;
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const files = [];
  let totalBytes = 0;
  async function collect(source, relative) {
    const st = await fs.lstat(source);
    if (st.isSymbolicLink()) die('Symlinked package content is unsupported: ' + source);
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(source)).sort()) {
        if (['node_modules', '.git', '.cursodex'].includes(name)) continue;
        await collect(path.join(source, name), path.join(relative, name));
      }
    } else {
      if (!st.isFile()) die('Unsupported package file: ' + source);
      totalBytes += st.size;
      if (files.length >= 20000 || totalBytes > 134217728) die('Runtime snapshot exceeds 20,000 files or 128 MiB.');
      const bytes = await fs.readFile(source);
      files.push({ source, relative, bytes: bytes.length, sha256: hash(bytes), mode: st.mode & 0o777 });
    }
  }
  for (const dir of [...nodes.keys()].sort()) {
    const relative = path.join('tree', path.relative(base, dir));
    if (dir === root) {
      for (const name of ['package.json', 'src', 'bin']) await collect(path.join(dir, name), path.join(relative, name));
    } else await collect(dir, relative);
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const manifest = files.map(({ relative, bytes, sha256, mode }) => ({ relative, bytes, sha256, mode }));
  const digest = hash(JSON.stringify(manifest));
  return { files, manifest, digest, entry: path.join('tree', path.relative(base, root), 'bin', 'cursodex.mjs'), bytes: totalBytes };
}
async function verifyRuntime(directory, plan) {
  await safePath(directory, 'directory');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8'));
  if (!equal(manifest, plan.manifest)) die('Existing runtime manifest conflicts; retained unchanged.');
  for (const file of plan.files) {
    const target = path.join(directory, file.relative);
    await safePath(target);
    if (hash(await fs.readFile(target)) !== file.sha256) die('Existing runtime file differs: ' + target);
  }
}
async function stageRuntime(directory, plan) {
  await safePath(path.dirname(directory), 'directory');
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  if (await optionalStat(directory)) { await verifyRuntime(directory, plan); return; }
  const staging = directory + '.stage-' + randomUUID();
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of plan.files) {
      const bytes = await fs.readFile(file.source);
      if (hash(bytes) !== file.sha256) die('Package changed during setup: ' + file.source);
      const target = path.join(staging, file.relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: file.mode });
    }
    await fs.writeFile(path.join(staging, 'snapshot.json'), JSON.stringify(plan.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(staging, directory);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
async function unchanged(target, prior) {
  const current = await readConfig(target);
  if ((prior === null) !== (current === null) || (prior && !prior.bytes.equals(current.bytes))) die('Configuration changed concurrently: ' + target);
}
async function atomicWrite(target, bytes, mode) {
  const temporary = path.join(path.dirname(target), '.cursodex-config-' + randomUUID() + '.tmp');
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
  try { await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function setup(options, sourceRoot = packageRoot) {
  if (!options.project || !path.isAbsolute(options.project)) die('--project requires an absolute existing directory.');
  const project = path.resolve(options.project);
  await safePath(project, 'directory');
  if (!(await optionalStat(project))) die('Project directory must already exist.');
  const targets = [
    { kind: 'codex', path: options.codexConfig ?? path.join(project, '.codex', 'config.toml') },
    { kind: 'cursor', path: options.cursorConfig ?? path.join(project, '.cursor', 'mcp.json') }
  ];
  if (path.resolve(targets[0].path).normalize('NFC').toLowerCase() === path.resolve(targets[1].path).normalize('NFC').toLowerCase()) die('Codex and Cursor config paths must differ.');
  for (const target of targets) { if (!path.isAbsolute(target.path)) die('Configuration override paths must be absolute.'); target.prior = await readConfig(target.path); }
  const plan = await runtimePlan(sourceRoot);
  const runtime = path.join(project, '.cursodex', 'runtime', plan.digest);
  await safePath(runtime, 'directory');
  const executable = path.join(runtime, plan.entry);
  for (const target of targets) {
    const entry = { command: process.execPath, args: [executable, 'server', '--agent', target.kind, '--project', project] };
    target.next = target.kind === 'codex'
      ? mergeCodex(target.prior?.text ?? '', entry, options.force)
      : mergeCursor(target.prior?.text ?? '{}', entry, options.force);
  }
  const changes = targets.filter(t => t.next !== t.prior?.text);
  const result = { dry_run: Boolean(options.dryRun), project, runtime, runtime_bytes: plan.bytes,
    configurations: targets.map(t => ({ client: t.kind, path: t.path, changed: changes.includes(t) })), backups: [] };
  if (options.dryRun) return result;
  await stageRuntime(runtime, plan);
  // Back up all originals before changing either configuration.
  for (const target of changes) {
    await unchanged(target.path, target.prior);
    await safePath(path.dirname(target.path), 'directory');
    await fs.mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
    if (target.prior) {
      const backup = target.path + '.cursodex-backup-' + Date.now() + '-' + randomUUID();
      await fs.writeFile(backup, target.prior.bytes, { flag: 'wx', mode: target.prior.mode });
      result.backups.push(backup);
    }
  }
  const committed = [];
  try {
    for (const target of changes) {
      await unchanged(target.path, target.prior);
      await atomicWrite(target.path, Buffer.from(target.next), target.prior?.mode ?? 0o600);
      committed.push(target);
    }
  } catch (error) {
    for (const target of committed.reverse()) {
      const current = await readConfig(target.path);
      if (current?.text !== target.next) continue; // Never overwrite a later external edit.
      if (target.prior) await atomicWrite(target.path, target.prior.bytes, target.prior.mode);
      else await fs.unlink(target.path); // Only the exact file created by this failed setup.
    }
    throw error;
  }
  return result;
}
const HELP = 'Cursodex — local Codex/Cursor coordination over MCP stdio\n\n' +
  'cursodex setup --project ABS [--codex-config ABS] [--cursor-config ABS] [--dry-run] [--force]\n' +
  'cursodex server --agent codex|cursor --project ABS\n' +
  'cursodex cloud --project ABS [--host HOST] [--port PORT]\n' +
  'cursodex --help | --version\n\n' +
  'Setup validates and merges both project configs, backs up changed originals and snapshots\n' +
  'installed production dependencies into PROJECT/.cursodex/runtime. No install, authentication,\n' +
  'inference or client restart is performed. --force replaces only an existing cursodex entry.\n' +
  'Dry run writes nothing. Existing symlinks/nonfiles and uncertain config edits are refused.\n';
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); return; }
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version + '\n'); return;
  }
  const [command, ...args] = argv;
  if (!['setup', 'server', 'cloud'].includes(command)) die('Unknown command. Use cursodex --help.');
  const options = {}, accepted = command === 'server' ? ['--project', '--agent'] : command === 'cloud' ? ['--project', '--host', '--port'] : ['--project', '--codex-config', '--cursor-config', '--dry-run', '--force'];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!accepted.includes(flag)) die('Unknown option: ' + flag);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(options, key)) die('Duplicate option: ' + flag);
    if (['--dry-run', '--force'].includes(flag)) options[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) die('Missing value for ' + flag); options[key] = args[++i]; }
  }
  if (!options.project || !path.isAbsolute(options.project)) die('--project requires an absolute existing directory.');
  if (command === 'setup') { process.stdout.write(JSON.stringify(await setup(options), null, 2) + '\n'); return; }
  if (command === 'cloud') {
    const port = options.port === undefined ? 8787 : Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (options.port !== undefined && !/^[0-9]+$/.test(options.port))) die('--port must be an integer from 1 to 65535.');
    await safePath(options.project, 'directory');
    const { startCloud } = await import('../src/http.js');
    await startCloud({ projectRoot: options.project, host: options.host ?? '127.0.0.1', port });
    return;
  }
  if (!['codex', 'cursor'].includes(options.agent)) die('--agent must be codex or cursor.');
  await safePath(options.project, 'directory');
  process.env.PROJECT_ROOT = options.project;
  process.env.CURSODEX_AGENT = options.agent;
  const { main: startServer } = await import('../src/index.js');
  await startServer();
}
const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(error => { process.stderr.write('Cursodex: ' + error.message + '\n'); process.exitCode = 1; });
}
