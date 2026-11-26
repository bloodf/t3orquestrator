// orq env-report [--json] | --peers | --versions (what a peer runs here: version strings only): what this machine runs (kit, T3, toolchain, agent CLIs, schedules, disk), and with
// --peers the same from every machine in the `peers` config, side by side, with the versions that differ flagged as
// drift. Read-only: it runs version commands and `crontab -l`, reads LaunchAgents names and statfs, nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { kitFor } from './kit-info.mjs';
import { short } from '../kit.mjs';
import { resolveT3Bin } from '../t3.mjs';
import { homeDir, machineConfigPath } from '../paths.mjs';
import { loadMachineConfig } from '../config.mjs';
import { parseFlags } from './common.mjs';

// key -> [command, args]: the first line of its output is the version
const TOOLS = {
  node: ['node', ['--version']],
  pnpm: ['pnpm', ['--version']],
  bun: ['bun', ['--version']],
  gh: ['gh', ['--version']],
  rtk: ['rtk', ['--version']],
  claude: ['claude', ['--version']],
  codex: ['codex', ['--version']],
  docker: ['docker', ['--version']],
};
export const VERSION_KEYS = ['kit', 't3', ...Object.keys(TOOLS), 'playwright'];
// only version strings cross the machine: never crontab text, paths or disk figures
const REMOTE = 'node .t3orq/kit/bin/orq.mjs env-report --versions';
const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
  return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '' };
}

function versionOf(run, cmd, args) {
  const r = run(cmd, args);
  return r.code === 0 ? clean(String(r.stdout).split('\n').find((l) => l.trim()) ?? '') || 'unknown' : 'missing';
}

function kitVersion(ctx) {
  try {
    const kit = kitFor(ctx);
    if (!kit.isCheckout()) return 'not a checkout';
    const head = kit.head();
    const tag = kit.tagAt(head);
    return `${short(head)}${tag ? ` ${tag}` : ' untagged'}`;
  } catch {
    return 'unknown';
  }
}

// Playwright's browser builds, from its cache directory (PLAYWRIGHT_BROWSERS_PATH, or the platform default)
function playwright(ctx, platform) {
  const home = ctx.deps.homedir();
  const dir = ctx.env.PLAYWRIGHT_BROWSERS_PATH || (platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright'));
  try {
    const builds = fs.readdirSync(dir).filter((n) => /^[a-z][a-z0-9_-]*-\d+$/.test(n)).sort();
    return builds.length ? builds.join(' ') : 'none';
  } catch {
    return 'none';
  }
}

function schedules(ctx, run, platform) {
  const cron = run('crontab', ['-l']);
  const lines = cron.code === 0 ? String(cron.stdout).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => `cron: ${clean(l, 300)}`) : [];
  if (platform === 'darwin') {
    const dir = path.join(ctx.deps.homedir(), 'Library', 'LaunchAgents');
    const names = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
    lines.push(...names.filter((n) => n.endsWith('.plist')).sort().map((n) => `launchd: ${clean(n.slice(0, -6))}`));
  }
  return lines;
}

// bytes and inodes of the roots orq and its agents write to
function disk(ctx) {
  const t3 = ctx.env.T3CODE_HOME || path.join(ctx.deps.homedir(), '.t3');
  const roots = [...new Set([ctx.deps.homedir(), homeDir(ctx.env), t3, os.tmpdir()])];
  const statfs = ctx.deps.statfs ?? fs.statfsSync;
  return roots.map((root) => {
    try {
      const s = statfs(root);
      return {
        root, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, freeInodes: s.ffree, totalInodes: s.files,
      };
    } catch {
      return { root, missing: true };
    }
  });
}

function versionsOf(ctx, run, platform) {
  const t3bin = resolveT3Bin({ env: ctx.env, homedir: ctx.deps.homedir(), exists: (f) => fs.existsSync(f) });
  const versions = {
    kit: kitVersion(ctx),
    t3: versionOf(run, t3bin, ['--version']),
    ...Object.fromEntries(Object.entries(TOOLS).map(([k, [cmd, args]]) => [k, versionOf(run, cmd, args)])),
    playwright: playwright(ctx, platform),
  };
  return versions;
}

export function collect(ctx) {
  const run = ctx.deps.run ?? defaultRun;
  const platform = ctx.deps.platform ?? process.platform;
  const versions = versionsOf(ctx, run, platform);
  return {
    v: 1, host: String((ctx.deps.hostname ?? os.hostname)()).split('.')[0], platform, versions, schedules: schedules(ctx, run, platform), disk: disk(ctx),
  };
}

const GIB = 1024 ** 3;
const pct = (free, total) => (total > 0 ? `${Math.round((100 * (total - free)) / total)}% used` : '');
export function reportLines(r) {
  return [
    `host: ${r.host} (${r.platform})`,
    ...VERSION_KEYS.map((k) => `${k}: ${r.versions[k]}`),
    ...(r.schedules.length ? r.schedules : ['schedules: none']),
    ...r.disk.map((d) => (d.missing ? `disk ${d.root}: missing`
      : `disk ${d.root}: ${(d.freeBytes / GIB).toFixed(1)} of ${(d.totalBytes / GIB).toFixed(1)} GiB free (${pct(d.freeBytes, d.totalBytes)}), inodes ${d.freeInodes} of ${d.totalInodes} free (${pct(d.freeInodes, d.totalInodes)})`)),
  ];
}

// A peer's report is another machine's text: only its version strings are kept, cleaned and cut short.
export function cleanReport(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.versions !== 'object' || raw.versions === null) return null;
  return { versions: Object.fromEntries(VERSION_KEYS.map((k) => [k, clean(raw.versions[k]) || 'unknown'])) };
}

const defaultSsh = (target) => new Promise((resolve) => {
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', target, REMOTE], { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => resolve({ code: error ? 1 : 0, stdout }));
});

// One line per version: every machine's value, DRIFT when the reachable ones differ.
export function driftLines(self, peers) {
  const all = [{ host: self.host, report: self }, ...peers];
  const out = VERSION_KEYS.map((k) => {
    const vals = all.filter((m) => m.report).map((m) => m.report.versions[k]);
    const cells = all.map((m) => `${m.host}=${m.report ? m.report.versions[k] : '-'}`).join(' | ');
    return `${k}: ${cells}${new Set(vals).size > 1 ? ' DRIFT' : ''}`;
  });
  return [...out, ...peers.filter((p) => !p.report).map((p) => `note: ${p.host} not read (${p.error})`)];
}

export async function envReport(args, ctx) {
  const { flags } = parseFlags(args, { bool: ['json', 'peers', 'versions'] }, 'env-report');
  if (flags.versions) { // read at the source: schedules and disk are never collected for this
    ctx.stdout.write(`${JSON.stringify({ v: 1, versions: versionsOf(ctx, ctx.deps.run ?? defaultRun, ctx.deps.platform ?? process.platform) })}\n`);
    return 0;
  }
  const self = collect(ctx);
  if (!flags.peers) {
    ctx.stdout.write(flags.json ? `${JSON.stringify(self)}\n` : `${reportLines(self).join('\n')}\n`);
    return 0;
  }
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const ssh = ctx.deps.ssh ?? defaultSsh;
  const peers = await Promise.all((machine.peers ?? []).map(async (p) => {
    const r = await ssh(p.ssh).catch(() => ({ code: 1 }));
    if (r.code !== 0) return { host: p.host, error: 'ssh failed' };
    let report = null;
    try { report = cleanReport(JSON.parse(String(r.stdout).trim().split('\n').at(-1))); } catch { /* not JSON */ }
    return report ? { host: p.host, report } : { host: p.host, error: 'no readable report (is the kit there and recent?)' };
  }));
  ctx.stdout.write(`${driftLines(self, peers).join('\n')}\n`);
  return 0;
}
