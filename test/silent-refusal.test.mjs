// A provider that refuses a thread without a reply (Codex reports its usage limit as a turn error): the reason is read
// from T3's own log of the thread, and a preferred instance is not left for another model family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { threadError } from '../lib/t3-log.mjs';
import { observeThreads } from '../lib/wait-threads.mjs';
import { reduce } from '../lib/ledger.mjs';
import { route } from '../lib/route.mjs';
import { withPolicy } from '../lib/policy.mjs';

const NOW = Date.parse('2026-11-22T18:00:00Z');
const REFUSAL = 'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 24th, 2026 7:59 PM.';
// as T3 writes it: one line per protocol event, the turn error twice (the `error` event and the failed turn)
const line = (payload) => `[2026-11-22T17:59:12.284Z] NTIVE: ${JSON.stringify({ provider: 'codex', kind: 'protocol', event: { direction: 'incoming', payload } })}\n`;
const LOG = line({ method: 'mcpServer/startupStatus/updated', params: { name: 't3-code', status: 'ready', error: null } })
  + line({ method: 'item/completed', params: { item: { type: 'userMessage', content: [{ type: 'text', text: 'quote "error":{"message":"Rate limit reached"} in the order' }] } } })
  + line({ method: 'error', params: { error: { message: REFUSAL, codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } })
  + line({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: REFUSAL, codexErrorInfo: 'usageLimitExceeded' } } } });

async function t3Home(t, logs = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-t3log-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'userdata', 'logs', 'provider');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(logs)) await fs.writeFile(path.join(dir, name), text);
  return home;
}

test('threadError: the last error the provider gave in T3\'s log of the thread; null when there is none', async (t) => {
  const home = await t3Home(t, { 'events.mcp-44157441-bde5.log': LOG, 'events.mcp-quiet.log': line({ method: 'turn/started', params: { error: null } }) });
  const ctx = { env: { T3CODE_HOME: home } };
  assert.equal(threadError(ctx, {}, 'mcp:44157441-bde5'), REFUSAL);
  assert.equal(threadError({ env: {} }, { t3Home: home }, 'mcp:44157441-bde5'), REFUSAL); // the machine's recorded T3 home
  assert.equal(threadError(ctx, {}, 'mcp:quiet'), null);
  assert.equal(threadError(ctx, {}, 'mcp:none'), null); // no log
  assert.equal(threadError(ctx, {}, '../../../../etc/passwd'), null); // an id never leaves the log directory
  // only an error of the run that stopped: the refusal was logged at 17:59:12, so a run started after it has none
  assert.equal(threadError(ctx, {}, 'mcp:44157441-bde5', { after: Date.parse('2026-11-22T17:59:00Z') }), REFUSAL);
  assert.equal(threadError(ctx, {}, 'mcp:44157441-bde5', { after: Date.parse('2026-11-22T18:30:00Z') }), null);
});

const A = 'a'.repeat(40);
const state = reduce([
  { type: 'plan-started', unit: null, at: 1, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
  { type: 'launched', unit: 'u', at: 2, attempt: 1, threadId: 'mcp:t1', key: 'codex::sol', instance: 'codex', model: 'sol', branch: 'orq/p1/u-a1', baseSha: A, tier: 3 },
]);
const plan = { units: [{ id: 'u' }] };
const fx = (messages, said) => ({ now: () => NOW, threadError: () => said, t3: { showThread: () => ({ thread: {}, messages }) } });
const failed = { id: 'mcp:t1', status: 'failed', updatedAt: NOW - 1000 };

test('a logged error from before the stopped run started is not read: the reply counts', () => {
  // launched at 2 and fed back at NOW - 5 min: the run that stopped started then
  const later = reduce([
    { type: 'plan-started', unit: null, at: 1, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    { type: 'launched', unit: 'u', at: 2, attempt: 1, threadId: 'mcp:t1', key: 'codex::sol', instance: 'codex', model: 'sol', branch: 'orq/p1/u-a1', baseSha: A, tier: 3 },
    { type: 'thread-ended', unit: 'u', at: 3, status: 'completed' },
    { type: 'gated', unit: 'u', at: 4, attempt: 1, verdict: 'fail', failures: ['x'], flags: [], headSha: A },
    { type: 'feedback-sent', unit: 'u', at: NOW - 5 * 60_000, attempt: 2, threadId: 'mcp:t1' },
  ]);
  const asked = [];
  const f = {
    now: () => NOW,
    threadError: (id, after) => { asked.push(after); return after <= NOW - 60 * 60_000 ? REFUSAL : null; }, // logged an hour ago
    t3: { showThread: () => ({ thread: {}, messages: [{ role: 'assistant', text: 'Now let me check the docs.' }] }) },
  };
  assert.equal(observeThreads(f, plan, later, [failed])['mcp:t1'].limit, undefined);
  assert.deepEqual(asked, [NOW - 5 * 60_000]);
  assert.equal(observeThreads({ ...f, threadError: (id, after) => (after === 2 ? REFUSAL : null) }, plan, state, [failed])['mcp:t1'].limit.kind, 'limit'); // the launch run
});

test('a failed thread carries the limit its provider logged, before its last reply; a completed turn is read from its reply', () => {
  const user = [{ role: 'user', text: '# Work order' }];
  const { limit } = observeThreads(fx(user, REFUSAL), plan, state, [failed])['mcp:t1'];
  assert.deepEqual([limit.kind, limit.until], ['limit', new Date(2026, 10, 24, 19, 59).getTime()]); // no zone: this machine's time
  assert.equal(observeThreads(fx(user, null), plan, state, [failed])['mcp:t1'].limit, undefined);
  assert.equal(observeThreads(fx(user, 'unexpected status 404 Not Found'), plan, state, [failed])['mcp:t1'].limit, undefined); // not a limit: a failure
  // the worker said something before the refusal: the logged error wins over its narration
  const narrated = [{ role: 'assistant', text: 'Now let me check the docs.' }];
  assert.equal(observeThreads(fx(narrated, REFUSAL), plan, state, [failed])['mcp:t1'].limit.kind, 'limit');
  // a logged error that is no limit leaves the reply to speak for itself
  const refused = [{ role: 'assistant', text: 'Token Plan usage limit reached (2056)' }];
  assert.equal(observeThreads(fx(refused, 'unexpected status 404 Not Found'), plan, state, [failed])['mcp:t1'].limit.kind, 'limit');
  assert.equal(observeThreads(fx(narrated, null), plan, state, [failed])['mcp:t1'].limit, undefined);
  const done = { ...failed, status: 'completed' };
  assert.equal(observeThreads(fx(user, REFUSAL), plan, state, [done])['mcp:t1'].limit, undefined);
});

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const inst = { enabled: true, constraints: [], limit: 4, failures: 0, cooldownUntil: null };
const mod = (instance, model, family) => [`${instance}::${model}`, {
  instance, model, family, tier: 3, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null,
}];

test('preferInstances: after a failure the unit moves to the preferred sibling instance, not to another model family', () => {
  const models = [mod('codex', 'sol', 'openai'), mod('codex-2', 'sol', 'openai'), mod('claude', 'sonnet', 'anthropic')];
  const registry = { version: 1, instances: { codex: inst, 'codex-2': inst, claude: inst }, models: Object.fromEntries(models) };
  const go = (machine) => route({
    registry: withPolicy(registry, machine), rules, job: 'implement', now: NOW, avoidKeys: ['codex::sol'], avoidInstances: ['codex'], avoidFamilies: ['openai'],
  }).candidates.map((c) => c.key);
  assert.deepEqual(go({}), ['claude::sonnet', 'codex-2::sol', 'codex::sol']); // no preference: another family first, as before
  assert.deepEqual(go({ preferInstances: ['^codex(-[0-9]+)?$'] }), ['codex-2::sol', 'claude::sonnet', 'codex::sol']);
});
