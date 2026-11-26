// orq watchdog tick: nudge once, a fresh thread when the nudge brings no progress, escalate instead of stopping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTick, NUDGE, NUDGE_INBOX } from '../lib/watchdog.mjs';
import { cronLine, plist, withCronLine } from '../lib/commands/watchdog.mjs';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const MIN = 60_000;

async function setup(t, { goal = 'ship it', status = 'completed', start = 'Take over from OLD_THREAD.', files = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-watchdog-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'proj');
  await fs.mkdir(path.join(project, '.orq'), { recursive: true });
  await fs.writeFile(path.join(project, '.orq', 'config.json'), JSON.stringify({
    t3: { bin: 't3', version: 'v1' }, checks: { setup: null, unit: null, full: null }, ...(goal ? { goal } : {}),
  }));
  const dir = path.join(home, 'watchdog', 'alpha');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'path'), `${project}\n`);
  await fs.writeFile(path.join(dir, 'thread'), 'old-thread\n');
  if (start) await fs.writeFile(path.join(dir, 'start.txt'), start);
  for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(dir, f), text);
  const w = {
    root, home, project, dir, status, sent: [], started: [], next: 1,
  };
  w.t3 = () => ({
    showThread: (id) => ({ thread: { id, status: w.status, instance: 'pa' }, messages: [] }),
    sendThread: (id, message) => { w.sent.push({ id, message }); return {}; },
    startThread: (a) => { w.started.push(a); return { threadId: `new-${w.next++}` }; },
  });
  return w;
}

const candidates = {
  plan: [{ instance: 'pa', model: 'fable-1' }, { instance: 'pa', model: 'big' }, { instance: 'pb', model: 'big' }],
  'implement-complex': [{ instance: 'pc', model: 'mid' }],
};
const tick = (w, now, over = {}) => runTick({
  env: { T3ORQ_HOME: w.home }, now: () => now, deps: { createT3: w.t3, exec: () => ({}), watchdogRoute: async (job) => candidates[job] ?? [] }, ...over,
});
const read = (f) => fs.readFile(f, 'utf8').then((s) => s.trim(), () => null);

test('watchdog: a stopped orchestrator with an open goal is nudged once, then replaced when nothing moved', async (t) => {
  const w = await setup(t);
  assert.deepEqual(await tick(w, NOW), ['alpha: completed, goal open, nudged']);
  assert.deepEqual(w.sent, [{ id: 'old-thread', message: NUDGE }]);
  // the same tick again within the cycle: no second nudge, no fresh thread
  assert.deepEqual(await tick(w, NOW + 2 * MIN), ['alpha: completed, nudged 2 min ago']);
  const [line] = await tick(w, NOW + 10 * MIN);
  assert.match(line, /no progress 10 min after a nudge; fresh orchestrator new-1 on pb big \(took over old-thread\)/);
  // pa runs this orchestrator already: another account first; a decision-only model never orchestrates
  assert.deepEqual(w.started, [{ project: w.project, message: 'Take over from old-thread.', provider: 'pb', model: 'big', title: 'alpha - Orchestrator' }]);
  assert.equal(await read(path.join(w.dir, 'thread')), 'new-1');
  assert.equal(await read(path.join(w.dir, 'nudge.json')), null);
  assert.match(await read(path.join(w.home, 'watchdog', 'log')), /alpha: completed, goal open, nudged/);
});

test('watchdog: ledger progress after a nudge earns another nudge, not a fresh thread', async (t) => {
  const w = await setup(t);
  await tick(w, NOW);
  await fs.writeFile(path.join(w.project, '.orq', 'ledger.jsonl'), '{"type":"x"}\n');
  assert.deepEqual(await tick(w, NOW + 10 * MIN), ['alpha: completed, goal open, nudged']);
  assert.equal(w.started.length, 0);
});

test('watchdog: a thread at work, a hold, a remote host, a met goal are left alone', async (t) => {
  const w = await setup(t, { status: 'running' });
  assert.deepEqual(await tick(w, NOW), ['alpha: running']);
  w.status = 'completed';
  await fs.writeFile(path.join(w.dir, 'hold'), '');
  assert.deepEqual(await tick(w, NOW), ['alpha: on hold']);
  await fs.rm(path.join(w.dir, 'hold'));
  await fs.writeFile(path.join(w.dir, 'remote'), 'otherhost\n');
  assert.match((await tick(w, NOW))[0], /runs on another host/);
  const done = await setup(t, { goal: null });
  assert.deepEqual(await tick(done, NOW), ['alpha: completed, no open goal']);
  assert.deepEqual([w.sent, done.sent, w.started], [[], [], []]);
});

test('watchdog: an undelivered inbox message is a reason to nudge, even with no goal', async (t) => {
  const w = await setup(t, { goal: null });
  await fs.writeFile(path.join(w.project, '.orq', 'inbox.md'), '## 2026-11-26T11:00:00.000Z\nswitch to draft\n');
  assert.deepEqual(await tick(w, NOW), ['alpha: completed with an undelivered inbox message, nudged']);
  assert.equal(w.sent[0].message, NUDGE_INBOX);
});

test('watchdog: a failed thread is replaced at once, on another account than the failed one', async (t) => {
  const w = await setup(t, { status: 'failed' });
  const [line] = await tick(w, NOW);
  assert.match(line, /thread failed; fresh orchestrator new-1 on pb big/);
});

test('watchdog: three fresh threads in 2 h, or no model, escalate one line instead of asking the user forever', async (t) => {
  const recent = [1, 2, 3].map((n) => `${NOW - n * MIN} pb big`).join('\n');
  const w = await setup(t, { status: 'failed', files: { replaced: `${recent}\n` } });
  const [line] = await tick(w, NOW);
  assert.match(line, /3 fresh threads in 2 h did not hold; escalated to/);
  assert.match(await read(path.join(w.home, 'supervisor', 'escalations.log')), /alpha: thread failed, and 3 fresh threads/);
  assert.match((await tick(w, NOW + MIN))[0], /escalated already/);
  assert.equal((await read(path.join(w.home, 'supervisor', 'escalations.log'))).split('\n').length, 1);
  // past the window the replacements are free again
  assert.match((await tick(w, NOW + 125 * MIN))[0], /fresh orchestrator new-1/);
  const none = await setup(t, { status: 'failed' });
  const [l2] = await tick(none, NOW, { deps: { createT3: none.t3, exec: () => ({}), watchdogRoute: async () => [] } });
  assert.match(l2, /orq has no usable model for a fresh thread; escalated/);
});

test('watchdog: --dry-run says what it would do and changes nothing', async (t) => {
  const w = await setup(t, { status: 'failed' });
  const [line] = await tick(w, NOW, { dryRun: true });
  assert.match(line, /would start a fresh orchestrator on pb big/);
  assert.deepEqual([w.started, await read(path.join(w.dir, 'thread')), await read(path.join(w.home, 'watchdog', 'log'))], [[], 'old-thread', null]);
});

test('watchdog install: the launchd agent and the tagged crontab line, replaced in place', () => {
  const job = {
    node: '/usr/bin/node', orq: '/k/bin/orq.mjs', env: { PATH: '/a b:/c', T3CODE_HOME: "/h/it's" }, log: '/h/.t3orq/watchdog/log',
  };
  assert.match(plist(job), /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(plist(job), /<string>watchdog<\/string><string>tick<\/string>/);
  const line = cronLine(job);
  assert.equal(line, `*/10 * * * * PATH='/a b:/c' T3CODE_HOME='/h/it'\\''s' '/usr/bin/node' '/k/bin/orq.mjs' watchdog tick >/dev/null 2>>'/h/.t3orq/watchdog/log' # orq-watchdog`);
  const first = withCronLine('0 3 * * * other\n', line);
  assert.deepEqual(first, { text: `0 3 * * * other\n${line}\n`, changed: true });
  assert.deepEqual(withCronLine(first.text, line), { text: first.text, changed: false });
  assert.equal(withCronLine(`0 3 * * * other\n*/10 * * * * old # orq-watchdog\n`, line).text, `0 3 * * * other\n${line}\n`);
});
