// Reads account usage from a CLIProxyAPI management API (`usage` in ~/.t3orq/config.json) and caches it per instance
// in ~/.t3orq/usage.json. Unconfigured: null, and routing works as before. The key is never written anywhere.
import fs from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './store.mjs';
import { usagePath } from './paths.mjs';
import { usageByInstance, withUsage } from './usage.mjs';

export const DEFAULT_TTL_SECONDS = 300;
const TIMEOUT_MS = 3000;

async function managementKey(settings, env) {
  const fromEnv = settings.keyEnv ? env[settings.keyEnv]?.trim() : '';
  if (fromEnv) return fromEnv;
  if (settings.keyFile) return (await fs.readFile(settings.keyFile, 'utf8')).trim();
  throw new Error(`no management key: set ${settings.keyEnv} or usage.keyFile`);
}

async function fetchAuthFiles(settings, { env, fetch }) {
  const key = await managementKey(settings, env);
  const res = await fetch(`${settings.url.replace(/\/+$/, '')}/v0/management/auth-files`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.files)) throw new Error('unexpected auth-files payload');
  return body.files;
}

const reason = (e) => `${e.message.split('\n')[0].slice(0, 120)}${e.cause?.code ? ` (${e.cause.code})` : ''}`;

// {fetchedAt, instances, missing, error?}. fresh: fetch whatever the cache's age (`orq sync`).
export async function loadUsage(ctx, machine, { fresh = false } = {}) {
  const settings = machine.usage;
  if (!settings) return null;
  const file = usagePath(ctx.env);
  const cached = await readJson(file, null);
  const now = ctx.now();
  if (!fresh && cached && now - cached.fetchedAt < (settings.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000) return cached;
  let next;
  try {
    const files = await fetchAuthFiles(settings, { env: ctx.env, fetch: ctx.deps?.fetch ?? fetch });
    next = { fetchedAt: now, ...usageByInstance(files, settings.accounts, now) };
  } catch (e) {
    // proxy down or unreachable: keep the last known usage (it only grows until a reset) and retry after the TTL
    next = {
      fetchedAt: now, instances: cached?.instances ?? {}, missing: cached?.missing ?? [], error: reason(e),
    };
  }
  await writeJsonAtomic(file, next);
  return next;
}

// usage, and apply: the registry as routing sees it, with the account usage laid over it.
export async function usageView(ctx, machine) {
  const usage = await loadUsage(ctx, machine);
  return { usage, apply: (registry) => withUsage(registry, usage?.instances, { now: ctx.now(), threshold: machine.usage?.threshold }) };
}
