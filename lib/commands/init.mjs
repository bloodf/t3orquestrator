import fs from 'node:fs';
import path from 'node:path';
import { createT3, resolveT3Bin } from '../t3.mjs';
import { resolveCap } from '../probe.mjs';
import { loadCatalog, resolveSlots, detectChecks, SLOTS } from '../detect.mjs';
import { loadMachineConfig } from '../config.mjs';
import { hasLease } from '../leases.mjs';
import { leasesDir, machineConfigPath } from '../paths.mjs';
import { updateProjectConfig } from './project.mjs';
import {
  CliError, loadToolCatalog, parseFlags, readRegistry,
} from './common.mjs';

const STALE_MS = 12 * 3600_000;

function findT3({ env, deps }) {
  const home = deps.homedir();
  const first = resolveT3Bin({ env, homedir: home, exists: deps.exists ?? fs.existsSync });
  const candidates = [...new Set([first, `${home}/.t3/bin/t3`, 't3'])]
    .filter((b) => b === 't3' || b === first || (deps.exists ?? fs.existsSync)(b));
  for (const bin of candidates) {
    try {
      if (deps.exec(bin, ['thread', '--help'], {}).code !== 0) continue;
      return { bin, version: createT3({ bin, exec: deps.exec }).version() };
    } catch {
      // this candidate does not run; try the next
    }
  }
  return null;
}

function summary({ t3, cap, slots, checks, config, registry, now, note }) {
  const regs = { instances: Object.keys(registry.instances).length, models: Object.keys(registry.models).length };
  const age = registry.syncedAt === null ? null : Math.floor((now - registry.syncedAt) / 3600_000);
  const lines = [
    `t3=${t3 ? t3.version : 'missing'} cap=${cap}`,
    `slots: ${SLOTS.map((s) => `${s}=${slots[s][0].name}`).join(' ')}`,
    `checks: setup=${checks.setup ?? 'none'} full=${checks.full ?? 'none'}`,
    `autonomy=${config.autonomy ?? 'unset'}`,
    `registry: ${regs.instances} instances, ${regs.models} models, synced ${age === null ? 'never' : `${age}h ago`}`,
  ];
  if (registry.syncedAt === null || now - registry.syncedAt > STALE_MS) {
    lines.push('next: pipe orchestrator_capabilities JSON to "orq sync"');
  }
  return note ? [...lines, note] : lines;
}

export async function init(args, ctx) {
  parseFlags(args, {}, 'init');
  const { env, cwd, deps } = ctx;
  const own = env.T3CODE_THREAD_ID;
  if (own && await hasLease(leasesDir(env), own)) {
    throw new CliError('this thread is a worker started by orq; follow your work order', 3);
  }
  const machine = await loadMachineConfig(machineConfigPath(env));
  const t3 = findT3(ctx);
  const { cap } = resolveCap({ machine: deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  const catalog = loadCatalog(await loadToolCatalog(env));
  let note = null;
  const config = await updateProjectConfig(ctx, (existing, raw) => {
    const keep = Object.values(existing.slots).flat().filter((p) => p.kind === 'mcp').map((p) => p.name);
    const slots = resolveSlots({ catalog, which: deps.which, toolNames: [], keep });
    const at = (f) => path.join(cwd, f);
    let found = {};
    try {
      found = detectChecks({ exists: (f) => fs.existsSync(at(f)), readFile: (f) => fs.readFileSync(at(f), 'utf8') });
    } catch (e) {
      note = `note: checks not detected (${e.message.split('\n')[0].slice(0, 100)})`;
    }
    // keys present in the file (even null) are the user's; only absent keys take detection
    const checks = {};
    for (const k of ['setup', 'unit', 'full']) {
      if (Object.hasOwn(raw.checks ?? {}, k)) checks[k] = existing.checks[k];
      else if (found[k] != null) checks[k] = found[k];
    }
    return { ...existing, checks, slots, t3 };
  });
  const checks = { setup: null, unit: null, full: null, ...config.checks };
  const registry = await readRegistry(env);
  ctx.stdout.write(`${summary({
    t3, cap, slots: config.slots, checks, config, registry, now: ctx.now(), note,
  }).join('\n')}\n`);
  return 0;
}
