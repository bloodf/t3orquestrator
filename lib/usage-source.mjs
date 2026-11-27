// Reads each instance's usage from T3's provider status cache, <T3 home>/caches/<instance>.json. The T3 home is
// T3CODE_HOME, else the machine config's t3Home (recorded by `orq sync` from a T3 thread), else ~/.t3. T3 writes the
// file from its own usage probe per instance; no CLI or MCP tool returns it. Read-only and best effort: a missing
// file means no usage for that instance, and routing as before.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { instanceUsage, withUsage } from './usage.mjs';
import { creditMatcher, withPolicy } from './policy.mjs';
import { currentQuota, overlayQuota } from './quota.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const MISSING = Symbol('missing');

export function t3CacheDir(ctx, machine) {
  const home = ctx.env.T3CODE_HOME || machine?.t3Home || path.join((ctx.deps?.homedir ?? os.homedir)(), '.t3');
  return path.join(home, 'caches');
}

// The parsed file, MISSING, or null when it does not parse twice (T3 may have been writing it the first time).
async function readSnapshot(file, readFile) {
  for (let i = 0; i < 2; i += 1) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return MISSING;
    }
    try {
      return JSON.parse(text);
    } catch { /* read again */ }
  }
  return null;
}

// {dir, instances: {instanceId: instanceUsage | {unreadable: true}}, quota} for the registry's instances with a cache
// file, and those with a real EasyCLI quota reading (quota.mjs), which replaces T3's windows.
export async function readUsage(ctx, registry, machine) {
  const dir = t3CacheDir(ctx, machine);
  const readFile = ctx.deps?.readFile ?? fs.readFile;
  const ids = Object.keys(registry.instances).filter((id) => SAFE_ID.test(id) && !id.startsWith('.'));
  const read = await Promise.all(ids.map(async (id) => [id, await readSnapshot(path.join(dir, `${id}.json`), readFile)]));
  const instances = Object.fromEntries(read.filter(([, s]) => s !== MISSING)
    .map(([id, s]) => [id, instanceUsage(s, ctx.now()) ?? { unreadable: true }]));
  const quota = await currentQuota(ctx, machine).catch(() => null);
  const models = Object.fromEntries(read.filter(([, s]) => Array.isArray(s?.models)).map(([id, s]) => [id, s.models]));
  return {
    dir, instances: overlayQuota(instances, registry, quota, machine?.quotaSource?.accounts, ctx.now(), models), ...(quota ? { quota } : {}),
  };
}

// Usage read earlier laid over the registry, as routing sees it.
// with the machine's routing policy (policy.mjs). An instance the machine lets run on paid credits (creditInstances)
// keeps routing past its usage windows: its windows are left out, so only a real refusal holds it. When EasyCLI read
// its credit balance as 0, its windows count again.
const outOfCredits = (u) => u?.credits === 0 || (typeof u?.credits === 'number' && u.credits < 0);
export const applyUsage = (registry, usage, machine, now) => {
  const credit = creditMatcher(machine);
  const instances = Object.fromEntries(Object.entries(usage.instances ?? {})
    .map(([id, u]) => [id, credit(id) && u?.windows && !outOfCredits(u) ? { ...u, windows: [] } : u]));
  return withPolicy(withUsage(registry, instances, { now, threshold: machine?.usageThreshold, thresholds: machine?.usageThresholds }), machine ?? {});
};

export async function usageView(ctx, registry, machine) {
  const usage = await readUsage(ctx, registry, machine);
  return { usage, registry: applyUsage(registry, usage, machine, ctx.now()) };
}

// The instances worth showing: with windows, down, stale or unreadable.
export const notable = (instances) => Object.fromEntries(Object.entries(instances)
  .filter(([, u]) => u.unreadable || u.down || u.stale || u.windows.length));
