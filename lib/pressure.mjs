// What the machine says about its own load, read on every poll. New launches and gates wait while any metric is at
// its limit; a metric that held keeps holding until it is back under `release` times its limit (hysteresis: no flapping).
//   load: 1-minute load average per core (every platform)
//   cpu, io, mem: Linux pressure stall information, the 10-second "some" share in percent (/proc/pressure/*)
//   memLevel: macOS memory pressure level (1 normal, 2 warning, 4 critical), one sysctl. The default limit is
//     critical: a Mac sits at warning for hours with a browser open, and nothing orq holds back would lower it
// Machine config `pressure` overrides any limit; `false` turns the check off.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PRESSURE = Object.freeze({
  load: 2, cpu: 60, io: 40, mem: 10, memLevel: 4, release: 0.8,
});
const PSI_FILES = { cpu: 'cpu', io: 'io', mem: 'memory' };
const METRICS = ['load', 'cpu', 'io', 'mem', 'memLevel'];
const NAMES = { cpu: 'cpu pressure', io: 'io pressure', mem: 'memory pressure' };

export function parsePsi(text) {
  const m = /^some\s+avg10=([\d.]+)/m.exec(String(text));
  if (!m) throw new Error('no "some avg10" line in the pressure file');
  return Number(m[1]);
}

const defaults = {
  platform: process.platform,
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  exec: (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }),
};

function linuxPressure(readFile) {
  const out = {};
  for (const [key, file] of Object.entries(PSI_FILES)) {
    try {
      out[key] = parsePsi(readFile(`/proc/pressure/${file}`));
    } catch { /* a kernel without PSI, or one file unreadable: that metric is not judged */ }
  }
  return out;
}

function macPressure(exec) {
  try {
    const level = Number(String(exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 })).trim());
    return Number.isFinite(level) && level > 0 ? { memLevel: level } : {};
  } catch {
    return {}; // not judged
  }
}

// Best effort: a metric that cannot be read is left out, and never holds anything.
export function readPressure(deps = {}) {
  const d = { ...defaults, ...deps };
  if (d.platform === 'linux') return linuxPressure(d.readFile);
  if (d.platform === 'darwin') return macPressure(d.exec);
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
  const now = METRICS.filter((k) => Number.isFinite(sample[k]) && sample[k] >= at(k));
  return { held: now.length > 0, holding: now, reasons: now.map((k) => reason(k, sample[k], limits[k], sample[k] < limits[k] ? at(k) : null)) };
}

export function pressureText(sample) {
  if (!sample) return 'not read';
  const parts = [`load=${sample.load.toFixed(1)}/core`];
  for (const k of ['cpu', 'io', 'mem']) if (Number.isFinite(sample[k])) parts.push(`${k}=${percent(sample[k])}`);
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
