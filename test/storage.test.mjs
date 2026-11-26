import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  judgeStorage, readStorage, storageError, storageRoots, storageRootsError, storageSummary,
} from '../lib/storage.mjs';
import { admission, machineAdmission } from '../lib/admission.mjs';
import { cleanStatus, peerText, selfPath } from '../lib/peers.mjs';
import { setConfigValue } from '../lib/config.mjs';

const NOW = 1_800_000_000_000;

// statfs answers per path: blocks/bavail in 4 KiB blocks, files/ffree inodes
const disk = (dev, freeBlocksPct, freeInodesPct, files = 1000) => ({
  dev, s: { bsize: 4096, blocks: 1000, bavail: freeBlocksPct * 10, files, ffree: (freeInodesPct * files) / 100 },
});
function fakeFs(table) {
  return {
    stat: (p) => { if (!table[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { dev: table[p].dev }; },
    statfs: (p) => table[p].s,
  };
}

test('readStorage: free bytes and inodes once per filesystem; a missing root or one with no inode table is handled', () => {
  const table = {
    '/h/.t3orq': disk(1, 40, 50), '/h/.t3/worktrees': disk(1, 40, 50), '/tmp': disk(2, 50, 3), '/btrfs': disk(3, 20, 0, 0),
  };
  const list = readStorage(['/h/.t3orq', '/h/.t3/worktrees', '/tmp', '/gone', '/btrfs'], fakeFs(table));
  assert.deepEqual(list, [
    {
      path: '/h/.t3orq', freeBytes: 400 * 4096, bytesPct: 40, freeInodes: 500, inodesPct: 50,
    },
    {
      path: '/tmp', freeBytes: 500 * 4096, bytesPct: 50, freeInodes: 30, inodesPct: 3,
    },
    { path: '/btrfs', freeBytes: 200 * 4096, bytesPct: 20 },
  ]);
  assert.deepEqual(storageSummary(list), { bytesPct: 20, inodesPct: 3 });
  assert.deepEqual(storageSummary([]), {});
});

test('readStorage reads a real directory', async () => {
  const [f] = readStorage([os.tmpdir()]);
  assert.equal(f.path, os.tmpdir());
  assert.ok(f.freeBytes > 0 && f.bytesPct > 0 && f.bytesPct <= 100);
});

test('storageRoots: orq home, T3 worktrees, temp dir, pnpm and bun stores, and configured extras', () => {
  const env = { T3ORQ_HOME: '/h/orq', TMPDIR: '/h/.cache/agent-tmp' };
  assert.deepEqual(storageRoots(env, { storageRoots: ['/srv/work'] }, { home: '/h', platform: 'linux', tmpdir: '/tmp' }), [
    '/h/orq', '/h/.t3/worktrees', '/h/.cache/agent-tmp', '/h/.local/share/pnpm/store', '/h/.bun/install/cache', '/srv/work',
  ]);
  const mac = storageRoots({ T3ORQ_HOME: '/h/orq', npm_config_store_dir: '/s/pnpm' }, { t3Home: '/h/t3' }, { home: '/h', platform: 'darwin', tmpdir: '/var/folders/x' });
  assert.deepEqual(mac, ['/h/orq', '/h/t3/worktrees', '/var/folders/x', '/s/pnpm', '/h/.bun/install/cache']);
});

test('judgeStorage holds under 10% free bytes or inodes, keeps holding through the release band, and can be turned off', () => {
  const list = [{ path: '/tmp', bytesPct: 50, inodesPct: 3 }, { path: '/', bytesPct: 9.5, inodesPct: 60 }];
  const j = judgeStorage(list);
  assert.deepEqual(j.holding, ['inodes:/tmp', 'bytes:/']);
  assert.deepEqual(j.reasons, ['disk /tmp: 3% inodes free (limit 10%)', 'disk /: 9.5% space free (limit 10%)']);
  const band = judgeStorage([{ path: '/tmp', inodesPct: 11 }], {}, j.holding); // over 10, under 10 / 0.8
  assert.deepEqual(band.reasons, ['disk /tmp: 11% inodes free (limit 10%, releases over 12.5%)']);
  assert.equal(judgeStorage([{ path: '/tmp', inodesPct: 13 }], {}, j.holding).held, false);
  assert.equal(judgeStorage([{ path: '/tmp', inodesPct: 11 }]).held, false); // not held before: 11% is fine
  assert.equal(judgeStorage(list, false).held, false);
  assert.equal(judgeStorage(list, { bytes: 5, inodes: 2 }).held, false);
  assert.equal(judgeStorage(undefined).held, false);
});

test('storage config values are checked', () => {
  assert.equal(storageError(undefined), null);
  assert.equal(storageError(false), null);
  assert.equal(storageError({ bytes: 15, release: 0.9 }), null);
  assert.match(storageError({ disk: 1 }), /unknown key "disk"/);
  assert.match(storageError({ bytes: 0 }), /positive number/);
  assert.match(storageError({ inodes: 100 }), /under 100/);
  assert.match(storageError({ release: 2 }), /release/);
  assert.match(storageError([]), /false or an object/);
  assert.equal(storageRootsError(['/srv/work']), null);
  assert.match(storageRootsError(['rel']), /absolute/);
  const m = setConfigValue({ perInstanceLimit: 2 }, 'storage', '{"inodes":15}', 'machine');
  assert.deepEqual(m.storage, { inodes: 15 });
  assert.throws(() => setConfigValue({}, 'storage', '{"x":1}', 'machine'), /unknown key/);
  assert.deepEqual(setConfigValue({}, 'storageRoots', '["/srv/work"]', 'machine').storageRoots, ['/srv/work']);
  assert.equal(setConfigValue({}, 'storage', 'false', 'machine').storage, false);
});

async function context(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ctx = { env: { T3ORQ_HOME: dir }, clock: NOW };
  ctx.now = () => ctx.clock;
  ctx.deps = { hostname: () => 'host-1', readMachine: () => ({ cores: 8, load1: 0, availableMemBytes: 8 * 1024 ** 3 }) };
  return ctx;
}

test('admission: a low disk holds new launches only (gates drain), is published to peers, and keeps the release band', async (t) => {
  const ctx = await context(t);
  const go = (storage) => admission(ctx, {
    machine: {}, facts: { cores: 8, load1: 0, pressure: {} }, cap: 4, active: 1, storage,
  });
  const ok = await go([{ path: '/tmp', bytesPct: 50, inodesPct: 40 }]);
  assert.deepEqual([ok.held, ok.storageHeld], [false, false]);
  const low = await go([{ path: '/tmp', bytesPct: 50, inodesPct: 4 }]);
  assert.deepEqual([low.held, low.storageHeld, low.protectHeld, low.status.free], [true, true, false, 0]);
  assert.deepEqual(low.reasons, ['disk /tmp: 4% inodes free (limit 10%)']);
  const published = JSON.parse(await fs.readFile(selfPath(ctx.env), 'utf8'));
  assert.deepEqual([published.storage, published.holding], [{ bytesPct: 50, inodesPct: 4 }, ['inodes:/tmp']]);
  const peer = cleanStatus(published);
  assert.deepEqual(peer.storage, { bytesPct: 50, inodesPct: 4 }); // numbers only: no path reaches a peer
  assert.equal(peerText({ host: 'h', ok: true, status: { ...peer, at: NOW } }, NOW), 'h HELD free=0/4 load=0.0/core disk=50%free inodes=4%free');
  ctx.clock += 1000;
  assert.equal((await go([{ path: '/tmp', bytesPct: 50, inodesPct: 11 }])).held, true); // release band
  assert.equal((await go([{ path: '/tmp', bytesPct: 50, inodesPct: 20 }])).held, false);
});

test('machineAdmission reads the storage roots, and storage false reads nothing', async (t) => {
  const ctx = await context(t);
  const asked = [];
  ctx.deps.readStorage = (roots) => { asked.push(roots); return [{ path: roots[0], bytesPct: 2 }]; };
  const a = await machineAdmission(ctx, { perInstanceLimit: 2 });
  assert.equal(asked[0][0], ctx.env.T3ORQ_HOME);
  assert.equal(a.storageHeld, true);
  const off = await machineAdmission(ctx, { perInstanceLimit: 2, storage: false });
  assert.deepEqual([asked.length, off.storageHeld], [1, false]);
});
