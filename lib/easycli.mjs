// Real per-account quota from EasyCLIProxyAPI (a desktop GUI over CLIProxyAPI) through its management API: the
// account list (GET /v0/management/auth-files), then each account's provider usage endpoint called through the
// proxy with that account's own token (POST /v0/management/api-call, `$TOKEN$` filled in by the proxy), as the
// GUI's Quota Lookup does. docs/easycli-quota.md has the details. Read-only: nothing here starts, stops or
// reconfigures the app, and the management key never leaves this module (no error text carries it).
// Failure is no data (null), never an error.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = (home = os.homedir()) => path.join(home, 'Library', 'Application Support', 'com.cpa.gui', 'config.toml');
const TIMEOUT_MS = 8_000; // each request; the accounts are asked in parallel
const MAX_ACCOUNTS = 50;

// The top-level `key = value` lines of the GUI's config.toml that matter; the rest of TOML is not needed.
export function parseGuiConfig(text) {
  const top = String(text).split(/^\s*\[/m)[0]; // before the first table
  const get = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, 'm').exec(top);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  const port = Number(get('port'));
  const host = get('host') || '127.0.0.1';
  const key = get('management-secret-key');
  if (!Number.isInteger(port) || port <= 0 || !key) return null;
  return { url: `http://${host === '0.0.0.0' || host === '' ? '127.0.0.1' : host}:${port}`, key };
}

// {url, key} from the machine's quotaSource ({url?, configPath?}) and the GUI config, or null.
export async function easyCliEndpoint(source = {}, { readFile = fs.readFile, homedir = os.homedir } = {}) {
  let cfg;
  try {
    cfg = parseGuiConfig(await readFile(source.configPath ?? DEFAULT_CONFIG_PATH(homedir()), 'utf8'));
  } catch {
    return null;
  }
  return cfg && { ...cfg, ...(source.url ? { url: String(source.url).replace(/\/+$/, '') } : {}) };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => {
  if (isObj(v) && 'val' in v) return num(v.val);
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clamp = (n) => Math.max(0, Math.min(100, n));
const leftOfUsed = (used) => (num(used) === null ? null : clamp(100 - num(used)));
// an epoch in seconds or ms, or an ISO time -> epoch ms
export function instant(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? (n > 0 ? (n < 1e12 ? n * 1000 : n) : NaN) : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}
const resetOf = (o, abs, rel, now) => {
  for (const k of abs) if (instant(o[k]) !== null) return instant(o[k]);
  for (const k of rel) if (num(o[k]) !== null && num(o[k]) >= 0) return now + num(o[k]) * 1000;
  return null;
};
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const win = (name, remainingPct, resetsAt) => (remainingPct === null ? null : { name, remainingPct, resetsAt: resetsAt ?? null });

// --- provider usage bodies -> {windows, credits?, plan?} ------------------------------------------------------------

const H5 = 18_000;
const WEEK = 604_800;
const period = (secs, fallback) => {
  if (secs === H5) return '5h';
  if (secs === WEEK) return 'weekly';
  if (secs >= 28 * 86_400 && secs <= 31 * 86_400) return 'monthly';
  return secs ? `${Math.round(secs / 3600)}h` : fallback;
};

// chatgpt.com/backend-api/wham/usage
export function codexQuota(body, now) {
  const windows = [];
  const add = (rl, prefix) => {
    if (!isObj(rl)) return;
    const reached = rl.limit_reached === true || rl.allowed === false;
    for (const [k, fallback] of [['primary_window', '5h'], ['secondary_window', 'weekly']]) {
      const w = rl[k];
      if (!isObj(w)) continue;
      const resetsAt = resetOf(w, ['reset_at'], ['reset_after_seconds'], now);
      const left = leftOfUsed(w.used_percent) ?? (reached && resetsAt !== null ? 0 : null);
      windows.push(win(`${prefix}${period(num(w.limit_window_seconds), fallback)}`, left, resetsAt));
    }
  };
  add(body.rate_limit, '');
  add(body.code_review_rate_limit, 'code-review-');
  for (const extra of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    if (isObj(extra)) add(extra.rate_limit, `${slug(extra.limit_name ?? extra.metered_feature ?? 'extra')}-`);
  }
  const c = isObj(body.credits) ? body.credits : null;
  return {
    windows: windows.filter(Boolean),
    credits: c ? (c.unlimited === true ? Infinity : num(c.balance)) : null,
    plan: typeof body.plan_type === 'string' ? body.plan_type : null,
  };
}

// api.anthropic.com/api/oauth/usage. Dollar pools (cloud-session credits) are balances, not windows.
const CLAUDE = {
  five_hour: '5h', seven_day: 'weekly', seven_day_opus: 'weekly-opus', seven_day_sonnet: 'weekly-sonnet', seven_day_oauth_apps: 'weekly-oauth-apps', iguana_necktie: 'weekly-fable',
};
export function claudeQuota(body) {
  const dollars = (o) => isObj(o) && ['limit_dollars', 'used_dollars', 'remaining_dollars'].some((k) => num(o[k]) !== null);
  const fable = (Array.isArray(body.limits) ? body.limits : []).filter((l) => isObj(l) && String(l.kind).toLowerCase() === 'weekly_scoped'
    && /^fable( 5)?$/i.test(String(l.scope?.model?.display_name ?? '')) && num(l.percent) !== null);
  const active = fable.find((l) => l.is_active === true) ?? fable[0];
  const windows = Object.entries(CLAUDE)
    .filter(([k]) => isObj(body[k]) && 'utilization' in body[k] && !dollars(body[k]) && !(k === 'iguana_necktie' && active))
    .map(([k, name]) => win(name, leftOfUsed(body[k].utilization), instant(body[k].resets_at)));
  if (active) windows.push(win('weekly-fable', leftOfUsed(active.percent), instant(active.resets_at)));
  const pool = Object.values(body).find(dollars);
  const credits = pool ? num(pool.remaining_dollars) ?? (num(pool.limit_dollars) !== null && num(pool.used_dollars) !== null ? num(pool.limit_dollars) - num(pool.used_dollars) : null) : null;
  return { windows: windows.filter(Boolean), credits, plan: null };
}

// daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary. The window id carries the quota pool the way
// T3 names it (usage.mjs binds): `gemini-…` for Gemini models, `3p-…` for the shared Claude and GPT pool, and a
// model's own pool as `gemini-<name>-…` ("Gemini 4 Argon" -> gemini-argon-weekly).
const AG_WINDOW = [[/^(5[ -]hour|five[ -]hour)/, '5h'], [/^weekly|^week$/, 'weekly'], [/^daily|^day$/, 'daily'], [/^monthly|^month$/, 'monthly']];
function agPool(group) {
  const g = String(group).toLowerCase();
  if (/claude|gpt/.test(g)) return '3p';
  if (!/gemini/.test(g)) return slug(group) || 'quota';
  const own = g.replace(/gemini|models?|\d+(\.\d+)?|[^a-z ]/g, ' ').trim().split(/\s+/).filter(Boolean)[0];
  return own ? `gemini-${own}` : 'gemini';
}
export function antigravityQuota(body) {
  const summary = Array.isArray(body.groups) ? body : (() => { try { return JSON.parse(body.body); } catch { return {}; } })();
  const windows = (Array.isArray(summary.groups) ? summary.groups : []).flatMap((g) => {
    if (!isObj(g) || !Array.isArray(g.buckets)) return [];
    const pool = agPool(g.displayName ?? g.display_name ?? '');
    return g.buckets.filter(isObj).map((b) => {
      const label = String(b.displayName ?? b.display_name ?? b.description ?? b.window ?? '').toLowerCase().replace(/\s*(-|:)?\s*remaining$/, '').trim();
      const w = AG_WINDOW.find(([re]) => re.test(label) || re.test(String(b.window ?? '').toLowerCase()))?.[1] ?? (slug(b.window ?? label) || 'quota');
      const f = num(b.remainingFraction ?? b.remaining_fraction);
      return win(`${pool}-${w}`, f === null ? null : clamp(f * 100), instant(b.resetTime ?? b.reset_time));
    });
  });
  return { windows: windows.filter(Boolean), credits: null, plan: null };
}

// One request per provider through the proxy, with the account's token. kimi and xai accounts are listed with no
// windows: their usage bodies are not read yet (no orq instance runs on them today).
const UA_CODEX = 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)';
const PROVIDERS = {
  codex: { url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': UA_CODEX }, parse: codexQuota },
  claude: { url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }, parse: claudeQuota },
  antigravity: {
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    method: 'POST',
    header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64' },
    data: (f) => (f.project_id ? JSON.stringify({ project: f.project_id }) : undefined),
    parse: antigravityQuota,
  },
};
const ALIASES = { anthropic: 'claude', 'anti-gravity': 'antigravity', grok: 'xai', 'x-ai': 'xai', 'kimi-ai': 'kimi' };
export const QUOTA_PROVIDERS = ['claude', 'codex', 'antigravity', 'xai', 'kimi'];
export const providerOf = (f) => {
  const p = String(f.provider ?? f.type ?? '').toLowerCase().replace(/_/g, '-');
  const name = ALIASES[p] ?? p;
  return QUOTA_PROVIDERS.includes(name) ? name : null;
};

async function call(fetchFn, ep, pathName, init) {
  const res = await fetchFn(`${ep.url}/v0/management${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${ep.key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function accountQuota(fetchFn, ep, f, provider, now) {
  const spec = PROVIDERS[provider];
  const base = {
    provider, account: String(f.email ?? f.account ?? f.label ?? f.name ?? ''), label: String(f.label ?? f.name ?? ''), windows: [], credits: null, plan: null,
  };
  if (!spec) return base;
  try {
    const r = await call(fetchFn, ep, '/api-call', {
      method: 'POST',
      body: JSON.stringify({
        auth_index: String(f.auth_index), method: spec.method ?? 'GET', url: spec.url, header: spec.header, ...(spec.data?.(f) ? { data: spec.data(f) } : {}),
      }),
    });
    const status = Number(r.status_code ?? r.statusCode ?? 0);
    if (status < 200 || status >= 300) return { ...base, error: `upstream ${status || 'no answer'}` };
    const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    return isObj(body) ? { ...base, ...spec.parse(body, now) } : { ...base, error: 'unreadable usage' };
  } catch (e) {
    return { ...base, error: e.name === 'TimeoutError' ? 'timed out' : 'request failed' };
  }
}

// -> {at, source: 'easycli', accounts: [{provider, account, label, plan, windows: [{name, remainingPct, resetsAt}], credits, error?}]}
// or null when EasyCLI cannot be read (not running, wrong key, no config).
export async function fetchEasyCli(ep, { fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (!ep) return null;
  let list;
  try {
    list = await call(fetchFn, ep, '/auth-files', { method: 'GET' });
  } catch {
    return null;
  }
  const files = (Array.isArray(list?.files) ? list.files : []).filter((f) => isObj(f) && f.disabled !== true && f.auth_index != null && providerOf(f)).slice(0, MAX_ACCOUNTS);
  const accounts = await Promise.all(files.map((f) => accountQuota(fetchFn, ep, f, providerOf(f), now)));
  return { at: now, source: 'easycli', accounts };
}

// --- a snapshot that may have come from another machine: only what this file names, in shapes it checks -------------
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._%+@-]{0,99}$/;
const WINDOW = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const PLAN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
function cleanAccount(a) {
  if (a === null || typeof a !== 'object' || !QUOTA_PROVIDERS.includes(a.provider) || !ACCOUNT.test(a.account ?? '')) return null;
  const windows = (Array.isArray(a.windows) ? a.windows : []).slice(0, 20)
    .filter((w) => w && WINDOW.test(w.name ?? '') && fin(w.remainingPct) && w.remainingPct >= 0 && w.remainingPct <= 100 && (w.resetsAt === null || fin(w.resetsAt)))
    .map((w) => ({ name: w.name, remainingPct: w.remainingPct, resetsAt: w.resetsAt }));
  return {
    provider: a.provider,
    account: a.account,
    ...(PLAN.test(a.plan ?? '') ? { plan: a.plan } : {}),
    windows,
    credits: fin(a.credits) || a.credits === 'unlimited' ? a.credits : null,
  };
}
// JSON has no Infinity: an unlimited balance is stored as 'unlimited'
const storable = (a) => ({ ...a, credits: a.credits === Infinity ? 'unlimited' : a.credits });
export function cleanQuota(q) {
  if (q === null || typeof q !== 'object' || !fin(q.at) || !Array.isArray(q.accounts)) return null;
  return { at: q.at, accounts: q.accounts.slice(0, 50).map((a) => cleanAccount(storable(a))).filter(Boolean) };
}
