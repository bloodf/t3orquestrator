import { createT3 } from '../t3.mjs';
import {
  mergeCapabilities, harvestThreads, validateCapabilities,
} from '../registry.mjs';
import { loadCatalog, resolveSlots } from '../detect.mjs';
import { loadProjectConfig } from '../config.mjs';
import { writeJsonAtomic } from '../store.mjs';
import { projectConfigPath, registryPath } from '../paths.mjs';
import {
  CliError, MAX_INPUT, loadToolCatalog, parseFlags, playbook, readRegistry, usage, withMachineLock,
} from './common.mjs';
import { updateProjectConfig } from './project.mjs';

function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CliError(`stdin is not valid JSON: ${e.message}`);
  }
  const wrapped = data !== null && typeof data === 'object' && 'capabilities' in data;
  const tools = wrapped ? data.tools : undefined;
  if (tools !== undefined && !(Array.isArray(tools) && tools.every((t) => typeof t === 'string'))) {
    throw new CliError('tools must be an array of strings');
  }
  return { capabilities: wrapped ? data.capabilities : data, tools };
}

// Slow (spawns t3): must run before the machine lock is taken.
function listHistory(project, ctx) {
  if (!project.t3) return { threads: [], note: null };
  try {
    const t3 = createT3({ bin: project.t3.bin, exec: ctx.deps.exec });
    return { threads: t3.listThreads({ project: ctx.cwd }), note: null };
  } catch (e) {
    return { threads: [], note: `note: history not harvested (${e.message.split('\n')[0].slice(0, 100)})` };
  }
}

function report(registry, diff) {
  const out = [];
  const list = (label, ids) => { if (ids.length) out.push(`${label}: ${ids.join(', ')}`); };
  list('+instances', diff.instancesAdded);
  list('-instances', diff.instancesDisabled);
  list('enabled', diff.instancesEnabled);
  if (diff.modelsAdded.length) out.push(`+models: ${diff.modelsAdded.length}`);
  if (diff.modelsUnavailable.length) out.push(`unavailable: ${diff.modelsUnavailable.length}`);
  const instances = Object.values(registry.instances);
  const models = Object.values(registry.models);
  out.push(`synced: ${instances.length} instances (${instances.filter((i) => i.enabled).length} enabled), `
    + `${models.length} models (${models.filter((m) => m.confirmedAt !== null).length} confirmed)`);
  const off = Object.keys(registry.instances).filter((id) => registry.instances[id].userDisabled === true).sort();
  if (off.length) out.push(`user-disabled: ${off.join(', ')}`);
  return out;
}

function inferredLine(registry) {
  const keys = Object.keys(registry.models).filter((k) => registry.models[k].tierSource === 'inferred').sort();
  if (!keys.length) return [];
  const more = keys.length > 8 ? ` +${keys.length - 8} more` : '';
  return [`inferred: ${keys.slice(0, 8).join(', ')}${more} — set with: orq tier set <key> <1-4>`];
}

// The model the orchestrator itself runs on, so `orq ask` knows when no stronger model exists. Absent: left unset.
// threadId (`parentThreadId`, the caller's own id) ties the record to the thread that synced: `orq ask` trusts it only
// from that thread. Fields absent: the old record no longer describes anyone and is removed.
async function saveOrchestrator(ctx, capabilities) {
  const { inheritedProviderInstanceId: instance, inheritedModel: model, parentThreadId: threadId } = capabilities;
  const known = (v) => typeof v === 'string' && v !== '';
  await updateProjectConfig(ctx, (_current, raw) => { // raw: keep unset keys unset
    const { orchestrator: _old, ...rest } = raw;
    if (!known(instance) || !known(model)) return rest;
    return { ...rest, orchestrator: { instance, model, ...(known(threadId) ? { threadId } : {}) } };
  });
}

async function saveSlots(ctx, tools) {
  const catalog = loadCatalog(await loadToolCatalog(ctx.env));
  await updateProjectConfig(ctx, (current) => ({
    ...current, slots: resolveSlots({ catalog, which: ctx.deps.which, toolNames: tools }),
  }));
}

export async function sync(args, ctx) {
  parseFlags(args, {}, 'sync');
  const text = await ctx.stdin();
  if (Buffer.byteLength(text) > MAX_INPUT) throw usage('sync: input too large');
  if (text.trim() === '') throw usage('sync: expects JSON on stdin');
  const { capabilities, tools } = parsePayload(text);
  validateCapabilities(capabilities);
  const suggestions = playbook('suggestions.json');
  const project = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const history = listHistory(project, ctx);
  const done = await withMachineLock(ctx, async () => {
    const merged = mergeCapabilities(await readRegistry(ctx.env), capabilities, { now: ctx.now(), suggestions });
    const registry = harvestThreads(merged.registry, history.threads, { suggestions });
    await writeJsonAtomic(registryPath(ctx.env), registry);
    return { registry, note: history.note, diff: merged.diff };
  });
  if (tools) await saveSlots(ctx, tools);
  await saveOrchestrator(ctx, capabilities);
  const lines = report(done.registry, done.diff);
  const head = lines.slice(0, -1);
  ctx.stdout.write(`${[...head, ...(done.note ? [done.note] : []), lines.at(-1), ...inferredLine(done.registry)].join('\n')}\n`);
  return 0;
}
