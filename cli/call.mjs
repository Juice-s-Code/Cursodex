import { parseJSON, readJSONFile, runRequest, validateRequest } from './client.mjs';

/** Parse the public call command completely before starting a stdio child. */
export function parseCallArguments(argv) {
  const accepted = new Set(['--request', '--agent', '--project', '--tool', '--arguments-file', '--arguments', '--deadline-ms']);
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!accepted.has(flag)) throw new Error('Unknown call option: ' + flag);
    if (options.has(flag)) throw new Error('Duplicate call option: ' + flag);
    const value = argv[++i];
    if (typeof value !== 'string' || !value.length || value.startsWith('--')) throw new Error('Missing value for ' + flag);
    options.set(flag, value);
  }
  if (options.has('--request')) {
    if (options.size !== 1) throw new Error('--request cannot be combined with single-call options.');
    return validateRequest(readJSONFile(options.get('--request')));
  }
  if (!options.has('--agent') || !options.has('--project') || !options.has('--tool'))
    throw new Error('Call requires --request ABS or --agent codex|cursor --project ABS --tool cursodex_NAME.');
  if (options.has('--arguments') && options.has('--arguments-file')) throw new Error('Choose only one arguments input.');
  const rawDeadline = options.get('--deadline-ms');
  if (rawDeadline !== undefined && !/^[1-9][0-9]*$/.test(rawDeadline)) throw new Error('--deadline-ms must be an integer from 1000 to 60000.');
  const argumentsValue = options.has('--arguments-file') ? readJSONFile(options.get('--arguments-file'), 'Arguments') :
    options.has('--arguments') ? parseJSON(options.get('--arguments'), 'Arguments') : {};
  return validateRequest({ actor: options.get('--agent'), projectRoot: options.get('--project'),
    deadlineMs: rawDeadline === undefined ? 60000 : Number(rawDeadline),
    calls: [{ name: options.get('--tool'), arguments: argumentsValue }] });
}
/** Bin routing calls this handler with flags after the call command. */
export async function main(argv = process.argv.slice(2)) {
  const result = await runRequest(parseCallArguments(argv));
  process.stdout.write(JSON.stringify(result.receipt) + '\n');
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}
