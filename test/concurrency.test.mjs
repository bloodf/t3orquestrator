import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ORQ = fileURLToPath(new URL('../bin/orq.mjs', import.meta.url));

test('two processes adding models concurrently lose nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-conc-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify({
    version: 1, syncedAt: 1, models: {},
    instances: { a: { driverKind: 'k', displayName: 'a', enabled: true, constraints: [], limit: null, failures: 0, cooldownUntil: null, lastSeenAt: 1 } },
  }));
  const chain = async (tag) => {
    for (let i = 0; i < 20; i += 1) {
      await run(process.execPath, [ORQ, 'model', 'add', 'a', `m-${tag}-${i}`, '--tier', '2'], { cwd, env: { ...process.env, T3ORQ_HOME: home } });
    }
  };
  await Promise.all([chain('x'), chain('y')]);
  const reg = JSON.parse(await fs.readFile(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(Object.keys(reg.models).length, 40);
});
