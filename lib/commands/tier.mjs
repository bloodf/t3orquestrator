import { setTier } from '../registry.mjs';
import { parseFlags, updateRegistry, usage } from './common.mjs';

export async function tier(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['by'] }, 'tier');
  const [sub, key, n] = positional;
  if (sub !== 'set' || !key || n === undefined || positional.length !== 3) throw usage('tier: usage: tier set <key> <1-4> [--by user|orchestrator]');
  const by = flags.by ?? 'orchestrator';
  if (by !== 'user' && by !== 'orchestrator') throw usage(`tier: --by must be user or orchestrator, got "${by}"`);
  const out = await updateRegistry(ctx, (reg) => {
    const { registry, applied } = setTier(reg, key, Number(n), by);
    return { registry, result: { applied, source: registry.models[key].tierSource } };
  });
  if (!out.applied) {
    ctx.stdout.write(`unchanged: ${key} is set by ${out.source}\n`);
    return 4;
  }
  ctx.stdout.write(`tier ${key} = ${n} (${by})\n`);
  return 0;
}
