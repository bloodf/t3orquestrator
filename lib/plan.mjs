// Plan validation: collect every problem, then give a topological order.
import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ORDER_LINES = 40;

export function literalPrefix(glob) {
  const i = glob.search(/[*?]/);
  return i < 0 ? glob : glob.slice(0, i);
}

function globsOverlap(a, b) {
  const [pa, pb] = [literalPrefix(a), literalPrefix(b)];
  // ponytail: prefix comparison over-reports overlap (e.g. src/a/*.js vs src/a/*.css); exact glob intersection if it blocks real plans.
  return pa.startsWith(pb) || pb.startsWith(pa);
}

const blank = (s) => typeof s !== 'string' || s.trim() === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
const idsOf = (units) => units.map((u) => u.id);

// Type errors only: a unit that has any is skipped by every deeper check.
function shapeErrors(u, label) {
  if (!isObject(u)) return [`${label}: must be an object`];
  const errs = ['id', 'title', 'job', 'evidence', 'order']
    .filter((k) => typeof u[k] !== 'string').map((k) => `${label}: ${k} must be a string`);
  if (!isStrings(u.paths)) errs.push(`${label}: paths must be an array of non-empty strings`);
  for (const k of ['deps', 'forbidden']) {
    if (u[k] !== undefined && !isStrings(u[k])) errs.push(`${label}: ${k} must be an array of non-empty strings`);
  }
  return errs;
}

// Real location of p, following symlinks in the nearest existing ancestor. null for a dangling symlink.
function realOf(p) {
  const rest = [];
  for (let cur = p; ; cur = path.dirname(cur)) {
    let exists = true;
    try {
      fs.lstatSync(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') return null;
      exists = false;
    }
    if (exists) {
      try {
        return path.join(fs.realpathSync(cur), ...rest);
      } catch {
        return null; // dangling symlink: not provably inside
      }
    }
    if (path.dirname(cur) === cur) return null;
    rest.unshift(path.basename(cur));
  }
}

// A relative path that stays inside the project's .orq/ directory after normalization. With cwd, symlinks
// are resolved too, so one planted under .orq/ cannot redirect a read or write outside it.
export function underOrq(file, cwd) {
  if (typeof file !== 'string' || path.isAbsolute(file)) return false;
  const norm = path.posix.normalize(file);
  if (!norm.startsWith('.orq/')) return false;
  if (cwd === undefined) return true;
  const root = realOf(path.join(cwd, '.orq'));
  const real = realOf(path.join(cwd, norm));
  return root !== null && real !== null && (real === root || real.startsWith(root + path.sep));
}

function orderErrors(u, files) {
  const at = `unit ${u.id}`;
  if (blank(u.order)) return [`${at}: order (work-order file) must be set`];
  const norm = path.posix.normalize(u.order);
  if (!underOrq(u.order)) return [`${at}: order must be a file under .orq/`];
  if (!files.exists(norm)) return [`${at}: work order ${u.order} is missing`];
  const lines = files.readFile(norm).replace(/\n$/, '').split('\n').length;
  return lines > MAX_ORDER_LINES ? [`${at}: work order has ${lines} lines, limit is ${MAX_ORDER_LINES}`] : [];
}

function unitErrors(u, jobs, files) {
  const errs = [];
  const at = `unit ${u.id}`;
  if (!ID.test(u.id)) errs.push(`unit id "${u.id}" must match ${ID}`);
  if (!(u.job in jobs)) errs.push(`${at}: unknown job "${u.job}"; valid jobs: ${Object.keys(jobs).join(', ')}`);
  if (u.paths.length === 0) errs.push(`${at}: paths must not be empty`);
  if (blank(u.evidence)) errs.push(`${at}: evidence must not be empty`);
  return [...errs, ...orderErrors(u, files)];
}

function findCycle(units) {
  const deps = new Map(units.map((u) => [u.id, (u.deps ?? []).filter((d) => idsOf(units).includes(d))]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return stack.slice(stack.indexOf(id));
    state.set(id, 'open');
    stack.push(id);
    for (const d of deps.get(id)) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

function ancestors(units, id) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const seen = new Set();
  const walk = (x) => (byId.get(x)?.deps ?? []).forEach((d) => { if (!seen.has(d)) { seen.add(d); walk(d); } });
  walk(id);
  return seen;
}

function overlapErrors(units) {
  const errs = [];
  const anc = new Map(units.map((u) => [u.id, ancestors(units, u.id)]));
  units.forEach((a, i) => units.slice(i + 1).forEach((b) => {
    if (anc.get(a.id).has(b.id) || anc.get(b.id).has(a.id)) return;
    for (const ga of a.paths ?? []) {
      const gb = (b.paths ?? []).find((g) => globsOverlap(ga, g));
      if (gb !== undefined) { errs.push(`units ${a.id} and ${b.id} may run in parallel but their paths overlap (${ga} vs ${gb})`); return; }
    }
  }));
  return errs;
}

function topoOrder(units) {
  const order = [];
  const left = [...units];
  while (left.length) {
    const i = left.findIndex((u) => (u.deps ?? []).every((d) => order.includes(d)));
    order.push(left.splice(i, 1)[0].id);
  }
  return order;
}

export function validatePlan(plan, { jobs, exists, readFile }) {
  const fail = (errors) => ({ ok: false, errors, order: [] });
  if (!isObject(plan)) return fail(['plan must be an object']);
  const errors = [];
  if (blank(plan.goal)) errors.push('goal must be a non-empty string');
  if (!Array.isArray(plan.units)) return fail([...errors, 'units must be an array']);
  if (plan.units.length === 0) errors.push('plan has no units');
  const label = (u, i) => (isObject(u) && typeof u.id === 'string' ? `unit ${u.id}` : `units[${i}]`);
  const good = plan.units.filter((u, i) => {
    const errs = shapeErrors(u, label(u, i));
    errors.push(...errs);
    return errs.length === 0;
  });
  const ids = idsOf(good);
  const known = plan.units.filter(isObject).map((u) => u.id);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) errors.push(`duplicate unit id "${id}"`); });
  for (const u of good) {
    errors.push(...unitErrors(u, jobs, { exists, readFile }));
    for (const d of u.deps ?? []) if (!known.includes(d)) errors.push(`unit ${u.id}: dependency "${d}" does not exist`);
  }
  const cycle = findCycle(good);
  if (cycle) errors.push(`dependency cycle among units: ${cycle.join(' -> ')}`);
  else errors.push(...overlapErrors(good));
  return { ok: errors.length === 0, errors, order: errors.length === 0 ? topoOrder(good) : [] };
}

export function readyUnits(plan, doneIds) {
  const done = new Set(doneIds);
  return plan.units
    .filter((u) => !done.has(u.id) && (u.deps ?? []).every((d) => done.has(d)))
    .map((u) => u.id);
}
