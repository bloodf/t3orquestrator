// What one `orq ship` carries, from plan state only. Pure.

// The units first integrated after the last shipped head, up to the one whose merge made `green`. Heads only move
// forward on the integration branch, so ledger order is reachability. Empty for a ledger written before 0.8.0.
export function shipUnits(p) {
  const list = p.integrations ?? [];
  const from = p.shipped ? list.findIndex((x) => x.head === p.shipped) + 1 : 0;
  const to = list.findIndex((x) => x.head === p.green);
  return to < from ? [] : list.slice(from, to + 1).map((x) => x.unit);
}

// only a head whose final run passed is ready: `orq ship` refuses any other verdict
export const unshipped = (p) => Boolean(p.green) && p.green !== p.shipped && p.greenVerdict === 'pass';

// `head` comes after the shipped head in the integration order (heads only move forward)
export function newerThanShipped(p, head) {
  const at = (h) => (p.integrations ?? []).findIndex((x) => x.head === h);
  return at(head) >= 0 && (!p.shipped || at(head) > at(p.shipped));
}

export function shipTitle(planId, n, ids) {
  const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
  return `${planId} ship ${n}: ${ids.slice(0, 3).join(', ')}${more}`;
}

// checks: the checks.full command the green run used
export function shipBody(plan, ids, green, checks) {
  const title = (id) => plan?.units?.find((u) => u.id === id)?.title ?? '';
  return [
    'Units in this ship:', '', ...ids.map((id) => `- ${id}: ${String(title(id)).replace(/\r?\n/g, ' ')}`), '',
    `final checks passed on ${green}`, `checks.full: \`${String(checks).replace(/\r?\n/g, ' ')}\``,
  ].join('\n');
}
