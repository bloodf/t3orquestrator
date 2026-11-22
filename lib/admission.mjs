// Whether this machine may start more work now: its own pressure (pressure.mjs) and its protected services
// (protect.mjs). Read on every `orq wait` poll and by `orq status`; the result is also what the machine publishes for
// its peers (peers.mjs), and that file carries the hold from one poll to the next (hysteresis, and since when).
import os from 'node:os';
import { readJson, writeJsonAtomic } from './store.mjs';
import { loadMachineConfig } from './config.mjs';
import { resolveCap } from './probe.mjs';
import { countActive, listLeases, DEFAULT_LEASE_TTL_MINUTES } from './leases.mjs';
import { leasesDir, machineConfigPath } from './paths.mjs';
import { judge, pressureSample } from './pressure.mjs';
import { checkProtect, protectReasons } from './protect.mjs';
import { selfPath, selfStatus } from './peers.mjs';

const PUBLISH_EVERY_MS = 30_000;
const hostName = (ctx) => String((ctx.deps?.hostname ?? os.hostname)()).split('.')[0];

// -> {held, since, reasons, sample, services, status}. machine: the machine config; facts: probe.mjs readMachine.
export async function admission(ctx, {
  machine, facts, cap, active,
}) {
  const now = ctx.now();
  const prev = await readJson(selfPath(ctx.env), null).catch(() => null);
  const sample = pressureSample(facts);
  const pressure = judge(sample, machine.pressure, prev?.holding);
  const services = await checkProtect(ctx, machine.protect);
  const reasons = [...pressure.reasons, ...protectReasons(services)];
  const held = reasons.length > 0;
  const since = held ? (prev?.held === true && Number.isFinite(prev.since) ? prev.since : now) : null;
  const status = selfStatus({
    host: hostName(ctx), now, facts, sample, held, since, holding: pressure.holding, reasons, cap, active, services,
  });
  const changed = !prev || prev.held !== held || String(prev.holding) !== String(pressure.holding) || !Number.isFinite(prev.at) || now < prev.at;
  if (changed || now - prev.at >= PUBLISH_EVERY_MS) await writeJsonAtomic(selfPath(ctx.env), status).catch(() => {}); // published again on the next poll
  return {
    held, since, reasons, sample, services, status,
  };
}

// The same, from what is on this machine now: its config, its facts, its cap and its active leases.
export async function machineAdmission(ctx, config) {
  const machine = config ?? await loadMachineConfig(machineConfigPath(ctx.env));
  const facts = ctx.deps.readMachine();
  const { cap } = resolveCap({ machine: facts, config: machine.cap ? { cap: machine.cap } : {} });
  const active = countActive(await listLeases(leasesDir(ctx.env)), ctx.now(), DEFAULT_LEASE_TTL_MINUTES * 60_000);
  return admission(ctx, {
    machine, facts, cap, active,
  });
}

const minutes = (ms) => Math.floor(ms / 60_000);
// One line for `orq status` and the `orq wait` note: what holds this machine, and for how long.
export const holdText = (a, now) => `${a.reasons.join('; ')}${a.since !== null && now - a.since >= 60_000 ? `, for ${minutes(now - a.since)} min` : ''}`;
