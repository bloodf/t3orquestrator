// Why a provider stopped a thread, read from the text it left: its last reply (or a t3 error). T3 reports no
// reason in `thread show`, but the providers write their quota, sign-in and capacity errors as the reply. Pure.
//   limit: the account's quota or rate limit (cools the instance's models of that family until the reset)
//   auth: the instance is signed out (cools the instance)
//   capacity: the provider has no room for that model now (cools the model)
// Only a short text whose FIRST LINE starts with a provider's error phrasing. A completed turn (strict) needs the
// explicit phrasings, since a wrong match skips the gate; a failed thread may also start with a bare 429, 503, …
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const DEFAULT_COOL_MIN = { limit: 60, auth: 30, capacity: 10 }; // when the text names no reset time
const MAX_TEXT = 600;
const HORIZON = 8 * DAY; // a reset further ahead (or in the past) is a misread: the default applies

// optional "thread start failed (exit 1): " (a t3 error), then "API Error: 401" or the provider's phrasing
const START = String.raw`^(?:[\w ]*failed \(exit \d+\):\s*)?`;
const rule = (codes, strict, loose) => [
  new RegExp(`${START}(?:api error:?\\s*(?:${codes})\\b|${strict})`, 'i'),
  new RegExp(`${START}(?:(?:api )?error:?\\s*)?(?:${codes}\\b|${strict}|${loose})`, 'i'),
];
const RULES = [
  ['auth', ...rule('401', "your access token could not be refreshed|(?:you are|you're|you've been) (?:signed|logged) out|not (?:signed|logged) in\\b.*\\/login|invalid api key\\b.*\\/login|please run \\/login",
    'invalid api key|authentication (?:failed|required|expired)')],
  ['limit', ...rule('429', "usage limit (?:reached|exceeded)|you(?:'|’| ha)ve hit your\\b.*\\blimit|you (?:have )?(?:reached|exceeded) your (?:current )?(?:usage )?quota|rate limit reached for\\b|credit balance is too low",
    'rate[ _]?limit(?:ed|_error| error| reached| exceeded)|too many requests|quota (?:exceeded|reached)|insufficient_quota')],
  ['capacity', ...rule('503|529', 'no capacity available',
    'overloaded|(?:the )?(?:model|service|server|provider)\\b[^.]{0,60}?\\b(?:currently|temporarily) (?:unavailable|overloaded)')],
];
const MIN_COOL = MIN; // a reset already past (an old reply, "try again in 340ms") still cools: no relaunch loop

// "reset in 5 days, 4 hours", "try again in 20s", "try again in 340ms"
const unitMs = (u) => (/^(ms|milli)/i.test(u) ? 1 : { d: DAY, h: 60 * MIN, m: MIN, s: 1000 }[u[0].toLowerCase()]);
function relative(text, base) {
  const m = /(?:resets?|try again)\s+in\s+((?:[\d.]+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  const parts = m ? [...m[1].matchAll(/([\d.]+)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)] : [];
  return parts.length ? base + parts.reduce((sum, [, n, u]) => sum + Number(n) * unitMs(u), 0) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PARTS = { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
// a zone's wall clock at an instant; throws on an unknown zone
const wall = (t, zone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, ...PARTS }).formatToParts(t).map((x) => [x.type, Number(x.value)]));
// wall-clock time -> epoch ms: in an IANA zone (an unknown one is UTC), or this machine's time when none is named
function at(y, mo, d, h, mi, zone) {
  if (!zone) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const p = wall(guess, zone);
    return guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess);
  } catch {
    return guess;
  }
}
const hour24 = (h, ap) => (ap ? (Number(h) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0) : Number(h ?? 0)); // 12am is 0
const ahead = (base, ts) => ts.find((t) => t > base && t <= base + HORIZON) ?? null;

// "resets Nov 17 at 12am (America/Sao_Paulo)", "try again at Nov 9th, 2026 11:58 AM" (no zone: this machine's time),
// "resets 3pm (America/Los_Angeles)" (today or tomorrow there)
function absolute(text, base) {
  const m = /(?:resets?|try again)(?:\s+(?:at|on))?\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?)?(?:\s*\(([^)]+)\))?/i.exec(text);
  const mo = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (mo >= 0) {
    const y = new Date(base).getUTCFullYear();
    const years = m[3] ? [Number(m[3])] : [y - 1, y, y + 1]; // no year: the one that lands just ahead
    return ahead(base, years.map((yy) => at(yy, mo, Number(m[2]), hour24(m[4], m[6]), Number(m[5] ?? 0), m[7]?.trim())));
  }
  const t = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!t) return null;
  let today;
  try {
    today = t[4] ? wall(base, t[4].trim()) : null;
  } catch {
    today = null;
  }
  const d = today ?? { year: new Date(base).getFullYear(), month: new Date(base).getMonth() + 1, day: new Date(base).getDate() };
  return ahead(base, [0, 1].map((k) => at(d.year, d.month - 1, d.day + k, hour24(t[1], t[3]), Number(t[2] ?? 0), t[4]?.trim())));
}

const firstLine = (text) => text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

/**
 * base: when the provider wrote the text (the thread's last update); relative resets count from it. now: the time
 * of reading (default base). strict: the turn completed, so only the explicit phrasings count.
 * -> null, or {kind: 'limit'|'auth'|'capacity', reason: the text's first line, until: epoch ms it may be tried again}.
 */
export function classifyFailure(text, base, { now = base, strict = false } = {}) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  const line = firstLine(text);
  const hit = RULES.find(([, s, l]) => (strict ? s : l).test(line));
  if (!hit) return null;
  const [kind] = hit;
  const named = relative(text, base) ?? absolute(text, base);
  const ok = named !== null && Number.isFinite(named) && named > base && named <= base + HORIZON;
  return { kind, reason: line.slice(0, 120), until: Math.max(ok ? named : base + DEFAULT_COOL_MIN[kind] * MIN, now + MIN_COOL) };
}
