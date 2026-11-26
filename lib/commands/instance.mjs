// orq instance list|disable|enable: a local switch for automated use that sync never overwrites.
// --until <time>: the switch holds until then and flips after (registry.mjs userOff), so "off until the quota is
// back" needs no cron job.
import { setInstanceDisabled, userOff } from '../registry.mjs';
import {
  CliError, parseFlags, readRegistry, updateRegistry, usage,
} from './common.mjs';

const USAGE = 'instance: usage: instance list | instance disable <id> [--until <time>] | instance enable <id> [--until <time>]';
const iso = (ms) => new Date(ms).toISOString();

function state(inst, now) {
  if (userOff(inst, now)) return 'off-user';
  return inst.enabled ? 'on' : 'off-t3';
}

// "<time>": an ISO date-time (2026-11-27T10:00Z), or a duration from now (90m, 6h, 2d)
export function parseUntil(text, now) {
  const d = /^(\d+)([mhd])$/.exec(text);
  const ms = d ? now + Number(d[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2]] : Date.parse(text);
  if (!Number.isFinite(ms)) throw usage(`instance: --until must be an ISO time (2026-11-27T10:00Z) or a duration (90m, 6h, 2d), got "${text}"`);
  if (ms <= now) throw usage(`instance: --until ${text} is not in the future`);
  return ms;
}

async function list(ctx) {
  const reg = await readRegistry(ctx.env);
  const now = ctx.now();
  const lines = Object.keys(reg.instances).sort().map((id) => {
    const inst = reg.instances[id];
    const models = Object.values(reg.models).filter((m) => m.instance === id).length;
    const cooling = inst.cooldownUntil != null && inst.cooldownUntil > now;
    const flip = Number.isFinite(inst.userUntil) && inst.userUntil > now ? ` until=${iso(inst.userUntil)}` : '';
    return `${id} ${state(inst, now)}${flip} models=${models}${cooling ? ` cooldown_until=${iso(inst.cooldownUntil)}` : ''}`;
  });
  if (lines.length) ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export async function instance(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['until'] }, 'instance');
  const [sub, id] = positional;
  if (sub === 'list' && positional.length === 1 && flags.until === undefined) return list(ctx);
  if ((sub === 'disable' || sub === 'enable') && id && positional.length === 2) {
    const disabled = sub === 'disable';
    const until = flags.until === undefined ? null : parseUntil(flags.until, ctx.now());
    await updateRegistry(ctx, (reg) => {
      if (!reg.instances[id]) throw new CliError(`unknown instance ${id}`, 4);
      return { registry: setInstanceDisabled(reg, id, disabled, until), result: null };
    });
    const then = until === null ? '' : ` until ${iso(until)}, then ${disabled ? 'enabled' : 'disabled by user'}`;
    ctx.stdout.write(`instance ${id}: ${disabled ? 'disabled by user' : 'enabled'}${then}\n`);
    return 0;
  }
  throw usage(USAGE);
}
