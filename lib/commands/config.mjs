import { loadMachineConfig, loadProjectConfig, setConfigValue } from '../config.mjs';
import { writeJsonAtomic } from '../store.mjs';
import { machineConfigPath, projectConfigPath } from '../paths.mjs';
import { parseFlags, usage, withMachineLock } from './common.mjs';
import { updateProjectConfig } from './project.mjs';

export async function config(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['machine'] }, 'config');
  const [sub, key, value] = positional;
  const machine = flags.machine === true;
  const file = machine ? machineConfigPath(ctx.env) : projectConfigPath(ctx.cwd);
  const load = () => (machine ? loadMachineConfig(file) : loadProjectConfig(file));
  if (sub === 'get' && positional.length === 1) {
    ctx.stdout.write(`${JSON.stringify(await load(), null, 2)}\n`);
    return 0;
  }
  if (sub === 'set' && key && value !== undefined && positional.length === 3) {
    if (machine) {
      await withMachineLock(ctx, async () => writeJsonAtomic(file, setConfigValue(await load(), key, value, 'machine')));
    } else {
      await updateProjectConfig(ctx, (current) => setConfigValue(current, key, value, 'project'));
    }
    ctx.stdout.write(`${key} = ${value}\n`);
    return 0;
  }
  throw usage('config: usage: config get [--machine] | config set [--machine] <key> <value>');
}
