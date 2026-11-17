// What one `orq ship` carries, from plan state only. Pure.

const TITLE_MAX = 72;

// The units first integrated after the last shipped head, up to the one whose merge made `head`. Heads only move
// forward on the integration branch, so ledger order is reachability. Empty for a ledger written before 0.8.0.
// A head orq made by merging origin's base carries no unit (unit null).
export function shipUnits(p, head = p.green) {
  const list = p.integrations ?? [];
  const from = p.shipped ? list.findIndex((x) => x.head === p.shipped) + 1 : 0;
  const to = list.findIndex((x) => x.head === head);
  return to < from ? [] : list.slice(from, to + 1).map((x) => x.unit).filter(Boolean);
}

// every unit whose merge `head` contains, shipped or not
export const unitsIn = (p, head) => shipUnits({ ...p, shipped: undefined }, head);

// only a head whose final run passed is ready: `orq ship` refuses any other verdict
export const unshipped = (p) => Boolean(p.green) && p.green !== p.shipped && p.greenVerdict === 'pass';

// `head` comes after the shipped head in the integration order (heads only move forward)
export function newerThanShipped(p, head) {
  const at = (h) => (p.integrations ?? []).findIndex((x) => x.head === h);
  return at(head) >= 0 && (!p.shipped || at(head) > at(p.shipped));
}

const titleOf = (plan, id) => String(plan?.units?.find((u) => u.id === id)?.title ?? '').replace(/\s+/g, ' ').trim();
// unit titles start with the issues they are for, before the first word: `#843`, `#843, #850 and #851:`
const REFS = /^\s*(#\d+(?:(?:\s*,\s*|\s+and\s+|\s+)#\d+)*)[\s:;,-]*/;

// the issue numbers a unit title starts with
export function issuesOf(title) {
  const m = REFS.exec(title);
  return m ? [...m[1].matchAll(/#(\d+)/g)].map((x) => x[1]) : [];
}

// a unit title without its leading issue refs or its own id
// a title without its leading issue refs (and the `:` or `-` after them)
export const withoutRefs = (title) => String(title).replace(REFS, '').replace(/^[\s:-]+/, '').trim();

const bare = (title, id) => title.replace(REFS, '').replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:-]?\\s*`), '').trim();

const fit = (text, suffix) => (text.length + suffix.length <= TITLE_MAX ? `${text}${suffix}` : `${text.slice(0, TITLE_MAX - suffix.length - 1)}…${suffix}`);

// Used when the orchestrator gives no --title: the work, never plan, ship or unit ids (those stay in the branch name).
export function shipTitle(plan, ids) {
  const first = ids.length ? bare(titleOf(plan, ids[0]), ids[0]) : '';
  if (!first) return fit(String(plan?.goal ?? '').trim() || 'Ship integrated work', '');
  return fit(first, ids.length > 1 ? ` and ${ids.length - 1} more` : '');
}

// summary: the orchestrator's --body-file text. Then a line per issue the units start with: `Closes` once every
// plan unit naming it is integrated, `Refs` before. Then the checks line (checks.full stays in the ledger).
export function shipBody(plan, ids, green, summary = null, integrated = new Set(ids)) {
  const issues = [...new Set(ids.flatMap((id) => issuesOf(titleOf(plan, id))))];
  const done = (n) => (plan?.units ?? []).filter((u) => issuesOf(titleOf(plan, u.id)).includes(n)).every((u) => integrated.has(u.id));
  return [String(summary ?? '').trim(), issues.map((n) => `${done(n) ? 'Closes' : 'Refs'} #${n}`).join('\n'), `Final checks passed on ${green.slice(0, 12)}.`]
    .filter(Boolean).join('\n\n');
}

// credit for writing the change, not a product's name: `Add Gemini provider` is fine, `Written by Gemini` is not
// a bare `AI` counts only as the whole phrase (`by an AI agent.`), not `by AI team members`
const AI = String.raw`(?:an?\s+)?(?:ai|llm)(?:\s+(?:agent|assistant|model|tool))?(?=\s*(?:$|[.,;:!)\]]))`;
const MODEL = String.raw`(?:\[?\s*)(?:the\s+)?(?:claude|anthropic|openai|chatgpt|gpt-?\d|codex|copilot|gemini|kimi|minimax|grok|sonnet|opus|haiku|llama|mistral|deepseek|qwen|${AI})`;
const CREDITS = [
  /🤖/u,
  new RegExp(String.raw`\bgenerated\s+(?:with|by)\s+${MODEL}`, 'i'),
  new RegExp(String.raw`^(?:co-authored|assisted)-by:.*(?:${MODEL}|anthropic\.com|openai\.com)`, 'im'),
  /\b(?:built|made)\s+(?:using|with)\s+claude\s+code\b/i,
  new RegExp(String.raw`\b(?:prepared|written|authored|orchestrated|reviewed)\s+(?:with|by)\s+${MODEL}`, 'i'),
  new RegExp(String.raw`\b(?:claude|chatgpt|gpt-?\d\S*|codex|copilot|gemini|kimi|minimax|grok|sonnet|opus|ai)\s+responding\s+on\s+behalf\s+of`, 'i'),
];

// the text that credits a tool or model, or null
export const creditIn = (text) => (text === undefined ? null : CREDITS.map((re) => re.exec(text)).find(Boolean)?.[0] ?? null);

// The pull request reads as the maintainer's: a one-line title, and no tool or model credited anywhere.
export function shipTextError({ title: raw, body }) {
  const title = raw?.trim();
  if (raw !== undefined && (!title || title.length > TITLE_MAX || /[\r\n]/.test(title))) {
    return `ship: --title must be one line of 1 to ${TITLE_MAX} characters; nothing was shipped`;
  }
  for (const [flag, text] of [['--title', title], ['--body-file', body]]) {
    const hit = creditIn(text);
    if (hit) return `ship: ${flag} credits a tool or model ("${hit}"); write it as the maintainer; nothing was shipped`;
  }
  return null;
}
