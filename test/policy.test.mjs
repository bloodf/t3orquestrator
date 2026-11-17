// Machine routing policy: free models first, families an instance may run, models kept for decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { route } from '../lib/route.mjs';
import { withPolicy } from '../lib/policy.mjs';
import { providersLine } from '../lib/providers.mjs';
import { setConfigValue } from '../lib/config.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const inst = { enabled: true, constraints: [], limit: 4, failures: 0, cooldownUntil: null };
const mod = (instance, model, tier, family = 'fam-a') => [`${instance}::${model}`, {
  instance, model, family, tier, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null,
}];
const reg = (models) => ({
  version: 1, instances: Object.fromEntries([...new Set(models.map(([, m]) => m.instance))].map((i) => [i, inst])), models: Object.fromEntries(models),
});
const go = (registry, machine = {}, over = {}) => route({
  registry: withPolicy(registry, machine), rules, job: 'implement', now: 1000, ...over,
});
const keys = (r) => r.candidates.map((c) => c.key);

test('free models go first among eligible candidates, marked free; local models are never routed by default', () => {
  const r = reg([mod('sub', 'm2', 2), mod('durindoor-api', 'qwen/qwen3-coder:free', 3), mod('durindoor-api', 'ollama-local/llama3', 2), mod('durindoor-api', 'tiny:free', 1)]);
  const out = go(r);
  assert.deepEqual(keys(out), ['durindoor-api::qwen/qwen3-coder:free', 'sub::m2']); // tier 1 stays out, ollama-local is excluded
  assert.deepEqual(out.candidates.map((c) => Boolean(c.free)), [true, false]);
  assert.deepEqual(keys(go(r, { freeModels: [] })), ['sub::m2', 'durindoor-api::qwen/qwen3-coder:free']); // off: tier first
  assert.deepEqual(keys(go(r, { excludeModels: [] })), ['durindoor-api::qwen/qwen3-coder:free', 'durindoor-api::ollama-local/llama3', 'sub::m2']);
  assert.deepEqual(keys(go(r, { excludeModels: [], freeModels: ['^ollama-local/'] })).slice(0, 1), ['durindoor-api::ollama-local/llama3']);
  assert.deepEqual(keys(go(r, { excludeModels: ['m2$'] })), ['durindoor-api::qwen/qwen3-coder:free', 'durindoor-api::ollama-local/llama3']); // replaces the default
  for (const job of ['decide', 'review', 'docs']) assert.ok(!keys(go(r, {}, { job, authorTier: 2, authorFamily: 'x' })).some((k) => k.includes('ollama')), job);
  // decisions want the strongest model, not the cheapest
  assert.equal(keys(go(r, {}, { job: 'decide' }))[0], 'durindoor-api::qwen/qwen3-coder:free');
  assert.equal(go(r, {}, { job: 'decide' }).candidates.findIndex((c) => c.free), 0);
});

test('an instance runs only the families it allows; antigravity instances only google', () => {
  const r = reg([mod('antigravity', 'claude-sonnet', 3, 'anthropic'), mod('antigravity', 'gemini-pro', 3, 'google'), mod('antigravity-3', 'gpt-x', 3, 'openai'), mod('other', 'gpt-y', 2, 'openai')]);
  assert.deepEqual(keys(go(r)), ['other::gpt-y', 'antigravity::gemini-pro']);
  assert.deepEqual(keys(go(r, { instanceFamilies: { other: ['google'], antigravity: ['anthropic'] } })), ['antigravity::claude-sonnet']);
  const p = withPolicy(r, {});
  assert.deepEqual([p.instances.antigravity.families, p.instances['antigravity-3'].families, p.instances.other.families], [['google'], ['google'], undefined]);
  assert.match(providersLine(p, 0), /; families: antigravity=google, antigravity-3=google$/);
});

test('decision-only models route only for decide; a job left with only them waits, saying why', () => {
  const r = reg([mod('claudeAgent', 'claude-fable-5-2', 4, 'anthropic'), mod('x', 'Astra-1', 4), mod('pa', 'm2', 2)]);
  assert.deepEqual(keys(go(r, {}, { job: 'implement-complex' })), ['pa::m2']); // below its tier rather than a decision model
  assert.equal(go(r, {}, { job: 'implement-complex' }).reason, 'no model at tier 3; using best available');
  for (const job of ['fix', 'review', 'test', 'docs']) {
    assert.ok(!keys(go(r, {}, { job, authorTier: 2, authorFamily: 'fam-a' })).some((k) => /fable|Astra/.test(k)), job);
  }
  assert.deepEqual(keys(go(r, {}, { job: 'decide' })).slice(0, 2).sort(), ['claudeAgent::claude-fable-5-2', 'x::Astra-1']);
  const only = reg([mod('claudeAgent', 'claude-fable-5-2', 4, 'anthropic')]);
  assert.deepEqual(go(only), {
    candidates: [], blocked: 'policy', reason: 'only decision-only models are usable (kept for decisions: machine config decisionOnly)', retryAt: null,
  });
  assert.deepEqual(keys(go(only, { decisionOnly: [] })), ['claudeAgent::claude-fable-5-2']);
  assert.equal(go(reg([mod('antigravity', 'gpt', 2, 'openai')])).reason, 'no model of a family its instance allows (machine config instanceFamilies)');
});

test('providers line counts free and excluded models; withPolicy never changes its input', () => {
  const r = reg([mod('d', 'a:free', 2), mod('d', 'b', 2), mod('d', 'ollama-local/x', 2)]);
  const before = JSON.stringify(r);
  assert.match(providersLine(withPolicy(r, {}), 0), /; 1 free model; 1 excluded model \(d::ollama-local\/x\)$/);
  assert.equal(route({ registry: withPolicy(reg([mod('d', 'ollama-local/x', 2)]), {}), rules, job: 'implement', now: 1 }).reason, 'every usable model is excluded (machine config excludeModels)');
  assert.equal(JSON.stringify(r), before);
});

test('config set --machine: freeModels and decisionOnly take a JSON list or a comma list of regexes, instanceFamilies a JSON map', () => {
  assert.deepEqual(setConfigValue({}, 'freeModels', '[":free$", "^ollama-local/"]', 'machine').freeModels, [':free$', '^ollama-local/']);
  assert.deepEqual(setConfigValue({}, 'freeModels', '[]', 'machine').freeModels, []);
  assert.deepEqual(setConfigValue({}, 'decisionOnly', 'astra, fable', 'machine').decisionOnly, ['astra', 'fable']);
  assert.deepEqual(setConfigValue({}, 'excludeModels', '^ollama-local/', 'machine').excludeModels, ['^ollama-local/']);
  assert.deepEqual(setConfigValue({}, 'instanceFamilies', '{"ag":["google"]}', 'machine').instanceFamilies, { ag: ['google'] });
  assert.deepEqual(setConfigValue({ freeModels: [] }, 'freeModels', 'null', 'machine'), {});
  assert.throws(() => setConfigValue({}, 'freeModels', '["("]', 'machine'), /freeModels: "\(" is not a valid regular expression/);
  assert.throws(() => setConfigValue({}, 'instanceFamilies', '{"ag":"google"}', 'machine'), /instanceFamilies must be a JSON object of instance ids to lists of families/);
});

test('review fixes: any antigravity instance runs google only; prototype-named instances route; decision-only patterns are anchored', () => {
  const r = reg([mod('codex-antigravity-proxy', 'gpt-x', 3, 'openai'), mod('codex-antigravity-proxy', 'gemini', 3, 'google'), mod('constructor', 'm', 2), mod('toString', 'n', 2)]);
  assert.deepEqual(keys(go(r)).sort(), ['codex-antigravity-proxy::gemini', 'constructor::m', 'toString::n']);
  const d = reg([mod('cx', 'cx/gpt-6-astra', 4), mod('a', 'claude-fable-5-2', 4), mod('o', 'anthropic/claude-fable-5-1', 4), mod('p', 'castrate-1', 4), mod('q', 'fabled-coder', 4), mod('z', 'FABLE', 4)]);
  assert.deepEqual(keys(go(d, {}, { job: 'plan' })).sort(), ['p::castrate-1', 'q::fabled-coder']);
});

test('config: a regex with a comma needs the JSON list form', () => {
  assert.deepEqual(setConfigValue({}, 'freeModels', '["a{1,2}"]', 'machine').freeModels, ['a{1,2}']);
  assert.deepEqual(setConfigValue({}, 'freeModels', 'a{1,2}', 'machine').freeModels, ['a{1', '2}']);
});
