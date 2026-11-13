// Decisions (`orq ask`): the order sent to the deciding model, how its reply is read, and .orq/asks.json
// (not in the ledger: a decision commits nothing).
import { readJson, writeJsonAtomic } from './store.mjs';
import { withLock } from './lock.mjs';
import { asksPath, projectLockPath } from './paths.mjs';
import { assertNotArchiving } from './ledger.mjs';
import { cleanLine, parseStatusLine, quoteLines } from './worker-status.mjs';

export const MAX_QUESTION = 16 * 1024;
const MAX_LINES = 30;
const MAX_FIRST = 160;
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

export const emptyAsks = () => ({ asks: [] });
export const readAsks = (cwd) => readJson(asksPath(cwd), emptyAsks());
export const findAsk = (doc, n) => (n === undefined ? doc.asks.at(-1) : doc.asks.find((a) => a.n === n));
export const addAsk = (doc, ask) => ({ asks: [...doc.asks, { ...ask, n: doc.asks.length + 1 }] });

const patchAsk = (doc, n, patch) => ({ asks: doc.asks.map((a) => (a.n === n ? { ...a, ...patch } : a)) });

// ended is true only when this call moved the decision out of "starting"/"running": the caller settles the thread once.
export function endAsk(doc, n, { status, outcome }, endedAt) {
  const cur = findAsk(doc, n);
  if (!cur || (cur.status !== 'running' && cur.status !== 'starting')) return { doc, ended: false };
  return { doc: patchAsk(doc, n, { status, outcome, endedAt }), ended: true };
}

// The thread started: the reserved number now names a running decision.
export function runAsk(doc, n, threadId) {
  if (findAsk(doc, n)?.status !== 'starting') throw new Error(`decision ${n} is no longer starting`);
  return patchAsk(doc, n, { status: 'running', threadId });
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

export const questionLine = (question) => cleanLine(question.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '', MAX_FIRST);

// Text from the project inside a fence it cannot close: one backtick longer than its longest backtick run.
export function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

// The decision order: the playbook template, then what orq knows, each under a "(data)" heading and fenced,
// so a heading or rule inside a question, a plan or a work order stays data. Pure.
export function decisionMessage({
  template, question, plan, unit, order,
}) {
  const parts = [template.trimEnd(), '## Question (data)', fenced(question.trim())];
  if (plan) {
    const decisions = (plan.decisions ?? []).map((d) => `- ${d}`);
    parts.push('## Plan (data)', fenced([`Goal: ${plan.goal}`, ...(decisions.length ? ['Decisions:', ...decisions] : [])].join('\n')));
  }
  if (unit) parts.push('## Unit (data)', fenced(`id: ${unit.id}\ntitle: ${unit.title}\npaths: ${unit.paths.join(', ')}\n\n${order.trim()}`));
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
    lines: [`${word}: ${detail}`, ...quoteLines(rest, MAX_LINES - 1, MAX_FIRST)],
  };
}

export function noDecision(why) {
  const safe = cleanLine(String(why).split('\n')[0], MAX_FIRST);
  return { status: 'failed', outcome: `no decision (${safe})`, lines: [`escalate: no decision (${safe})`] };
}

export const pendingLine = (n) => `pending: decision ${n} still running; run "orq ask --show ${n}"`;
