import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRESSURE, busyPercent, cpuTimes, judge, parsePsi, pressureError, pressureSample, pressureText, readPressure,
} from '../lib/pressure.mjs';

const PSI = 'some avg10=72.56 avg60=74.18 avg300=69.04 total=44229796797\nfull avg10=57.74 avg60=61.03 avg300=55.64 total=34409198714\n';

test('parsePsi reads the 10-second "some" average', () => {
  assert.equal(parsePsi(PSI), 72.56);
  assert.throws(() => parsePsi('garbage'), /some avg10/);
});

test('readPressure on linux reads cpu, io and memory pressure, and leaves out what it cannot read', () => {
  const files = { '/proc/pressure/cpu': 'some avg10=1.50 avg60=0 avg300=0 total=1\n', '/proc/pressure/io': PSI };
  const read = (f) => {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  };
  assert.deepEqual(readPressure({ platform: 'linux', readFile: read }), { cpu: 1.5, io: 72.56 });
});

test('readPressure on linux judges io by user.slice, where agents run, when systemd has it', () => {
  const files = {
    '/proc/pressure/io': PSI,
    '/sys/fs/cgroup/user.slice/io.pressure': 'some avg10=6.02 avg60=4 avg300=3 total=1\n',
  };
  const read = (f) => {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  };
  assert.deepEqual(readPressure({ platform: 'linux', readFile: read }), { io: 6.02 });
});

const core = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
const noCpus = () => { throw new Error('no cpus'); };

test('readPressure on macOS reads the memory pressure level with one cheap call', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push([cmd, args, opts.timeout]);
    return '2\n';
  };
  assert.deepEqual(readPressure({ platform: 'darwin', exec, cpus: noCpus }), { memLevel: 2 });
  assert.deepEqual(calls, [['sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], 2000]]);
  assert.deepEqual(readPressure({ platform: 'darwin', exec: () => { throw new Error('no sysctl'); }, cpus: noCpus }), {});
  assert.deepEqual(readPressure({ platform: 'win32' }), {});
});

test('busyPercent is the busy share of the CPU time between two readings', () => {
  const a = cpuTimes([core(100, 900), core(100, 900)]);
  assert.deepEqual(a, { idle: 1800, total: 2000 });
  const b = cpuTimes([core(200, 1000), core(150, 950)]); // +150 busy, +150 idle
  assert.equal(busyPercent(a, b), 50);
  assert.equal(busyPercent(a, a), null);
});

test('readPressure on macOS judges CPU busy from the delta since the last reading, not since boot', () => {
  // since boot the cores look idle (10% busy); over the last interval they were 95% busy
  const readings = [[core(100, 900)], [core(195, 905)], [core(205, 995)]];
  const cpus = () => readings.shift();
  const sleeps = [];
  const state = { last: null };
  const deps = {
    platform: 'darwin', exec: () => '1\n', cpus, sleep: (ms) => sleeps.push(ms), cpuState: state,
  };
  assert.deepEqual(readPressure(deps), { memLevel: 1, busy: 95 }); // first reading: two samples, a short wait between
  assert.equal(sleeps.length, 1);
  assert.deepEqual(readPressure(deps), { memLevel: 1, busy: 10 }); // next poll: against the reading before, no wait
  assert.equal(sleeps.length, 1);
});

test('judge on macOS holds by CPU busy, never by the load average', () => {
  const mac = pressureSample({ cores: 10, load1: 69, pressure: { memLevel: 1, busy: 44 } });
  assert.equal(judge(mac).held, false); // load 6.9 per core with the CPU 56% idle: no hold
  const busy = judge({ ...mac, busy: 93 });
  assert.deepEqual([busy.held, busy.holding, busy.reasons], [true, ['busy'], ['cpu busy 93% (limit 90%)']]);
  assert.equal(judge({ ...mac, busy: 80 }, {}, ['busy']).held, true); // releases under 72%
  assert.equal(judge({ ...mac, busy: 70 }, {}, ['busy', 'load']).held, false); // a load hold from an older reading ends
  assert.equal(judge({ load: 6.9, memLevel: 1 }).held, true); // no busy reading (cpus failed): load still judged
});

test('pressureSample adds load per core, and is null for machine facts that carry no pressure', () => {
  assert.deepEqual(pressureSample({ cores: 20, load1: 36, pressure: { io: 72 } }), { load: 1.8, io: 72 });
  assert.equal(pressureSample({ cores: 8, load1: 400 }), null);
});

test('judge holds at a limit and names every metric over it', () => {
  assert.deepEqual(judge({ load: 0.4, cpu: 2, io: 10, mem: 0 }), { held: false, holding: [], reasons: [] });
  const r = judge({ load: 2.5, cpu: 2, io: 72.56, mem: 0 });
  assert.deepEqual([r.held, r.holding], [true, ['load', 'io']]);
  assert.deepEqual(r.reasons, ['load 2.5 per core (limit 2)', 'io pressure 73% (limit 40%)']);
  assert.deepEqual(judge({ memLevel: 2 }).reasons, []); // warning is where a Mac lives; critical holds
  assert.deepEqual(judge({ memLevel: 4 }).reasons, ['memory pressure level 4 (limit 4)']);
  assert.deepEqual(judge({ memLevel: 2 }, { memLevel: 2 }).reasons, ['memory pressure level 2 (limit 2)']);
  assert.equal(judge(null).held, false);
});

test('judge releases only under the release share of a limit (hysteresis)', () => {
  const between = { io: 35, load: 1.8 }; // io: under the limit 40, over the release point 32
  assert.equal(judge(between, {}, []).held, false);
  const kept = judge(between, {}, ['io']);
  assert.deepEqual([kept.held, kept.holding], [true, ['io']]); // load never held: it is judged against its own limit
  assert.deepEqual(kept.reasons, ['io pressure 35% (limit 40%, releases under 32%)']);
  assert.equal(judge({ io: 31 }, {}, ['io']).held, false);
  assert.equal(judge({ memLevel: 2 }, {}, ['memLevel']).held, false);
  assert.equal(judge(between, {}, 'io').held, false); // a stored value that is not a list holds nothing
});

test('judge takes limits from machine config; false turns it off', () => {
  assert.equal(judge({ io: 35 }, { io: 30 }).held, true);
  assert.equal(judge({ load: 9, io: 99 }, false).held, false);
  assert.equal(DEFAULT_PRESSURE.release, 0.8);
});

test('pressureText is one short line of what was read', () => {
  assert.equal(pressureText({ load: 1.806, cpu: 1.69, io: 72.56, mem: 0.1 }), 'load=1.8/core cpu=2% io=73% mem=0%');
  assert.equal(pressureText({ load: 1.5, memLevel: 1 }), 'load=1.5/core mem_level=1');
  assert.equal(pressureText({ load: 6.9, memLevel: 1, busy: 44.2 }), 'load=6.9/core busy=44% mem_level=1');
});

test('pressureError checks a stored value', () => {
  assert.equal(pressureError(undefined), null);
  assert.equal(pressureError(false), null);
  assert.equal(pressureError({ io: 30, release: 0.5 }), null);
  assert.match(pressureError({ disk: 3 }), /unknown key "disk"/);
  assert.match(pressureError({ io: -1 }), /io must be a positive number/);
  assert.match(pressureError({ release: 1.5 }), /release must be over 0 and at most 1/);
  assert.match(pressureError([]), /pressure must be false or an object/);
});
