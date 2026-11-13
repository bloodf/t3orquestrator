// orq instance list|disable|enable: a local switch for automated use that sync never overwrites.
import { setInstanceDisabled } from '../registry.mjs';
import {
  CliError, parseFlags, readRegistry, updateRegistry, usage,
} from './common.mjs';

const USAGE = 'instance: usage: instance list | instance disable <id> | instance enable <id>';

function state(inst) {
  if (inst.userDisabled === true) return 'off-user';
  return inst.enabled ? 'on' : 'off-t3';
}

async function list(ctx) {
  const reg = await readRegistry(ctx.env);
  const lines = Object.keys(reg.instances).sort().map((id) => {
    const inst = reg.instances[id];
    const models = Object.values(reg.models).filter((m) => m.instance === id).length;
    const cooling = inst.cooldownUntil != null && inst.cooldownUntil > ctx.now();
    return `${id} ${state(inst)} models=${models}${cooling ? ` cooldown_until=${new Date(inst.cooldownUntil).toISOString()}` : ''}`;
  });
  if (lines.length) ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export async function instance(args, ctx) {
  const { positional } = parseFlags(args, {}, 'instance');
  const [sub, id] = positional;
  if (sub === 'list' && positional.length === 1) return list(ctx);
  if ((sub === 'disable' || sub === 'enable') && id && positional.length === 2) {
    const disabled = sub === 'disable';
    await updateRegistry(ctx, (reg) => {
      if (!reg.instances[id]) throw new CliError(`unknown instance ${id}`, 4);
      return { registry: setInstanceDisabled(reg, id, disabled), result: null };
    });
    ctx.stdout.write(`instance ${id}: ${disabled ? 'disabled by user' : 'enabled'}\n`);
    return 0;
  }
  throw usage(USAGE);
}
