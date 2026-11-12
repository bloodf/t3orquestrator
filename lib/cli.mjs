import fs from 'node:fs';
import { readMachine, resolveCap } from './probe.mjs';
import { readJson } from './store.mjs';
import { machineConfigPath } from './paths.mjs';

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
  for (const [name, { summary }] of Object.entries(commands)) {
    ctx.stdout.write(`${name.padEnd(8)} ${summary}\n`);
  }
  return 0;
}

function version(_args, ctx) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ctx.stdout.write(`${pkg.version}\n`);
  return 0;
}

export const commands = {
  probe: { summary: 'print how many agent threads may be active', run: probe },
  help: { summary: 'list commands', run: help },
};

const aliases = { '--help': 'help', '-h': 'help' };

export async function run(argv, ctx) {
  const [first, ...rest] = argv;
  try {
    if (first === undefined) return await help([], ctx);
    if (first === '--version') return version(rest, ctx);
    const cmd = commands[aliases[first] || first];
    if (!cmd) {
      ctx.stderr.write(`orq: unknown command "${first}"; valid: ${Object.keys(commands).join(', ')}\n`);
      return 2;
    }
    return await cmd.run(rest, ctx);
  } catch (e) {
    ctx.stderr.write(`orq: ${e.message}\n`);
    return 1;
  }
}
