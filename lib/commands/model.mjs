import { addModel, modelKey } from '../registry.mjs';
import { parseFlags, playbook, updateRegistry, usage } from './common.mjs';

export async function model(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['tier'] }, 'model');
  const [sub, instance, name] = positional;
  if (sub !== 'add' || !instance || !name || positional.length !== 3) throw usage('model: usage: model add <instance> <model> [--tier N]');
  const tier = flags.tier === undefined ? undefined : Number(flags.tier);
  const key = modelKey(instance, name);
  const entry = await updateRegistry(ctx, (reg) => {
    const registry = addModel(reg, { instance, model: name, tier, source: 'user' }, { suggestions: playbook('suggestions.json') });
    return { registry, result: registry.models[key] };
  });
  ctx.stdout.write(`added ${key} tier=${entry.tier} (${entry.tierSource})\n`);
  return 0;
}
