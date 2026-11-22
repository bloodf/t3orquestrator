// The machine's routing policy, laid over the registry as routing sees it (never stored). Pure.
//   freeModels: model ids that cost nothing (hosted free tiers): routed first among eligible candidates.
//   excludeModels: model ids never routed (local models, by default).
//   decisionOnly: model ids kept for `decide`: too expensive for any other job.
//   instanceFamilies: the model families an instance may run (T3 lists others on some of them).
//   preferInstances: instance ids (regular expressions) routed first among eligible candidates, before free models.
//   creditInstances: instance ids (regular expressions) that may run past their usage windows on paid credits.
export const DEFAULT_FREE = [':free$'];
export const DEFAULT_EXCLUDE = ['^ollama-local/'];
export const DEFAULT_DECISION_ONLY = ['(^|[/-])astra($|[-/:])', '(^|[/-])fable($|[-/:])']; // a name part, not a substring
export const DEFAULT_INSTANCE_FAMILIES = { antigravity: ['google'], 'antigravity-2': ['google'] };

const matcher = (list) => {
  const res = list.map((s) => new RegExp(s, 'i'));
  return (id) => res.some((re) => re.test(id));
};

// the families `instance` may run, or null for any; an instance id containing `antigravity` runs google models
export function allowedFamilies(instance, map = {}) {
  const all = { ...DEFAULT_INSTANCE_FAMILIES, ...map };
  if (Object.hasOwn(all, instance)) return all[instance];
  return /antigravity/i.test(instance) ? ['google'] : null;
}

export const creditMatcher = (machine) => matcher(machine?.creditInstances ?? []);

export function withPolicy(registry, machine = {}) {
  const free = matcher(machine.freeModels ?? DEFAULT_FREE);
  const excluded = matcher(machine.excludeModels ?? DEFAULT_EXCLUDE);
  const decision = matcher(machine.decisionOnly ?? DEFAULT_DECISION_ONLY);
  const families = Object.fromEntries(Object.keys(registry.instances).map((id) => [id, allowedFamilies(id, machine.instanceFamilies)]));
  const preferred = matcher(machine.preferInstances ?? []);
  const flag = (m) => {
    const marks = {
      free: free(m.model), preferred: preferred(m.instance), excluded: excluded(m.model), decisionOnly: decision(m.model), familyBlocked: Boolean(families[m.instance]) && !families[m.instance].includes(m.family),
    };
    return { ...m, ...Object.fromEntries(Object.entries(marks).filter(([, v]) => v)) };
  };
  return {
    ...registry,
    instances: Object.fromEntries(Object.entries(registry.instances).map(([id, i]) => [id, families[id] ? { ...i, families: families[id] } : i])),
    models: Object.fromEntries(Object.entries(registry.models).map(([k, m]) => [k, flag(m)])),
  };
}

// Machine config keys: lists of regular expressions on the model id (on the instance id for creditInstances and preferInstances), and instanceFamilies.
export const POLICY_KEYS = ['freeModels', 'excludeModels', 'decisionOnly', 'instanceFamilies', 'creditInstances', 'preferInstances'];
const FAMILIES = 'instanceFamilies must be a JSON object of instance ids to lists of families';

function checkList(key, list) {
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && s !== '')) throw new Error(`${key} must be a list of regular expressions`);
  for (const s of list) {
    try { new RegExp(s, 'i'); } catch { throw new Error(`${key}: "${s}" is not a valid regular expression`); }
  }
  return list;
}

function checkFamilies(map) {
  const ok = map !== null && typeof map === 'object' && !Array.isArray(map)
    && Object.values(map).every((l) => Array.isArray(l) && l.every((f) => typeof f === 'string' && f !== ''));
  if (!ok) throw new Error(FAMILIES);
  return map;
}

// A stored value: why it is invalid, or null.
export function policyError(c) {
  try {
    for (const k of POLICY_KEYS) if (c[k] !== undefined) (k === 'instanceFamilies' ? checkFamilies : (v) => checkList(k, v))(c[k]);
    return null;
  } catch (e) {
    return e.message;
  }
}

// `orq config set --machine <key> <value>`: a JSON value, or for a list a comma-separated one
export function parsePolicyValue(key, value) {
  const json = /^\s*[[{]/.test(value);
  let v;
  try {
    v = json ? JSON.parse(value) : value.split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    throw new Error(key === 'instanceFamilies' ? FAMILIES : `${key} must be a JSON list or a comma-separated list`);
  }
  return key === 'instanceFamilies' ? checkFamilies(json ? v : null) : checkList(key, v);
}
