import nodeOs from 'node:os';
import { execFileSync } from 'node:child_process';

const GIB = 1024 ** 3;

function requireNumber(name, v, { positive = false } = {}) {
  if (!Number.isFinite(v) || (positive ? v <= 0 : v < 0)) {
    throw new Error(`${name} must be a ${positive ? 'positive' : 'non-negative'} finite number, got ${v}`);
  }
}

function limitByInstances(cap, instanceLimits) {
  if (instanceLimits === undefined) return { cap, reasons: [] };
  if (!(Array.isArray(instanceLimits) && instanceLimits.every((n) => Number.isInteger(n) && n >= 0))) {
    throw new Error('instanceLimits must be an array of non-negative integers');
  }
  if (instanceLimits.length === 0) return { cap, reasons: [] };
  const sum = instanceLimits.reduce((a, b) => a + b, 0);
  const limited = Math.min(cap, sum);
  return { cap: limited, reasons: limited < cap ? [`instance limits: sum ${sum}`] : [] };
}

export function computeCap({
  cores, availableMemBytes, load1, memPerThreadBytes = 2 * GIB, max = 8, instanceLimits,
}) {
  requireNumber('cores', cores, { positive: true });
  requireNumber('availableMemBytes', availableMemBytes);
  requireNumber('load1', load1);
  requireNumber('memPerThreadBytes', memPerThreadBytes, { positive: true });
  if (!Number.isInteger(max) || max < 1) throw new Error(`max must be a positive integer, got ${max}`);
  // ponytail: fixed heuristic (cores/2, 2 GiB per thread, load > 0.7). Override with "cap" in machine config; replace with measured per-thread cost if it proves wrong.
  const byCpu = Math.floor(cores / 2);
  const byMem = Math.floor(availableMemBytes / memPerThreadBytes);
  const base = Math.min(byCpu, byMem);
  const clamp = (n) => Math.min(max, Math.max(1, n));
  const loaded = load1 / cores > 0.7;
  const raw = loaded ? base - 1 : base;
  const reasons = [byCpu <= byMem ? `cpu: ${cores} cores allow ${byCpu}` : `mem: available memory allows ${byMem}`];
  if (loaded && clamp(raw) !== clamp(base)) {
    reasons.push(`load: load1 ${load1.toFixed(2)} over 0.7 per core, minus 1`);
  }
  if (raw < 1) reasons.push('clamp: raised to minimum 1');
  if (raw > max) reasons.push(`clamp: limited to max ${max}`);
  const limited = limitByInstances(clamp(raw), instanceLimits);
  return { cap: limited.cap, reasons: [...reasons, ...limited.reasons] };
}

export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) throw new Error('page size not found in vm_stat output');
  let pages = 0;
  for (const label of ['free', 'inactive', 'speculative']) {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text);
    if (!m) throw new Error(`Pages ${label} not found in vm_stat output`);
    pages += Number(m[1]);
  }
  return pages * Number(size[1]);
}

const defaults = {
  platform: process.platform,
  os: nodeOs,
  availableMemory: () => process.availableMemory(),
  exec: (cmd, args = [], opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }),
};

function availableMem({ platform, os, availableMemory, exec }) {
  const fallback = (why) => ({
    bytes: os.freemem(),
    note: `mem: fallback to os.freemem (${why})`,
  });
  try {
    if (platform === 'linux') return { bytes: availableMemory(), note: null };
    if (platform === 'darwin') return { bytes: parseVmStat(exec('vm_stat', [], { timeout: 2000 })), note: null };
  } catch (e) {
    return fallback(String(e.message).split('\n')[0]);
  }
  return fallback(`unsupported platform ${platform}`);
}

export function readMachine(deps = {}) {
  const d = { ...defaults, ...deps };
  const mem = availableMem(d);
  return {
    cores: d.os.availableParallelism(),
    availableMemBytes: mem.bytes,
    load1: d.os.loadavg()[0],
    notes: mem.note ? [mem.note] : [],
  };
}

export function resolveCap({ machine, config = {}, instanceLimits }) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid config: expected an object');
  }
  const { notes = [], ...facts } = machine;
  let result;
  if (config.cap === undefined) {
    result = computeCap({ ...facts, instanceLimits });
  } else {
    if (!Number.isInteger(config.cap) || config.cap < 1) {
      throw new Error('invalid config: cap must be a positive integer');
    }
    const limited = limitByInstances(config.cap, instanceLimits);
    result = { cap: limited.cap, reasons: ['override', ...limited.reasons] };
  }
  return { cap: result.cap, reasons: [...result.reasons, ...notes] };
}
