import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggest, outranks, TIER_SOURCES } from '../lib/tiers.mjs';

const suggestions = JSON.parse(readFileSync(new URL('../playbook/suggestions.json', import.meta.url), 'utf8'));

test('suggest: family and tier from first match', () => {
  assert.deepEqual(suggest('claude-opus-9', suggestions), { family: 'anthropic', tier: 4, tierSource: 'suggested' });
  assert.deepEqual(suggest('gpt-5-mini', suggestions), { family: 'openai', tier: 1, tierSource: 'suggested' });
  assert.deepEqual(suggest('GEMINI-pro', suggestions), { family: 'google', tier: 3, tierSource: 'suggested' });
});

test('suggest: first tier entry wins when several match', () => {
  assert.equal(suggest('claude-opus-mini', suggestions).tier, 1);
});

test('suggest: no match is unknown family, tier 2 inferred', () => {
  assert.deepEqual(suggest('model-x', suggestions), { family: 'unknown', tier: 2, tierSource: 'inferred' });
});

test('suggest: validates shape and patterns', () => {
  assert.throws(() => suggest('m', null), /suggestions/);
  assert.throws(() => suggest('m', { families: [], tiers: 'x' }), /tiers/);
  assert.throws(() => suggest('m', { families: [{ match: '(', family: 'a' }], tiers: [] }), /pattern/);
  assert.throws(() => suggest('m', { families: [], tiers: [{ match: 'a', tier: 9 }] }), /tier/);
  assert.throws(() => suggest('', suggestions), /modelId/);
});

test('TIER_SOURCES order and outranks', () => {
  assert.deepEqual([...TIER_SOURCES], ['user', 'orchestrator', 'suggested', 'inferred']);
  assert.equal(outranks('user', 'suggested'), true);
  assert.equal(outranks('suggested', 'suggested'), false);
  assert.equal(outranks('inferred', 'user'), false);
  assert.throws(() => outranks('bogus', 'user'), /bogus/);
});

test('suggest: "gemini" is not matched by the "mini" tier pattern', () => {
  assert.equal(suggest('gemini-ultra', suggestions).tier, 4);
  assert.equal(suggest('gemini-2-flash', suggestions).tier, 1);
});

test('suggest: tier keywords match whole tokens only', () => {
  const t = (id) => suggest(id, suggestions);
  assert.deepEqual(t('minimax-m2'), { family: 'minimax', tier: 2, tierSource: 'inferred' });
  assert.equal(t('vendor-x-flash').tier, 1);
  assert.equal(t('gemini-x').tier, 2);
  assert.equal(t('vendor-x-pro').tier, 3);
  assert.equal(t('vendor-prose-x').tier, 2);
  assert.equal(t('vendor-process-x').tier, 2);
  assert.equal(t('vendor-x-max').tier, 3);
  assert.equal(t('vendor-opus-x').tier, 4);
});

test('suggest: openai o-series at start or after a colon only', () => {
  assert.equal(suggest('o3', suggestions).family, 'openai');
  assert.equal(suggest('m:vendor:o4', suggestions).family, 'openai');
  assert.equal(suggest('foo3', suggestions).family, 'unknown');
});
