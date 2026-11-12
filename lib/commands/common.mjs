// Shared helpers for commands: errors with exit codes, flag parsing, machine-state access.
import fs from 'node:fs';
import { readJson, writeJsonAtomic } from '../store.mjs';
import { withLock } from '../lock.mjs';
import { emptyRegistry } from '../registry.mjs';
import { registryPath, machineLockPath, toolsPath } from '../paths.mjs';

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const usage = (message) => new CliError(message, 2);

export function parseFlags(args, { bool = [], value = [] }, command) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (bool.includes(name)) flags[name] = true;
    else if (value.includes(name)) {
      if (i + 1 >= args.length) throw usage(`${command}: option "${a}" needs a value`);
      i += 1;
      flags[name] = args[i];
    } else throw usage(`${command}: unknown option "${a}"`);
  }
  return { flags, positional };
}

export const playbook = (name) => JSON.parse(fs.readFileSync(new URL(`../../playbook/${name}`, import.meta.url), 'utf8'));

export const MAX_INPUT = 8 * 1024 * 1024;

export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) throw usage('sync: expects JSON on stdin');
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > MAX_INPUT) throw usage('sync: input too large');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const readRegistry = (env) => readJson(registryPath(env), emptyRegistry());

export const withMachineLock = (ctx, fn) => withLock(machineLockPath(ctx.env), fn);

// Read-modify-write the registry under the machine lock; fn returns {registry, result}.
export function updateRegistry(ctx, fn) {
  return withMachineLock(ctx, async () => {
    const { registry, result } = await fn(await readRegistry(ctx.env));
    await writeJsonAtomic(registryPath(ctx.env), registry);
    return result;
  });
}

export async function loadToolCatalog(env) {
  const user = await readJson(toolsPath(env), { tools: [] });
  return { kitCatalog: playbook('tools.json').tools, userCatalog: Array.isArray(user) ? user : user.tools ?? [] };
}
