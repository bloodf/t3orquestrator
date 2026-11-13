// The pull-request body, rendered from facts only. Pure: same inputs, same output.
import { unitOf } from './ledger.mjs';

const NO_EVIDENCE = 'No full check command is configured, so nothing verified the integrated result.';
const one = (s) => String(s).replace(/\r?\n/g, ' ');
const cell = (s) => one(s).replaceAll('|', '\\|');
const section = (title, lines) => (lines.length ? [`## ${title}`, '', ...lines, ''] : []);

function unitRow(spec, u) {
  const kinds = [...new Set(u.flags.map((f) => f.kind))];
  return `| ${[spec.id, spec.title, spec.job, u.key ?? '-', u.tier ?? '-', u.attempt, u.state, kinds.length ? kinds.join(', ') : '-'].map(cell).join(' | ')} |`;
}

function evidenceLines(plan, state, gates) {
  return plan.units
    .filter((s) => unitOf(state, s.id).state === 'integrated')
    .map((s) => `- ${s.evidence ? `\`${one(s.evidence)}\`` : 'no evidence command'} → ${gates[s.id]?.verdict ?? 'no gate result'}`);
}

function finalLines(state, checks) {
  const { final, integrationBranch, integrationHead } = state.plan;
  const current = final !== null && final.head === integrationHead; // a verdict belongs to one head only
  const verdict = current ? final.verdict : null;
  return [
    current ? `Verdict: ${verdict}` : 'Not run for the current head.',
    ...(verdict === 'no-evidence' ? [NO_EVIDENCE] : []),
    ...(checks ? [`Checks: \`${one(checks)}\``] : []),
    `Integration branch: ${integrationBranch}`,
    `Head: ${integrationHead}`,
  ];
}

function notDone(plan, state) {
  return plan.units.flatMap((s) => {
    const u = unitOf(state, s.id);
    if (u.state !== 'dropped' && u.state !== 'failed') return [];
    const last = Array.isArray(u.lastFailure) ? u.lastFailure.join('; ') : u.lastFailure;
    return [`- ${s.id}: ${u.state} — ${one(u.reason ?? (last || 'no reason recorded'))}`];
  });
}

// Decisions `orq ask` took in the user's place; escalated and unfinished ones are not decisions.
const taken = (asks) => (asks?.asks ?? []).filter((a) => a.status === 'answered')
  .map((a) => `- ${one(a.question)} → ${one(a.outcome)} (${one(a.key)})`);

export function renderSummary({
  plan, state, gates = {}, reviews = null, checks = null, asks = null,
}) {
  const units = plan.units.map((s) => unitRow(s, unitOf(state, s.id)));
  const table = ['| id | title | job | model | tier | attempts | state | flags |', '|---|---|---|---|---|---|---|---|', ...units];
  const rv = (reviews?.reviews ?? []).map((r) => `- review ${r.n}: ${one(r.key)} — ${one(r.status)}`);
  return `${[
    ...section('Goal', [one(plan.goal)]),
    ...section('Decisions', (plan.decisions ?? []).map((d) => `- ${one(d)}`)),
    ...section('Decisions taken without you', taken(asks)),
    ...section('Units', table),
    ...section('Evidence', evidenceLines(plan, state, gates)),
    ...section('Final checks', finalLines(state, checks)),
    ...section('Review', rv),
    ...section('Not done', notDone(plan, state)),
  ].slice(0, -1).join('\n')}\n`;
}
