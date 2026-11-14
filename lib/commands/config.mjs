import { loadMachineConfig, loadProjectConfig, setConfigValue } from '../config.mjs';
import { writeJsonAtomic } from '../store.mjs';
import { machineConfigPath, projectConfigPath } from '../paths.mjs';
import {
  CliError, parseFlags, usage, withMachineLock,
} from './common.mjs';
import { updateProjectConfig } from './project.mjs';
import { createGit } from '../git.mjs';
import { syncShareExclude, trackedShareMessage } from '../share.mjs';

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
    let warn = null;
    let shown = value; // what was stored, for goal
    if (machine) {
      await withMachineLock(ctx, async () => writeJsonAtomic(file, setConfigValue(await load(), key, value, 'machine')));
    } else {
      const git = createGit({ exec: ctx.deps.gitExec ?? ctx.deps.exec });
      if (key === 'share' && value !== 'null') { // git would hide new files under a tracked directory: refuse it
        const tracked = setConfigValue({}, key, value, 'project').share.find((p) => git.tracked(ctx.cwd, p));
        if (tracked !== undefined) throw new CliError(trackedShareMessage(tracked));
      }
      const next = await updateProjectConfig(ctx, (current) => setConfigValue(current, key, value, 'project'));
      if (key === 'goal' && next.goal !== undefined) shown = next.goal;
      if (key === 'share') warn = syncShareExclude(ctx.cwd, next.share ?? [], git, { prune: true }).note;
    }
    ctx.stdout.write(`${key} = ${shown}\n${warn ? `${warn}\n` : ''}`);
    return 0;
  }
  throw usage('config: usage: config get [--machine] | config set [--machine] <key> <value>');
}
