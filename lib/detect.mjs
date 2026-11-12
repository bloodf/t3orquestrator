// Capability slots resolve to ordered fallback chains that always end in a built-in path.
import fs from 'node:fs';
import path from 'node:path';

export const SLOTS = ['judge', 'memory', 'code-index', 'git-host'];

const BUILTIN = {
  judge: { name: 'self', kind: 'builtin', use: 'Decide it yourself.' },
  memory: { name: 'file', kind: 'builtin', use: 'Append to and read .orq/memory.md.' },
  'code-index': { name: 'search', kind: 'builtin', use: 'Use plain text search.' },
  'git-host': { name: 'local', kind: 'builtin', use: 'Keep the integration branch local and report it.' },
};

function validateEntry(e, i) {
  const at = `catalog entry ${i}`;
  if (!SLOTS.includes(e?.slot)) throw new Error(`${at}: slot must be one of ${SLOTS.join(', ')}`);
  for (const k of ['name', 'use']) {
    if (typeof e[k] !== 'string' || e[k] === '') throw new Error(`${at}: ${k} must be a non-empty string`);
  }
  const d = e.detect;
  const hasCommand = typeof d?.command === 'string' && d.command !== '';
  const hasMcp = typeof d?.mcpTool === 'string' && d.mcpTool !== '';
  if (hasCommand === hasMcp) throw new Error(`${at}: detect needs exactly one of command or mcpTool`);
  if (hasMcp) {
    try {
      new RegExp(d.mcpTool);
    } catch (err) {
      throw new Error(`${at}: detect.mcpTool is not a valid regex: ${err.message}`);
    }
  }
}

export function loadCatalog({ kitCatalog, userCatalog }) {
  for (const [name, list] of [['kitCatalog', kitCatalog], ['userCatalog', userCatalog]]) {
    if (!Array.isArray(list)) throw new Error(`${name} must be an array`);
  }
  const seen = new Set();
  return [...userCatalog, ...kitCatalog].filter((e, i) => {
    validateEntry(e, i);
    const id = `${e.slot}/${e.name}`;
    return seen.has(id) ? false : seen.add(id);
  });
}

export function defaultWhich(cmd, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter).filter((d) => d !== '' && path.isAbsolute(d))) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here; keep scanning
    }
  }
  return null;
}

export function resolveSlots({ catalog, which, toolNames, keep = [] }) {
  const out = {};
  for (const slot of SLOTS) {
    const found = catalog.filter((e) => e.slot === slot).flatMap((e) => {
      const { command, mcpTool } = e.detect;
      if (command) return which(command) ? [{ name: e.name, kind: 'command', use: e.use }] : [];
      const seen = keep.includes(e.name) || toolNames.some((t) => new RegExp(mcpTool).test(t));
      return seen ? [{ name: e.name, kind: 'mcp', use: e.use }] : [];
    });
    out[slot] = [...found, { ...BUILTIN[slot] }];
  }
  return out;
}

function packageChecks(files) {
  let pkg;
  try {
    pkg = JSON.parse(files.readFile('package.json'));
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${e.message}`);
  }
  const lock = [
    ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn', 'yarn install --immutable'],
    ['bun.lock', 'bun', 'bun install --frozen-lockfile'],
    ['bun.lockb', 'bun', 'bun install --frozen-lockfile'],
    ['package-lock.json', 'npm', 'npm ci'],
  ].find(([f]) => files.exists(f));
  const pm = lock ? lock[1] : 'npm';
  const present = ['lint', 'typecheck', 'test', 'build'].filter((s) => pkg?.scripts?.[s] !== undefined);
  return {
    setup: lock ? lock[2] : null,
    unit: null,
    full: present.length ? present.map((s) => `${pm} run ${s}`).join(' && ') : null,
  };
}

export function detectChecks(files) {
  const none = { setup: null, unit: null, full: null };
  const full = (cmd) => ({ ...none, full: cmd });
  if (files.exists('package.json')) return packageChecks(files);
  if (files.exists('Cargo.toml')) return full('cargo test');
  if (files.exists('go.mod')) return full('go test ./...');
  if (files.exists('Makefile') && /^test:/m.test(files.readFile('Makefile'))) return full('make test');
  if (files.exists('pyproject.toml') && /pytest/.test(files.readFile('pyproject.toml'))) return full('python -m pytest');
  return none;
}
