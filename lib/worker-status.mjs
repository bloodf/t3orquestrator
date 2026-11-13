// The status line a worker starts its report with (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT); a decision
// thread uses the same form with ANSWER and ESCALATE. Only the first non-empty line counts. The reason is the rest
// of that line after a separator, or else the next non-empty line.
const MAX_DETAIL = 160;
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g; // and the Unicode line breaks: one line stays one line
const WORKER = ['DONE_WITH_CONCERNS', 'DONE', 'BLOCKED', 'NEEDS_CONTEXT']; // longest first: DONE is a prefix

export const ASKS_ORCHESTRATOR = ['BLOCKED', 'NEEDS_CONTEXT'];

const clean = (line) => line.replace(CONTROL, ' ').trim();
export const cleanLine = (line, max) => clean(String(line)).slice(0, max);

// A model's text, printed under an orq line: each line indented two spaces so none can pose as an orq line
// (`answer:`, `done:`, `judgment:` …), control characters removed, lines and length capped.
export function quoteLines(lines, maxLines, maxChars) {
  const all = lines.map((l) => clean(String(l))).filter((l) => l !== '');
  const shown = all.length > maxLines ? all.slice(0, maxLines - 1) : all;
  const more = all.length - shown.length;
  return [...shown.map((l) => `  ${l.slice(0, maxChars)}`), ...(more ? [`  … ${more} more lines`] : [])];
}

// statuses: the words that count; rest: the cleaned non-empty lines after the status and its reason.
export function parseStatusLine(text, statuses, maxDetail = MAX_DETAIL) {
  const lines = String(text ?? '').split('\n').map(clean).filter((l) => l !== '');
  const head = (lines[0] ?? '').replace(/^[#*`\s]+/, '');
  const inline = new RegExp(`^(${statuses.join('|')})\\s*[:\\-–—]\\s*(\\S.*)$`, 'i').exec(head.replace(/[`*]/g, '').trim());
  const status = (inline ? inline[1] : head.replace(/[`*\s.,:;!?]+$/, '')).toUpperCase();
  const detail = inline ? inline[2] : (lines[1] ?? '');
  return { status, detail: detail.slice(0, maxDetail), rest: lines.slice(inline ? 1 : 2) };
}

export function parseWorkerStatus(text) {
  const { status, detail } = parseStatusLine(text, WORKER);
  return { status, detail };
}
