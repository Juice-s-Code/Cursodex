import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const bundledSkill = fileURLToPath(new URL('../skills/cursodex', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function stat(name) {
  try { return await fs.lstat(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(name, required = true) {
  if (!path.isAbsolute(name)) throw Error('Skill paths must be absolute.');
  let cursor = path.parse(name).root;
  for (const part of name.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const value = await stat(cursor);
    if (!value) { if (required) throw Error('Directory must already exist: ' + cursor); continue; }
    if (value.isSymbolicLink() || !value.isDirectory()) throw Error('Refusing symlink or non-directory: ' + cursor);
  }
}
async function files(root) {
  await directory(root);
  const result = [];
  let total = 0;
  async function visit(relative) {
    for (const item of (await fs.readdir(path.join(root, relative))).sort()) {
      const name = path.join(relative, item), absolute = path.join(root, name);
      const value = await fs.lstat(absolute);
      if (value.isSymbolicLink()) throw Error('Refusing symlinked skill content: ' + name);
      if (value.isDirectory()) await visit(name);
      else {
        if (!value.isFile() || value.nlink > 1) throw Error('Refusing non-file or hard-linked skill content: ' + name);
        total += value.size;
        if (result.length >= 100 || total > 1048576) throw Error('Skill exceeds 100 files or 1 MiB.');
        const bytes = await fs.readFile(absolute);
        if (bytes.length !== value.size) throw Error('Skill content changed during read.');
        result.push({ name, bytes, sha256: digest(bytes) });
      }
    }
  }
  await visit('');
  if (!result.some(file => file.name === 'SKILL.md')) throw Error('Bundled skill lacks SKILL.md.');
  return result;
}

/** Explicit portable skill installation only; never edits a host's configuration. */
export async function installSkill({ target, dryRun = false }, source = bundledSkill) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('--target requires an absolute skill directory.');
  target = path.resolve(target);
  await directory(path.dirname(target)); // The caller chooses and creates its host skill location.
  await directory(target, false);
  const content = await files(source);
  const existing = await stat(target);
  if (existing) {
    const previous = await files(target);
    if (previous.length !== content.length || previous.some((file, i) => file.name !== content[i].name || file.sha256 !== content[i].sha256)) {
      throw Error('Existing skill differs; retained unchanged. Choose a new target or review the existing skill.');
    }
  }
  const receipt = { target, dry_run: dryRun, changed: !existing, files: content.map(({ name, sha256 }) => ({ name, sha256 })) };
  if (dryRun || existing) return receipt;
  // Exclusive creation prevents overwriting a concurrent installation. If a write fails,
  // retain the partial directory for review rather than recursively deleting unknown files.
  await fs.mkdir(target, { mode: 0o755 });
  for (const file of content) {
    await fs.mkdir(path.dirname(path.join(target, file.name)), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(target, file.name), file.bytes, { flag: 'wx', mode: 0o644 });
  }
  return receipt;
}

export async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--target', '--dry-run'].includes(flag)) throw Error('Unknown option: ' + flag);
    const key = flag === '--target' ? 'target' : 'dryRun';
    if (Object.hasOwn(options, key)) throw Error('Duplicate option: ' + flag);
    if (key === 'dryRun') options[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for ' + flag);
      options[key] = args[++i];
    }
  }
  process.stdout.write(JSON.stringify(await installSkill(options)) + '\n');
}
