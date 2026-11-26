// Machine maintenance shipped with the kit (maint/disk-clean.sh, maint/tmp-churn.sh): what the cleanup must keep,
// one cleanup run when the disk runs low, and the cron (Linux) or launchd (macOS) entries that run them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './store.mjs';
import { listLeases } from './leases.mjs';
import { ACTIVE, createT3, resolveT3Bin } from './t3.mjs';
import {
  gateLeasesDir, homeDir, leasesDir, maintStatePath, projectConfigPath,
} from './paths.mjs';

export const MAINT_DIR = fileURLToPath(new URL('../maint/', import.meta.url));
export const SCRIPTS = ['tmp-churn', 'disk-clean'];
const CLEAN_EVERY_MS = 60 * 60_000; // a low disk starts at most one cleanup run an hour
const MARK = '# orq-maint';

// The paths a cleanup must never remove: every project an orq lease or gate lease names, the worktree of every
// leased thread, and the worktree of every T3 thread at work in those projects and in `projects` (absolute paths).
// Throws when a leased thread's worktree cannot be learned: the caller keeps everything then (fail closed).
export async function keepPaths(ctx, projects = []) {
  const leases = await listLeases(leasesDir(ctx.env));
  const gates = (await listLeases(gateLeasesDir(ctx.env)).catch(() => [])).filter((l) => typeof l?.project === 'string');
  const leased = [...new Set([...leases, ...gates].map((l) => l.project).filter((p) => typeof p === 'string' && path.isAbsolute(p)))];
  const keep = new Set(leased);
  const t3For = async (project) => {
    const bin = (await readJson(projectConfigPath(project), null).catch(() => null))?.t3?.bin
      ?? resolveT3Bin({ env: ctx.env, homedir: ctx.deps.homedir(), exists: fs.existsSync });
    return createT3({ bin, exec: ctx.deps.exec });
  };
  const threadIds = new Set(leases.filter((l) => !l.reservation).map((l) => l.threadId).filter((id) => typeof id === 'string'));
  for (const project of new Set([...leased, ...projects])) {
    let threads;
    try {
      threads = (await t3For(project)).listThreads({ project });
    } catch (e) {
      if (leased.includes(project)) throw new Error(`threads of ${project} could not be read: ${String(e.message).split('\n')[0]}`);
      continue; // not a T3 project: its worktrees are plain git ones
    }
    for (const t of threads) {
      if (!t.worktreePath) continue;
      if (ACTIVE.includes(t.status) || threadIds.has(t.id)) keep.add(t.worktreePath);
      threadIds.delete(t.id);
    }
  }
  if (threadIds.size > 0) throw new Error(`the worktree of leased thread ${[...threadIds][0]} is not known`);
  return [...keep].sort();
}

// Start one cleanup run (tmp-churn, then disk-clean) in the background, at most once an hour. -> true when started.
export async function startCleanup(ctx, { spawnClean = defaultSpawnClean } = {}) {
  const file = maintStatePath(ctx.env);
  const last = await readJson(file, null).catch(() => null);
  const now = ctx.now();
  if (Number.isFinite(last?.at) && now - last.at < CLEAN_EVERY_MS && now >= last.at) return false;
  await writeJsonAtomic(file, { at: now });
  spawnClean({ env: { ...process.env, ...ctx.env, T3ORQ_HOME: homeDir(ctx.env) }, log: path.join(homeDir(ctx.env), 'maint.log') });
  return true;
}

function defaultSpawnClean({ env, log }) {
  const fd = fs.openSync(log, 'a');
  try {
    const [churn, disk] = SCRIPTS.map((n) => path.join(MAINT_DIR, `${n}.sh`));
    spawn('/bin/sh', ['-c', '/bin/sh "$1"; /bin/sh "$2"', 'orq-clean', churn, disk], {
      env, detached: true, stdio: ['ignore', fd, fd],
    }).unref();
  } finally {
    fs.closeSync(fd);
  }
}

// Minutes staggered per machine, so peers that share a disk array or a network never clean at the same minute.
export function schedule(host) {
  const n = createHash('sha256').update(String(host)).digest().readUInt32BE(0);
  const churn = n % 60;
  return { churn, disk: (churn + 30) % 60, diskHour: Math.floor(n / 60) % 6 };
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The cron lines for this machine: tmp-churn hourly, disk-clean every 6 hours.
export function cronLines({ host, kit = MAINT_DIR, env = {} }) {
  const s = schedule(host);
  const vars = Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const cmd = (name) => `${vars ? `${vars} ` : ''}/bin/sh ${shq(path.join(kit, `${name}.sh`))} >/dev/null 2>&1 ${MARK} ${name}`;
  const hours = [0, 1, 2, 3].map((i) => s.diskHour + 6 * i).join(',');
  return [`${s.churn} * * * * ${cmd('tmp-churn')}`, `${s.disk} ${hours} * * * ${cmd('disk-clean')}`];
}

// A crontab with our lines in place: earlier orq-maint lines and hand-made disk-clean/tmp-churn lines are replaced.
export function mergeCrontab(current, lines) {
  const old = (l) => l.includes(MARK) || /(^|[\s/])(disk-clean|tmp-churn)\.sh\b/.test(l);
  const kept = String(current ?? '').split('\n').filter((l) => l !== '' && !(old(l) && !l.trimStart().startsWith('#')));
  return { text: `${[...kept, ...lines].join('\n')}\n`, replaced: String(current ?? '').split('\n').filter((l) => old(l) && !l.trimStart().startsWith('#')).length };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const plistLabel = (name) => `com.t3orq.${name}`;

// A launchd agent for one script: calendar times only, never RunAtLoad (a run right after boot competes with it).
export function plist({
  name, host, kit = MAINT_DIR, env = {},
}) {
  const s = schedule(host);
  const times = name === 'tmp-churn' ? [{ Minute: s.churn }] : [0, 1, 2, 3].map((i) => ({ Hour: s.diskHour + 6 * i, Minute: s.disk }));
  const dict = (o) => `<dict>${Object.entries(o).map(([k, v]) => `<key>${xml(k)}</key>${typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${xml(v)}</string>`}`).join('')}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistLabel(name)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(path.join(kit, `${name}.sh`))}</string></array>
  <key>StartCalendarInterval</key><array>${times.map(dict).join('')}</array>
  <key>EnvironmentVariables</key>${dict(env)}
  <key>RunAtLoad</key><false/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

// Install or update the entries, idempotently. dryRun: say what would be written, change nothing. -> output lines
export function install({
  platform = process.platform, host = os.hostname().split('.')[0], env, exec, home = os.homedir(), uid = process.getuid?.(), dryRun = false, writeFile = fs.writeFileSync,
}) {
  const vars = { PATH: env.PATH ?? '/usr/bin:/bin', ...(env.T3ORQ_HOME ? { T3ORQ_HOME: env.T3ORQ_HOME } : {}) };
  if (platform === 'darwin') {
    return SCRIPTS.flatMap((name) => {
      const file = path.join(home, 'Library', 'LaunchAgents', `${plistLabel(name)}.plist`);
      const text = plist({ name, host, env: vars });
      if (dryRun) return [`would write ${file}`, text];
      writeFile(file, text);
      exec('launchctl', ['bootout', `gui/${uid}/${plistLabel(name)}`]); // not loaded yet: fails, fine
      const r = exec('launchctl', ['bootstrap', `gui/${uid}`, file]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap ${plistLabel(name)} failed: ${String(r.stderr).trim().split('\n')[0]}`);
      return [`installed ${plistLabel(name)} (${file})`];
    });
  }
  if (platform !== 'linux') throw new Error(`maint install: ${platform} is not supported (macOS launchd, Linux cron)`);
  const current = exec('crontab', ['-l']);
  const merged = mergeCrontab(current.code === 0 ? current.stdout : '', cronLines({ host, env: vars }));
  if (dryRun) return ['would install crontab:', merged.text.trimEnd()];
  const r = exec('crontab', ['-'], { input: merged.text });
  if (r.code !== 0) throw new Error(`crontab - failed: ${String(r.stderr).trim().split('\n')[0]}`);
  return [`installed cron entries (${merged.replaced} earlier line${merged.replaced === 1 ? '' : 's'} replaced)`, ...cronLines({ host, env: vars })];
}
