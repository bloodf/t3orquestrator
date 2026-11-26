import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cronLines, install, keepPaths, mergeCrontab, plist, schedule, startCleanup,
} from '../lib/maint.mjs';
import { writeGateLease, writeLease } from '../lib/leases.mjs';

const KIT = fileURLToPath(new URL('..', import.meta.url));
const NOW = 1_800_000_000_000;
const tmp = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-maint-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// a fake t3 CLI: `thread list --project <p> --json` answers from a JSON file of {project: threads}; exit 1 when FAIL exists
function fakeT3(dir, threads) {
  const data = path.join(dir, 't3-threads.json');
  fs.writeFileSync(data, JSON.stringify(threads));
  const bin = path.join(dir, 't3');
  fs.writeFileSync(bin, `#!/bin/sh
[ -e "${dir}/FAIL" ] && { echo "t3 down" >&2; exit 1; }
exec node -e 'const t = require(process.argv[1]); process.stdout.write(JSON.stringify(t[process.argv[2]] ?? []))' "${data}" "$4"
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}
const thread = (id, worktreePath, status = 'completed') => ({
  threadId: id, projectId: 'p', status, itemCount: 1, updatedAt: new Date(NOW).toISOString(), worktreePath,
});

test('schedule and cron lines: staggered per machine, stable, tmp-churn hourly and disk-clean every 6 hours', () => {
  assert.deepEqual(schedule('host-a'), schedule('host-a'));
  const hosts = ['host-a', 'host-b', 'host-c'].map((h) => schedule(h).churn);
  assert.ok(new Set(hosts).size > 1, String(hosts));
  const s = schedule('host-a');
  assert.equal(s.disk, (s.churn + 30) % 60);
  const [churn, disk] = cronLines({ host: 'host-a', kit: '/k/maint/', env: { PATH: '/usr/bin:/bin', T3ORQ_HOME: "/h/it's" } });
  assert.equal(churn, `${s.churn} * * * * PATH='/usr/bin:/bin' T3ORQ_HOME='/h/it'\\''s' /bin/sh '/k/maint/tmp-churn.sh' >/dev/null 2>&1 # orq-maint tmp-churn`);
  assert.match(disk, new RegExp(`^${s.disk} ${s.diskHour},${s.diskHour + 6},${s.diskHour + 12},${s.diskHour + 18} \\* \\* \\* .*disk-clean\\.sh' .*# orq-maint disk-clean$`));
});

test('mergeCrontab is idempotent, replaces only orq-maint lines, and lists other cleanup lines without touching them', () => {
  const lines = cronLines({ host: 'h', kit: '/k/maint/' });
  const current = ['MAILTO=""', '*/10 * * * * /h/reenable.sh', '23 * * * * /h/.t3orq/maint/tmp-churn.sh', '0 3 * * * /opt/other/disk-clean.sh', '# 5 * * * * disk-clean.sh (commented)', '7 * * * * /bin/sh /old/kit/maint/tmp-churn.sh # orq-maint tmp-churn', ''].join('\n');
  const once = mergeCrontab(current, lines);
  assert.equal(once.replaced, 1);
  assert.deepEqual(once.legacy, ['23 * * * * /h/.t3orq/maint/tmp-churn.sh', '0 3 * * * /opt/other/disk-clean.sh']);
  assert.deepEqual(once.text.trimEnd().split('\n'), ['MAILTO=""', '*/10 * * * * /h/reenable.sh', '23 * * * * /h/.t3orq/maint/tmp-churn.sh', '0 3 * * * /opt/other/disk-clean.sh', '# 5 * * * * disk-clean.sh (commented)', ...lines]);
  const twice = mergeCrontab(once.text, lines);
  assert.equal(twice.text, once.text);
  assert.equal(mergeCrontab('', lines).text, `${lines.join('\n')}\n`);
});

test('plist: calendar times only, never RunAtLoad, low priority I/O, escaped values', () => {
  const s = schedule('mac');
  const p = plist({
    name: 'disk-clean', host: 'mac', kit: '/k/maint/', env: { PATH: '/usr/bin:/bin', T3ORQ_HOME: '/h/a&b' },
  });
  assert.match(p, /<key>Label<\/key><string>com\.t3orq\.disk-clean<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(p, /<key>RunAtLoad<\/key><true/);
  assert.match(p, /<key>LowPriorityIO<\/key><true\/>/);
  assert.match(p, /\/h\/a&amp;b/);
  assert.equal(p.match(/<key>Hour<\/key>/g).length, 4);
  assert.match(plist({ name: 'tmp-churn', host: 'mac', kit: '/k/maint/' }), new RegExp(`<array><dict><key>Minute</key><integer>${s.churn}</integer></dict></array>`));
});

test('install: launchd on macOS (bootout then bootstrap, same labels as before), crontab on Linux, dry run changes nothing', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, ...args, opts?.input ?? '']); return { code: cmd === 'crontab' && args[0] === '-l' ? 0 : 0, stdout: cmd === 'crontab' ? '5 * * * * other\n' : '', stderr: '' }; };
  const mac = install({
    platform: 'darwin', host: 'mac', env: { PATH: '/bin' }, exec, home, uid: 501,
  });
  assert.equal(mac.length, 2);
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.t3orq.disk-clean.plist')));
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['launchctl', 'bootout', 'gui/501/com.t3orq.tmp-churn'], ['launchctl', 'bootstrap', 'gui/501'],
    ['launchctl', 'bootout', 'gui/501/com.t3orq.disk-clean'], ['launchctl', 'bootstrap', 'gui/501']]);
  calls.length = 0;
  const linux = install({
    platform: 'linux', host: 'storm', env: { PATH: '/bin', T3ORQ_HOME: '/h/o' }, exec,
  });
  assert.match(linux[0], /installed cron entries \(0 earlier orq-maint lines replaced\)/);
  assert.equal(calls[1][0], 'crontab');
  assert.match(calls[1][2], /^5 \* \* \* \* other\n.*tmp-churn.*\n.*disk-clean/s);
  calls.length = 0;
  const dry = install({
    platform: 'linux', host: 'storm', env: { PATH: '/bin' }, exec, dryRun: true,
  });
  assert.equal(dry[0], 'would install crontab:');
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['crontab', '-l']]); // read only
  assert.throws(() => install({ platform: 'win32', env: {}, exec }), /not supported/);
  const broken = (cmd, args) => (args[0] === '-l' ? { code: 1, stdout: '', stderr: 'crontab: permission denied' } : assert.fail('must not write'));
  assert.throws(() => install({ platform: 'linux', host: 'h', env: {}, exec: broken }), /crontab -l failed/); // never a crontab without the user's lines
  const none = [];
  install({
    platform: 'linux', host: 'h', env: {}, exec: (cmd, args, o) => { none.push(o?.input); return args[0] === '-l' ? { code: 1, stdout: '', stderr: 'no crontab for u' } : { code: 0 }; },
  });
  assert.match(none[1], /orq-maint tmp-churn/);
  // a plist with the same label that orq did not write is backed up first
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.t3orq.tmp-churn.plist');
  fs.writeFileSync(plistFile, '<plist>hand made</plist>');
  const again = install({
    platform: 'darwin', host: 'mac', env: { PATH: '/bin' }, exec, home, uid: 501, now: () => 42,
  });
  assert.equal(fs.readFileSync(`${plistFile}.bak-42`, 'utf8'), '<plist>hand made</plist>');
  assert.ok(again.some((l) => l.includes('kept as')));
  assert.equal(install({
    platform: 'darwin', host: 'mac', env: { PATH: '/bin' }, exec, home, uid: 501, now: () => 43,
  }).some((l) => l.includes('kept as')), false); // our own plist is simply replaced
});

async function keepCtx(t, threads) {
  const dir = tmp(t);
  const bin = fakeT3(dir, threads);
  const home = path.join(dir, 'orq');
  return {
    dir, home, ctx: { env: { T3ORQ_HOME: home, T3CODE_CLI_PATH: bin }, now: () => NOW, deps: { homedir: () => dir, exec: (b, a) => { const r = spawnSync(b, a, { encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; } } },
  };
}

test('keepPaths: leased projects, worktrees of leased threads and of T3 threads at work; fail closed when a leased thread is unknown', async (t) => {
  const k = await keepCtx(t, {
    '/p/one': [thread('th1', '/wt/one-1'), thread('th2', '/wt/one-2', 'running'), thread('th3', '/wt/one-3')],
    '/p/plain': [thread('th9', '/wt/plain-9', 'running'), thread('th8', '/wt/plain-8')],
  });
  await writeLease(path.join(k.home, 'leases'), {
    threadId: 'th1', project: '/p/one', unit: 'a', instance: 'i', model: 'm', startedAt: NOW,
  });
  await writeGateLease(path.join(k.home, 'gate-leases'), {
    id: '1'.repeat(16), pid: 4242, project: '/p/gated', unit: 'b', startedAt: NOW,
  });
  // the fake t3 lists no threads for /p/gated: an empty list is an answer
  assert.deepEqual(await keepPaths(k.ctx, ['/p/plain']), ['/p/gated', '/p/one', '/wt/one-1', '/wt/one-2', '/wt/plain-9']);
  const real = fs.realpathSync(k.dir);
  const alias = path.join(k.dir, 'alias');
  fs.symlinkSync(real, alias);
  await writeLease(path.join(k.home, 'leases'), {
    threadId: 'th3', project: alias, unit: 'c', instance: 'i', model: 'm', startedAt: NOW,
  });
  const withAlias = await keepPaths(k.ctx);
  assert.ok(withAlias.includes(alias) && withAlias.includes(real), 'a symlinked path is kept by its real path too');
  fs.rmSync(path.join(k.home, 'leases', 'th3.json'));
  fs.writeFileSync(path.join(k.home, 'gate-leases', `${'2'.repeat(16)}.json`), '{torn');
  await assert.rejects(keepPaths(k.ctx), /invalid JSON/); // an unreadable gate lease: uncertain, nothing is deleted
  fs.rmSync(path.join(k.home, 'gate-leases', `${'2'.repeat(16)}.json`));
  await writeLease(path.join(k.home, 'leases'), {
    threadId: 'gone', project: '/p/one', unit: 'b', instance: 'i', model: 'm', startedAt: NOW,
  });
  await assert.rejects(keepPaths(k.ctx), /worktree of leased thread gone is not known/);
  fs.writeFileSync(path.join(k.dir, 'FAIL'), '');
  await assert.rejects(keepPaths(k.ctx), /threads of \/p\/one could not be read/);
  fs.rmSync(path.join(k.home, 'leases'), { recursive: true });
  fs.rmSync(path.join(k.home, 'gate-leases'), { recursive: true });
  await assert.rejects(keepPaths(k.ctx, ['/p/not-t3']), /threads of \/p\/not-t3 could not be read/); // never "not a T3 project"
  fs.rmSync(path.join(k.dir, 'FAIL'));
  assert.deepEqual(await keepPaths(k.ctx), []);
});

test('startCleanup starts one run at most once an hour', async (t) => {
  const dir = tmp(t);
  let clock = NOW;
  const started = [];
  const ctx = {
    env: {
      T3ORQ_HOME: dir, MAINT_TEMP_ROOTS: '/', MAINT_CHURN_ROOTS: '/', ORQ_MAINT_TEST: '1', ORQ_MAINT_TEST_AREA: '/', ORQ_MAINT_TEST_PAUSE: '/x', KEEP_ME: 'y',
    },
    now: () => clock,
  };
  const spawnClean = (o) => started.push(o);
  assert.equal(await startCleanup(ctx, { spawnClean }), true);
  assert.equal(started[0].env.T3ORQ_HOME, dir);
  assert.equal(started[0].env.KEEP_ME, 'y');
  assert.deepEqual(Object.keys(started[0].env).filter((k) => /^(MAINT_|ORQ_MAINT_)/.test(k)), []); // test-only overrides never reach a real run
  clock += 30 * 60_000;
  assert.equal(await startCleanup(ctx, { spawnClean }), false);
  clock += 31 * 60_000;
  assert.equal(await startCleanup(ctx, { spawnClean }), true);
  assert.equal(started.length, 2);
});

const OLD = () => Date.now() / 1000 - 2 * 86400;
const age = (p) => { const at = OLD(); fs.utimesSync(p, at, at); };
function mkOld(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  age(file);
  for (let d = path.dirname(file); d.length > 1 && d.includes(`${path.sep}temp`); d = path.dirname(d)) age(d);
}

// A temp root with old scratch and old things that must stay, a leased project reached through a symlink, a
// maint-skip glob, and a pushed, clean, idle git worktree outside the temp root (worktrees are never cleaned here).
function world(t) {
  const dir = tmp(t);
  const home = path.join(dir, 'home');
  const orqHome = path.join(dir, 'orq');
  const temp = path.join(dir, 'temp');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(dir, 'wt-idle');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main');
  mkOld(path.join(temp, 'old-scratch', 'f'));
  // a disposable checkout with uncommitted work: is a repository, never scratch
  const checkout = path.join(temp, 'old-checkout');
  fs.mkdirSync(checkout, { recursive: true });
  git(checkout, 'init', '-q');
  mkOld(path.join(checkout, 'uncommitted.txt'), 'work');
  age(path.join(checkout, '.git'));
  for (const f of fs.readdirSync(path.join(checkout, '.git'), { recursive: true })) age(path.join(checkout, '.git', f));
  age(checkout);
  // a directory holding a repository deeper down
  const nest = path.join(temp, 'old-nest');
  fs.mkdirSync(path.join(nest, 'a'), { recursive: true });
  git(path.join(nest, 'a'), 'init', '-q');
  for (const f of fs.readdirSync(nest, { recursive: true })) age(path.join(nest, f));
  age(nest);
  // a leased project, named in its lease through a symlink alias
  const leasedDir = path.join(temp, 'old-leased');
  mkOld(path.join(leasedDir, 'f'));
  const alias = path.join(dir, 'alias-to-leased');
  fs.symlinkSync(leasedDir, alias);
  // a maint-skip glob that matches a child: its parent must stay too
  mkOld(path.join(temp, 'old-parent', 'precious-1', 'f'));
  fs.mkdirSync(orqHome, { recursive: true });
  fs.writeFileSync(path.join(orqHome, 'maint-skip'), '*/precious-*\n');
  const bin = fakeT3(dir, { [alias]: [] });
  fs.mkdirSync(path.join(orqHome, 'leases'), { recursive: true });
  fs.writeFileSync(path.join(orqHome, 'leases', 'th1.json'), JSON.stringify({
    threadId: 'th1', project: alias, unit: 'a', instance: 'i', model: 'm', startedAt: NOW, reservation: true,
  }));
  const run = (script, env = {}, cwd = dir) => spawnSync('/bin/sh', [path.join(KIT, 'maint', script)], {
    encoding: 'utf8',
    cwd,
    env: {
      PATH: process.env.PATH, HOME: home, T3ORQ_HOME: orqHome, T3CODE_CLI_PATH: bin, TMPDIR: dir, MAINT_TEMP_ROOTS: temp, MAINT_DOCKER: '0', ORQ_MAINT_LOWPRIO: '1', ORQ_MAINT_TEST: '1', ORQ_MAINT_TEST_AREA: dir, ...env,
    },
  });
  return {
    dir, temp, checkout, nest, leasedDir, worktree, orqHome, run, repo,
  };
}

test('disk-clean DRY=1 lists what would go and changes nothing', (t) => {
  const w = world(t);
  const r = w.run('disk-clean.sh', { DRY: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /old-scratch\n/);
  assert.doesNotMatch(r.stdout, /old-checkout|old-nest|old-leased|old-parent/);
  assert.match(r.stdout, /disk-clean \(dry run\)/);
  assert.ok(fs.existsSync(path.join(w.temp, 'old-scratch')));
  assert.equal(fs.existsSync(path.join(w.orqHome, 'maint.log')), false);
});

test('disk-clean deletes old scratch only: never a repository, a kept path reached through a symlink, a maint-skip ancestor, or a worktree', (t) => {
  const w = world(t);
  const r = w.run('disk-clean.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch')), false);
  assert.equal(fs.readFileSync(path.join(w.checkout, 'uncommitted.txt'), 'utf8'), 'work');
  assert.ok(fs.existsSync(path.join(w.nest, 'a', '.git')));
  assert.ok(fs.existsSync(path.join(w.leasedDir, 'f')));
  assert.ok(fs.existsSync(path.join(w.temp, 'old-parent', 'precious-1', 'f')));
  assert.ok(fs.existsSync(w.worktree));
  assert.match(git(w.repo, 'worktree', 'list'), /wt-idle/);
  assert.match(fs.readFileSync(path.join(w.orqHome, 'maint.log'), 'utf8'), /disk-clean freed=/);
});

test('disk-clean and tmp-churn fail closed: when the keep list cannot be learned nothing is deleted', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.dir, 'FAIL'), '');
  const r = w.run('disk-clean.sh');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing deleted: the paths to keep could not be learned \(orq: maint keep: threads of .* could not be read/);
  assert.ok(fs.existsSync(path.join(w.temp, 'old-scratch')));
  const c = w.run('tmp-churn.sh', { MAINT_CHURN_ROOTS: w.temp });
  assert.equal(c.status, 1);
  assert.ok(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')));
});

test('tmp-churn deletes old files only: never in a repository, a maint-skip match, a kept path or a file held open; emergency mode; DRY', async (t) => {
  const w = world(t);
  const recent = path.join(w.temp, 'live', 'recent.log');
  fs.mkdirSync(path.dirname(recent), { recursive: true });
  fs.writeFileSync(recent, 'x');
  const mid = path.join(w.temp, 'live', 'mid.log');
  fs.writeFileSync(mid, 'x');
  fs.utimesSync(mid, Date.now() / 1000 - 30 * 60, Date.now() / 1000 - 30 * 60);
  const held = path.join(w.temp, 'live', 'held.log');
  mkOld(held);
  const holder = spawn('/bin/sh', ['-c', 'exec 3<"$0"; sleep 60', held], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((r) => { setTimeout(r, 300); });
  const churn = (env = {}) => w.run('tmp-churn.sh', { MAINT_CHURN_ROOTS: w.temp, ...env });
  const dry = churn({ DRY: '1' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /temp: 1 files idle over 120 min/); // old-scratch/f only
  assert.ok(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')));
  const r = churn();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tmp-churn removed=1 files/);
  assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')), false); // its directory, now fresh, goes on a later run
  for (const p of [path.join(w.checkout, 'uncommitted.txt'), path.join(w.temp, 'old-parent', 'precious-1', 'f'), path.join(w.leasedDir, 'f'), held, recent, mid]) {
    assert.ok(fs.existsSync(p), p);
  }
  const emergency = churn({ EMERGENCY: '0', EMERGENCY_AGE: '10' }); // every filesystem counts as out of inodes
  assert.match(emergency.stdout, /removed=1 files/);
  assert.deepEqual([fs.existsSync(recent), fs.existsSync(mid), fs.existsSync(held)], [true, false, true]);
  const link = path.join(w.dir, 'link-root');
  fs.symlinkSync(w.temp, link);
  assert.match(churn({ MAINT_CHURN_ROOTS: link }).stdout, /removed=0 files/); // a linked root is not searched
});

test('neither script cleans a root inside a git repository, however deep', (t) => {
  const w = world(t);
  const repo = path.join(w.dir, 'outer-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  const root = path.join(repo, 'deep', 'scratch');
  mkOld(path.join(root, 'old-entry', 'f'));
  const at = OLD();
  fs.utimesSync(path.join(root, 'old-entry'), at, at);
  for (const [script, env] of [['disk-clean.sh', { MAINT_TEMP_ROOTS: root }], ['tmp-churn.sh', { MAINT_CHURN_ROOTS: root }]]) {
    const r = w.run(script, env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(root, 'old-entry', 'f')), script);
  }
});

test('a literal maint-skip entry that is a symlink protects its target in both scripts', (t) => {
  const w = world(t);
  const target = path.join(w.temp, 'old-target');
  mkOld(path.join(target, 'f'));
  age(target);
  const link = path.join(w.dir, 'skip-link');
  fs.symlinkSync(target, link);
  fs.writeFileSync(path.join(w.orqHome, 'maint-skip'), `${link}\n`);
  const churn = w.run('tmp-churn.sh', { MAINT_CHURN_ROOTS: w.temp });
  assert.equal(churn.status, 0, churn.stderr);
  assert.ok(fs.existsSync(path.join(target, 'f')));
  const clean = w.run('disk-clean.sh');
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(fs.existsSync(path.join(target, 'f')));
});

test('with no maint-skip file, or an empty one, tmp-churn still deletes old scratch', (t) => {
  for (const skip of [null, '', '\n\n']) {
    const w = world(t);
    const file = path.join(w.orqHome, 'maint-skip');
    if (skip === null) fs.rmSync(file);
    else fs.writeFileSync(file, skip);
    const r = w.run('tmp-churn.sh', { MAINT_CHURN_ROOTS: w.temp });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed=\d+ files/);
    assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')), false, JSON.stringify(skip));
    assert.ok(fs.existsSync(path.join(w.checkout, 'uncommitted.txt')));
  }
});

test('a name with a newline never splits into another path: bait\\nvictim leaves victim alone, in the working directory and in the root', (t) => {
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const cwd = path.join(w.dir, 'cwd');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'victim'), 'keep me');
    mkOld(path.join(w.temp, 'victim'), 'keep me too'); // the second half of the split, as a sibling in the root
    mkOld(path.join(w.temp, 'bait\nvictim'), 'bait');
    mkOld(path.join(w.temp, 'odd\ndir', 'f'), 'x');
    mkOld(path.join(w.temp, 'tab\tname'), 'x');
    const before = fs.readFileSync(path.join(w.temp, 'victim'), 'utf8');
    const r = w.run(script, { MAINT_CHURN_ROOTS: w.temp }, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, 'victim'), 'utf8'), 'keep me', script);
    for (const name of ['bait\nvictim', path.join('odd\ndir', 'f'), 'tab\tname']) assert.ok(fs.existsSync(path.join(w.temp, name)), `${script}: ${JSON.stringify(name)}`);
    // the real old file named victim is ordinary scratch: it may go, but only as itself
    if (fs.existsSync(path.join(w.temp, 'victim'))) assert.equal(fs.readFileSync(path.join(w.temp, 'victim'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')), false, `${script} still cleans`);
  }
});

test('a cleanup root that is a symlink to elsewhere is never followed; a root below a linked parent neither', (t) => {
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const outside = path.join(w.dir, 'documents');
    mkOld(path.join(outside, 'important', 'f'), 'data');
    const at = OLD();
    fs.utimesSync(path.join(outside, 'important'), at, at);
    const linked = path.join(w.dir, 'orq-linked-root');
    fs.symlinkSync(outside, linked);
    const viaParent = path.join(w.dir, 'docs-link');
    fs.symlinkSync(w.dir, viaParent); // documents reached through a linked parent directory
    for (const root of [linked, `${linked}/`, path.join(viaParent, 'documents')]) {
      const r = w.run(script, { MAINT_TEMP_ROOTS: root, MAINT_CHURN_ROOTS: root });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(outside, 'important', 'f'), 'utf8'), 'data', `${script} ${root}`);
    }
    const plain = w.run(script, { MAINT_TEMP_ROOTS: w.temp, MAINT_CHURN_ROOTS: w.temp });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')), false, `${script} still cleans a real root`);
  }
});

test('a $TMPDIR that is a link to an outside folder is no temp alias: none of its forms is cleaned', (t) => {
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const outside = path.join(w.dir, 'documents');
    mkOld(path.join(outside, 'important', 'f'), 'data');
    mkOld(path.join(outside, 'node-compile-cache', 'g'), 'cache data');
    const at = OLD();
    for (const d of ['important', 'node-compile-cache']) fs.utimesSync(path.join(outside, d), at, at);
    const tmpLink = path.join(w.dir, 'tmp-link');
    fs.symlinkSync(outside, tmpLink);
    for (const root of [tmpLink, `${tmpLink}/`, path.join(tmpLink, 'node-compile-cache')]) {
      const r = w.run(script, { TMPDIR: tmpLink, MAINT_TEMP_ROOTS: root, MAINT_CHURN_ROOTS: root });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(outside, 'important', 'f'), 'utf8'), 'data', `${script} ${root}`);
      assert.equal(fs.readFileSync(path.join(outside, 'node-compile-cache', 'g'), 'utf8'), 'cache data', `${script} ${root}`);
    }
  }
});

test('a $TMPDIR with a wildcard in its name is matched literally: a sibling it would glob to is never an alias', (t) => {
  const sysTemp = process.platform === 'darwin'
    ? spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim()
    : os.tmpdir();
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const docs = path.join(w.dir, 'documents');
    mkOld(path.join(docs, 'node-compile-cache', 'precious'), 'KEEP');
    mkOld(path.join(docs, 'important', 'f'), 'KEEP');
    const at = OLD();
    for (const d of ['important', 'node-compile-cache']) fs.utimesSync(path.join(docs, d), at, at);
    fs.symlinkSync(docs, path.join(w.dir, 'alias'));
    const wildcard = path.join(w.dir, 'alias*'); // a valid temp alias by itself (a link to the real user temp dir)
    fs.symlinkSync(sysTemp, wildcard);
    const alias = path.join(w.dir, 'alias');
    for (const root of [alias, `${alias}/`, path.join(alias, 'node-compile-cache')]) {
      const r = w.run(script, { TMPDIR: wildcard, MAINT_TEMP_ROOTS: root, MAINT_CHURN_ROOTS: root });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(docs, 'node-compile-cache', 'precious'), 'utf8'), 'KEEP', `${script} ${root}`);
      assert.equal(fs.readFileSync(path.join(docs, 'important', 'f'), 'utf8'), 'KEEP', `${script} ${root}`);
    }
  }
});

test('adversarial names and links: nothing outside the root, nothing young and no link target is ever deleted', (t) => {
  const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const outside = path.join(w.dir, 'outside');
    for (const name of ['-rf', '*', '?', '[a]', 'a b', '--', 'victim', 'globX']) mkOld(path.join(outside, name), 'KEEP');
    mkOld(path.join(outside, 'sub dir', '-n'), 'KEEP');
    const before = tree(outside);
    const old = ['-rf', '--', '*', '?', '[a]/f', 'sp ace/f', '-dash dir/f', 'glob*/f', 'q?/f', 'nest/[x]/*', 'a b c'];
    for (const rel of old) mkOld(path.join(w.temp, rel), 'scratch');
    for (const d of ['[a]', 'sp ace', '-dash dir', 'glob*', 'q?', 'nest', path.join('nest', '[x]')]) age(path.join(w.temp, d));
    fs.writeFileSync(path.join(w.temp, 'globX'), 'young'); // what glob* or q? would match if ever expanded
    fs.writeFileSync(path.join(w.temp, 'qX'), 'young');
    fs.symlinkSync(outside, path.join(w.temp, 'link-out')); // a link at the top level of the root
    fs.mkdirSync(path.join(w.temp, 'deep', 'er'), { recursive: true });
    fs.symlinkSync(outside, path.join(w.temp, 'deep', 'er', 'inner-link')); // and deeper down
    fs.symlinkSync(path.join(outside, 'victim'), path.join(w.temp, 'file-link'));
    for (const p of ['link-out', 'file-link', path.join('deep', 'er', 'inner-link')]) {
      const at = OLD();
      fs.lutimesSync(path.join(w.temp, p), at, at);
    }
    for (const d of [path.join('deep', 'er'), 'deep']) age(path.join(w.temp, d));
    const r = w.run(script, { MAINT_CHURN_ROOTS: w.temp }, outside); // run from inside the outside folder
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tree(outside), before, `${script}: outside changed`);
    for (const name of before) {
      const p = path.join(outside, name);
      if (fs.statSync(p).isFile()) assert.equal(fs.readFileSync(p, 'utf8'), 'KEEP', `${script}: ${name}`);
    }
    assert.equal(fs.readFileSync(path.join(w.temp, 'globX'), 'utf8'), 'young', script);
    assert.equal(fs.readFileSync(path.join(w.temp, 'qX'), 'utf8'), 'young', script);
    for (const rel of ['-rf', '*', 'a b c']) assert.equal(fs.existsSync(path.join(w.temp, rel)), false, `${script} cleans ${rel}`);
  }
});

test('the root overrides are test-only: without ORQ_MAINT_TEST, or a root outside the test area, nothing is deleted', (t) => {
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const outside = path.join(os.homedir(), '.orq-never-used');
    for (const env of [
      { ORQ_MAINT_TEST: '' }, // production: an override set by accident
      { ORQ_MAINT_TEST: '0' },
      { ORQ_MAINT_TEST_AREA: '' },
      { ORQ_MAINT_TEST_AREA: os.homedir() }, // an area that is no temp dir
      { MAINT_TEMP_ROOTS: `${w.temp} ${outside}`, MAINT_CHURN_ROOTS: `${w.temp} ${outside}` }, // one root outside the area
      { MAINT_TEMP_ROOTS: `${w.dir}/../x`, MAINT_CHURN_ROOTS: `${w.dir}/../x` },
    ]) {
      const r = w.run(script, { MAINT_CHURN_ROOTS: w.temp, ...env });
      assert.equal(r.status, 2, `${script} ${JSON.stringify(env)}: ${r.stderr}`);
      assert.match(r.stderr, /nothing deleted: MAINT_(TEMP|CHURN)_ROOTS is for tests only/);
      assert.ok(fs.existsSync(path.join(w.temp, 'old-scratch', 'f')), `${script} ${JSON.stringify(env)}`);
    }
  }
});

test('a root swapped for a symlink after the checks and before the deletion deletes nothing outside it', async (t) => {
  for (const script of ['disk-clean.sh', 'tmp-churn.sh']) {
    const w = world(t);
    const docs = path.join(w.dir, 'documents');
    mkOld(path.join(docs, 'old-scratch', 'f'), 'precious'); // the same names as the scratch the checks approved
    mkOld(path.join(docs, 'precious'), 'precious');
    const at = OLD();
    fs.utimesSync(path.join(docs, 'old-scratch'), at, at);
    const pause = path.join(w.dir, 'pause');
    const child = spawn('/bin/sh', [path.join(KIT, 'maint', script)], {
      cwd: w.dir,
      env: {
        PATH: process.env.PATH, HOME: path.join(w.dir, 'home'), T3ORQ_HOME: w.orqHome, TMPDIR: w.dir, MAINT_TEMP_ROOTS: w.temp, MAINT_CHURN_ROOTS: w.temp,
        MAINT_DOCKER: '0', ORQ_MAINT_LOWPRIO: '1', ORQ_MAINT_TEST: '1', ORQ_MAINT_TEST_AREA: w.dir, ORQ_MAINT_TEST_PAUSE: pause,
        T3CODE_CLI_PATH: path.join(w.dir, 't3'),
      },
      stdio: 'ignore',
    });
    const exited = new Promise((r) => { child.on('exit', r); });
    for (let i = 0; i < 300 && !fs.existsSync(`${pause}.ready`); i += 1) await new Promise((r) => { setTimeout(r, 100); });
    assert.ok(fs.existsSync(`${pause}.ready`), `${script} reached the deletion`);
    fs.renameSync(w.temp, `${w.temp}.real`); // swap the validated root for a link to documents
    fs.symlinkSync(docs, w.temp);
    fs.writeFileSync(`${pause}.go`, '');
    assert.equal(await exited, 0, script);
    assert.equal(fs.readFileSync(path.join(docs, 'old-scratch', 'f'), 'utf8'), 'precious', script);
    assert.equal(fs.readFileSync(path.join(docs, 'precious'), 'utf8'), 'precious', script);
  }
});

test('a root with a backslash in its name keeps every exclusion: a backslash-t name is not a tab', (t) => {
  for (const script of ['tmp-churn.sh', 'disk-clean.sh']) {
    const w = world(t);
    const root = path.join(w.dir, 'root\\t'); // a backslash and a t, not a tab
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout, { recursive: true });
    git(checkout, 'init', '-q');
    mkOld(path.join(checkout, 'uncommitted.txt'), 'work');
    mkOld(path.join(root, 'held.log'), 'held');
    mkOld(path.join(root, 'kept', 'f'), 'kept');
    mkOld(path.join(root, 'scratch', 'f'), 'scratch');
    const at = OLD();
    for (const d of ['checkout', 'kept', 'scratch']) fs.utimesSync(path.join(root, d), at, at);
    fs.utimesSync(root, at, at);
    fs.writeFileSync(path.join(w.orqHome, 'maint-skip'), `${path.join(root, 'kept')}\n`);
    const r = w.run(script, { MAINT_TEMP_ROOTS: root, MAINT_CHURN_ROOTS: root });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(checkout, 'uncommitted.txt'), 'utf8'), 'work', script);
    assert.equal(fs.readFileSync(path.join(root, 'kept', 'f'), 'utf8'), 'kept', script);
    assert.equal(fs.existsSync(path.join(root, 'scratch', 'f')), false, `${script} still cleans`);
  }
});
