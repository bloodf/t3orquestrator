import fs from 'node:fs';
import os from 'node:os';
import { readMachine, resolveCap } from './probe.mjs';
import { readJson } from './store.mjs';
import { machineConfigPath } from './paths.mjs';
import { defaultExec } from './t3.mjs';
import { defaultWhich } from './detect.mjs';
import { readStdin } from './commands/common.mjs';
import { init } from './commands/init.mjs';
import { sync } from './commands/sync.mjs';
import { route } from './commands/route.mjs';
import { model } from './commands/model.mjs';
import { tier } from './commands/tier.mjs';
import { config } from './commands/config.mjs';
import { plan } from './commands/plan.mjs';
import { gateRun } from './commands/gate-run.mjs';
import { wait } from './commands/wait.mjs';
import { status } from './commands/status.mjs';
import { unit } from './commands/unit.mjs';
import { version as versionCmd } from './commands/version.mjs';
import { update } from './commands/update.mjs';
import { instance } from './commands/instance.mjs';
import { review } from './commands/review.mjs';
import { summary } from './commands/summary.mjs';
import { ask } from './commands/ask.mjs';

const GIB = 1024 ** 3;

async function probe(args, ctx) {
  const bad = args.find((a) => a !== '--json');
  if (bad) {
    ctx.stderr.write(`orq: probe: unknown option "${bad}"\n`);
    return 2;
  }
  const machine = (ctx.readMachine || readMachine)();
  const config = await readJson(machineConfigPath(ctx.env), {});
  const { cap, reasons } = resolveCap({ machine, config });
  if (args.includes('--json')) {
    const { cores, availableMemBytes, load1 } = machine;
    ctx.stdout.write(`${JSON.stringify({ cap, cores, availableMemBytes, load1, reasons })}\n`);
    return 0;
  }
  const mem = (machine.availableMemBytes / GIB).toFixed(1);
  ctx.stdout.write(`cap=${cap} cores=${machine.cores} mem_gb=${mem} load1=${machine.load1.toFixed(2)} reasons="${reasons.join('; ')}"\n`);
  return 0;
}

function help(_args, ctx) {
  for (const name of visible()) ctx.stdout.write(`${name.padEnd(8)} ${commands[name].summary}\n`);
  return 0;
}

function version(_args, ctx) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ctx.stdout.write(`${pkg.version}\n`);
  return 0;
}

export const commands = {
  probe: { summary: 'print how many agent threads may be active', run: probe },
  init: { summary: 'set up this project: detect t3, slots and checks', run: init },
  sync: { summary: 'merge orchestrator capabilities (stdin) into the registry', run: sync },
  route: { summary: 'pick a model for a job class', run: route },
  model: { summary: 'model add <instance> <model> [--tier N]', run: model },
  tier: { summary: 'tier set <key> <1-4> [--by user|orchestrator]', run: tier },
  config: { summary: 'config get|set [--machine]', run: config },
  plan: { summary: 'plan check: validate .orq/plan.json | plan archive: put a finished plan away', run: plan },
  wait: { summary: 'run the plan until something needs you [--max-seconds N]', run: wait },
  status: { summary: 'plan, slots and one line per unit [--json]', run: status },
  unit: { summary: 'unit retry <id> [--tier N] | unit drop <id>', run: unit },
  version: { summary: 'print orq and kit versions', run: versionCmd },
  update: { summary: 'update the kit checkout [--to <tag|sha>] [--check] (origin trusted, tags unsigned)', run: update },
  instance: { summary: 'instance list | instance disable|enable <id>', run: instance },
  review: { summary: 'review start [--order <file>] | review show [<n>]', run: review },
  ask: { summary: 'ask [--unit <id>] [--max-seconds N] < question | ask --show [<n>]: a decision without the user', run: ask },
  summary: { summary: 'write the pull request body to .orq/summary.md [--out <file>] | --plan <id>', run: summary },
  help: { summary: 'list commands', run: help },
  'gate-run': { summary: 'internal: run one gate', run: gateRun, hidden: true },
};

const visible = () => Object.keys(commands).filter((name) => !commands[name].hidden);

function withDefaults(ctx) {
  return {
    now: () => Date.now(),
    stdin: readStdin,
    ...ctx,
    deps: {
      exec: defaultExec,
      which: defaultWhich,
      homedir: os.homedir,
      readMachine: ctx.readMachine || readMachine,
      ...ctx.deps,
    },
  };
}

const aliases = { '--help': 'help', '-h': 'help' };

export async function run(argv, ctx) {
  const [first, ...rest] = argv;
  try {
    if (first === undefined) return await help([], ctx);
    if (first === '--version') return version(rest, ctx);
    const cmd = commands[aliases[first] || first];
    if (!cmd) {
      ctx.stderr.write(`orq: unknown command "${first}"; valid: ${visible().join(', ')}\n`);
      return 2;
    }
    return await cmd.run(rest, withDefaults(ctx));
  } catch (e) {
    ctx.stderr.write(`orq: ${e.message}\n`);
    return e.exitCode ?? 1;
  }
}
