// Reviews of the integrated result, tracked in .orq/reviews.json (not in the ledger: they commit nothing).
import { readJson, writeJsonAtomic } from './store.mjs';
import { withLock } from './lock.mjs';
import { projectLockPath, reviewsPath } from './paths.mjs';
import { assertNotArchiving } from './ledger.mjs';

export const REVIEW_ORDER = '.orq/orders/review.md';
export const MAX_ORDER_LINES = 40;
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

export const emptyReviews = () => ({ reviews: [] });
export const nextN = (doc) => doc.reviews.length + 1;
export const findReview = (doc, n) => (n === undefined ? doc.reviews.at(-1) : doc.reviews.find((r) => r.n === n));
export const isEnded = (threadStatus) => TERMINAL.includes(threadStatus);

export const addReview = (doc, review) => ({ reviews: [...doc.reviews, { ...review, n: nextN(doc) }] });

// ended is true only when this call moved the review out of "running": the caller records the outcome once.
export function endReview(doc, n, status, endedAt) {
  const cur = findReview(doc, n);
  if (!cur || cur.status !== 'running') return { doc, ended: false };
  return { doc: { reviews: doc.reviews.map((r) => (r.n === n ? { ...r, status, endedAt } : r)) }, ended: true };
}

export function lastMessage(messages) {
  const text = messages.at(-1)?.text;
  return typeof text === 'string' && text !== '' ? text : '(no message)';
}

export const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

export const readReviews = (cwd) => readJson(reviewsPath(cwd), emptyReviews());

// Read-modify-write under the project lock; fn(doc) -> {doc, result}. fn must not spawn anything.
export function updateReviews(cwd, fn) {
  return withLock(projectLockPath(cwd), async () => {
    await assertNotArchiving(cwd); // an archive may have started since the caller checked
    const { doc, result } = fn(await readReviews(cwd));
    await writeJsonAtomic(reviewsPath(cwd), doc);
    return result;
  });
}
