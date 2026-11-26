// Free bytes and free inodes of the filesystems agents write to: orq's home, T3's worktrees, the temp dir and the
// pnpm/bun stores (plus machine config `storageRoots`). A filesystem under its limit holds new launches, like pressure,
// and `orq wait` starts one cleanup run (maint/). Machine config `storage` overrides the limits; `false` turns it off.
//   bytes, inodes: the free share in percent under which the machine holds (default 10 each)
//   release: a filesystem that held keeps holding until its free share is back over limit / release (hysteresis)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './paths.mjs';

export const DEFAULT_STORAGE = Object.freeze({ bytes: 10, inodes: 10, release: 0.8 });

const pct = (part, whole) => Math.round((1000 * part) / whole) / 10; // one decimal

// The directories to measure: each that exists, once per filesystem (the first path named for it).
export function storageRoots(env = process.env, machine = {}, { home = os.homedir(), platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  const t3 = machine.t3Home ?? path.join(home, '.t3');
  const pnpmHome = env.PNPM_HOME ?? (platform === 'darwin' ? path.join(home, 'Library', 'pnpm') : path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'pnpm'));
  return [
    homeDir(env), path.join(t3, 'worktrees'), env.TMPDIR || tmpdir,
    env.npm_config_store_dir || path.join(pnpmHome, 'store'),
    env.BUN_INSTALL_CACHE_DIR || path.join(env.BUN_INSTALL ?? path.join(home, '.bun'), 'install', 'cache'),
    ...(Array.isArray(machine.storageRoots) ? machine.storageRoots : []),
  ];
}

const defaults = { statfs: (p) => fs.statfsSync(p), stat: (p) => fs.statSync(p) };

// -> [{path, freeBytes, bytesPct, freeInodes?, inodesPct?}], one per filesystem. A root that cannot be read is left
// out. A filesystem that reports no inode table (btrfs, some network mounts: files 0) has no inode numbers.
export function readStorage(roots, deps = {}) {
  const d = { ...defaults, ...deps };
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    try {
      const dev = d.stat(root).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const s = d.statfs(root);
      if (!(s.blocks > 0)) continue;
      const fsInfo = { path: root, freeBytes: s.bavail * s.bsize, bytesPct: pct(s.bavail, s.blocks) };
      out.push(s.files > 0 ? { ...fsInfo, freeInodes: s.ffree, inodesPct: pct(s.ffree, s.files) } : fsInfo);
    } catch { /* missing or unreadable: not judged */ }
  }
  return out;
}

const KINDS = [['bytes', 'bytesPct', 'space'], ['inodes', 'inodesPct', 'inodes']];

// holding: what held on the last poll ("bytes:<path>", "inodes:<path>"); each keeps holding until its free share is
// over limit / release. -> {held, holding, reasons}
export function judgeStorage(list, config = {}, holding = []) {
  if (config === false || !Array.isArray(list)) return { held: false, holding: [], reasons: [] };
  const limits = { ...DEFAULT_STORAGE, ...config };
  const was = new Set(Array.isArray(holding) ? holding : []);
  const now = [];
  const reasons = [];
  for (const f of list) {
    for (const [kind, field, word] of KINDS) {
      const key = `${kind}:${f.path}`;
      const at = was.has(key) ? limits[kind] / limits.release : limits[kind];
      if (!(Number.isFinite(f[field]) && f[field] < at)) continue;
      now.push(key);
      reasons.push(`disk ${f.path}: ${f[field]}% ${word} free (limit ${limits[kind]}%${f[field] >= limits[kind] ? `, releases over ${Math.round(at * 10) / 10}%` : ''})`);
    }
  }
  return { held: now.length > 0, holding: now, reasons };
}

// The least free share over every filesystem, for the published status: {bytesPct, inodesPct}, either may be missing.
export function storageSummary(list) {
  const least = (field) => {
    const v = (list ?? []).map((f) => f[field]).filter(Number.isFinite);
    return v.length ? Math.min(...v) : undefined;
  };
  return Object.fromEntries([['bytesPct', least('bytesPct')], ['inodesPct', least('inodesPct')]].filter(([, v]) => v !== undefined));
}

// A stored `storage` value: why it is invalid, or null.
export function storageError(v) {
  if (v === undefined || v === false) return null;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'storage must be false or an object of limits';
  for (const [k, n] of Object.entries(v)) {
    if (!Object.hasOwn(DEFAULT_STORAGE, k)) return `storage: unknown key "${k}"; valid keys: ${Object.keys(DEFAULT_STORAGE).join(', ')}`;
    if (!(Number.isFinite(n) && n > 0)) return `storage: ${k} must be a positive number`;
  }
  if (v.release !== undefined && v.release > 1) return 'storage: release must be over 0 and at most 1';
  return ['bytes', 'inodes'].some((k) => v[k] !== undefined && v[k] >= 100) ? 'storage: bytes and inodes are percents under 100' : null;
}

// A stored `storageRoots` value: why it is invalid, or null.
export function storageRootsError(v) {
  if (v === undefined) return null;
  return Array.isArray(v) && v.every((p) => typeof p === 'string' && path.isAbsolute(p)) ? null : 'storageRoots must be a list of absolute paths';
}
