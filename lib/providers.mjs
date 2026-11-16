// The provider pool at a glance, for init, sync and status. Pure.
const MAX_IDS = 6;
const idList = (ids) => (ids.length === 0 ? '' : ` (${ids.slice(0, MAX_IDS).join(', ')}${ids.length > MAX_IDS ? ` +${ids.length - MAX_IDS} more` : ''})`);

// The provider pool at a glance, each instance in one group: disabled by you, disabled in T3, no models listed
// (needs `orq model add`), cooling, or usable.
export function providersLine(registry, now) {
  const groups = {
    usable: [], t3: [], user: [], cooling: [], bare: [],
  };
  const withModels = new Set(Object.values(registry.models).filter((m) => m.available).map((m) => m.instance));
  for (const [id, i] of Object.entries(registry.instances).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (i.userDisabled === true) groups.user.push(id);
    else if (!i.enabled) groups.t3.push(id);
    else if (!withModels.has(id)) groups.bare.push(id);
    else if (i.cooldownUntil != null && i.cooldownUntil > now) groups.cooling.push(id);
    else groups.usable.push(id);
  }
  const g = (n, label) => `${groups[n].length} ${label}${idList(groups[n])}`;
  const bare = groups.bare.length ? `; ${g('bare', 'no models listed')}` : '';
  return `providers: ${g('usable', 'usable')}; ${g('t3', 'disabled in T3')}; ${g('user', 'disabled by you')}; ${g('cooling', 'cooling')}${bare}`;
}

// Account usage per instance (usage-source.mjs), for sync and status; registry is the view withUsage laid it over.
export function usageLine(registry, usage, now) {
  if (!usage) return [];
  const iso = (t) => new Date(t).toISOString();
  const parts = Object.keys(usage.instances).filter((id) => registry.instances[id]?.usage).sort().map((id) => {
    const u = registry.instances[id].usage;
    const used = u.usedPercent === null ? '-' : `${u.usedPercent}%`;
    return `${id} ${used}${u.resetAt > now ? ` resets ${iso(u.resetAt)}` : ''}${u.exhaustedUntil > now ? ` exhausted until ${iso(u.exhaustedUntil)}` : ''}`;
  });
  const failed = usage.error ? ` (last fetch failed: ${usage.error})` : '';
  const missing = usage.missing?.length ? `; no account matches ${usage.missing.join(', ')}` : '';
  const none = usage.error ? 'nothing read yet' : 'no instance mapped';
  return [`usage${failed}: ${parts.join('; ') || none}${missing}`];
}
