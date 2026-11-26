// orq watchdog tick [--dry-run] | orq watchdog install [--dry-run]: see lib/watchdog.mjs.
// install schedules the tick every CYCLE_MINUTES: a launchd agent on macOS (label com.t3orq.watchdog, the label the
// supervisor's old watch.sh used, so it replaces that job), a tagged crontab line elsewhere. Idempotent.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTick, watchdogRoot, CYCLE_MINUTES } from '../watchdog.mjs';
import { parseFlags, usage } from './common.mjs';

const USAGE = 'watchdog: usage: watchdog tick [--dry-run] | watchdog install [--dry-run]';
const LABEL = 'com.t3orq.watchdog';
const TAG = '# orq-watchdog';
const ORQ = fileURLToPath(new URL('../../bin/orq.mjs', import.meta.url));
const OLD_JOBS = /watch\.sh|keeper\.sh/; // the supervisor's scripts this replaces

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s) => `'${s.replace(/'/g, "'\\''")}'`;

// the environment the job needs: where node, git and t3 are, and which T3 server (T3CODE_HOME) this machine runs
const jobEnv = (env) => Object.fromEntries(['PATH', 'T3ORQ_HOME', 'T3CODE_HOME'].filter((k) => env[k]).map((k) => [k, env[k]]));

export function plist({ node, orq, env, log }) {
  const vars = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(orq)}</string><string>watchdog</string><string>tick</string></array>
  <key>EnvironmentVariables</key><dict>${vars}</dict>
  <key>StartInterval</key><integer>${CYCLE_MINUTES * 60}</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function cronLine({ node, orq, env, log }) {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  return `*/${CYCLE_MINUTES} * * * * ${vars} ${sh(node)} ${sh(orq)} watchdog tick >/dev/null 2>>${sh(log)} ${TAG}`;
}

// The crontab with the tagged line replaced (or added). -> {text, changed}
export function withCronLine(current, line) {
  const kept = current.split('\n').filter((l) => l !== '' && !l.endsWith(TAG));
  const text = `${[...kept, line].join('\n')}\n`;
  return { text, changed: text !== (current.endsWith('\n') ? current : `${current}\n`) };
}

const spawn = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

async function install(ctx, dryRun) {
  const run = ctx.deps.spawn ?? spawn;
  const job = {
    node: process.execPath, orq: ORQ, env: jobEnv(ctx.env), log: path.join(watchdogRoot(ctx.env), 'log'),
  };
  const out = [];
  const platform = ctx.deps.platform ?? process.platform;
  if (platform === 'darwin') {
    const file = path.join(ctx.deps.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const want = plist(job);
    if ((await fs.readFile(file, 'utf8').catch(() => null)) === want) out.push(`watchdog: ${file} is current`);
    else if (dryRun) out.push(`watchdog: would write ${file} and reload ${LABEL}`);
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, want);
      const domain = `gui/${os.userInfo().uid}`;
      run('launchctl', ['bootout', `${domain}/${LABEL}`]); // not loaded yet: fine
      const r = run('launchctl', ['bootstrap', domain, file]);
      out.push(r.code === 0 ? `watchdog: installed ${file}, every ${CYCLE_MINUTES} min` : `watchdog: wrote ${file}; launchctl bootstrap failed: ${r.stderr.trim()}`);
    }
  }
  const cron = run('crontab', ['-l']);
  const current = cron.code === 0 ? cron.stdout : '';
  if (platform !== 'darwin') {
    const { text, changed } = withCronLine(current, cronLine(job));
    if (!changed) out.push('watchdog: crontab line is current');
    else if (dryRun) out.push(`watchdog: would set the crontab line: ${cronLine(job)}`);
    else {
      const r = run('crontab', ['-'], text);
      out.push(r.code === 0 ? `watchdog: crontab line set, every ${CYCLE_MINUTES} min` : `watchdog: crontab failed: ${r.stderr.trim()}`);
    }
  }
  // the scripts this replaces are left to the user: remove their lines once the tick runs
  for (const l of current.split('\n').filter((x) => OLD_JOBS.test(x) && !x.endsWith(TAG))) out.push(`note: an older watchdog job is still in crontab; remove it once it only restarts orchestrators: ${l}`);
  return out;
}

export async function watchdog(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['dry-run'] }, 'watchdog');
  const dryRun = flags['dry-run'] === true;
  if (positional.length !== 1) throw usage(USAGE);
  let lines;
  if (positional[0] === 'tick') lines = await runTick({ ...ctx, dryRun });
  else if (positional[0] === 'install') lines = await install(ctx, dryRun);
  else throw usage(USAGE);
  if (lines.length) ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
