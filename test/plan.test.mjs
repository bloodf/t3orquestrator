import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, readyUnits, literalPrefix } from '../lib/plan.mjs';

const jobs = { implement: {}, test: {} };
const unit = (id, over = {}) => ({
  id, title: id, job: 'implement', paths: [`src/${id}/**`], evidence: 'tests pass', order: `.orq/units/${id}/order.md`, ...over,
});
const files = (over = {}) => ({
  exists: (f) => !(f in over) || over[f] !== null,
  readFile: (f) => over[f] ?? 'one line\n',
});
const NOWHERE = '/nonexistent-orq-project'; // no symlinks to follow: the fake files decide
const check = (plan, over) => validatePlan(plan, { jobs, ...files(over), cwd: NOWHERE });
const good = { goal: 'g', units: [unit('a'), unit('b', { deps: ['a'] }), unit('c')] };

test('valid plan: ok and topological order', () => {
  const r = check(good);
  assert.deepEqual(r, { ok: true, errors: [], order: ['a', 'b', 'c'] });
});

test('order respects deps regardless of listing order', () => {
  const r = check({ goal: 'g', units: [unit('b', { deps: ['a'], paths: ['x/**'] }), unit('a', { paths: ['y/**'] })] });
  assert.deepEqual(r.order, ['a', 'b']);
});

test('goal and units', () => {
  assert.ok(check({ goal: '', units: [unit('a')] }).errors.some((e) => /goal/.test(e)));
  assert.ok(check({ goal: 'g', units: [] }).errors.some((e) => /no units/.test(e)));
});

test('id format and duplicates', () => {
  const r = check({ goal: 'g', units: [unit('Bad_Id'), unit('a'), unit('a', { paths: ['z/**'] })] });
  assert.ok(r.errors.some((e) => /Bad_Id/.test(e) && /id/.test(e)));
  assert.ok(r.errors.some((e) => /duplicate.*a/.test(e)));
});

test('unknown job lists valid ones; missing dep', () => {
  const r = check({ goal: 'g', units: [unit('a', { job: 'nope' }), unit('b', { deps: ['ghost'], paths: ['b/**'] })] });
  assert.ok(r.errors.some((e) => /unknown job "nope".*implement, test/.test(e)));
  assert.ok(r.errors.some((e) => /unit b.*ghost/.test(e)));
});

test('cycle names the units', () => {
  const r = check({ goal: 'g', units: [unit('a', { deps: ['b'] }), unit('b', { deps: ['a'], paths: ['b/**'] })] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /cycle/.test(e) && /a/.test(e) && /b/.test(e)));
});

test('empty paths, empty evidence', () => {
  const r = check({ goal: 'g', units: [unit('a', { paths: [] }), unit('b', { evidence: ' ', paths: ['b/**'] })] });
  assert.ok(r.errors.some((e) => /unit a.*paths/.test(e)));
  assert.ok(r.errors.some((e) => /unit b.*evidence/.test(e)));
});

test('work order: missing, too long, missing field', () => {
  const p = { goal: 'g', units: [unit('a'), unit('b', { paths: ['b/**'] })] };
  const r = check(p, { '.orq/units/a/order.md': null, '.orq/units/b/order.md': 'x\n'.repeat(41) });
  assert.ok(r.errors.some((e) => /unit a.*work order.*missing/.test(e)));
  assert.ok(r.errors.some((e) => /unit b.*41 lines.*40/.test(e)));
  assert.ok(check({ goal: 'g', units: [unit('a', { order: '' })] }).errors.some((e) => /unit a.*order/.test(e)));
  assert.equal(check({ goal: 'g', units: [unit('a')] }, { '.orq/units/a/order.md': 'x\n'.repeat(40) }).ok, true);
});

test('literalPrefix', () => {
  assert.equal(literalPrefix('src/a/**'), 'src/a/');
  assert.equal(literalPrefix('src/a/b.js'), 'src/a/b.js');
  assert.equal(literalPrefix('**/x'), '');
  assert.equal(literalPrefix('a?b'), 'a');
});

test('parallel overlap is an error; dependency or disjoint paths are fine', () => {
  const overlap = check({ goal: 'g', units: [unit('a', { paths: ['src/a/**'] }), unit('b', { paths: ['src/a/b.js'] })] });
  assert.ok(overlap.errors.some((e) => /units a and b/.test(e) && /overlap/.test(e)));
  const sep = check({ goal: 'g', units: [unit('a', { paths: ['src/a/**'] }), unit('b', { paths: ['src/b/**'] })] });
  assert.equal(sep.ok, true);
  const dep = check({ goal: 'g', units: [unit('a', { paths: ['src/**'] }), unit('b', { deps: ['a'], paths: ['src/x.js'] })] });
  assert.equal(dep.ok, true);
  const trans = check({ goal: 'g', units: [unit('a', { paths: ['s/**'] }), unit('b', { deps: ['a'], paths: ['t/**'] }), unit('c', { deps: ['b'], paths: ['s/x'] })] });
  assert.equal(trans.ok, true);
  const all = check({ goal: 'g', units: [unit('a', { paths: ['**'] }), unit('b', { paths: ['z/q'] })] });
  assert.equal(all.ok, false);
});

test('collects every error, does not stop at the first', () => {
  const r = check({ goal: '', units: [unit('a', { job: 'x', paths: [] })] });
  assert.ok(r.errors.length >= 3);
});

test('does not mutate the plan', () => {
  const p = Object.freeze({ goal: 'g', units: Object.freeze([Object.freeze(unit('a'))]) });
  assert.doesNotThrow(() => check(p));
});

test('readyUnits', () => {
  assert.deepEqual(readyUnits(good, []), ['a', 'c']);
  assert.deepEqual(readyUnits(good, ['a']), ['b', 'c']);
  assert.deepEqual(readyUnits(good, ['a', 'b', 'c']), []);
});

test('order is confined to .orq/', () => {
  for (const order of ['../../../etc/hosts', '/etc/hosts', '.orq/../x', 'x.md', '.orq']) {
    const r = check({ goal: 'g', units: [unit('a', { order })] });
    assert.ok(r.errors.includes('unit a: order must be a file under .orq/'), order);
  }
  assert.equal(check({ goal: 'g', units: [unit('a', { order: '.orq/./units/../units/a/order.md' })] }).ok, true);
});

test('malformed shapes report instead of throwing', () => {
  const bads = [
    null, 3, [], { goal: 'g' }, { goal: 'g', units: 'x' }, { goal: 'g', units: [null] }, { goal: 'g', units: [3, 'x'] },
    { goal: 'g', units: [{ ...unit('a'), paths: [1] }] }, { goal: 'g', units: [{ ...unit('a'), paths: 'src' }] },
    { goal: 'g', units: [{ ...unit('a'), deps: 'b' }] }, { goal: 'g', units: [{ ...unit('a'), forbidden: [2] }] },
    { goal: 'g', units: [{ ...unit('a'), title: 4, job: 5, evidence: 6, order: 7 }] },
  ];
  for (const b of bads) {
    let r;
    assert.doesNotThrow(() => { r = check(b); }, JSON.stringify(b));
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.deepEqual(r.order, []);
  }
  const many = check({ goal: 'g', units: [{ ...unit('a'), title: 4, job: 5, evidence: 6, order: 7 }] });
  assert.ok(many.errors.length >= 4);
});

test('a work order symlinked out of .orq/ is refused; cwd is required so no caller skips the check', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-plan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'p', '.orq', 'units', 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'secret.txt'), 'SECRET\n');
  await fs.symlink(path.join(root, 'secret.txt'), path.join(root, 'p', '.orq', 'units', 'a', 'order.md'));
  const r = validatePlan({ goal: 'g', units: [unit('a')] }, { jobs, ...files(), cwd: path.join(root, 'p') });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unit a: order must be a file under \.orq\//.test(e)), r.errors.join('\n'));
  assert.throws(() => validatePlan({ goal: 'g', units: [unit('a')] }, { jobs, ...files() }), /cwd/);
});
