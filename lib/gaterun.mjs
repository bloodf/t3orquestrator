// Gates run as detached `orq gate-run` children so they outlive the `orq wait` call that started them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  commit, readState, unitOf, FINAL,
} from './ledger.mjs';
import { readJson } from './store.mjs';
import { gateFile, unitDir } from './paths.mjs';

const BIN = fileURLToPath(new URL('../bin/orq.mjs', import.meta.url));

export function spawnGateRun({
  cwd, env, args, logFile,
}) {
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [BIN, 'gate-run', ...args], {
      cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd],
    });
    if (!child.pid) throw new Error('could not start gate-run');
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const readPid = async (file) => {
  try {
    return Number((await fsp.readFile(file, 'utf8')).trim());
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
};

const exists = (file) => fsp.stat(file).then(() => true, (e) => {
  if (e.code === 'ENOENT') return false;
  throw e;
});

// Claim the pid file by exclusive create: a FileHandle when we own it, or the pid of a live gate that does.
// A pid whose attempt already has a result is finished, whatever process now owns that pid.
async function claimPidFile(file, resultFile, isAlive) {
  for (;;) {
    try {
      return await fsp.open(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = await readPid(file);
    if (pid > 0 && isAlive(pid) && !(await exists(resultFile))) return pid;
    await fsp.rm(file, { force: true }); // left by a gate that died or a spawn that never happened
  }
}

async function launchGate(fx, unit, attempt, headSha) {
  const file = (ext) => gateFile(fx.cwd, unit, attempt, ext);
  await fsp.mkdir(unitDir(fx.cwd, unit), { recursive: true });
  const claim = await claimPidFile(file('pid'), file('json'), fx.isAlive);
  let pid = claim;
  if (typeof claim !== 'number') {
    try {
      await fsp.rm(file('json'), { force: true }); // a result left by an earlier life of this unit
      pid = await fx.spawnGate({
        cwd: fx.cwd, env: fx.env, args: [unit, String(attempt), headSha], logFile: file('log'),
      });
      await claim.writeFile(`${pid}\n`);
    } finally {
      await claim.close();
    }
  }
  await commit(fx.cwd, (s) => {
    const u = unitOf(s, unit);
    const applies = unit === FINAL || (u.state === 'gating' && u.attempt === attempt);
    return applies ? [{ type: 'gate-started', unit, at: fx.now(), attempt, headSha, pid }] : [];
  });
}

export async function startUnitGate(fx, { unit, attempt }) {
  const u = unitOf(await readState(fx.cwd), unit);
  let headSha;
  try {
    headSha = fx.git.resolveSha(fx.cwd, `refs/heads/${u.branch}`);
  } catch (e) {
    await commit(fx.cwd, (s) => (unitOf(s, unit).state !== 'gating' ? [] : [{
      type: 'needs-judgment', unit, at: fx.now(), reason: `gate could not start: ${e.message}`,
    }]));
    return;
  }
  // u.headSha still names the commit the previous attempt's gate failed, until this attempt's gate starts
  const afterFeedback = u.since !== null && u.gateStarts === 0;
  if (afterFeedback && u.headSha === headSha) return sameCommit(fx, unit, u);
  await launchGate(fx, unit, attempt, headSha);
}

// After feedback the branch did not move: the gate that already failed this commit would fail again.
// Record the same quality failure and let the ladder take its next rung.
function sameCommit(fx, unit, u) {
  const failures = ['no new commit after feedback', ...(u.lastFailure ?? [])];
  return commit(fx.cwd, (s) => {
    const now = unitOf(s, unit);
    if (now.state !== 'gating' || now.attempt !== u.attempt) return [];
    return [{
      type: 'gated', unit, at: fx.now(), attempt: u.attempt, verdict: 'fail', failures, flags: now.flags, headSha: u.headSha,
    }];
  });
}

export async function startFinalGate(fx) {
  const { plan } = await readState(fx.cwd);
  await launchGate(fx, FINAL, 1, plan.integrationHead);
}

// Result file present -> result; else the recorded pid alive -> running; else neither. A result for a commit
// other than `expectedHead` is stale (an earlier life of this unit): it is removed and ignored.
export async function collectGate(fx, unit, attempt, expectedHead) {
  const file = gateFile(fx.cwd, unit, attempt, 'json');
  const result = await readJson(file, null);
  if (result !== null && (expectedHead === undefined || result.headSha === expectedHead)) {
    await fsp.rm(gateFile(fx.cwd, unit, attempt, 'pid'), { force: true }); // finished: never read it as running again
    return { running: false, result };
  }
  if (result !== null) await fsp.rm(file, { force: true });
  const pid = await readPid(gateFile(fx.cwd, unit, attempt, 'pid'));
  if (pid > 0 && fx.isAlive(pid)) return { running: true, result: null };
  const error = await lastLogLine(gateFile(fx.cwd, unit, attempt, 'log'));
  return { running: false, result: null, ...(error ? { error } : {}) };
}

// Why a gate process died without a result: the last line it logged, safe to print.
async function lastLogLine(file) {
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const lines = text.split('\n').map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter((l) => l !== '');
  return (lines.at(-1) ?? '').slice(0, 160);
}
