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
  const chain = Math.max(0, ...levels);
  // ponytail: units per depth level, a lower bound of what can run at once; exact (widest antichain) if it ever matters
  const widest = Math.max(0, ...Array.from({ length: chain }, (_, i) => levels.filter((d) => d === i + 1).length));
  return { remaining: left.length, widest, chain };
}

export function shapeLines({ remaining, widest, chain }) {
  if (remaining < MIN_UNITS) return [];
  if (widest === 1) {
    return [`warning: the ${remaining} units still to run form one chain, so they run one at a time; keep a dep only where a unit needs what another commits`];
  }
  return [`shape: ${remaining} units to run, at most ${widest} at once, longest chain ${chain}`];
}
