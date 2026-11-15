// What one `orq ship` carries, from plan state only. Pure.

// The units first integrated after the last shipped head, up to the one whose merge made `green`. Heads only move
// forward on the integration branch, so ledger order is reachability. Empty for a ledger written before 0.8.0.
export function shipUnits(p) {
  const list = p.integrations ?? [];
  const from = p.shipped ? list.findIndex((x) => x.head === p.shipped) + 1 : 0;
  const to = list.findIndex((x) => x.head === p.green);
  return to < from ? [] : list.slice(from, to + 1).map((x) => x.unit);
}

export const unshipped = (p) => Boolean(p.green) && p.green !== p.shipped;

export function shipTitle(planId, n, ids) {
  const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
  return `${planId} ship ${n}: ${ids.slice(0, 3).join(', ')}${more}`;
}

// checked: false when no full check command is configured, so the final run proved nothing
export function shipBody(plan, ids, green, checked) {
  const title = (id) => plan?.units?.find((u) => u.id === id)?.title ?? '';
  return [
    'Units in this ship:', '', ...ids.map((id) => `- ${id}: ${String(title(id)).replace(/\r?\n/g, ' ')}`), '',
    checked ? `final checks passed on ${green}` : `no full check command is configured: nothing verified ${green}`,
  ].join('\n');
}
