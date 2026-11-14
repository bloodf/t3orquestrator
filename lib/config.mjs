// Machine and project config: defaults, validation, and whitelisted edits. Pure apart from the loaders.
import { readJson } from './store.mjs';
import { validSharePath } from './share.mjs';
import { cleanGoal, MAX_GOAL } from './goal.mjs';

export const AUTONOMY = ['draft', 'review-fix', 'review-fix-merge'];
export const QUESTIONS = ['auto', 'user']; // auto: `orq ask` lets the strongest model decide; user: the user does
const MACHINE_KEYS = ['cap', 'perInstanceLimit'];
const SCHEDULER_KEYS = ['pollSeconds', 'stallMinutes', 'gateConcurrency', 'leaseTtlMinutes'];
const PROJECT_KEYS = ['autonomy', 'base', 'cap', 'checks.setup', 'checks.unit', 'checks.full', ...SCHEDULER_KEYS, 'questions', 'share', 'goal'];
const INT_KEYS = ['cap', 'perInstanceLimit', ...SCHEDULER_KEYS];
const CHECK_NAMES = ['setup', 'unit', 'full'];
// every poll runs t3 once plus once per running thread: faster polling only loads the machine
export const MIN_POLL_SECONDS = 5;

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
  if (!QUESTIONS.includes(c.questions)) fail(file, `questions must be one of ${QUESTIONS.join(', ')}`);
  // share: dependency directories worktrees link from the main checkout; null = off, unset = `orq init` detects
  if (c.share !== undefined && c.share !== null && !(Array.isArray(c.share) && c.share.every(validSharePath))) {
    fail(file, 'share must be null or a list of relative paths inside the repository');
  }
  // the playbook each orchestrator thread has read (`playbooks`, by thread id), recorded by `orq init` and `orq sync`;
  // `playbook` is the single record of the previous version, still read
  const isMark = (pb) => isObject(pb) && typeof pb.hash === 'string' && (pb.kit === undefined || typeof pb.kit === 'string');
  if (c.playbook !== undefined && !isMark(c.playbook)) fail(file, 'playbook must be {hash, kit?}');
  if (c.playbooks !== undefined && !(isObject(c.playbooks) && Object.values(c.playbooks).every(isMark))) {
    fail(file, 'playbooks must map thread ids to {hash, kit?, at}');
  }
  const o = c.orchestrator; // the orchestrator's own model, recorded by `orq sync`
  if (o !== undefined && !(isObject(o) && typeof o.instance === 'string' && typeof o.model === 'string'
    && (o.threadId === undefined || typeof o.threadId === 'string'))) {
    fail(file, 'orchestrator must be {instance, model, threadId?}');
  }
  // cap: this project's own thread limit, under the machine cap (unset or null: none)
  if (c.cap !== undefined && c.cap !== null && !isPositiveInt(c.cap)) fail(file, 'cap must be a positive integer');
  // goal: the standing goal, one clean line (unset: none)
  if (c.goal !== undefined && !(typeof c.goal === 'string' && c.goal !== '' && c.goal.length <= MAX_GOAL && cleanGoal(c.goal) === c.goal)) {
    fail(file, `goal must be one clean line of 1 to ${MAX_GOAL} characters`);
  }
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
  // a value from before the floor existed is read as the floor, not refused
  return c.pollSeconds < MIN_POLL_SECONDS ? { ...c, pollSeconds: MIN_POLL_SECONDS } : c;
}

async function load(file, defaults, validate) {
  const stored = await readJson(file, {});
  if (!isObject(stored)) fail(file, 'expected an object');
  const { goal, ...withoutGoal } = stored;
  const read = goal === null ? withoutGoal : stored; // a cleared goal means none
  const { questions, ...rest } = read;
  const raw = questions === null ? rest : read; // a cleared key means the default
  return validate({ ...defaults, ...raw, ...('checks' in defaults && isObject(raw.checks) ? { checks: { ...defaults.checks, ...raw.checks } } : {}) }, file);
}

export const loadMachineConfig = (file) => load(file, { perInstanceLimit: 2 }, validateMachine);

export const loadProjectConfig = (file) => load(file, {
  autonomy: null, questions: 'auto', base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null,
}, validateProject);

function parseValue(key, value) {
  const nullable = key === 'autonomy' || key === 'cap' || key === 'goal' || key === 'share' || SCHEDULER_KEYS.includes(key) || key.startsWith('checks.');
  if (value === 'null') {
    if (!nullable) throw new Error(`${key} cannot be cleared`);
    return null;
  }
  if (key === 'share') {
    const list = value.split(',').map((x) => x.trim()).filter((x) => x !== '');
    const bad = list.find((x) => !validSharePath(x));
    if (bad !== undefined) throw new Error(`share: "${bad}" must be a relative path inside the repository (not .git or .orq)`);
    return list;
  }
  if (key === 'goal') {
    const goal = cleanGoal(value);
    if (goal === '') throw new Error('goal must not be empty');
    if (goal.length > MAX_GOAL) throw new Error(`goal must be at most ${MAX_GOAL} characters, got ${goal.length}`);
    return goal;
  }
  if (key === 'questions') {
    if (!QUESTIONS.includes(value)) throw new Error(`questions must be one of ${QUESTIONS.join(', ')}`);
    return value;
  }
  if (key === 'autonomy') {
    if (!AUTONOMY.includes(value)) throw new Error(`autonomy must be null or one of ${AUTONOMY.join(', ')}`);
    return value;
  }
  if (INT_KEYS.includes(key)) {
    const n = Number(value);
    if (!isPositiveInt(n)) throw new Error(`${key} must be a positive integer, got ${value}`);
    if (key === 'pollSeconds' && n < MIN_POLL_SECONDS) {
      throw new Error(`pollSeconds must be at least ${MIN_POLL_SECONDS} (every poll runs t3 once, plus once per running thread), got ${value}`);
    }
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
  if (v === null && (scope === 'machine' || key === 'cap' || key === 'goal' || SCHEDULER_KEYS.includes(key))) { // unset: the default applies
    const { [key]: _drop, ...rest } = config;
    return rest;
  }
  return { ...config, [key]: v };
}
