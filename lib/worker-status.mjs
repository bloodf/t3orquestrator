// The status line a worker starts its report with (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT); a decision
// thread uses the same form with ANSWER and ESCALATE. Only the first non-empty line counts. The reason is the rest
// of that line after a separator, or else the next non-empty line.
const MAX_DETAIL = 160;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const WORKER = ['DONE_WITH_CONCERNS', 'DONE', 'BLOCKED', 'NEEDS_CONTEXT']; // longest first: DONE is a prefix

export const ASKS_ORCHESTRATOR = ['BLOCKED', 'NEEDS_CONTEXT'];

const clean = (line) => line.replace(CONTROL, ' ').trim();

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
