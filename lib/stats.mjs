// Per-model outcome numbers from ledger events. Pure: no I/O, input never mutated, unknown or malformed events ignored.
// A `launched` event sets the model a unit runs on; later events of that unit count for it until the next `launched`.
const FINAL = 'integration';
const emptyRow = () => ({
  launched: 0, completed: 0, provider_failed: 0, gate_pass: 0, gate_fail: 0, first_pass: 0, no_commit: 0, stopped: 0, integrated: 0,
  continued: 0, // launches that took over the commits of a worker whose provider failed
});
const num = (x) => (Number.isFinite(x) ? x : null);
const bump = (map, k, field) => { map[k] ??= emptyRow(); map[k][field] += 1; };
const hasNoCommit = (f) => Array.isArray(f) && f.some((x) => String(x).startsWith('no commits on top of'));

function newSegment() {
  return {
    cur: new Map(), units: new Set(), final: new Map(), firstGate: new Set(), openAt: new Map(), continued: new Set(), min: null, max: null,
  };
}

export function computeStats(events) {
  const models = {};
  const tiers = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const instances = {};
  const t = { plans: 0, units: 0, integrated: 0, dropped: 0, failed: 0, wallMs: 0, workerMs: 0 };
  let seg = null;
  const close = () => {
    if (!seg || (seg.min === null && seg.units.size === 0)) return; // nothing recorded in it
    t.plans += 1;
    t.units += seg.units.size;
    for (const s of seg.final.values()) {
      if (s === 'integrated') t.integrated += 1;
      else if (s === 'dropped') t.dropped += 1;
      else if (s === 'failed') t.failed += 1;
    }
    if (seg.min !== null) t.wallMs += seg.max - seg.min;
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    if (e.type === 'plan-started' || seg === null) {
      close();
      seg = newSegment();
    }
    const at = num(e.at);
    if (at !== null) {
      seg.min = seg.min === null ? at : Math.min(seg.min, at);
      seg.max = seg.max === null ? at : Math.max(seg.max, at);
    }
    const u = typeof e.unit === 'string' && e.unit !== FINAL ? e.unit : null;
    if (u === null) continue;
    const key = seg.cur.get(u);
    const known = ['launched', 'feedback-sent', 'thread-ended', 'gated', 'unfinished', 'needs-judgment', 'integrated', 'dropped', 'retried'];
    if (!known.includes(e.type)) continue;
    seg.units.add(u);
    if (e.type === 'launched') {
      const k = typeof e.key === 'string' ? e.key : 'unknown';
      seg.cur.set(u, k);
      bump(models, k, 'launched');
      if (typeof e.continues === 'string') {
        bump(models, k, 'continued');
        seg.continued.add(u);
      } else seg.continued.delete(u);
      if ([1, 2, 3, 4].includes(e.tier)) tiers[e.tier] += 1;
      const inst = typeof e.instance === 'string' ? e.instance : 'unknown';
      instances[inst] = (instances[inst] ?? 0) + 1;
    }
    if ((e.type === 'launched' || e.type === 'feedback-sent') && at !== null) seg.openAt.set(u, at);
    if (e.type === 'thread-ended') {
      if (seg.openAt.has(u) && at !== null) t.workerMs += Math.max(0, at - seg.openAt.get(u));
      seg.openAt.delete(u);
      if (key !== undefined) bump(models, key, e.status === 'completed' ? 'completed' : 'provider_failed');
    }
    if (e.type === 'gated' && key !== undefined) {
      const pass = e.verdict === 'pass' || e.verdict === 'no-evidence';
      bump(models, key, pass ? 'gate_pass' : 'gate_fail');
      if (!pass && hasNoCommit(e.failures)) bump(models, key, 'no_commit');
      if (!seg.firstGate.has(u)) {
        seg.firstGate.add(u);
        // a continued launch passed on work another model began: not a first pass of its own
        if (pass && e.attempt === 1 && !seg.continued.has(u)) bump(models, key, 'first_pass');
      }
    }
    if (e.type === 'unfinished' && key !== undefined) { // a turn that ended with no commit, or a stop report, told to go on
      bump(models, key, typeof e.stop === 'string' ? 'stopped' : 'no_commit');
      seg.firstGate.add(u); // what passes after a nudge is not a first pass
    }
    if (e.type === 'needs-judgment' && key !== undefined && String(e.reason ?? '').startsWith('worker reported')) bump(models, key, 'stopped');
    if (e.type === 'integrated' && key !== undefined) bump(models, key, 'integrated');
    const end = { 'needs-judgment': 'failed', dropped: 'dropped', integrated: 'integrated', retried: 'queued' }[e.type];
    if (end) seg.final.set(u, end);
  }
  close();
  const { wallMs, workerMs, ...counts } = t;
  return {
    ...counts, wallMinutes: Math.round(wallMs / 60000), workerMinutes: Math.round(workerMs / 60000), tiers, instances, models,
  };
}

const COLS = [['launched', 'launched'], ['completed', 'done'], ['provider_failed', 'prov-fail'], ['gate_pass', 'gate-pass'],
  ['gate_fail', 'gate-fail'], ['first_pass', 'first-pass'], ['no_commit', 'no-commit'], ['stopped', 'stopped'], ['continued', 'continued']];
const MAX_ROWS = 40;
const NAME_W = 44;

export function renderStats(s) {
  if (s.plans === 0) return 'no runs recorded\n';
  const rows = Object.entries(s.models).sort((a, b) => b[1].launched - a[1].launched || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, MAX_ROWS);
  const name = Math.min(NAME_W, Math.max(5, ...shown.map(([k]) => k.length)));
  const cut = (k) => (k.length > name ? `${k.slice(0, name - 1)}~` : k);
  const lines = [
    `plans: ${s.plans}  units: ${s.units}  integrated: ${s.integrated}  dropped: ${s.dropped}  failed: ${s.failed}  wall: ${s.wallMinutes} min  worker time: ${s.workerMinutes} min`,
    `tiers: ${[1, 2, 3, 4].map((n) => `t${n}=${s.tiers[n]}`).join(' ')}`,
    `instances: ${Object.entries(s.instances).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`.slice(0, 159),
    ['model'.padEnd(name), ...COLS.map(([, h]) => h.padStart(10))].join(' '),
    ...shown.map(([k, r]) => [cut(k).padEnd(name), ...COLS.map(([f]) => String(r[f]).padStart(10))].join(' ')),
  ];
  if (rows.length > shown.length) lines.push(`+${rows.length - shown.length} more`);
  return `${lines.join('\n')}\n`;
}
