// The provider pool at a glance, for init, sync and status. Pure.
import { userOff } from './registry.mjs';
const MAX_IDS = 6;
const idList = (ids) => (ids.length === 0 ? '' : ` (${ids.slice(0, MAX_IDS).join(', ')}${ids.length > MAX_IDS ? ` +${ids.length - MAX_IDS} more` : ''})`);

// the machine policy (policy.mjs), when it applies: free and excluded models, instances limited to some families
function policyText(registry) {
  const models = Object.entries(registry.models).filter(([, m]) => m.available);
  const free = models.filter(([, m]) => m.free && !m.excluded).length;
  const out = models.filter(([, m]) => m.excluded).map(([k]) => k);
  const fams = Object.entries(registry.instances).filter(([, i]) => i.families).map(([id, i]) => `${id}=${i.families.join('+')}`);
  return `${free ? `; ${free} free model${free > 1 ? 's' : ''}` : ''}${out.length ? `; ${out.length} excluded model${out.length > 1 ? 's' : ''}${idList(out)}` : ''}${fams.length ? `; families: ${fams.join(', ')}` : ''}`;
}

// The provider pool at a glance, each instance in one group: disabled by you, disabled in T3, no models listed
// (needs `orq model add`), cooling, or usable.
export function providersLine(registry, now) {
  const groups = {
    usable: [], t3: [], user: [], cooling: [], bare: [],
  };
  const withModels = new Set(Object.values(registry.models).filter((m) => m.available).map((m) => m.instance));
  for (const [id, i] of Object.entries(registry.instances).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (userOff(i, now)) groups.user.push(id);
    else if (!i.enabled) groups.t3.push(id);
    else if (!withModels.has(id)) groups.bare.push(id);
    else if (i.cooldownUntil != null && i.cooldownUntil > now) groups.cooling.push(id);
    else groups.usable.push(id);
  }
  const g = (n, label) => `${groups[n].length} ${label}${idList(groups[n])}`;
  const bare = groups.bare.length ? `; ${g('bare', 'no models listed')}` : '';
  return `providers: ${g('usable', 'usable')}; ${g('t3', 'disabled in T3')}; ${g('user', 'disabled by you')}; ${g('cooling', 'cooling')}${bare}${policyText(registry)}`;
}

// Account usage per instance (usage-source.mjs), for sync and status: each instance's fullest window and its reset.
// An account with several quota groups (antigravity: usage.mjs) shows the fullest window of each, so that one full
// group does not read as the whole account being out.
const windowText = (w) => `${Math.round(w.used)}% ${w.id}${w.resetAt ? ` resets ${new Date(w.resetAt).toISOString()}` : ''}`;
const fullest = (ws) => ws.reduce((a, w) => (w.used > a.used ? w : a));
export function usageLine({ dir, instances }) {
  const ids = Object.keys(instances);
  if (ids.length === 0) return [`usage: no T3 provider cache in ${dir}`];
  const parts = ids.sort().flatMap((id) => {
    const u = instances[id];
    if (u.unreadable) return [`${id} unreadable`];
    if (u.down) return [`${id} down`];
    if (u.stale) return [`${id} stale`];
    if (!u.windows.length) return [];
    const groups = Object.entries(Object.groupBy(u.windows, (w) => w.group ?? ''));
    if (groups.length < 2) return [`${id} ${windowText(fullest(u.windows))}`];
    return [`${id} ${groups.map(([g, ws]) => `${g} ${windowText(fullest(ws))}`.trim()).join(', ')}`];
  });
  return parts.length ? [`usage: ${parts.join('; ')}`] : [];
}
