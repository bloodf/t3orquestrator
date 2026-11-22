import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.mjs';

const NOW = 1_800_000_000_000;
const GIB = 1024 ** 3;
const PROTECT = '[{"name":"gateway","url":"http://127.0.0.1:11434/v1/models","timeoutMs":3000}]';
const PEERS = '[{"host":"stormtrooper","ssh":"stormtrooper@stormtrooper"},{"host":"mac","ssh":"macbook"}]';

async function machine(t, deps = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-admission-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const asked = [];
  const orq = async (...args) => {
    const out = [];
    const err = [];
    const code = await run(args, {
      stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { T3ORQ_HOME: path.join(dir, 'home'), T3CODE_HOME: path.join(dir, 't3') }, cwd: dir, now: () => NOW,
      deps: {
        hostname: () => 'cortex', readMachine: () => ({ cores: 20, availableMemBytes: 40 * GIB, load1: 36, pressure: { cpu: 2, io: 72, mem: 0 } }),
        fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
        ssh: async (target) => {
          asked.push(target);
          return target === 'macbook' ? { code: 255, stdout: '', stderr: 'ssh: connect to host macbook port 22: Connection refused' }
            : { code: 0, stdout: JSON.stringify({ at: NOW, cores: 32, load: 0.2, cap: 16, active: 7, free: 9, held: false, pressure: { cpu: 1 }, protect: {} }), stderr: '' };
        },
        ...deps,
      },
    });
    return { code, out: out.join(''), err: err.join('') };
  };
  return { dir, orq, asked };
}

test('config set --machine takes pressure, protect and peers as JSON and refuses a bad value', async (t) => {
  const { orq } = await machine(t);
  assert.equal((await orq('config', 'set', '--machine', 'protect', PROTECT)).code, 0);
  assert.equal((await orq('config', 'set', '--machine', 'peers', PEERS)).code, 0);
  assert.equal((await orq('config', 'set', '--machine', 'pressure', '{"io":30}')).code, 0);
  const stored = JSON.parse((await orq('config', 'get', '--machine')).out);
  assert.deepEqual([stored.protect, stored.peers, stored.pressure], [JSON.parse(PROTECT), JSON.parse(PEERS), { io: 30 }]);
  assert.match((await orq('config', 'set', '--machine', 'peers', '[{"host":"x","ssh":"-oProxyCommand=id"}]')).err, /ssh must be an ssh target/);
  assert.match((await orq('config', 'set', '--machine', 'protect', 'gateway')).err, /protect must be a JSON value/);
  assert.match((await orq('config', 'set', '--machine', 'pressure', '{"disk":1}')).err, /unknown key "disk"/);
  assert.equal((await orq('config', 'set', '--machine', 'pressure', 'false')).code, 0);
  assert.equal((await orq('config', 'set', '--machine', 'pressure', 'null')).code, 0);
  assert.equal(JSON.parse((await orq('config', 'get', '--machine')).out).pressure, undefined);
  assert.match((await orq('config', 'set', 'peers', PEERS)).err, /unknown project config key "peers"/);
});

test('status and peers show the machine pressure, its protected services and its peers', async (t) => {
  const { orq, asked } = await machine(t);
  await orq('config', 'set', '--machine', 'protect', PROTECT);
  await orq('config', 'set', '--machine', 'peers', PEERS);
  const lines = (await orq('status')).out.split('\n');
  const expected = [
    'pressure: load=1.8/core cpu=2% io=72% mem=0% HELD, nothing new starts: io pressure 72% (limit 40%)',
    'protect: gateway ok',
    'peers: stormtrooper ok free=9/16 load=0.2/core cpu=1%; mac unreachable (connection refused); least loaded with room: stormtrooper',
  ];
  assert.deepEqual(lines.filter((l) => /^(pressure|protect|peers):/.test(l)), expected);
  assert.equal((await orq('peers')).out, `${expected.join('\n')}\n`);
  assert.equal(asked.length, 2); // the second command read the cache
  const json = JSON.parse((await orq('status', '--json')).out).machine;
  assert.deepEqual([json.held, json.reasons, json.protect.gateway.ok, json.peers.map((p) => p.ok)], [true, ['io pressure 72% (limit 40%)'], true, [true, false]]);
  assert.equal(json.protect.gateway.url, undefined); // a URL may carry a credential
});

test('peers --self prints and publishes this machine\'s status without asking its own peers', async (t) => {
  const { dir, orq, asked } = await machine(t);
  await orq('config', 'set', '--machine', 'peers', PEERS);
  await orq('config', 'set', '--machine', 'cap', '16');
  const self = JSON.parse((await orq('peers', '--self')).out);
  assert.deepEqual([self.host, self.held, self.cap, self.active, self.free, self.pressure.io], ['cortex', true, 16, 0, 0, 72]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'home', 'peers', 'self.json'), 'utf8')), self);
  assert.deepEqual(asked, []);
});

test('a machine with nothing configured and facts without pressure shows no extra status line', async (t) => {
  const { orq } = await machine(t, { readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }) });
  assert.doesNotMatch((await orq('status')).out, /^(pressure|protect|peers):/m);
  assert.equal((await orq('peers')).out, 'pressure: not read; no protected services; no peers\n');
});
