import { spawn } from 'node:child_process';
import { matchesAny } from './glob.mjs';
import { scanDiff } from './scan.mjs';
import { lastSafeLine } from './gaterun.mjs';

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
export function defaultRun(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, detached: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let timedOut = false;
    let done = false;
    const timers = [];
    const collect = (chunk) => { buf = lastLines(buf + chunk.toString('utf8'), 400); };
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

function offendingPaths(files, unit) {
  const forbidden = unit.forbidden ?? []; // optional in the plan
  const bad = files.filter((f) => !matchesAny(f.path, unit.paths) || (forbidden.length > 0 && matchesAny(f.path, forbidden)));
  return [...new Set(bad.map((f) => f.path))];
}

const listPaths = (paths) => (paths.length > 5
  ? `${paths.slice(0, 5).join(', ')} +${paths.length - 5} more`
  : paths.join(', '));

function requireSha(name, value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${name} must be a full commit SHA`);
}

// Run `body` inside a fresh detached checkout of `sha`; always remove it, never mask body's error.
async function inFreshCheckout({ git, repo, workDir, sha }, body) {
  git.addDetachedWorktree(repo, workDir, sha);
  let failure;
  try {
    await body();
  } catch (e) {
    failure = { error: e };
  }
  try {
    git.removeWorktree(repo, workDir);
  } catch (removeError) {
    if (!failure) failure = { error: removeError };
  }
  if (failure) throw failure.error;
}

/**
 * Judge the committed bytes of `headSha` against `baseSha`. `checks.setup` runs in the same fresh
 * checkout as the evidence, but each step's processes are killed when the step ends, so a setup
 * step must not leave a service running for the steps that follow.
 */
export async function runGate({
  repo, baseSha, headSha, unit, checks, git, run, workDir, now = Date.now, timeoutMs = 20 * 60 * 1000,
}) {
  requireSha('baseSha', baseSha);
  requireSha('headSha', headSha);
  const failures = [];
  const flags = [];
  const steps = [];
  let setupFailed = false; // a project-level fact, not a defect of the unit: the scheduler asks the orchestrator
  const result = () => {
    const proved = Boolean(unit.evidence || checks.unit);
    const verdict = failures.length > 0 ? 'fail' : proved ? 'pass' : 'no-evidence';
    return { verdict, failures, flags, steps, headSha, ...(setupFailed ? { setupFailed } : {}) };
  };

  if (git.commitsAhead(repo, baseSha, headSha) === 0) {
    failures.push(`no commits on top of ${baseSha.slice(0, 12)}`);
    return result();
  }
  const files = git.changedFiles(repo, baseSha, headSha);
  const outside = offendingPaths(files, unit);
  if (outside.length > 0) failures.push(`outside writable paths: ${listPaths(outside)}`);
  flags.push(...scanDiff({
    addedLines: git.addedLines(repo, baseSha, headSha),
    removedLines: git.removedLines(repo, baseSha, headSha),
    changedFiles: files,
    evidence: unit.evidence,
  }));
  if (failures.length > 0) return result();

  const step = async (name, command) => {
    const started = now();
    const r = await run(command, { cwd: workDir, timeoutMs });
    steps.push({ name, code: r.code, durationMs: now() - started, tail: lastLines(r.output, 15) });
    return r;
  };
  // run once, retry once on failure; returns an error string or null
  const withRetry = async (label, command) => {
    const first = await step(label, command);
    if (first.code === 0 && !first.timedOut) return null;
    if (first.timedOut) return `${label} timed out`;
    const second = await step(`${label} (retry)`, command);
    if (second.timedOut) return `${label} timed out`;
    if (second.code !== 0) return `${label} failed (exit ${second.code})`;
    flags.push({ kind: 'flaky', path: '', detail: `${label} passed on retry` });
    return null;
  };
  const plan = [
    checks.setup && (async () => {
      const error = await withRetry('setup', checks.setup);
      if (!error) return null;
      setupFailed = true;
      const last = lastSafeLine(steps.at(-1).tail);
      return last ? `${error}: ${last}` : error;
    }),
    unit.evidence && (() => withRetry('evidence', unit.evidence)),
    checks.unit && (() => withRetry('checks', checks.unit)),
  ].filter(Boolean);
  if (plan.length === 0) return result();

  await inFreshCheckout({ git, repo, workDir, sha: headSha }, async () => {
    for (const task of plan) {
      const error = await task();
      if (error) { failures.push(error); break; }
    }
  });
  return result();
}
