// How parallel the rest of a plan is. Pure. A plan whose units all wait on each other runs one thread at a time
// whatever the machine could take, so `orq plan check` shows the number before the work starts.
const MIN_UNITS = 3; // below this there is nothing to learn from the shape

/** units: [{id, deps}]; doneIds: integrated or dropped units, which hold nothing back. */
export function planShape(units, doneIds) {
  const done = new Set(doneIds);
  const left = units.filter((u) => !done.has(u.id));
  const ids = new Set(left.map((u) => u.id));
  const depth = new Map();
  const depthOf = (u, seen = new Set()) => {
    if (depth.has(u.id)) return depth.get(u.id);
    if (seen.has(u.id)) return 1; // a cycle is validation's finding, not ours
    const below = (u.deps ?? []).filter((d) => ids.has(d)).map((d) => depthOf(left.find((x) => x.id === d), new Set([...seen, u.id])));
    const d = 1 + Math.max(0, ...below);
    depth.set(u.id, d);
    return d;
  };
  const levels = left.map((u) => depthOf(u));
  // ready: units with nothing unfinished below them, which is what can start now; chain: the longest path of deps
  return { remaining: left.length, ready: levels.filter((d) => d === 1).length, chain: Math.max(0, ...levels) };
}

export function shapeLines({ remaining, ready, chain }) {
  if (remaining < MIN_UNITS) return [];
  if (chain === remaining) {
    return [`warning: the ${remaining} units still to run form one chain, so they run one at a time; keep a dep only where a unit needs what another commits`];
  }
  return [`shape: ${remaining} units to run, ${ready} can start now, longest chain ${chain}`];
}
