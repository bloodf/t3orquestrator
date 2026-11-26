// What the machine says about its own load, read on every poll. New launches and gates wait while any metric is at
// its limit; a metric that held keeps holding until it is back under `release` times its limit (hysteresis: no flapping).
//   load: 1-minute load average per core (Linux and others; not judged on macOS, see busy)
//   cpu, io, mem: Linux pressure stall information, the 10-second "some" share in percent (/proc/pressure/*).
//     io is read from user.slice when systemd has it: agents run there, and a slow disk only system services use
//     (databases, containers) stalls them and not the agents. Without that cgroup, the machine-wide file
//   memLevel: macOS memory pressure level (1 normal, 2 warning, 4 critical), one sysctl. The default limit is
//     critical: a Mac sits at warning for hours with a browser open, and nothing orq holds back would lower it
//   busy: macOS CPU busy share in percent, from os.cpus() time deltas between two readings. A Mac's load average
//     counts threads waiting on disk and system daemons: load 6.9 per core was seen with the CPU 56% idle
// Machine config `pressure` overrides any limit; `false` turns the check off.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PRESSURE = Object.freeze({
  load: 2, cpu: 60, io: 40, mem: 10, memLevel: 4, busy: 90, release: 0.8,
});
const USER_SLICE = '/sys/fs/cgroup/user.slice';
const PSI_FILES = { cpu: 'cpu', io: 'io', mem: 'memory' };
const METRICS = ['load', 'cpu', 'io', 'mem', 'memLevel', 'busy'];
const NAMES = {
  cpu: 'cpu pressure', io: 'io pressure', mem: 'memory pressure', busy: 'cpu busy',
};
const FIRST_SAMPLE_MS = 250;

export function parsePsi(text) {
  const m = /^some\s+avg10=([\d.]+)/m.exec(String(text));
  if (!m) throw new Error('no "some avg10" line in the pressure file');
  return Number(m[1]);
}

// the last CPU times read in this process: `orq wait` polls, so each poll measures the time since the one before
const cpuState = { last: null };
const defaults = {
  platform: process.platform,
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  exec: (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }),
  cpus: () => os.cpus(),
  // ponytail: a one-shot command (orq status) blocks FIRST_SAMPLE_MS once for its first reading
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  cpuState,
};

// os.cpus() -> {idle, total} milliseconds summed over every core since boot
export function cpuTimes(cpus) {
  return cpus.reduce((a, { times: t }) => ({ idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq }), { idle: 0, total: 0 });
}

// The busy share in percent between two cpuTimes readings, or null when no time passed between them.
export function busyPercent(prev, next) {
  const total = next.total - prev.total;
  if (!(total > 0)) return null;
  return Math.min(100, Math.max(0, Math.round(1000 * (1 - (next.idle - prev.idle) / total)) / 10)); // one decimal
}

// Against the reading before (state.last); the first reading of a process waits FIRST_SAMPLE_MS for a second one.
function macBusy({ cpus, sleep, cpuState: state }) {
  let prev = state.last;
  if (!prev) {
    prev = cpuTimes(cpus());
    sleep(FIRST_SAMPLE_MS);
  }
  const next = cpuTimes(cpus());
  state.last = next;
  return busyPercent(prev, next);
}

function linuxPressure(readFile) {
  const out = {};
  for (const [key, file] of Object.entries(PSI_FILES)) {
    const paths = key === 'io' ? [`${USER_SLICE}/io.pressure`, '/proc/pressure/io'] : [`/proc/pressure/${file}`];
    for (const path of paths) {
      try {
        out[key] = parsePsi(readFile(path));
        break;
      } catch { /* a kernel without PSI, or one file unreadable: try the next, else that metric is not judged */ }
    }
  }
  return out;
}

function macPressure(d) {
  const out = {};
  try {
    const level = Number(String(d.exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 })).trim());
    if (Number.isFinite(level) && level > 0) out.memLevel = level;
  } catch { /* not judged */ }
  try {
    const busy = macBusy(d);
    if (busy !== null) out.busy = busy;
  } catch { /* not judged */ }
  return out;
}

// Best effort: a metric that cannot be read is left out, and never holds anything.
export function readPressure(deps = {}) {
  const d = { ...defaults, ...deps };
  if (d.platform === 'linux') return linuxPressure(d.readFile);
  if (d.platform === 'darwin') return macPressure(d);
  return {};
}

// machine: what probe.mjs readMachine returned. Facts with no `pressure` (a test's, an older caller's) are not judged.
export function pressureSample(machine) {
  if (!machine?.pressure) return null;
  return { load: machine.load1 / machine.cores, ...machine.pressure };
}

const percent = (v) => `${Math.round(v)}%`;
function reason(key, value, limit, releaseAt) {
  if (key === 'load') return `load ${value.toFixed(1)} per core (limit ${limit}${releaseAt === null ? '' : `, releases under ${releaseAt.toFixed(1)}`})`;
  if (key === 'memLevel') return `memory pressure level ${value} (limit ${limit})`;
  return `${NAMES[key]} ${percent(value)} (limit ${percent(limit)}${releaseAt === null ? '' : `, releases under ${percent(releaseAt)}`})`;
}

// holding: the metrics that held on the last poll; each of those keeps holding down to its release point, any other
// holds from its limit. -> {held, holding: the metrics that hold now, reasons: one text per such metric}.
export function judge(sample, config = {}, holding = []) {
  if (!sample || config === false) return { held: false, holding: [], reasons: [] };
  const limits = { ...DEFAULT_PRESSURE, ...config };
  const was = new Set(Array.isArray(holding) ? holding : []);
  const at = (k) => (was.has(k) ? limits[k] * limits.release : limits[k]);
  // a sample with a CPU busy share (macOS) is judged by it, not by its load average
  const judged = Number.isFinite(sample.busy) ? METRICS.filter((k) => k !== 'load') : METRICS;
  const now = judged.filter((k) => Number.isFinite(sample[k]) && sample[k] >= at(k));
  return { held: now.length > 0, holding: now, reasons: now.map((k) => reason(k, sample[k], limits[k], sample[k] < limits[k] ? at(k) : null)) };
}

export function pressureText(sample) {
  if (!sample) return 'not read';
  const parts = [`load=${sample.load.toFixed(1)}/core`];
  for (const k of ['cpu', 'io', 'mem', 'busy']) if (Number.isFinite(sample[k])) parts.push(`${k}=${percent(sample[k])}`);
  if (Number.isFinite(sample.memLevel)) parts.push(`mem_level=${sample.memLevel}`);
  return parts.join(' ');
}

// A stored `pressure` value: why it is invalid, or null.
export function pressureError(v) {
  if (v === undefined || v === false) return null;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'pressure must be false or an object of limits';
  for (const [k, n] of Object.entries(v)) {
    if (!Object.hasOwn(DEFAULT_PRESSURE, k)) return `pressure: unknown key "${k}"; valid keys: ${Object.keys(DEFAULT_PRESSURE).join(', ')}`;
    if (!(Number.isFinite(n) && n > 0)) return `pressure: ${k} must be a positive number`;
  }
  return v.release !== undefined && v.release > 1 ? 'pressure: release must be over 0 and at most 1' : null;
}
