// Tier suggestions: data-driven, never authoritative. Tiers: 4 strongest, 1 smallest.
export const TIER_SOURCES = Object.freeze(['user', 'orchestrator', 'suggested', 'inferred']);

function rank(source) {
  const i = TIER_SOURCES.indexOf(source);
  if (i < 0) throw new Error(`unknown tier source: ${source}`);
  return i;
}

export function outranks(a, b) {
  return rank(a) < rank(b);
}

function compile(list, name, valueKey, validValue) {
  if (!Array.isArray(list)) throw new Error(`suggestions.${name} must be an array`);
  return list.map((e, i) => {
    if (!e || typeof e.match !== 'string') throw new Error(`suggestions.${name}[${i}].match must be a string`);
    if (!validValue(e[valueKey])) throw new Error(`suggestions.${name}[${i}].${valueKey} is invalid`);
    let re;
    try {
      re = new RegExp(e.match, 'i');
    } catch (err) {
      throw new Error(`suggestions.${name}[${i}] pattern does not compile: ${err.message}`);
    }
    return { re, value: e[valueKey] };
  });
}

export function suggest(modelId, suggestions) {
  if (typeof modelId !== 'string' || modelId === '') throw new Error('modelId must be a non-empty string');
  if (!suggestions || typeof suggestions !== 'object') throw new Error('suggestions must be an object');
  const families = compile(suggestions.families, 'families', 'family', (v) => typeof v === 'string' && v !== '');
  const tiers = compile(suggestions.tiers, 'tiers', 'tier', (v) => Number.isInteger(v) && v >= 1 && v <= 4);
  const family = families.find((f) => f.re.test(modelId))?.value ?? 'unknown';
  const tier = tiers.find((t) => t.re.test(modelId));
  return tier
    ? { family, tier: tier.value, tierSource: 'suggested' }
    : { family, tier: 2, tierSource: 'inferred' };
}
