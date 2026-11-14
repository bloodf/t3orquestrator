// A plan.json that no longer lists units the ledger knows was replaced by a new request before the old plan was
// archived. Running it would put the new units on the old ledger and integration branch. Pure.
export function missingUnits(plan, state) {
  const listed = new Set((Array.isArray(plan?.units) ? plan.units : []).map((u) => u?.id));
  return Object.keys(state.units).filter((id) => !listed.has(id));
}

export const replacedPlanMessage = (ids) => `plan.json no longer lists units the ledger knows (${ids.join(', ')}); `
  + 'this looks like a new request: restore plan.json or run "orq plan archive" first';

// Every unit the ledger knows is integrated or dropped and the final gate has judged the current head.
function finished(state) {
  const units = Object.values(state.units);
  const done = units.length > 0 && units.every((u) => u.state === 'integrated' || u.state === 'dropped');
  const p = state.plan;
  return done && (units.every((u) => u.state === 'dropped') || p.final?.head === p.integrationHead);
}

/**
 * Why plan.json looks like a new request written over a plan that was not archived, or null. Units the ledger knows
 * that plan.json no longer lists; or, once the ledger's plan is finished, a goal other than the one it started with
 * (a goal edit while the plan runs is fine; a ledger from before goals were recorded is not checked).
 */
export function replacedPlan(plan, state) {
  const missing = missingUnits(plan, state);
  if (missing.length) return replacedPlanMessage(missing);
  const was = state.plan.goal;
  if (was == null || plan?.goal === was || !finished(state)) return null;
  return `plan.json has a new goal ("${plan?.goal}", was "${was}") but the ledger's plan is finished; `
    + 'this looks like a new request: restore plan.json or run "orq plan archive" first';
}
