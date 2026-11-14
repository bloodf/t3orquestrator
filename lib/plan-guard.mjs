// A plan.json that no longer lists units the ledger knows was replaced by a new request before the old plan was
// archived. Running it would put the new units on the old ledger and integration branch. Pure.
export function missingUnits(plan, state) {
  const listed = new Set((Array.isArray(plan?.units) ? plan.units : []).map((u) => u?.id));
  return Object.keys(state.units).filter((id) => !listed.has(id));
}

export const replacedPlanMessage = (ids) => `plan.json no longer lists units the ledger knows (${ids.join(', ')}); `
  + 'this looks like a new request: restore plan.json or run "orq plan archive" first';
