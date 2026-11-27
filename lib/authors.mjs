// Who wrote the integrated work, for review/fix routing. Pure.
import { unitOf } from './ledger.mjs';

// The author of integrated work, for review/fix routing: the highest tier used, its family from the first
// such unit in `ids` order; `families`: every integrated unit's family (a review avoids them all). null when nothing is integrated.
export function authorsOf(ids, state) {
  const done = ids.map((id) => unitOf(state, id)).filter((u) => u.state === 'integrated' && u.tier !== null);
  if (done.length === 0) return null;
  const maxTier = Math.max(...done.map((u) => u.tier));
  const families = [...new Set(done.map((u) => u.family ?? 'unknown'))];
  return { maxTier, family: done.find((u) => u.tier === maxTier).family ?? 'unknown', families };
}
