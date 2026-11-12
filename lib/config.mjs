// Machine and project config: defaults, validation, and whitelisted edits. Pure apart from the loaders.
import { readJson } from './store.mjs';

export const AUTONOMY = ['draft', 'review-fix', 'review-fix-merge'];
const MACHINE_KEYS = ['cap', 'perInstanceLimit'];
const SCHEDULER_KEYS = ['pollSeconds', 'stallMinutes', 'gateConcurrency', 'leaseTtlMinutes'];
const PROJECT_KEYS = ['autonomy', 'base', 'checks.setup', 'checks.unit', 'checks.full', ...SCHEDULER_KEYS];
const INT_KEYS = ['cap', 'perInstanceLimit', ...SCHEDULER_KEYS];
const CHECK_NAMES = ['setup', 'unit', 'full'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;
const isNullableString = (v) => v === null || typeof v === 'string';

function fail(file, what) {
  throw new Error(`invalid config ${file}: ${what}`);
}

function validateMachine(c, file) {
  if (c.cap !== undefined && !isPositiveInt(c.cap)) fail(file, 'cap must be a positive integer');
  if (!isPositiveInt(c.perInstanceLimit)) fail(file, 'perInstanceLimit must be a positive integer');
  return c;
}

function validateProject(c, file) {
  if (c.autonomy !== null && !AUTONOMY.includes(c.autonomy)) fail(file, `autonomy must be null or one of ${AUTONOMY.join(', ')}`);
  if (typeof c.base !== 'string' || c.base === '') fail(file, 'base must be a non-empty string');
  if (!isObject(c.checks)) fail(file, 'checks must be an object');
  for (const k of CHECK_NAMES) {
    if (!isNullableString(c.checks[k])) fail(file, `checks.${k} must be a string or null`);
  }
  if (!isObject(c.slots)) fail(file, 'slots must be an object');
  for (const k of SCHEDULER_KEYS) {
    if (c[k] !== undefined && !isPositiveInt(c[k])) fail(file, `${k} must be a positive integer`);
  }
  const t = c.t3;
  if (t !== null && !(isObject(t) && typeof t.bin === 'string' && typeof t.version === 'string')) {
    fail(file, 't3 must be null or {bin, version}');
  }
  return c;
}

async function load(file, defaults, validate) {
  const raw = await readJson(file, {});
  if (!isObject(raw)) fail(file, 'expected an object');
  return validate({ ...defaults, ...raw, ...('checks' in defaults && isObject(raw.checks) ? { checks: { ...defaults.checks, ...raw.checks } } : {}) }, file);
}

export const loadMachineConfig = (file) => load(file, { perInstanceLimit: 2 }, validateMachine);

export const loadProjectConfig = (file) => load(file, {
  autonomy: null, base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null,
}, validateProject);

function parseValue(key, value) {
  const nullable = key === 'autonomy' || key === 'cap' || key.startsWith('checks.');
  if (value === 'null') {
    if (!nullable) throw new Error(`${key} cannot be cleared`);
    return null;
  }
  if (key === 'autonomy') {
    if (!AUTONOMY.includes(value)) throw new Error(`autonomy must be null or one of ${AUTONOMY.join(', ')}`);
    return value;
  }
  if (INT_KEYS.includes(key)) {
    const n = Number(value);
    if (!isPositiveInt(n)) throw new Error(`${key} must be a positive integer, got ${value}`);
    return n;
  }
  if (value === '') throw new Error(`${key} must not be empty`);
  return value;
}

export function setConfigValue(config, key, value, scope) {
  const valid = scope === 'machine' ? MACHINE_KEYS : PROJECT_KEYS;
  if (!valid.includes(key)) throw new Error(`unknown ${scope} config key "${key}"; valid keys: ${valid.join(', ')}`);
  const v = parseValue(key, value);
  if (key.startsWith('checks.')) return { ...config, checks: { ...config.checks, [key.slice(7)]: v } };
  if (v === null && scope === 'machine') {
    const { [key]: _drop, ...rest } = config;
    return rest;
  }
  return { ...config, [key]: v };
}
