import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validatePlan } from '../lib/plan.mjs';
import { commands } from '../lib/cli.mjs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const lineCount = (f) => read(f).replace(/\n$/, '').split('\n').length;
const stub = (f) => read(f).match(/```\n([\s\S]*?)```/)?.[1];

const ORCH = 'playbook/ORCHESTRATOR.md';
const TEMPLATES = ['playbook/templates/work-order.md', 'playbook/templates/review-order.md'];
const DOCS = ['BOOTSTRAP.md', ORCH, ...TEMPLATES];

test('playbook files stay within their line budgets', () => {
  assert.ok(lineCount('BOOTSTRAP.md') <= 25);
  assert.ok(lineCount(ORCH) <= 150);
  for (const f of TEMPLATES) assert.ok(lineCount(f) <= 40, f);
});

test('README stub is byte-identical to BOOTSTRAP stub and points at an existing playbook', () => {
  const s = stub('BOOTSTRAP.md');
  assert.ok(s);
  assert.equal(stub('README.md'), s);
  assert.match(s, /playbook\/ORCHESTRATOR\.md/);
  assert.ok(fs.existsSync(new URL(ORCH, root)));
});

test('plan.example.json is a valid plan', () => {
  const plan = JSON.parse(read('playbook/templates/plan.example.json'));
  const { jobs } = JSON.parse(read('playbook/routing.json'));
  const result = validatePlan(plan, { cwd: '/nonexistent-orq-project', jobs, exists: () => true, readFile: () => '# Work order: x — y\n' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('ORCHESTRATOR.md names only real orq commands', () => {
  const allowed = new Set(Object.keys(commands).filter((c) => c !== 'gate-run'));
  const used = [...read(ORCH).matchAll(/`orq ([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const c of used) assert.ok(allowed.has(c), `unknown orq command: ${c}`);
});

test('playbook docs name no real model, provider or tool', () => {
  const families = JSON.parse(read('playbook/suggestions.json')).families.map((f) => f.family);
  const tools = JSON.parse(read('playbook/tools.json')).tools.map((t) => t.name);
  const deny = [...new Set([...families, ...tools])];
  assert.ok(deny.length > 0);
  for (const f of DOCS) {
    const text = read(f).toLowerCase();
    for (const name of deny) {
      assert.doesNotMatch(text, new RegExp(`(^|[^a-z0-9_-])${name.toLowerCase()}([^a-z0-9_-]|$)`), `${f} names "${name}"`);
    }
  }
});
