// orq env-report: what this machine runs, and drift against its peers. Read-only; every command is faked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { cleanReport, driftLines } from '../lib/commands/env-report.mjs';

const VERSIONS = {
  t3: 't3 v0.1.12', node: 'v24.1.0', pnpm: '10.0.0', bun: '1.2.0', gh: 'gh version 2.70.0', rtk: 'rtk 1.2.1', claude: '2.1.0 (Claude Code)', codex: 'codex-cli 0.1', docker: 'Docker version 28',
};

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-env-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const user = path.join(root, 'user');
  await fs.mkdir(path.join(user, 'Library', 'LaunchAgents'), { recursive: true });
  await fs.mkdir(path.join(user, 'Library', 'Caches', 'ms-playwright', 'chromium-1200'), { recursive: true });
  await fs.mkdir(path.join(user, 'Library', 'Caches', 'ms-playwright', '.links'), { recursive: true });
  await fs.writeFile(path.join(user, 'Library', 'LaunchAgents', 'com.t3orq.watchdog.plist'), '');
  await fs.mkdir(home);
  return { root, home, user };
}

async function orq(args, s, { ssh, missing = [] } = {}) {
  const out = [];
  const ran = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, env: { T3ORQ_HOME: s.home }, cwd: s.root, now: () => 0,
    deps: {
      homedir: () => s.user,
      platform: 'darwin',
      hostname: () => 'mac.local',
      kitDir: s.root, // not a checkout
      statfs: () => ({ bsize: 4096, bavail: 262144, blocks: 1048576, ffree: 900, files: 1000 }),
      run: (cmd, a) => {
        ran.push([cmd, ...a].join(' '));
        if (cmd === 'crontab') return { code: 0, stdout: '# comment\n*/10 * * * * /x/noclaude.sh on\n' };
        const key = cmd.endsWith('t3') ? 't3' : cmd;
        return missing.includes(key) ? { code: 127, stdout: '' } : { code: 0, stdout: `${VERSIONS[key]}\nextra line\n` };
      },
      ...(ssh ? { ssh } : {}),
    },
  });
  return { code, out: out.join(''), ran };
}

test('env-report: versions, schedules and disk of this machine, by running only version commands and crontab -l', async (t) => {
  const s = await setup(t);
  const r = await orq(['env-report'], s, { missing: ['bun'] });
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'host: mac (darwin)');
  assert.ok(lines.includes('kit: not a checkout'));
  assert.ok(lines.includes('node: v24.1.0'));
  assert.ok(lines.includes('bun: missing'));
  assert.ok(lines.includes('playwright: chromium-1200'));
  assert.ok(lines.includes('cron: */10 * * * * /x/noclaude.sh on'));
  assert.ok(lines.includes('launchd: com.t3orq.watchdog'));
  assert.ok(lines.some((l) => /^disk .*: 1\.0 of 4\.0 GiB free \(75% used\), inodes 900 of 1000 free \(10% used\)$/.test(l)));
  assert.ok(r.ran.every((c) => /--version$|^crontab -l$/.test(c)), r.ran.join(', '));
  const json = JSON.parse((await orq(['env-report', '--json'], s)).out);
  assert.equal(json.versions.pnpm, '10.0.0');
});

test('env-report --peers: one line per version across machines, DRIFT where they differ, a peer that cannot be read said', async (t) => {
  const s = await setup(t);
  await fs.writeFile(path.join(s.home, 'config.json'), JSON.stringify({ peers: [{ host: 'storm', ssh: 'storm' }, { host: 'cortex', ssh: 'cortex' }] }));
  const storm = { versions: { ...VERSIONS, kit: 'not a checkout', playwright: 'chromium-1200', node: 'v22.0.0\u001b[31m' } };
  const ssh = async (target) => (target === 'storm' ? { code: 0, stdout: `welcome\n${JSON.stringify(storm)}\n` } : { code: 255, stdout: '' });
  const r = await orq(['env-report', '--peers'], s, { ssh });
  assert.match(r.out, /^node: mac=v24\.1\.0 \| storm=v22\.0\.0 \[31m \| cortex=- DRIFT$/m);
  assert.match(r.out, /^pnpm: mac=10\.0\.0 \| storm=10\.0\.0 \| cortex=-$/m);
  assert.match(r.out, /^note: cortex not read \(ssh failed\)$/m);
});

test('env-report: a peer report keeps only cleaned version strings', () => {
  assert.equal(cleanReport({ nope: 1 }), null);
  const r = cleanReport({ versions: { kit: 'x'.repeat(500), t3: 7 }, schedules: ['secret'] });
  assert.equal(r.versions.kit.length, 120);
  assert.equal(r.versions.t3, '7');
  assert.equal(r.versions.node, 'unknown');
  assert.equal(r.schedules, undefined);
  assert.deepEqual(driftLines({ host: 'a', versions: r.versions }, []).at(0), `kit: a=${'x'.repeat(120)}`);
});

test('env-report --versions (what a peer runs): version strings only, no crontab, paths or disk, never even read', async (t) => {
  const s = await setup(t);
  const r = await orq(['env-report', '--versions'], s);
  const json = JSON.parse(r.out);
  assert.deepEqual(Object.keys(json).sort(), ['v', 'versions']);
  assert.equal(json.versions.node, 'v24.1.0');
  assert.doesNotMatch(r.out, /noclaude|crontab|com\.t3orq|\/user|disk/);
  assert.ok(!r.ran.includes('crontab -l'));
  const asked = [];
  await orq(['env-report', '--peers'], s, { ssh: async (target) => { asked.push(target); return { code: 1, stdout: '' }; } });
  assert.deepEqual(asked, []); // no peers configured
});
