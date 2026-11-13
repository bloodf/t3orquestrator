// The status line a worker starts its report with (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT).
// Only the first non-empty line counts. The reason is the rest of that line after a separator,
// or else the next non-empty line.
const MAX_DETAIL = 160;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const STATUS_LINE = /^(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\s*[:\-–—]\s*(\S.*)$/i;

export const ASKS_ORCHESTRATOR = ['BLOCKED', 'NEEDS_CONTEXT'];

const clean = (line) => line.replace(CONTROL, ' ').trim();

export function parseWorkerStatus(text) {
  const lines = String(text ?? '').split('\n').map(clean).filter((l) => l !== '');
  const head = (lines[0] ?? '').replace(/^[#*`\s]+/, '');
  const inline = STATUS_LINE.exec(head.replace(/[`*]/g, '').trim());
  const status = (inline ? inline[1] : head.replace(/[`*\s.,:;!?]+$/, '')).toUpperCase();
  const detail = inline ? inline[2] : (lines[1] ?? '');
  return { status, detail: detail.slice(0, MAX_DETAIL) };
}
