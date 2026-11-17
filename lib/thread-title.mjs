// The title of every thread orq starts: `<Type> - <Ticket> | <Name>`, at most 100 characters. Pure.
import { issuesOf, withoutRefs } from './ship.mjs';

const MAX = 100;
const TYPES = {
  implement: 'Implement', 'implement-complex': 'Implement', fix: 'Fix', test: 'Test', docs: 'Docs', mechanical: 'Chore', explore: 'Explore', summarize: 'Summary', plan: 'Plan', architecture: 'Plan', 'debug-hard': 'Debug', review: 'Review', decide: 'Decision',
};
const typeOf = (job) => TYPES[job] ?? `${String(job).charAt(0).toUpperCase()}${String(job).slice(1)}`;
const firstLine = (s) => String(s ?? '').trim().split('\n')[0].replace(/\s+/g, ' ').trim();
// the issue refs, at most 3 and then `+N`
function refs(titles) {
  const all = [...new Set(titles.flatMap(issuesOf))].map((n) => `#${n}`);
  return `${all.slice(0, 3).join(', ')}${all.length > 3 ? ` +${all.length - 3}` : ''}`;
}

// cut on a word boundary, with an ellipsis, to at most `max` characters (code points: an emoji is never split)
function cut(text, max = MAX) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > head.length / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

const title = (type, ticket, name) => cut(`${type} - ${ticket} | ${name}`);

// spec: the plan unit
export function unitTitle(spec) {
  const name = withoutRefs(firstLine(spec.title));
  return title(typeOf(spec.job), refs([firstLine(spec.title)]) || spec.id, name || spec.id);
}

// the issues of the units the review covers (integrated ones), or the plan id; the plan's goal, or the review's number
export function reviewTitle(n, plan, state) {
  const ids = (plan?.units ?? []).filter((u) => state.units[u.id]?.state === 'integrated');
  return title('Review', refs(ids.map((u) => firstLine(u.title))) || state.plan.planId, firstLine(plan?.goal) || `Integration review ${n}`);
}

export const askTitle = (n, question) => title('Decision', `ask-${n}`, firstLine(question) || `decision ${n}`);
