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
