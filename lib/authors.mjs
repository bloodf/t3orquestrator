// Who wrote the integrated work, for review/fix routing. Pure.
import { unitOf } from './ledger.mjs';

// a launch with no recorded family: its model's family, else its instance's when all its models share one
function familyOf(registry, key) {
  const known = (f) => (f && f !== 'unknown' ? f : null);
  const own = known(registry?.models?.[key]?.family);
  if (own || !key) return own ?? 'unknown';
  const instance = key.split('::')[0];
  const fams = new Set(Object.values(registry?.models ?? {}).filter((m) => m.instance === instance).map((m) => m.family));
  return fams.size === 1 ? known([...fams][0]) ?? 'unknown' : 'unknown';
}

// The author of integrated work, for review/fix routing: the highest tier used, its family from the first
// such unit in `ids` order; `families`: every family that wrote any launch of an integrated unit (a review avoids them
// all): the family each launch recorded, else its model's or instance's family in `registry`, else `unknown`.
// null when nothing is integrated.
export function authorsOf(ids, state, registry = null) {
  const done = ids.map((id) => unitOf(state, id)).filter((u) => u.state === 'integrated' && u.tier !== null);
  if (done.length === 0) return null;
  const maxTier = Math.max(...done.map((u) => u.tier));
  const families = [...new Set(done.flatMap((u) => [...(u.used ?? []).map((k) => u.usedFamily?.[k] ?? familyOf(registry, k)), u.family ?? familyOf(registry, u.key)]))];
  return { maxTier, family: done.find((u) => u.tier === maxTier).family ?? 'unknown', families };
}
