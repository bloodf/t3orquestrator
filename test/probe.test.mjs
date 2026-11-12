import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCap, parseVmStat, readMachine, resolveCap,
} from '../lib/probe.mjs';

const GIB = 1024 ** 3;
const base = { cores: 8, availableMemBytes: 16 * GIB, load1: 0 };

test('computeCap: cpu bound is cores/2', () => {
  const r = computeCap({ ...base, cores: 6 });
  assert.equal(r.cap, 3);
  assert.ok(r.reasons.some((s) => s.includes('cpu')));
});

test('computeCap: memory bound at 2 GiB per thread', () => {
  const r = computeCap({ ...base, cores: 32, availableMemBytes: 5 * GIB });
  assert.equal(r.cap, 2);
  assert.ok(r.reasons.some((s) => s.includes('mem')));
});

test('computeCap: custom memPerThreadBytes', () => {
  assert.equal(computeCap({ ...base, cores: 32, availableMemBytes: 8 * GIB, memPerThreadBytes: 4 * GIB }).cap, 2);
});

test('computeCap: 1 core clamps to 1', () => {
  assert.equal(computeCap({ ...base, cores: 1 }).cap, 1);
});

test('computeCap: low memory clamps to 1', () => {
  const r = computeCap({ ...base, availableMemBytes: GIB / 2 });
  assert.equal(r.cap, 1);
});

test('computeCap: huge memory does not raise above cpu bound', () => {
  assert.equal(computeCap({ ...base, availableMemBytes: 1024 * GIB }).cap, 4);
});

test('computeCap: high load subtracts one', () => {
  const r = computeCap({ ...base, load1: 6 });
  assert.equal(r.cap, 3);
  assert.ok(r.reasons.some((s) => s.includes('load')));
});

test('computeCap: load exactly 0.7 per core does not subtract', () => {
  assert.equal(computeCap({ ...base, load1: 5.6 }).cap, 4);
});

test('computeCap: load penalty cannot go below 1', () => {
  assert.equal(computeCap({ ...base, cores: 2, load1: 10 }).cap, 1);
});

test('computeCap: max clamp', () => {
  const r = computeCap({ cores: 128, availableMemBytes: 512 * GIB, load1: 0 });
  assert.equal(r.cap, 8);
  assert.ok(r.reasons.some((s) => s.includes('max')));
  assert.equal(computeCap({ cores: 128, availableMemBytes: 512 * GIB, load1: 0, max: 3 }).cap, 3);
});

test('computeCap: instance limits lower the cap', () => {
  const r = computeCap({ ...base, instanceLimits: [1, 1] });
  assert.equal(r.cap, 2);
  assert.ok(r.reasons.some((s) => s.includes('instance')));
});

test('computeCap: instance limits above cap change nothing', () => {
  assert.equal(computeCap({ ...base, instanceLimits: [10, 10] }).cap, 4);
});

test('computeCap: instance limits sum 0 gives 0', () => {
  assert.equal(computeCap({ ...base, instanceLimits: [0, 0] }).cap, 0);
});

test('computeCap: empty instance limits ignored', () => {
  assert.equal(computeCap({ ...base, instanceLimits: [] }).cap, 4);
});

test('computeCap: invalid inputs throw', () => {
  assert.throws(() => computeCap({ ...base, cores: 0 }), /cores/);
  assert.throws(() => computeCap({ ...base, cores: NaN }), /cores/);
  assert.throws(() => computeCap({ ...base, availableMemBytes: -1 }), /availableMemBytes/);
  assert.throws(() => computeCap({ ...base, availableMemBytes: Infinity }), /availableMemBytes/);
  assert.throws(() => computeCap({ ...base, load1: -0.1 }), /load1/);
  assert.throws(() => computeCap({ ...base, instanceLimits: [1, -1] }), /instanceLimits/);
  assert.throws(() => computeCap({ ...base, instanceLimits: [1.5] }), /instanceLimits/);
  assert.throws(() => computeCap({ ...base, max: 0 }), /max/);
  assert.throws(() => computeCap({ ...base, max: 2.5 }), /max/);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           30000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           5000.
`;

test('parseVmStat sums free+inactive+speculative+purgeable pages', () => {
  assert.equal(parseVmStat(VM_STAT), (10000 + 30000 + 2000) * 16384);
});

test('parseVmStat throws on malformed text', () => {
  assert.throws(() => parseVmStat('nonsense'), /page size/);
  assert.throws(() => parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\n'), /Pages/);
});

const fakeOs = (over = {}) => ({
  availableParallelism: () => 10,
  loadavg: () => [2.5, 1, 1],
  freemem: () => 3 * GIB,
  ...over,
});

test('computeCap: clamp reasons', () => {
  const lo = computeCap({ ...base, availableMemBytes: GIB / 2 });
  assert.ok(lo.reasons.includes('clamp: raised to minimum 1'));
  const hi = computeCap({ cores: 128, availableMemBytes: 512 * GIB, load1: 0 });
  assert.ok(hi.reasons.includes('clamp: limited to max 8'));
});

test('computeCap: no load reason when the penalty had no effect', () => {
  const r = computeCap({ ...base, cores: 2, load1: 10 });
  assert.equal(r.cap, 1);
  assert.ok(!r.reasons.some((s) => s.startsWith('load')));
  const capped = computeCap({ cores: 128, availableMemBytes: 512 * GIB, load1: 128 });
  assert.ok(!capped.reasons.some((s) => s.startsWith('load')));
});

test('readMachine linux uses process.availableMemory', () => {
  const m = readMachine({ platform: 'linux', os: fakeOs(), availableMemory: () => 9 * GIB });
  assert.deepEqual(m, { cores: 10, availableMemBytes: 9 * GIB, load1: 2.5, notes: [] });
});

test('readMachine darwin parses vm_stat with a timeout', () => {
  const m = readMachine({
    platform: 'darwin', os: fakeOs(),
    exec: (cmd, args, opts) => {
      assert.equal(cmd, 'vm_stat');
      assert.equal(opts.timeout, 2000);
      return VM_STAT;
    },
  });
  assert.equal(m.availableMemBytes, 42000 * 16384);
  assert.deepEqual(m.notes, []);
});

test('readMachine falls back to os.freemem and says so', () => {
  const l = readMachine({
    platform: 'linux', os: fakeOs(),
    availableMemory: () => { throw new Error('no api'); },
  });
  assert.equal(l.availableMemBytes, 3 * GIB);
  assert.deepEqual(l.notes, ['mem: fallback to os.freemem (no api)']);
  const d = readMachine({ platform: 'darwin', os: fakeOs(), exec: () => 'garbage' });
  assert.equal(d.availableMemBytes, 3 * GIB);
  assert.match(d.notes[0], /^mem: fallback to os\.freemem \(page size not found/);
});

test('readMachine on other platforms falls back with a note', () => {
  const m = readMachine({ platform: 'win32', os: fakeOs({ loadavg: () => [0, 0, 0] }) });
  assert.equal(m.availableMemBytes, 3 * GIB);
  assert.equal(m.load1, 0);
  assert.match(m.notes[0], /fallback to os\.freemem/);
});

test('resolveCap uses positive integer override', () => {
  const r = resolveCap({ machine: base, config: { cap: 3 } });
  assert.equal(r.cap, 3);
  assert.deepEqual(r.reasons, ['override']);
});

test('resolveCap rejects bad config', () => {
  assert.throws(() => resolveCap({ machine: base, config: null }), /invalid config: expected an object/);
  assert.throws(() => resolveCap({ machine: base, config: [] }), /invalid config: expected an object/);
  assert.throws(() => resolveCap({ machine: base, config: 'x' }), /invalid config: expected an object/);
  for (const cap of [0, 2.5, '3', -1]) {
    assert.throws(() => resolveCap({ machine: base, config: { cap } }), /invalid config: cap must be a positive integer/);
  }
});

test('resolveCap computes when no cap is configured', () => {
  assert.equal(resolveCap({ machine: base, config: {} }).cap, 4);
  assert.equal(resolveCap({ machine: base }).cap, 4);
});

test('resolveCap applies instance limits, also to an override', () => {
  assert.equal(resolveCap({ machine: base, config: {}, instanceLimits: [1] }).cap, 1);
  const r = resolveCap({ machine: base, config: { cap: 6 }, instanceLimits: [2, 1] });
  assert.equal(r.cap, 3);
  assert.equal(r.reasons[0], 'override');
  assert.ok(r.reasons.some((s) => s.includes('instance')));
  assert.equal(resolveCap({ machine: base, config: { cap: 6 }, instanceLimits: [0] }).cap, 0);
});

test('resolveCap appends machine notes to reasons', () => {
  const r = resolveCap({ machine: { ...base, notes: ['mem: fallback to os.freemem (x)'] }, config: {} });
  assert.equal(r.reasons.at(-1), 'mem: fallback to os.freemem (x)');
});
