import fs from 'node:fs';
import path from 'node:path';
import { createT3, resolveT3Bin } from '../t3.mjs';
import { resolveCap } from '../probe.mjs';
import { loadCatalog, resolveSlots, detectChecks, SLOTS } from '../detect.mjs';
import { providersLine } from '../providers.mjs';
import { createGit } from '../git.mjs';
import { detectShares, excludeShares } from '../share.mjs';
import { loadMachineConfig } from '../config.mjs';
import { machineConfigPath } from '../paths.mjs';
import { currentPlaybook, kitSha } from './kit-info.mjs';
import { updateProjectConfig } from './project.mjs';
import {
  loadToolCatalog, parseFlags, readRegistry, refuseWorker,
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

function summary({
  kit, t3, cap, slots, checks, config, registry, now, note, shareWhy,
}) {
  const regs = { instances: Object.keys(registry.instances).length, models: Object.keys(registry.models).length };
  const age = registry.syncedAt === null ? null : Math.floor((now - registry.syncedAt) / 3600_000);
  const lines = [
    `t3=${t3 ? t3.version : 'missing'} cap=${cap} kit=${kit}`,
    `slots: ${SLOTS.map((s) => `${s}=${slots[s][0].name}`).join(' ')}`,
    `checks: setup=${checks.setup ?? 'none'} full=${checks.full ?? 'none'}`,
    `autonomy=${config.autonomy ?? 'unset'} questions=${config.questions}`,
    `share: ${config.share?.length ? config.share.join(', ') : `none${shareWhy ? ` (${shareWhy})` : ''}`}`,
    `registry: ${regs.instances} instances, ${regs.models} models, synced ${age === null ? 'never' : `${age}h ago`}`,
    providersLine(registry, now),
  ];
  if (registry.syncedAt === null || now - registry.syncedAt > STALE_MS) {
    lines.push('next: pipe orchestrator_capabilities JSON to "orq sync"');
  }
  return note ? [...lines, note] : lines;
}

export async function init(args, ctx) {
  parseFlags(args, {}, 'init');
  const { env, cwd, deps } = ctx;
  await refuseWorker(ctx);
  const machine = await loadMachineConfig(machineConfigPath(env));
  const t3 = findT3(ctx);
  const { cap } = resolveCap({ machine: deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  const catalog = loadCatalog(await loadToolCatalog(env));
  let note = null;
  const git = createGit({ exec: deps.gitExec ?? deps.exec });
  const read = currentPlaybook(ctx).mark; // re-recorded on every init: the orchestrator has just read it
  let detected = { paths: [], why: null };
  try {
    detected = detectShares(cwd, git);
  } catch {
    detected = { paths: [], why: null }; // not a git checkout: nothing to share
  }
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
    // share: the user's list (even null) stays; absent, the detection made before taking the lock
    return {
      ...existing, checks, slots, t3, ...(Object.hasOwn(raw, 'share') ? {} : { share: detected.paths }), ...(read ? { playbook: read } : {}),
    };
  });
  const share = config.share ?? [];
  if (share.length) {
    try {
      excludeShares(cwd, share, git); // `node_modules/` does not ignore a symlink; an anchored exclude entry does
    } catch (e) {
      note = `note: share entries not excluded (${e.message.split('\n')[0].slice(0, 100)})`;
    }
  }
  const checks = { setup: null, unit: null, full: null, ...config.checks };
  const registry = await readRegistry(env);
  ctx.stdout.write(`${summary({
    kit: kitSha(ctx), t3, cap, slots: config.slots, checks, config, registry, now: ctx.now(), note, shareWhy: detected.why,
  }).join('\n')}\n`);
  return 0;
}
