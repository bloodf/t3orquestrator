// Decisions (`orq ask`): the order sent to the deciding model, how its reply is read, and .orq/asks.json
// (not in the ledger: a decision commits nothing).
import { readJson, writeJsonAtomic } from './store.mjs';
import { withLock } from './lock.mjs';
import { asksPath, projectLockPath } from './paths.mjs';
import { assertNotArchiving } from './ledger.mjs';
import { parseStatusLine } from './worker-status.mjs';

export const MAX_QUESTION = 16 * 1024;
const MAX_LINES = 30;
const MAX_FIRST = 400;
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g; // keeps tab and newline

export const emptyAsks = () => ({ asks: [] });
export const readAsks = (cwd) => readJson(asksPath(cwd), emptyAsks());
export const findAsk = (doc, n) => (n === undefined ? doc.asks.at(-1) : doc.asks.find((a) => a.n === n));
export const addAsk = (doc, ask) => ({ asks: [...doc.asks, { ...ask, n: doc.asks.length + 1 }] });

// ended is true only when this call moved the decision out of "running": the caller settles the thread once.
export function endAsk(doc, n, { status, outcome }, endedAt) {
  const cur = findAsk(doc, n);
  if (!cur || cur.status !== 'running') return { doc, ended: false };
  return { doc: { asks: doc.asks.map((a) => (a.n === n ? { ...a, status, outcome, endedAt } : a)) }, ended: true };
}

// Read-modify-write under the project lock; fn(doc) -> {doc, result}. fn must not spawn anything.
export function updateAsks(cwd, fn) {
  return withLock(projectLockPath(cwd), async () => {
    await assertNotArchiving(cwd);
    const { doc, result } = fn(await readAsks(cwd));
    await writeJsonAtomic(asksPath(cwd), doc);
    return result;
  });
}

const firstLine = (text) => text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
export const questionLine = (question) => firstLine(question).replace(CONTROL, ' ').slice(0, MAX_FIRST);

// The decision order: the playbook template, then what orq knows. Pure.
export function decisionMessage({
  template, question, plan, unit, order,
}) {
  const parts = [template.trimEnd(), '## Question', question.trim()];
  if (plan) {
    const decisions = (plan.decisions ?? []).map((d) => `- ${d}`);
    parts.push('## Plan', [`Goal: ${plan.goal}`, ...(decisions.length ? ['Decisions:', ...decisions] : [])].join('\n'));
  }
  if (unit) parts.push('## Unit', `id: ${unit.id}\ntitle: ${unit.title}\npaths: ${unit.paths.join(', ')}`, order.trim());
  return `${parts.join('\n\n')}\n`;
}

/**
 * What a decision thread came to. thread: its status; reply: its last assistant message.
 * -> {status: 'running'} | {status: 'answered'|'escalated'|'failed', outcome, lines} (lines: what `orq ask` prints).
 */
export function outcomeOf(threadStatus, reply) {
  if (!TERMINAL.includes(threadStatus)) return { status: 'running' };
  if (threadStatus !== 'completed') return noDecision('the decision thread failed');
  const { status, detail, rest } = parseStatusLine(reply, ['ANSWER', 'ESCALATE'], MAX_FIRST);
  if ((status !== 'ANSWER' && status !== 'ESCALATE') || detail === '') return noDecision('the reply had no ANSWER or ESCALATE line');
  const word = status === 'ANSWER' ? 'answer' : 'escalate';
  return {
    status: status === 'ANSWER' ? 'answered' : 'escalated',
    outcome: detail,
    lines: [`${word}: ${detail}`, ...rest].slice(0, MAX_LINES),
  };
}

export function noDecision(why) {
  return { status: 'failed', outcome: `no decision (${why})`, lines: [`escalate: no decision (${why})`] };
}

export const pendingLine = (n) => `pending: decision ${n} still running; run "orq ask --show ${n}"`;
