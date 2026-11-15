// orq ship (continuous mode): the head that last passed the final checks ships as its own pull request, and the
// base branch is fast-forwarded to it. git and gh run outside every lock; the `shipped` event is committed after.
import { defaultExec as gitExec, HARDEN } from '../git.mjs';
import { defaultExec } from '../t3.mjs';
import { loadProjectConfig } from '../config.mjs';
import { assertNotArchiving, commit, readState } from '../ledger.mjs';
import { readJson } from '../store.mjs';
import { planPath, projectConfigPath } from '../paths.mjs';
import { shipBody, shipTitle, shipUnits } from '../ship.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

const NET_MS = 300_000; // fetch and push go over the network
const MERGE_CHECKS = 3; // the host marks a pull request merged shortly after its head reaches the base
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const lastLine = (s) => String(s ?? '').trim().split('\n').at(-1).trim();
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function tools(ctx) {
  const gitRun = ctx.deps.gitExec ?? gitExec;
  const ghRun = ctx.deps.ghExec ?? defaultExec;
  return {
    git: (args) => gitRun('git', [...HARDEN, ...args], { cwd: ctx.cwd, timeoutMs: NET_MS }),
    gh: (args) => {
      try {
        return ghRun('gh', args, { cwd: ctx.cwd });
      } catch (e) {
        return { code: 1, stdout: '', stderr: e.message }; // gh missing: reported like any gh failure
      }
    },
  };
}

// The pull request for `branch`: the one an earlier, interrupted ship opened, or a new one.
function openPr(gh, {
  base, branch, title, body, sha,
}) {
  const seen = gh(['pr', 'view', branch, '--json', 'url,state']);
  const pr = seen.code === 0 ? json(seen.stdout) : null;
  if (pr?.url && pr.state !== 'CLOSED') return pr.url;
  const made = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  if (made.code !== 0) throw new CliError(`ship: gh pr create failed: ${lastLine(made.stderr)}; branch ${branch} holds ${sha.slice(0, 12)} on origin; run "orq ship" again`);
  return lastLine(made.stdout);
}

async function confirmMerged(ctx, gh, url, base) {
  const sleep = ctx.sleep ?? realSleep;
  for (let i = 0; i < MERGE_CHECKS; i += 1) {
    const r = gh(['pr', 'view', url, '--json', 'state,mergedAt']);
    if (r.code === 0 && json(r.stdout)?.state === 'MERGED') return null;
    if (i < MERGE_CHECKS - 1) await sleep(2000);
  }
  const m = gh(['pr', 'merge', url, '--merge']);
  if (m.code === 0) return `note: the host did not mark ${url} merged after the push; merged it with "gh pr merge"`;
  return `note: ${url} is not marked merged and "gh pr merge" failed: ${lastLine(m.stderr)}; ${base} already holds its work: merge or close it on the host`;
}

export async function ship(args, ctx) {
  const { positional } = parseFlags(args, {}, 'ship');
  if (positional.length) throw usage('ship: usage: ship');
  await assertNotArchiving(ctx.cwd);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (config.autonomy !== 'continuous') {
    throw new CliError(`ship: runs only in continuous mode (autonomy is ${config.autonomy ?? 'unset'}); "orq config set autonomy continuous" turns it on`, 4);
  }
  const { plan: p } = await readState(ctx.cwd);
  const sha = p.green?.slice(0, 12);
  const idle = !p.green ? 'no integration head has passed the final checks yet' : p.green === p.shipped && `${sha} is shipped`;
  if (idle) {
    ctx.stdout.write(`nothing to ship: ${idle}; run "orq wait"\n`);
    return 0;
  }
  const base = config.base.replace(/^origin\//, '');
  const { git, gh } = tools(ctx);
  const fetched = git(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (fetched.code !== 0) throw new CliError(`ship: git fetch origin ${base} failed: ${lastLine(fetched.stderr)}; nothing was shipped; fix the remote and run "orq ship" again`);
  const behind = git(['merge-base', '--is-ancestor', `refs/remotes/origin/${base}`, p.green]);
  if (behind.code === 1) throw new CliError(`ship: ${base} moved on origin; append a fix unit that merges origin/${base} into the integration branch`, 4);
  if (behind.code !== 0) throw new CliError(`ship: git merge-base failed: ${lastLine(behind.stderr)}; nothing was shipped`);
  const n = (p.ships ?? 0) + 1;
  const branch = `orq/${p.planId}/ship-${n}`;
  const pushed = git(['push', '--quiet', 'origin', `${p.green}:refs/heads/${branch}`]);
  if (pushed.code !== 0) throw new CliError(`ship: pushing ${sha} to ${branch} failed: ${lastLine(pushed.stderr)}; nothing was shipped; run "orq ship" again`);
  const ids = shipUnits(p);
  const url = openPr(gh, {
    base, branch, sha: p.green, title: shipTitle(p.planId, n, ids), body: shipBody(await readJson(planPath(ctx.cwd), null), ids, p.green, config.checks.full !== null),
  });
  const landed = git(['push', '--quiet', 'origin', `${p.green}:refs/heads/${base}`]); // never --force: git refuses a non-fast-forward
  if (landed.code !== 0) {
    throw new CliError(`ship: ${url} is open, but pushing ${sha} to ${base} failed: ${lastLine(landed.stderr)}; fix that and run "orq ship" again (it reuses the pull request)`);
  }
  const note = await confirmMerged(ctx, gh, url, base);
  await commit(ctx.cwd, (s) => (s.plan.shipped === p.green ? [] : [{
    type: 'shipped', unit: null, at: ctx.now(), head: p.green, pr: url, n,
  }]));
  ctx.stdout.write(`shipped ${sha} as ${url}: ${ids.length} units\n${note ? `${note}\n` : ''}`);
  return 0;
}
