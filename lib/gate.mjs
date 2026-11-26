import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { matchesAny } from './glob.mjs';
import { isDependencyFile } from './share.mjs';
import { scanDiff } from './scan.mjs';
import { lastSafeLine } from './gaterun.mjs';
import { inFreshCheckout } from './gate-checkout.mjs';
import { ORQ_VARS } from './gate-env.mjs';

const SHA = /^[0-9a-f]{40}$/;
const KILL_GRACE_MS = 2000;
const DRAIN_MS = 500;
const lastLines = (text, n) => text.split('\n').slice(-n).join('\n');

function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: the group is gone. EPERM: on macOS, kill(-pgid) fails with EPERM when every process left in the
    // group is a zombie (exited, not yet reaped); seen in about 1 run in 8 of the timeout test. It cannot hide a
    // live child of ours: kill() on a group succeeds if it signals any member, and a live process with our uid
    // is always signallable. Only a live member running as another user (a setuid program) would also give
    // EPERM, and orq could not kill that one anyway. Untested: the zombie window cannot be produced on demand.
    if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e;
  }
}

/**
 * Run a shell command line. When the step ends (exit, timeout or leftover children after exit)
 * every process in its process group is killed, so a step cannot leave a service running.
 */
const MAX_LOG_BYTES = 64 * 1024 * 1024; // a runaway logger must not fill the disk

// Best effort: a log that cannot be written never stops a step. Returns false once nothing more goes to it.
function appendLog(logFile, data) {
  try { fs.appendFileSync(logFile, data); return true; } catch { return false; }
}

// the parent's environment without orq's own gate variables: a stale list must never reach another gate
const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !ORQ_VARS.includes(k)));

// prefix: an argv run in front of the step's shell (gate-priority.mjs: ionice/nice, taskpolicy); [] or unset: none
export function defaultRun(command, {
  cwd, timeoutMs, logFile, maxLogBytes = MAX_LOG_BYTES, env, prefix = [],
}) {
  return new Promise((resolve) => {
    const opts = {
      detached: true, cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited(), ...env },
    };
    const child = prefix.length
      ? spawn(prefix[0], [...prefix.slice(1), '/bin/sh', '-c', command], opts)
      : spawn(command, { ...opts, shell: true });
    let buf = '';
    let timedOut = false;
    let done = false;
    const timers = [];
    let logging = Boolean(logFile);
    let logged = 0;
    const collect = (chunk) => {
      if (done) return; // late output from a finished step belongs to no step
      if (logging) { // the whole output: the returned tail can miss the failing test
        logged += chunk.length;
        logging = logged <= maxLogBytes ? appendLog(logFile, chunk) : (appendLog(logFile, '\n== log truncated\n'), false);
      }
      buf = lastLines(buf + chunk.toString('utf8'), 400);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = (code) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      if (child.pid) killGroup(child, 'SIGKILL'); // whatever the step started in the background dies with it
      resolve({ code: code ?? 1, output: lastLines(buf.replace(/\n$/, ''), 200), timedOut });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      timers.push(setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS));
    }, timeoutMs));
    child.on('error', (e) => { buf += `${e.message}\n`; finish(1); });
    child.on('exit', (code) => timers.push(setTimeout(() => finish(code), DRAIN_MS))); // children may hold the pipes
    child.on('close', (code) => finish(code));
  });
}

// `forbidden` is the fence: a change there fails. A file outside `paths` that nothing forbids is passed and flagged:
// workers stopped to ask for such files and every request was granted, so refusing them only cost a round trip.
function pathFindings(files, unit) {
  const forbidden = unit.forbidden ?? []; // optional in the plan
  const hit = (f) => forbidden.length > 0 && matchesAny(f.path, forbidden);
  const unique = (list) => [...new Set(list.map((f) => f.path))];
  const outside = files.filter((f) => !hit(f) && !matchesAny(f.path, unit.paths));
  // the worktree links the main checkout's node_modules unless `paths` cover these files, so they stay fenced
  return {
    forbidden: unique(files.filter(hit)),
    dependencies: unique(outside.filter((f) => isDependencyFile(f.path))),
    outside: unique(outside.filter((f) => !isDependencyFile(f.path))),
  };
}

const listPaths = (paths) => (paths.length > 5
  ? `${paths.slice(0, 5).join(', ')} +${paths.length - 5} more`
  : paths.join(', '));

function requireSha(name, value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${name} must be a full commit SHA`);
}

/**
 * Judge the committed bytes of `headSha` against `baseSha`. `checks.setup` runs in the same fresh
 * checkout as the evidence, but each step's processes are killed when the step ends, so a setup
 * step must not leave a service running for the steps that follow.
 */
export async function runGate({
  repo, baseSha, headSha, unit, checks, git, run, workDir, now = Date.now, timeoutMs = 20 * 60 * 1000, share = { paths: [], unit: null },
  retry = true, // false: a failing evidence or check step is not run again (setup always is)
  logFile, // when set, every step's whole output is appended there, under a `== <step>` line
  env, // added to every step's environment (gate-env.mjs)
  depCache = null, // dep-cache.mjs: a setup of only pnpm installs is skipped when the cache has its node_modules
}) {
  requireSha('baseSha', baseSha);
  requireSha('headSha', headSha);
  const failures = [];
  const flags = [];
  const steps = [];
  let setupFailed = false; // a project-level fact, not a defect of the unit: the scheduler asks the orchestrator
  let cleanup = null; // why the gate's checkout is still there, when it could not be removed
  const result = () => {
    const proved = Boolean(unit.evidence || checks.unit);
    const verdict = failures.length > 0 ? 'fail' : proved ? 'pass' : 'no-evidence';
    return { verdict, failures, flags, steps, headSha, ...(setupFailed ? { setupFailed } : {}), ...(cleanup ? { cleanup } : {}) };
  };

  if (git.commitsAhead(repo, baseSha, headSha) === 0) {
    failures.push(`no commits on top of ${baseSha.slice(0, 12)}`);
    return result();
  }
  const files = git.changedFiles(repo, baseSha, headSha);
  const found = pathFindings(files, unit);
  if (found.forbidden.length > 0) failures.push(`forbidden paths: ${listPaths(found.forbidden)}`);
  if (found.dependencies.length > 0) failures.push(`dependency files outside paths: ${listPaths(found.dependencies)}`);
  if (found.outside.length > 0) flags.push({ kind: 'outside-paths', path: found.outside[0], detail: listPaths(found.outside) });
  flags.push(...scanDiff({
    addedLines: git.addedLines(repo, baseSha, headSha),
    removedLines: git.removedLines(repo, baseSha, headSha),
    changedFiles: files,
    evidence: unit.evidence,
  }));
  if (failures.length > 0) return result();

  let checkout = workDir; // where the steps run: set once the checkout exists (it may be a directory beside workDir)
  const step = async (name, command) => {
    const started = now();
    if (logFile) appendLog(logFile, `== ${name}\n`);
    const r = await run(command, { cwd: checkout, timeoutMs, ...(logFile ? { logFile } : {}), ...(env ? { env } : {}) });
    steps.push({ name, code: r.code, durationMs: now() - started, tail: lastLines(r.output, 15) });
    return r;
  };
  // run once, retry once on failure; returns an error string or null
  const withRetry = async (label, command, again = retry) => {
    const first = await step(label, command);
    if (first.code === 0 && !first.timedOut) return null;
    if (first.timedOut) return `${label} timed out`;
    if (!again) return `${label} failed (exit ${first.code})`;
    const second = await step(`${label} (retry)`, command);
    if (second.timedOut) return `${label} timed out`;
    if (second.code !== 0) return `${label} failed (exit ${second.code})`;
    flags.push({ kind: 'flaky', path: '', detail: `${label} passed on retry` });
    return null;
  };
  const plan = [
    checks.setup && (async () => {
      const started = now();
      if (depCache?.restore(checkout)) {
        steps.push({
          name: 'setup', code: 0, durationMs: now() - started, tail: `node_modules from the install cache (${depCache.key.slice(0, 12)})`, cached: true,
        });
        if (logFile) appendLog(logFile, `== setup: node_modules from the install cache (${depCache.key.slice(0, 12)})\n`);
        return null;
      }
      const error = await withRetry('setup', checks.setup, true); // an install fails on a network blip: always once more
      if (!error) {
        depCache?.publish(checkout); // never fails the gate
        return null;
      }
      setupFailed = true;
      const last = lastSafeLine(steps.at(-1).tail);
      return last ? `${error}: ${last}` : error;
    }),
    unit.evidence && (() => withRetry('evidence', unit.evidence)),
    checks.unit && (() => withRetry('checks', checks.unit)),
  ].filter(Boolean);
  if (plan.length === 0) return result();

  // Never link when a setup step will run: `npm ci` empties node_modules through a link (tested), which would
  // wipe the main checkout's install. Setup then installs a private copy in the gate's checkout.
  const linked = checks.setup ? { paths: [], unit: null } : share;
  cleanup = await inFreshCheckout({
    git, repo, workDir, sha: headSha, share: linked,
  }, async (dir) => {
    checkout = dir;
    for (const task of plan) {
      const error = await task();
      if (error) { failures.push(error); break; }
    }
  });
  return result();
}
