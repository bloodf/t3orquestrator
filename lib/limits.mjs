// Why a provider stopped a thread, read from the text it left: its last reply (or a t3 error). T3 reports no
// reason in `thread show`, but the providers write their quota, sign-in and capacity errors as the reply. Pure.
//   limit: the account's quota or rate limit (cools the instance's models of that family until the reset)
//   auth: the instance is signed out (cools the instance)
//   capacity: the provider has no room for that model now (cools the model)
// A LINE must start with a provider's error phrasing. A failed thread's whole text is
// scanned (its last TAIL characters: the refusal often follows the worker's narration); a completed turn (strict) only
// its first and last lines, and needs the explicit phrasings, since a wrong match skips the gate. A failed thread
// may also start a line with a bare 429, 503, …
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const DEFAULT_COOL_MIN = { limit: 60, auth: 30, capacity: 10 }; // when the text names no reset time
const TAIL = 4096;
const HORIZON = 8 * DAY; // a reset further ahead (or in the past) is a misread: the default applies

// optional "thread start failed (exit 1): " (a t3 error), then "API Error: 401" or the provider's phrasing. A bare
// code or word in the loose rules needs error context ("429 Too Many…", "Rate limited: try again"): a failed thread's
// last reply is often the worker's narration ("429 tests pass", "Overloaded constructor fixed")
const START = String.raw`^(?:[\w ]*failed \(exit \d+\):\s*)?(?:⚠\uFE0F?\s*)?`; // antigravity 1.5 opens its refusal with a warning sign
const rule = (codes, strict, loose) => [
  new RegExp(`${START}(?:api error:?\\s*(?:${codes})\\b|${strict})`, 'i'),
  new RegExp(`${START}(?:(?:api )?error:?\\s*(?:${codes})\\b|(?:(?:api )?error:?\\s*)?(?:${strict}|${loose}))`, 'i'),
];
const STOP = String.raw`\s*(?:[.:;!,(-]|$)`; // the phrase ends a clause: an error, not a sentence about one
const AGAIN = String.raw`\s*(?:[.:;!,(-]\s*(?:please )?(?:try again|retry|wait)|$)`; // "…: try again", or the whole line
const RULES = [
  ['auth', ...rule('401', "your access token could not be refreshed|(?:you are|you're|you've been) (?:signed|logged) out|not (?:signed|logged) in\\b.*\\/login|invalid api key\\b.*\\/login|please run \\/login|oauth token (?:has )?expired",
    `401\\s+unauthorized|(?:invalid api key|authentication (?:failed|required|expired))${STOP}`)],
  ['limit', ...rule('429', "(?:claude (?:ai )?)?usage limit (?:reached|exceeded)|(?:\\d+-hour|weekly|daily|monthly|session|opus|sonnet|fable) limit (?:reached|exceeded)|token plan usage limit (?:reached|exceeded)|quota reached(?:[.!]?$|[.:;,]\\s*(?:resets?|try again|please))|you(?:'|’| ha)ve hit your\\b.*\\blimit|you (?:have )?(?:reached|exceeded) your (?:current )?(?:usage )?quota|individual quota reached|rate limit reached for\\b|credit balance is too low|resource_exhausted",
    `429\\s+(?:too many|rate)|rate_limit_error|(?:rate.?limit(?:ed)?(?: reached| exceeded)?|too many requests)${AGAIN}|quota (?:exceeded|reached)(?: for|${STOP})|insufficient_quota`)],
  ['capacity', ...rule('503|529', 'no capacity available',
    '5(?:03|29)\\s+(?:service unavailable|overloaded|\\{)|overloaded_error|(?:the )?(?:model|service|server|provider|api)\\b[^.]{0,60}?\\b(?:currently|temporarily) (?:unavailable|overloaded)')],
];
const MIN_COOL = MIN; // a reset already past (an old reply, "try again in 340ms") still cools: no relaunch loop

// "reset in 5 days, 4 hours", "try again in 20s", "try again in 340ms"
const unitMs = (u) => (/^(ms|milli)/i.test(u) ? 1 : { d: DAY, h: 60 * MIN, m: MIN, s: 1000 }[u[0].toLowerCase()]);
function relative(text, base) {
  const m = /(?:resets?|try again)\s+in\s+((?:[\d.]+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  const parts = m ? [...m[1].matchAll(/([\d.]+)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)] : [];
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
  const offset = (t) => { const p = wall(t, zone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t; };
  try {
    return guess - offset(guess - offset(guess)); // the offset at the target itself: right across a DST change
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

const trimmed = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
// The lines a refusal may be on, first line first. A tail cut mid-line drops that partial line.
function candidates(text, strict) {
  const head = trimmed(text.slice(0, TAIL))[0];
  const tail = text.length > TAIL ? trimmed(text.slice(-TAIL)).slice(1) : trimmed(text);
  return [...new Set([head, ...(strict ? tail.slice(-1) : tail)])].filter((l) => l !== undefined);
}

/**
 * base: when the provider wrote the text (the thread's last update); relative resets count from it. now: the time
 * of reading (default base). strict: the turn completed, so only the explicit phrasings count.
 * -> null, or {kind: 'limit'|'auth'|'capacity', reason: the refusal's line, until: epoch ms it may be tried again}.
 */
export function classifyFailure(text, base, { now = base, strict = false } = {}) {
  if (typeof text !== 'string') return null;
  const rules = strict ? RULES.map(([k, s]) => [k, s]) : RULES.map(([k, , lo]) => [k, lo]);
  const line = candidates(text, strict).find((l) => rules.some(([, re]) => re.test(l)));
  if (line === undefined) return null;
  const [kind] = rules.find(([, re]) => re.test(line));
  const rest = text.slice(text.lastIndexOf(line)); // the reset is named on that line or after it
  const epoch = /\|(\d{10})(?!\d)/.exec(rest); // "Claude AI usage limit reached|<epoch seconds>"
  const named = epoch ? Number(epoch[1]) * 1000 : relative(rest, base) ?? absolute(rest, base);
  const ok = named !== null && Number.isFinite(named) && named > base && named <= base + HORIZON;
  return { kind, reason: line.slice(0, 120), until: Math.max(ok ? named : base + DEFAULT_COOL_MIN[kind] * MIN, now + MIN_COOL) };
}
