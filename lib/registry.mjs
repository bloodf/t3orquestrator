// Registry of usable provider instances and models. Pure: plain objects in, new plain objects out.
import { suggest, outranks } from './tiers.mjs';

const NOT_REPORTED = 'not reported by T3';
const PLACEHOLDER = /<<[\s\S]*>>/;

export function emptyRegistry() {
  return { version: 1, syncedAt: null, instances: {}, models: {} };
}

// An instance may take automated work only when T3 reports it enabled and the user has not switched it off.
export const routable = (inst) => Boolean(inst?.enabled) && inst.userDisabled !== true;

export function setInstanceDisabled(registry, id, disabled) {
  if (!registry.instances[id]) throw new Error(`unknown instance ${id}`);
  return { ...registry, instances: { ...registry.instances, [id]: { ...registry.instances[id], userDisabled: disabled } } };
}

export function modelKey(instance, model) {
  return `${instance}::${model}`;
}

function hasPlaceholder(v) {
  if (typeof v === 'string') return PLACEHOLDER.test(v);
  if (v && typeof v === 'object') return Object.values(v).some(hasPlaceholder);
  return false;
}

export function validateCapabilities(caps) {
  if (!caps || typeof caps !== 'object' || !Array.isArray(caps.providers)) {
    throw new Error('capabilities must be an object with a providers array');
  }
  caps.providers.forEach((p, i) => {
    if (!p || typeof p.providerInstanceId !== 'string' || p.providerInstanceId === '') {
      throw new Error(`capabilities.providers[${i}].providerInstanceId must be a non-empty string`);
    }
    if (!Array.isArray(p.models)) throw new Error(`capabilities.providers[${i}].models must be an array`);
  });
  if (caps.providers.length === 0 || hasPlaceholder(caps)) {
    throw new Error('capabilities look truncated or compressed; read them again');
  }
}

function newModel(instance, model, source, suggestions) {
  return {
    instance, model, ...suggest(model, suggestions), source, available: true, confirmedAt: null,
    failures: 0, cooldownUntil: null, rejectedAt: null, lastUsedAt: null, outcomes: {},
  };
}

// Suggestions refresh family and tier unless a stronger source owns them.
function refresh(m, suggestions) {
  const s = suggest(m.model, suggestions);
  if (m.tierSource !== 'user') m.family = s.family;
  if (!outranks(m.tierSource, s.tierSource)) Object.assign(m, { tier: s.tier, tierSource: s.tierSource });
}

function mergeInstance(prev, p, now) {
  const constraints = p.constraints ?? [];
  return {
    driverKind: p.driverKind ?? null,
    displayName: p.displayName ?? p.providerInstanceId,
    enabled: constraints.length === 0,
    constraints: [...constraints],
    limit: prev?.limit ?? null,
    failures: prev?.failures ?? 0,
    cooldownUntil: prev?.cooldownUntil ?? null,
    lastSeenAt: now,
    ...(prev?.userDisabled === undefined ? {} : { userDisabled: prev.userDisabled }),
  };
}

function mergeModels(next, p, suggestions, diff) {
  const ids = [...new Set(p.models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean))];
  for (const id of ids) {
    const key = modelKey(p.providerInstanceId, id);
    const cur = next.models[key];
    if (!cur) {
      next.models[key] = newModel(p.providerInstanceId, id, 'capabilities', suggestions);
      diff.modelsAdded.push(key);
      continue;
    }
    if (cur.rejectedAt == null) cur.available = true;
    refresh(cur, suggestions);
  }
  if (ids.length === 0) return;
  for (const [key, m] of Object.entries(next.models)) {
    const stale = m.instance === p.providerInstanceId && !ids.includes(m.model);
    if (stale && m.available && m.source !== 'user' && m.source !== 'history') {
      m.available = false;
      diff.modelsUnavailable.push(key);
    }
  }
}

export function mergeCapabilities(registry, caps, { now, suggestions }) {
  validateCapabilities(caps);
  const next = structuredClone(registry);
  const diff = { instancesAdded: [], instancesDisabled: [], instancesEnabled: [], modelsAdded: [], modelsUnavailable: [] };
  const reported = new Set();
  for (const p of caps.providers) {
    const id = p.providerInstanceId;
    reported.add(id);
    const prev = next.instances[id];
    const inst = mergeInstance(prev, p, now);
    if (!prev) diff.instancesAdded.push(id);
    else if (prev.enabled && !inst.enabled) diff.instancesDisabled.push(id);
    else if (!prev.enabled && inst.enabled) diff.instancesEnabled.push(id);
    next.instances[id] = inst;
    mergeModels(next, p, suggestions, diff);
  }
  for (const [id, inst] of Object.entries(next.instances)) {
    if (reported.has(id)) continue;
    if (inst.enabled) diff.instancesDisabled.push(id);
    next.instances[id] = { ...inst, enabled: false, constraints: [NOT_REPORTED] };
  }
  next.syncedAt = now;
  for (const k of Object.keys(diff)) diff[k].sort();
  return { registry: next, diff };
}

export function harvestThreads(registry, threads, { suggestions }) {
  const next = structuredClone(registry);
  for (const t of threads) {
    if (t.status !== 'completed' || !t.instance || !t.model || !next.instances[t.instance]) continue;
    const key = modelKey(t.instance, t.model);
    if (next.models[key]) refresh(next.models[key], suggestions);
    else next.models[key] = newModel(t.instance, t.model, 'history', suggestions);
    if (next.models[key].confirmedAt === null || t.updatedAt > next.models[key].confirmedAt) {
      next.models[key].confirmedAt = t.updatedAt;
    }
  }
  return next;
}

export function edit(registry, key, fn) {
  const next = structuredClone(registry);
  const model = next.models[key];
  if (!model) throw new Error(`unknown model key: ${key}`);
  fn(model, next.instances[model.instance]);
  return next;
}

export function setTier(registry, key, tier, source) {
  if (!Number.isInteger(tier) || tier < 1 || tier > 4) throw new Error(`tier must be an integer 1-4, got ${tier}`);
  let applied = false;
  const next = edit(registry, key, (m) => {
    applied = source === m.tierSource || outranks(source, m.tierSource);
    if (applied) Object.assign(m, { tier, tierSource: source });
  });
  return { registry: next, applied };
}

export function addModel(registry, { instance, model, tier, source }, { suggestions }) {
  if (source !== 'user' && source !== 'orchestrator') throw new Error(`addModel source must be "user" or "orchestrator", got ${source}`);
  if (tier !== undefined && (!Number.isInteger(tier) || tier < 1 || tier > 4)) throw new Error(`tier must be an integer 1-4, got ${tier}`);
  if (!registry.instances[instance]) throw new Error(`unknown instance: ${instance}`);
  const next = structuredClone(registry);
  const key = modelKey(instance, model);
  const m = next.models[key] ?? newModel(instance, model, source, suggestions);
  const free = !next.models[key] || source === m.tierSource || outranks(source, m.tierSource);
  Object.assign(m, { source, available: true, rejectedAt: null });
  if (tier !== undefined && free) Object.assign(m, { tier, tierSource: source });
  next.models[key] = m;
  return next;
}
