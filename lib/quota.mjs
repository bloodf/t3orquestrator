// Real account quota for routing: a snapshot fetched from EasyCLIProxyAPI (easycli.mjs) on the machine that runs it,
// or the one a peer publishes (peers.mjs) on a machine without it, mapped onto this machine's provider instances and
// laid over T3's own usage readings (usage-source.mjs) so usage.mjs cools what is used up until its reset.
// Kept in <T3ORQ_HOME>/quota.json: {snapshot (last good local fetch), triedAt, error?}. Read-only and best effort:
// no snapshot means routing as before.
import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.mjs';
import { homeDir } from './paths.mjs';
import { cleanQuota, easyCliEndpoint, fetchEasyCli } from './easycli.mjs';
import { readPeers } from './peers.mjs';

export const REFRESH_MS = 5 * 60_000; // EasyCLI (or the peers) are asked at most this often
export const MAX_AGE_MS = 20 * 60_000; // an older snapshot says nothing about now
export const quotaPath = (env) => path.join(homeDir(env), 'quota.json');

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const fresh = (q, now) => q && Math.abs(now - q.at) <= MAX_AGE_MS;

// The local snapshot when it is fresh: what this machine publishes to its peers.
export async function localQuota(env, now) {
  const kept = await readJson(quotaPath(env), null).catch(() => null);
  const q = cleanQuota(kept?.snapshot);
  return fresh(q, now) ? q : null;
}

// The snapshot routing uses: this machine's own, else the freshest a peer published, each with where it came from.
export async function currentQuota(ctx, machine) {
  const now = ctx.now();
  const own = await localQuota(ctx.env, now);
  if (own) return { ...own, from: 'easycli' };
  const peers = await readPeers(ctx, machine?.peers, { cachedOnly: true }).catch(() => []); // a due peer is asked by refreshQuota, never here
  const best = peers.filter((p) => p.ok && fresh(p.status?.quota, now)).sort((a, b) => b.status.quota.at - a.status.quota.at)[0];
  return best ? { ...best.status.quota, from: `peer ${best.host}` } : null;
}

// Fetch from EasyCLI when due (REFRESH_MS since the last try); on a machine without it, ask the peers (their
// own cache paces the ssh). force: ask now. Never throws. -> {fetched: boolean, error?}
export async function refreshQuota(ctx, machine, { force = false } = {}) {
  const now = ctx.now();
  const source = machine?.quotaSource ?? {};
  if (source.kind === 'off') return { fetched: false };
  const file = quotaPath(ctx.env);
  const kept = await readJson(file, null).catch(() => null);
  if (!force && kept && fin(kept.triedAt) && now >= kept.triedAt && now - kept.triedAt < REFRESH_MS) return { fetched: false };
  const ep = await easyCliEndpoint(source, { ...(ctx.deps?.readFile ? { readFile: ctx.deps.readFile } : {}), homedir: ctx.deps?.homedir });
  const snap = ep ? await fetchEasyCli(ep, { fetch: ctx.deps?.fetch, now }).catch(() => null) : null;
  const error = ep ? (snap ? null : 'EasyCLI did not answer') : 'no EasyCLI config on this machine';
  await writeJsonAtomic(file, { snapshot: snap ? cleanQuota(snap) : kept?.snapshot ?? null, triedAt: now, ...(error ? { error } : {}) }).catch(() => {});
  if (!snap) await readPeers(ctx, machine?.peers).catch(() => []); // a peer may publish one
  return { fetched: Boolean(snap), ...(error ? { error } : {}) };
}

// A stored `quotaSource` value: why it is invalid, or null. {kind?: 'easycli'|'off', url?, configPath?, accounts?}
export function quotaSourceError(v) {
  if (v === undefined || v === null) return null;
  const msg = 'quotaSource must be {kind?: "easycli"|"off", url?: "http://host:port", configPath?: "/abs/config.toml", accounts?: {instanceId: account}}';
  if (typeof v !== 'object' || Array.isArray(v)) return msg;
  const extra = Object.keys(v).find((k) => !['kind', 'url', 'configPath', 'accounts'].includes(k));
  if (extra) return `${msg}; unknown key "${extra}"`;
  if (v.kind !== undefined && !['easycli', 'off'].includes(v.kind)) return msg;
  if (v.url !== undefined && !(typeof v.url === 'string' && /^https?:\/\/[^\s/]+\/?$/.test(v.url))) return `${msg}; url must be http(s)://host:port`;
  if (v.configPath !== undefined && !(typeof v.configPath === 'string' && v.configPath.startsWith('/'))) return `${msg}; configPath must be absolute`;
  const a = v.accounts;
  if (a !== undefined && !(a && typeof a === 'object' && !Array.isArray(a) && Object.values(a).every((s) => typeof s === 'string' && s !== ''))) return `${msg}; accounts maps instance ids to an e-mail or its local part`;
  return null;
}

// --- accounts -> instances ---------------------------------------------------------------------------------------------
// T3's driver kind for each EasyCLI provider
const DRIVERS = { claude: ['claudeAgent'], codex: ['codex'], antigravity: ['antigravity'], xai: ['grok'], kimi: ['acpRegistry'] };
const localPart = (s) => String(s).toLowerCase().split('@')[0];
// An instance takes an account when the machine maps it (quotaSource.accounts: {instanceId: e-mail or local part}),
// else when its T3 display name is the account's e-mail or its local part, on a driver of the account's provider.
export function accountFor(id, inst, accounts, overrides = {}) {
  const want = overrides[id];
  const same = (a, name) => {
    const n = String(name ?? '').toLowerCase();
    return n !== '' && (a.account.toLowerCase() === n || localPart(a.account) === n);
  };
  const onDriver = (a) => (DRIVERS[a.provider] ?? []).includes(inst.driverKind);
  if (want !== undefined) { // the provider's own account of that name first, then any (a proxy instance)
    const named = accounts.filter((a) => same(a, want));
    return named.find(onDriver) ?? named[0] ?? null;
  }
  const candidates = accounts.filter((a) => onDriver(a) && same(a, inst.displayName));
  return candidates.length === 1 ? candidates[0] : null; // two accounts of one name: not guessed
}

// {instanceId: account} for the registry's instances.
export function mapAccounts(registry, quota, overrides) {
  if (!quota) return {};
  return Object.fromEntries(Object.entries(registry.instances)
    .map(([id, inst]) => [id, accountFor(id, inst, quota.accounts, overrides)]).filter(([, a]) => a));
}

// The usage reading usage.mjs reads, from an account: its windows as used percent. An antigravity window carries its
// pool as its group, for display.
const reading = (a, at, driver) => ({
  checkedAt: at,
  windows: a.windows.map((w) => ({
    id: w.name, used: 100 - w.remainingPct, resetAt: w.resetsAt, ...(driver === 'antigravity' ? { group: w.name.split('-').slice(0, -1).join('-') } : {}),
  })),
  credits: a.credits,
  source: 'easycli',
});

// T3's readings (usage-source.mjs readUsage) with each mapped account's laid over: EasyCLI's windows replace T3's,
// T3's down / signed-out flags stay (EasyCLI does not see T3's own sign-in). Windows already reset are dropped.
export function overlayQuota(instances, registry, quota, overrides, now) {
  const mapped = mapAccounts(registry, quota, overrides);
  const out = { ...instances };
  for (const [id, a] of Object.entries(mapped)) {
    if (a.windows.length === 0 && a.credits === null) continue; // nothing read for it: T3's own reading stands
    const r = reading(a, quota.at, registry.instances[id].driverKind);
    const t3 = instances[id] && !instances[id].unreadable ? instances[id] : { down: false };
    out[id] = {
      ...t3, ...r, stale: false, windows: r.windows.filter((w) => w.resetAt === null || w.resetAt > now),
    };
  }
  return out;
}

// --- `orq usage` ---------------------------------------------------------------------------------------------------------
const hhmm = (t, now) => {
  const m = Math.max(0, Math.round((t - now) / 60_000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
};
const creditText = (c) => (c === null || c === undefined ? '' : ` credits=${c === 'unlimited' || c === Infinity ? 'unlimited' : c}`);
export function quotaTable(quota, registry, overrides, now) {
  if (!quota) return [];
  const mapped = mapAccounts(registry, quota, overrides);
  const byAccount = (a) => Object.keys(mapped).filter((id) => mapped[id] === a).sort();
  return quota.accounts.map((a) => {
    const ids = byAccount(a);
    const ws = a.windows.map((w) => `${w.name} ${Math.round(w.remainingPct)}% left${w.resetsAt ? ` (resets in ${hhmm(w.resetsAt, now)})` : ''}`);
    return `${a.provider} ${a.account} -> ${ids.length ? ids.join(',') : 'no instance'}${a.plan ? ` plan=${a.plan}` : ''}: ${ws.length ? ws.join(', ') : 'no windows read'}${creditText(a.credits)}`;
  });
}
