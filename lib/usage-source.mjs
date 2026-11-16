// Reads each instance's usage from T3's provider status cache, $T3CODE_HOME/caches/<instance>.json (T3CODE_HOME
// defaults to ~/.t3). T3 writes it from its own usage probe per instance; no CLI or MCP tool returns it.
// Read-only and best effort: a missing or unreadable file means no usage for that instance, and routing as before.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { instanceUsage, withUsage } from './usage.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function t3CacheDir(ctx) {
  const home = ctx.env.T3CODE_HOME || path.join((ctx.deps?.homedir ?? os.homedir)(), '.t3');
  return path.join(home, 'caches');
}

async function readSnapshot(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// {instanceId: instanceUsage} for the registry's instances that T3 has usage for.
export async function readUsage(ctx, registry) {
  const dir = t3CacheDir(ctx);
  const ids = Object.keys(registry.instances).filter((id) => SAFE_ID.test(id) && !id.startsWith('.'));
  const read = await Promise.all(ids.map(async (id) => [id, instanceUsage(await readSnapshot(path.join(dir, `${id}.json`)), ctx.now())]));
  return Object.fromEntries(read.filter(([, u]) => u !== null));
}

// usage, and the registry as routing sees it with that usage laid over it.
export async function usageView(ctx, registry, machine) {
  const usage = await readUsage(ctx, registry);
  return { usage, registry: withUsage(registry, usage, { now: ctx.now(), threshold: machine?.usageThreshold }) };
}
