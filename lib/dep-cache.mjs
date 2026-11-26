// Install once: a gate whose `checks.setup` is only pnpm installs gets its node_modules as a private copy of the ones
// an earlier gate installed for the same inputs, instead of installing again. The copy is a clone (`cp -c` on APFS,
// `cp --reflink=always` on Linux), so it costs no data blocks and the gate may write to it freely. Where the
// filesystem cannot clone (ext4), nothing is cached: a full copy would cost more disk and inodes than pnpm's
// hardlinks from its store. The key hashes every input of the install: the blob ids of the commit's package.json
// files, pnpm lockfiles, workspace and .npmrc/.pnpmfile files and patches, the setup command, NODE_ENV, node and
// pnpm versions, platform and arch. Entries are published atomically (rename of a finished directory) and the
// newest KEEP of them are kept. Machine config `depCache false` turns it off.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const KEEP = 4;
const FRESH_MS = 60 * 60_000; // an entry this young is never pruned: a gate may be cloning from it
const INPUTS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs']);
const SAFE = '[\\w./@+-]+';
const CD = new RegExp(`^cd\\s+${SAFE}$`);
const INSTALL = new RegExp(`^(?:[A-Z_][A-Z0-9_]*=${SAFE}\\s+)*pnpm(?:\\s+(?:-C|--dir)\\s+${SAFE})?\\s+(?:install|i)(?:\\s+--?[\\w-]+(?:=${SAFE})?)*$`);

// Is the setup command nothing but pnpm installs (joined by &&, with `cd <dir>` between)? Only then may it be skipped:
// anything else it does (a build, a code generator) would be skipped with it.
export function onlyPnpmInstalls(setup) {
  if (typeof setup !== 'string') return false;
  const parts = setup.split('&&').map((p) => p.trim());
  return parts.some((p) => INSTALL.test(p)) && parts.every((p) => INSTALL.test(p) || CD.test(p));
}

const isInput = (file) => INPUTS.has(path.posix.basename(file)) || /(^|\/)patches\//.test(file);

// lsTree: `git ls-tree -r --full-tree <sha>` output. -> hex key
export function cacheKey({
  lsTree, setup, nodeEnv = '', node, pnpm, platform = process.platform, arch = process.arch,
}) {
  const files = String(lsTree).split('\n').filter((l) => l && isInput(l.slice(l.indexOf('\t') + 1)));
  const h = createHash('sha256');
  for (const part of [`v1\n${setup}\n${nodeEnv}\n${node}\n${pnpm}\n${platform}-${arch}\n`, ...files.map((l) => `${l}\n`)]) h.update(part);
  return h.digest('hex');
}

// The node_modules directories of a checkout, relative, skipping .git and anything inside a node_modules.
export function findModules(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === '.orq') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') out.push(child);
      else walk(child);
    }
  };
  walk('');
  return out.sort();
}

// A clone of src at dst (dst must not exist), or false. null when this platform has no clone copy.
export function defaultClone(platform = process.platform) {
  const args = { darwin: ['-c', '-R'], linux: ['-R', '--reflink=always'] }[platform];
  if (!args) return null;
  return (src, dst) => spawnSync('cp', [...args, src, dst], { stdio: 'ignore', timeout: 10 * 60_000 }).status === 0;
}

const sameDevice = (a, b) => {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
};

// Drop entries past the newest KEEP (and leftover temp directories), never one younger than FRESH_MS.
function prune(root, now) {
  const list = fs.readdirSync(root).map((name) => {
    try {
      return { name, mtime: fs.statSync(path.join(root, name)).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const entries = list.filter((e) => !e.name.startsWith('.')).sort((a, b) => b.mtime - a.mtime);
  const old = [...entries.slice(KEEP), ...list.filter((e) => e.name.startsWith('.tmp-'))].filter((e) => now - e.mtime > FRESH_MS);
  for (const e of old) fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
}

// keyOf(dir) -> key or null (computed in the checkout: corepack picks pnpm's version there). clone: defaultClone().
// -> {restore(dir), publish(dir)}: restore says whether the checkout got its node_modules from the cache; neither throws.
export function createDepCache({
  root, keyOf, clone = defaultClone(), now = Date.now, log = () => {},
}) {
  let key = null;
  const usable = (dir) => {
    if (!clone) return false;
    fs.mkdirSync(root, { recursive: true });
    if (!sameDevice(root, dir)) return false; // a clone cannot cross filesystems
    key ??= keyOf(dir);
    return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);
  };
  return {
    get key() { return key; },
    restore(dir) {
      const placed = [];
      try {
        if (!usable(dir)) return false;
        const entry = path.join(root, key);
        const manifest = JSON.parse(fs.readFileSync(path.join(entry, 'manifest.json'), 'utf8'));
        if (!Array.isArray(manifest.dirs) || manifest.dirs.length === 0) return false;
        for (const rel of manifest.dirs) {
          const dst = path.join(dir, rel);
          if (rel.split('/').includes('..') || fs.existsSync(dst)) throw new Error(`cannot place ${rel}`);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          if (!clone(path.join(entry, 'tree', rel), dst)) throw new Error(`clone of ${rel} failed`);
          placed.push(dst);
        }
        const t = new Date(now());
        fs.utimesSync(entry, t, t); // the newest entries are the ones kept
        return true;
      } catch (e) {
        if (e.code !== 'ENOENT') log(`install cache not used: ${e.message}`);
        for (const p of placed) fs.rmSync(p, { recursive: true, force: true }); // setup installs from scratch
        return false;
      }
    },
    publish(dir) {
      let tmp = null;
      try {
        if (!usable(dir)) return false;
        const entry = path.join(root, key);
        if (fs.existsSync(entry)) return false;
        const dirs = findModules(dir);
        if (dirs.length === 0) return false;
        tmp = path.join(root, `.tmp-${key.slice(0, 12)}-${process.pid}-${randomBytes(4).toString('hex')}`);
        for (const rel of dirs) {
          fs.mkdirSync(path.dirname(path.join(tmp, 'tree', rel)), { recursive: true });
          if (!clone(path.join(dir, rel), path.join(tmp, 'tree', rel))) throw new Error(`clone of ${rel} failed`);
        }
        fs.writeFileSync(path.join(tmp, 'manifest.json'), `${JSON.stringify({ dirs, at: now() })}\n`);
        fs.renameSync(tmp, entry); // another gate that published the same key first wins: this rename fails
        tmp = null;
        prune(root, now());
        return true;
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) log(`install cache not written: ${e.message}`);
        return false;
      } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

// The real key: the commit's install inputs from git, and node and pnpm as the step's shell would find them.
export function realKeyOf({
  git, repo, sha, setup, env = process.env, exec = execFileSync,
}) {
  return (dir) => {
    const version = (cmd) => String(exec(cmd, ['--version'], {
      cwd: dir, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    try {
      return cacheKey({
        lsTree: git.raw(repo, ['ls-tree', '-r', '--full-tree', sha]), setup, nodeEnv: env.NODE_ENV ?? '', node: version('node'), pnpm: version('pnpm'),
      });
    } catch {
      return null; // no pnpm, no node: no cache, setup runs as always
    }
  };
}
