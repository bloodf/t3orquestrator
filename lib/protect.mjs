// Protected services: things on this machine that must keep answering while agents work (machine config `protect`,
// a list of {name, url, timeoutMs}). Each is asked with one GET at most once a minute, by whichever `orq wait` polls
// first; the answer is cached in ~/.t3orq/protect.json for every project. While one fails or is slow, new launches
// and gates wait on this machine, and go on after two good probes in a row.
import { readJson, writeJsonAtomic } from './store.mjs';
import { protectPath } from './paths.mjs';

export const PROBE_EVERY_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 3000;
const GOOD_PROBES = 2;
const NAME = /^[A-Za-z0-9._-]{1,40}$/;

async function probe(service, fetchFn) {
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  try {
    const res = await fetchFn(service.url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel?.().catch(() => {}); // the status is all that is asked
    return res.status < 500 ? { ok: true, ms: Date.now() - started } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, error: slow ? `no answer in ${timeoutMs} ms` : String(e?.cause?.code ?? e?.message ?? e).slice(0, 80) };
  }
}

const sameList = (cache, list) => list.every((s) => cache.services?.[s.name]?.url === s.url) && Object.keys(cache.services ?? {}).length === list.length;

// -> {name: {url, ok, ms?, error?, good: good probes in a row}}. Never throws: a probe that cannot run is a failure.
// ponytail: two `orq wait` loops whose polls land in the same second both probe; add a lock if a service minds.
export async function checkProtect(ctx, list) {
  if (!Array.isArray(list) || list.length === 0) return {};
  const file = protectPath(ctx.env);
  const stored = await readJson(file, null).catch(() => null);
  const cache = stored !== null && typeof stored === 'object' ? stored : {}; // unreadable: probed again
  const now = ctx.now();
  if (Number.isFinite(cache.at) && now - cache.at < PROBE_EVERY_MS && now >= cache.at && sameList(cache, list)) return cache.services;
  const fetchFn = ctx.deps?.fetch ?? fetch;
  const results = await Promise.all(list.map((s) => probe(s, fetchFn)));
  const services = Object.fromEntries(list.map((s, i) => {
    const before = cache.services?.[s.name];
    const good = results[i].ok ? (before?.url === s.url ? Math.min(GOOD_PROBES, (before.good ?? 0) + 1) : GOOD_PROBES) : 0;
    return [s.name, { url: s.url, ...results[i], good }];
  }));
  await writeJsonAtomic(file, { at: now, services }).catch(() => {}); // the next poll probes again
  return services;
}

export function protectReasons(services) {
  return Object.entries(services ?? {}).flatMap(([name, s]) => {
    if (!s.ok) return [`protected service ${name} is failing (${s.error})`];
    return s.good < GOOD_PROBES ? [`protected service ${name} is recovering (${s.good} of ${GOOD_PROBES} good probes)`] : [];
  });
}

export const protectText = (services) => Object.entries(services).map(([name, s]) => (
  s.ok ? `${name} ${s.good < GOOD_PROBES ? 'recovering' : 'ok'}` : `${name} FAILING (${s.error})`)).join(', ');

// A stored `protect` value: why it is invalid, or null.
export function protectError(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return 'protect must be a list of {name, url, timeoutMs?}';
  const seen = new Set();
  for (const s of v) {
    if (!NAME.test(s?.name ?? '')) return 'protect: name must be 1 to 40 letters, digits, dots, dashes or underscores';
    if (seen.has(s.name)) return `protect: duplicate name "${s.name}"`;
    seen.add(s.name);
    if (typeof s.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(s.url) || !URL.canParse(s.url)) return `protect: ${s.name}: url must be an http or https URL`;
    if (s.timeoutMs !== undefined && !(Number.isInteger(s.timeoutMs) && s.timeoutMs >= 100 && s.timeoutMs <= 30_000)) {
      return `protect: ${s.name}: timeoutMs must be an integer from 100 to 30000`;
    }
  }
  return null;
}
