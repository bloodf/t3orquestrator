import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('mergeCrontab is idempotent and replaces earlier orq-maint and hand-made disk-clean/tmp-churn lines only', () => {
  const lines = cronLines({ host: 'h', kit: '/k/maint/' });
  const current = ['MAILTO=""', '*/10 * * * * /home/u/reenable.sh', '23 * * * * /home/u/.t3orq/maint/tmp-churn.sh', '0 */6 * * * sh ~/.t3orq/maint/disk-clean.sh', '# 5 * * * * disk-clean.sh (commented)', ''].join('\n');
  const once = mergeCrontab(current, lines);
  assert.equal(once.replaced, 2);
  assert.deepEqual(once.text.trimEnd().split('\n'), ['MAILTO=""', '*/10 * * * * /home/u/reenable.sh', '# 5 * * * * disk-clean.sh (commented)', ...lines]);
  const twice = mergeCrontab(once.text, lines);
  assert.equal(twice.text, once.text);
  assert.equal(twice.replaced, 2);
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
  assert.match(linux[0], /installed cron entries \(0 earlier lines replaced\)/);
  assert.equal(calls[1][0], 'crontab');
  assert.match(calls[1][2], /^5 \* \* \* \* other\n.*tmp-churn.*\n.*disk-clean/s);
  calls.length = 0;
  const dry = install({
    platform: 'linux', host: 'storm', env: { PATH: '/bin' }, exec, dryRun: true,
  });
  assert.equal(dry[0], 'would install crontab:');
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['crontab', '-l']]); // read only
  assert.throws(() => install({ platform: 'win32', env: {}, exec }), /not supported/);
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
  await writeGateLease(path.join(k.home, 'gate-leases'), { pid: 4242, project: '/p/gated', unit: 'b', startedAt: NOW });
  assert.deepEqual(await keepPaths(k.ctx, ['/p/plain', '/p/not-t3']), ['/p/gated', '/p/one', '/wt/one-1', '/wt/one-2', '/wt/plain-9']);
  await writeLease(path.join(k.home, 'leases'), {
    threadId: 'gone', project: '/p/one', unit: 'b', instance: 'i', model: 'm', startedAt: NOW,
  });
  await assert.rejects(keepPaths(k.ctx), /worktree of leased thread gone is not known/);
  fs.writeFileSync(path.join(k.dir, 'FAIL'), '');
  await assert.rejects(keepPaths(k.ctx), /threads of \/p\/one could not be read/);
});

test('startCleanup starts one run at most once an hour', async (t) => {
  const dir = tmp(t);
  let clock = NOW;
  const started = [];
  const ctx = { env: { T3ORQ_HOME: dir }, now: () => clock };
  const spawnClean = (o) => started.push(o);
  assert.equal(await startCleanup(ctx, { spawnClean }), true);
  assert.equal(started[0].env.T3ORQ_HOME, dir);
  clock += 30 * 60_000;
  assert.equal(await startCleanup(ctx, { spawnClean }), false);
  clock += 31 * 60_000;
  assert.equal(await startCleanup(ctx, { spawnClean }), true);
  assert.equal(started.length, 2);
});

// A repository with three linked worktrees, all clean, pushed and idle for two days: one free, one a leased thread's,
// and one whose directory is gone (a stale registration only `git worktree prune` removes).
function world(t) {
  const dir = tmp(t);
  const home = path.join(dir, 'home');
  const orqHome = path.join(dir, 'orq');
  const repo = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const wt = (name) => {
    const p = path.join(dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', p, 'origin/main');
    return p;
  };
  const free = wt('wt-free');
  const leased = wt('wt-leased');
  const gone = wt('wt-gone');
  fs.rmSync(gone, { recursive: true, force: true });
  const old = Date.now() / 1000 - 2 * 86400;
  for (const p of [free, leased]) {
    const gd = git(p, 'rev-parse', '--absolute-git-dir').trim();
    for (const f of [path.join(gd, 'index'), path.join(gd, 'HEAD'), path.join(gd, 'logs', 'HEAD'), p]) if (fs.existsSync(f)) fs.utimesSync(f, old, old);
  }
  const orphan = path.join(home, '.t3', 'worktrees', 'proj', 'orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'f'), 'x');
  fs.utimesSync(path.join(orphan, 'f'), old, old);
  fs.utimesSync(orphan, old, old);
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(path.join(temp, 'old-scratch'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'old-scratch', 'f'), 'x');
  fs.utimesSync(path.join(temp, 'old-scratch', 'f'), old, old);
  fs.utimesSync(path.join(temp, 'old-scratch'), old, old);
  const bin = fakeT3(dir, { '/p/leased-project': [thread('th1', leased)] });
  fs.mkdirSync(path.join(orqHome, 'leases'), { recursive: true });
  fs.writeFileSync(path.join(orqHome, 'leases', 'th1.json'), JSON.stringify({
    threadId: 'th1', project: '/p/leased-project', unit: 'a', instance: 'i', model: 'm', startedAt: NOW,
  }));
  const run = (env = {}) => spawnSync('/bin/sh', [path.join(KIT, 'maint', 'disk-clean.sh')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: home, T3ORQ_HOME: orqHome, T3CODE_CLI_PATH: bin, TMPDIR: dir, MAINT_REPOS: repo, MAINT_TEMP_ROOTS: temp, MAINT_DOCKER: '0', ORQ_MAINT_LOWPRIO: '1', ...env,
    },
  });
  const registered = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  return {
    dir, repo, free, leased, gone, orphan, temp, run, registered, orqHome,
  };
}

test('disk-clean DRY=1 lists what would go and changes nothing, not even git worktree prune', (t) => {
  const w = world(t);
  const before = w.registered();
  const r = w.run({ DRY: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`\\t${w.free}\\n`));
  assert.match(r.stdout, new RegExp(`\\t${w.orphan}\\n`));
  assert.match(r.stdout, /old-scratch/);
  assert.doesNotMatch(r.stdout, new RegExp(w.leased));
  assert.match(r.stdout, /disk-clean \(dry run\)/);
  assert.deepEqual(w.registered(), before); // the gone worktree is still registered
  for (const p of [w.free, w.orphan, path.join(w.temp, 'old-scratch')]) assert.ok(fs.existsSync(p), p);
  assert.equal(fs.existsSync(path.join(w.orqHome, 'maint.log')), false);
});

test('disk-clean removes idle unleased worktrees, orphans and old temp entries; keeps a leased thread\'s worktree', (t) => {
  const w = world(t);
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(w.free), false);
  assert.equal(fs.existsSync(w.leased), true);
  assert.equal(fs.existsSync(w.orphan), false);
  assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch')), false);
  assert.deepEqual(w.registered(), [w.repo, w.leased]); // the gone one was pruned
  assert.match(fs.readFileSync(path.join(w.orqHome, 'maint.log'), 'utf8'), /disk-clean freed=/);
});

test('disk-clean never touches a path matching a maint-skip glob', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.orqHome, 'maint-skip'), `${path.dirname(w.free)}/wt-fr*\n*/.t3/worktrees/proj\n`);
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(w.free));
  assert.ok(fs.existsSync(w.orphan));
});

test('disk-clean fails closed: when the keep list cannot be learned, no worktree or orphan goes (temp roots still do)', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.dir, 'FAIL'), '');
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /worktrees kept: orq: maint keep: threads of \/p\/leased-project could not be read/);
  assert.match(r.stdout, /worktrees-kept/);
  for (const p of [w.free, w.leased, w.orphan]) assert.ok(fs.existsSync(p), p);
  assert.equal(w.registered().length, 4); // no prune either
  assert.equal(fs.existsSync(path.join(w.temp, 'old-scratch')), false);
});

test('disk-clean keeps a worktree whose git status fails', (t) => {
  const w = world(t);
  const gd = git(w.free, 'rev-parse', '--absolute-git-dir').trim();
  fs.writeFileSync(path.join(gd, 'index'), 'not an index'); // git status now fails
  const old = Date.now() / 1000 - 2 * 86400;
  fs.utimesSync(path.join(gd, 'index'), old, old);
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(w.free));
});

test('tmp-churn deletes old files inside busy roots and keeps new ones; emergency mode takes younger files; DRY changes nothing', (t) => {
  const dir = tmp(t);
  const root = path.join(dir, 'claude-x');
  const mk = (rel, minutesOld) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const at = Date.now() / 1000 - minutesOld * 60;
    fs.utimesSync(f, at, at);
    return f;
  };
  const old = mk('task-1/out.log', 300);
  const recent = mk('task-2/out.log', 5);
  const mid = mk('task-3/out.log', 30);
  for (const d of ['task-1', 'task-3']) { const at = Date.now() / 1000 - 300 * 60; fs.utimesSync(path.join(root, d), at, at); }
  const run = (env = {}) => spawnSync('/bin/sh', [path.join(KIT, 'maint', 'tmp-churn.sh')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, T3ORQ_HOME: path.join(dir, 'orq'), MAINT_CHURN_ROOTS: root, ORQ_MAINT_LOWPRIO: '1', ...env },
  });
  const dry = run({ DRY: '1' });
  assert.match(dry.stdout, /claude-x: 1 files idle over 120 min/);
  assert.ok(fs.existsSync(old));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tmp-churn removed=1 files/);
  assert.deepEqual([fs.existsSync(old), fs.existsSync(recent), fs.existsSync(mid)], [false, true, true]);
  assert.equal(fs.existsSync(root), true); // the root stays
  const emergency = run({ EMERGENCY: '0', EMERGENCY_AGE: '10' }); // every filesystem counts as out of inodes
  assert.match(emergency.stdout, /removed=1 files/);
  assert.deepEqual([fs.existsSync(recent), fs.existsSync(mid)], [true, false]);
});
