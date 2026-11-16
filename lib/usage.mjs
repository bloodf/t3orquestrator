// Account usage from CLIProxyAPI's management API (`GET /v0/management/auth-files`), mapped to T3 provider instances
// and laid over the registry for routing. Pure. The IO is in usage-source.mjs.
import path from 'node:path';

export const DEFAULT_THRESHOLD = 90; // used percent at which an instance waits for its reset
const QUOTA_REASONS = ['quota', 'credential_quota'];
const ID_FIELDS = ['name', 'email', 'label', 'id', 'auth_index'];
const UNKNOWN_USED = 50; // an account that reports no percent ranks as half used

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

// The windows an account reports as quota signals (codex: X-Codex-Primary-*, X-Codex-Secondary-*).
function windows(quota) {
  const s = quota?.signals ?? {};
  const observed = time(quota?.observed_at);
  return Object.keys(s).filter((k) => k.endsWith('-Used-Percent')).map((k) => {
    const p = k.slice(0, -'-Used-Percent'.length);
    const at = num(s[`${p}-Reset-At`]);
    const after = num(s[`${p}-Reset-After-Seconds`]);
    const resetAt = at > 0 ? at * 1000 : (after > 0 && observed !== null ? observed + after * 1000 : null);
    return { used: num(s[k]), resetAt };
  }).filter((w) => w.used !== null);
}

// One account: the fullest window that has not reset, and how long a quota cooldown on the whole credential lasts.
export function accountUsage(entry, now) {
  const live = windows(entry.quota).filter((w) => w.resetAt === null || w.resetAt > now);
  const top = live.reduce((a, w) => (a === null || w.used > a.used ? w : a), null);
  const until = (Array.isArray(entry.cooldowns) ? entry.cooldowns : [])
    .filter((c) => c?.scope === 'credential' && QUOTA_REASONS.includes(c.reason))
    .map((c) => time(c.retry_at)).filter((t) => t !== null && t > now);
  return {
    usedPercent: top?.used ?? null,
    resetAt: top?.resetAt ?? null,
    exhaustedUntil: until.length ? Math.max(...until) : null,
    observedAt: time(entry.quota?.observed_at),
  };
}

const least = (list, f) => list.reduce((a, x) => (f(x) < f(a) ? x : a));

// An instance on several accounts (a proxy pool) has the headroom of its best open account, and is exhausted only
// when every account is, until the first comes back.
function pool(list) {
  const open = list.filter((x) => x.exhaustedUntil === null);
  return open.length ? least(open, (x) => x.usedPercent ?? UNKNOWN_USED) : least(list, (x) => x.exhaustedUntil);
}

// accounts: {instanceId: selector | [selectors]}, a selector being an auth file's name, email, label, id or auth_index.
export function usageByInstance(files, accounts, now) {
  const instances = {};
  const missing = [];
  for (const [id, sel] of Object.entries(accounts ?? {})) {
    const found = [sel].flat().map((s) => {
      const e = files.find((f) => ID_FIELDS.some((k) => f?.[k] === s));
      if (!e) missing.push(`${id}: ${s}`);
      return e && accountUsage(e, now);
    }).filter(Boolean);
    if (found.length) instances[id] = pool(found);
  }
  return { instances, missing };
}

// The registry as routing sees it: an instance at or over the threshold cools until its window resets, an exhausted
// one until its quota cooldown ends, and each carries its headroom (0-1, null when unknown). Never written back.
export function withUsage(registry, usage, { now, threshold = DEFAULT_THRESHOLD }) {
  const known = Object.entries(usage ?? {}).filter(([id]) => registry.instances[id]);
  if (known.length === 0) return registry;
  const instances = { ...registry.instances };
  for (const [id, x] of known) {
    const used = x.resetAt === null || x.resetAt > now ? x.usedPercent : null; // a window that reset says nothing
    const full = used !== null && used >= threshold && x.resetAt !== null ? x.resetAt : 0;
    const until = Math.max(x.exhaustedUntil ?? 0, full, instances[id].cooldownUntil ?? 0);
    instances[id] = {
      ...instances[id], usage: { ...x, usedPercent: used }, headroom: used === null ? null : (100 - used) / 100, ...(until > now ? { cooldownUntil: until } : {}),
    };
  }
  return { ...registry, instances };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v !== '';
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// The `usage` block of ~/.t3orq/config.json; null when valid.
export function usageSettingsError(u) {
  if (!isObject(u)) return 'usage must be an object';
  if (typeof u.url !== 'string' || !/^https?:\/\/./.test(u.url)) return 'usage.url must be an http(s) URL';
  if (!isName(u.keyEnv) && !isName(u.keyFile)) return 'usage needs usage.keyEnv or usage.keyFile for the management key';
  if (u.keyEnv !== undefined && !isName(u.keyEnv)) return 'usage.keyEnv must be an environment variable name';
  if (u.keyFile !== undefined && !(isName(u.keyFile) && path.isAbsolute(u.keyFile))) return 'usage.keyFile must be an absolute path';
  const sel = (v) => isName(v) || (Array.isArray(v) && v.length > 0 && v.every(isName));
  if (!isObject(u.accounts) || !Object.values(u.accounts).every(sel)) return 'usage.accounts must map instance ids to an account or a list of accounts';
  if (u.threshold !== undefined && !isInt(u.threshold, 1, 100)) return 'usage.threshold must be an integer 1-100';
  if (u.ttlSeconds !== undefined && !isInt(u.ttlSeconds, 1, Infinity)) return 'usage.ttlSeconds must be a positive integer';
  return null;
}
