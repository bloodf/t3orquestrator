import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { reduce } from '../lib/ledger.mjs';
import { renderSummary } from '../lib/summary.mjs';
import { symlinkSync } from 'node:fs';
import { makeProject, unitSpec } from './support/project.mjs';

const A = 'a'.repeat(40);
const H = 'd'.repeat(40);
const plan = {
  goal: 'ship the thing',
  decisions: ['use the small API', 'keep v1 | compatible'],
  units: [unitSpec('a', { title: 'parse | split' }), unitSpec('b'), unitSpec('c')],
};
const launched = (unit, key = 'pa::m2', tier = 2) => ({
  type: 'launched', unit, at: 1, attempt: 1, launch: 1, threadId: `th-${unit}`, key, instance: key.split('::')[0], model: key.split('::')[1],
  branch: `orq/p1/${unit}-a1`, baseSha: A, tier, family: 'fam',
});
const events = [
  { type: 'plan-started', unit: null, at: 1, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
  launched('a'), { type: 'thread-ended', unit: 'a', at: 2, status: 'completed' },
  {
    type: 'gated', unit: 'a', at: 3, attempt: 1, verdict: 'pass', failures: [], headSha: H, flags: [{ kind: 'scope' }, { kind: 'scope' }, { kind: 'tests-touched' }],
  },
  { type: 'integrated', unit: 'a', at: 4, head: H },
  launched('b', 'pb::m3', 3), { type: 'dropped', unit: 'b', at: 5 },
  launched('c'), { type: 'needs-judgment', unit: 'c', at: 6, reason: '3 provider failures' },
  { type: 'final-gated', unit: null, at: 7, verdict: 'pass', failures: [], head: H },
];
const input = () => ({
  plan, state: reduce(events), gates: { a: { verdict: 'pass' } }, checks: 'npm test',
  reviews: { reviews: [{ n: 1, key: 'pb::m4', status: 'completed' }, { n: 2, key: 'pa::m3', status: 'running' }] },
});

test('renderSummary: full document', () => {
  assert.equal(renderSummary(input()), `${[
    '## Goal', '', 'ship the thing', '',
    '## Decisions', '', '- use the small API', '- keep v1 | compatible', '',
    '## Units', '',
    '| id | title | job | model | tier | attempts | state | flags |',
    '|---|---|---|---|---|---|---|---|',
    '| a | parse \\| split | implement | pa::m2 | 2 | 1 | integrated | scope, tests-touched |',
    '| b | do b | implement | pb::m3 | 3 | 1 | dropped | - |',
    '| c | do c | implement | pa::m2 | 2 | 1 | failed | - |', '',
    '## Evidence', '', '- `test -f a.txt` → pass', '',
    '## Final checks', '', 'Verdict: pass', 'Checks: `npm test`', 'Integration branch: orq/p1/integration', `Head: ${H}`, '',
    '## Review', '', '- review 1: pb::m4 — completed', '- review 2: pa::m3 — running', '',
    '## Not done', '', '- b: dropped — no reason recorded', '- c: failed — 3 provider failures',
  ].join('\n')}\n`);
});

test('renderSummary: no-evidence is stated in plain words; empty sections vanish', () => {
  const i = input();
  const state = reduce([...events.slice(0, 5), { type: 'final-gated', unit: null, at: 7, verdict: 'no-evidence', failures: [], head: H }]);
  const out = renderSummary({ plan: { goal: 'g', units: [plan.units[0]] }, state, gates: {}, reviews: null, checks: null });
  assert.match(out, /No full check command is configured, so nothing verified the integrated result\./);
  assert.doesNotMatch(out, /## (Decisions|Review|Not done)/);
  assert.match(out, /^## Goal\n\ng\n\n## Units/);
  assert.match(out, /- `test -f a.txt` → no gate result/);
  assert.ok(i);
});

test('renderSummary: final check not run, deterministic, inputs untouched', () => {
  const state = reduce(events.slice(0, 2));
  const frozen = Object.freeze({ plan, state, gates: Object.freeze({}), reviews: null, checks: 'x' });
  const a = renderSummary(frozen);
  assert.equal(renderSummary(frozen), a);
  assert.match(a, /Not run for the current head\./);
  assert.match(a, /Head: a{40}/);
  assert.doesNotMatch(a, /Verdict:/);
  assert.doesNotMatch(a, /## Evidence/);
});

async function orq(args, p, extra = {}) {
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => 1,
    deps: { readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }) }, ...extra,
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('summary command: gathers files, writes .orq/summary.md, confines --out', async (t) => {
  const p = await makeProject(t, plan.units, { checks: { full: 'npm test' } });
  await fs.writeFile(path.join(p.repo, '.orq/plan.json'), JSON.stringify(plan));
  const ledger = events.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(path.join(p.repo, '.orq/ledger.jsonl'), `${ledger}\n`);
  await fs.mkdir(path.join(p.repo, '.orq/units/a'), { recursive: true });
  await fs.writeFile(path.join(p.repo, '.orq/units/a/gate-1.json'), JSON.stringify({ verdict: 'pass', failures: [], flags: [] }));
  await fs.writeFile(path.join(p.repo, '.orq/reviews.json'), JSON.stringify({ reviews: [{ n: 1, key: 'pb::m4', status: 'completed' }] }));
  const r = await orq(['summary'], p);
  assert.equal(r.code, 0, r.err);
  const text = await fs.readFile(path.join(p.repo, '.orq/summary.md'), 'utf8');
  assert.match(r.out, new RegExp(`^summary: \\.orq/summary\\.md \\(${text.trimEnd().split('\n').length} lines\\)\\n$`));
  assert.match(text, /- `test -f a.txt` → pass/);
  assert.match(text, /Checks: `npm test`/);
  assert.match(text, /- review 1: pb::m4 — completed/);
  const again = await orq(['summary', '--out', '.orq/pr.md'], p);
  assert.equal(again.code, 0, again.err);
  assert.equal(await fs.readFile(path.join(p.repo, '.orq/pr.md'), 'utf8'), text);
  for (const out of ['../x.md', '/tmp/x.md', 'README.md', '.orq/../x.md']) {
    const bad = await orq(['summary', '--out', out], p);
    assert.equal(bad.code, 2, out);
    assert.match(bad.err, /--out must be a \.md file directly under \.orq\//);
  }
  const noPlan = await makeProject(t, [unitSpec('z')]);
  await fs.rm(path.join(noPlan.repo, '.orq/plan.json'));
  assert.equal((await orq(['summary'], noPlan)).code, 1);
});

test('renderSummary: a verdict for another head is never shown as current', () => {
  const moved = reduce([...events.slice(0, 5), { type: 'final-gated', unit: null, at: 6, verdict: 'pass', failures: [], head: 'e'.repeat(40) }]);
  const out = renderSummary({ plan, state: moved, gates: {}, checks: 'x' });
  assert.match(out, /Not run for the current head\./);
  assert.doesNotMatch(out, /Verdict:/);
  assert.ok(out.includes(`Head: ${H}`));
});

test('renderSummary: multi-line and null fields stay on one line', () => {
  const p2 = { goal: 'one\ntwo', decisions: ['a\r\nb'], units: [{ ...plan.units[0], title: 'x\ny|z', evidence: null }] };
  const out = renderSummary({ plan: p2, state: reduce(events.slice(0, 5)), gates: {}, checks: null });
  assert.match(out, /^one two$/m);
  assert.match(out, /^- a b$/m);
  assert.match(out, /\| x y\\\|z \|/);
  assert.match(out, /- no evidence command → no gate result/);
  assert.doesNotMatch(out, /null/);
});

test('summary command: --out must be a .md file directly under .orq/, plan must have started', async (t) => {
  const p = await makeProject(t, plan.units);
  await fs.writeFile(path.join(p.repo, '.orq/plan.json'), JSON.stringify(plan));
  const early = await orq(['summary'], p);
  assert.equal(early.code, 4);
  assert.match(early.err, /summary: plan has not started/);
  await fs.writeFile(path.join(p.repo, '.orq/ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await fs.mkdir(path.join(p.repo, '.orq/sub.md'));
  for (const out of ['.orq/ledger.jsonl', '.orq/plan.json', '.orq/units/a/x.md', '.orq/sub/pr.md', '.orq/', '.orq/sub.md', '.orq/notes.txt']) {
    const r = await orq(['summary', '--out', out], p);
    assert.equal(r.code, 2, out);
    assert.match(r.err, /summary: --out must be a \.md file directly under \.orq\//);
  }
  assert.equal((await orq(['summary', '--out', '.orq/pr.md'], p)).code, 0);
  assert.match(await fs.readFile(path.join(p.repo, '.orq/ledger.jsonl'), 'utf8'), /plan-started/);
});

test('summary command: a symlink under .orq cannot redirect the write', async (t) => {
  const p = await makeProject(t, plan.units);
  await fs.writeFile(path.join(p.repo, '.orq/ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const outside = path.join(p.root, 'outside.md');
  symlinkSync(outside, path.join(p.repo, '.orq/link.md'));
  const r = await orq(['summary', '--out', '.orq/link.md'], p);
  assert.equal(r.code, 2);
  await assert.rejects(fs.stat(outside));
});

test('renderSummary: decisions taken without the user list answered asks only; the section is omitted when none', () => {
  const asks = { asks: [
    { n: 1, question: 'Which port?', status: 'answered', outcome: 'use 8080', key: 'pb::m4' },
    { n: 2, question: 'Drop the table?', status: 'escalated', outcome: 'the user must decide', key: 'pb::m4' },
    { n: 3, question: 'Rename x?', status: 'running', outcome: null, key: 'pb::m4' },
  ] };
  const text = renderSummary({ ...input(), asks });
  assert.match(text, /## Decisions taken without you\n\n- Which port\? → use 8080 \(pb::m4\)\n\n## Units/);
  assert.doesNotMatch(text, /Drop the table|Rename x/);
  assert.doesNotMatch(renderSummary({ ...input(), asks: { asks: [asks.asks[1]] } }), /taken without you/);
  assert.doesNotMatch(renderSummary(input()), /taken without you/);
});
