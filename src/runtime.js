import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Fixed package-relative metadata, read once for this module's lifetime. A disk
// update must not make an already running server advertise a newer version.
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const field of ['name', 'version']) {
  const value = metadata?.[field];
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || Buffer.byteLength(value) > 128)
    throw new Error('Cursodex package metadata requires a bounded name and version.');
}
export const PACKAGE_VERSION = metadata.version;
// Diagnostic self-report only, not artifact integrity, actor authentication or
// proof that an AI host used this server. Shared by sessions in this process.
export const RUNTIME = Object.freeze({
  package_name: metadata.name,
  package_version: PACKAGE_VERSION,
  instance_id: randomUUID(),
});
