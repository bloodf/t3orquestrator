// orq ship (continuous mode): the head that last passed the final checks ships as its own pull request, and the
// base branch is fast-forwarded to it. git and gh run outside every lock; the `shipped` event is committed after.
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultExec as gitExec, HARDEN } from '../git.mjs';
import { defaultExec } from '../t3.mjs';
import { loadProjectConfig } from '../config.mjs';
import { assertNotArchiving, commit, readState } from '../ledger.mjs';
import { readJson } from '../store.mjs';
import { withLock } from '../lock.mjs';
import { planPath, projectConfigPath, runnerLockPath } from '../paths.mjs';
import {
  creditIn, newerThanShipped, shipBody, shipTextError, shipTitle, shipUnits, unitsIn,
} from '../ship.mjs';
import { creditedCommits } from '../strip-credit.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

const NET_MS = 300_000; // fetch and push go over the network
const MERGE_WAIT_MS = 30_000; // the host marks a pull request merged shortly after its head reaches the base
const POLL_MS = 2000;
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const lastLine = (s) => String(s ?? '').trim().split('\n').at(-1).trim();
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export function tools(ctx) {
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

// The pull request for `branch`: an OPEN one whose head is `sha` (left by an interrupted ship), or a new one.
// A merged or closed pull request, or one on another head, is never reused.
function openPr(gh, {
  base, branch, title, body, sha,
}) {
  const seen = gh(['pr', 'view', branch, '--json', 'url,state,headRefOid']);
  const pr = seen.code === 0 ? json(seen.stdout) : null;
  if (pr?.url && pr.state === 'OPEN' && pr.headRefOid === sha) return pr.url;
  const made = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  if (made.code !== 0) throw new CliError(`ship: gh pr create failed: ${lastLine(made.stderr)}; branch ${branch} holds ${sha.slice(0, 12)} on origin; run "orq ship" again`);
  return lastLine(made.stdout);
}

// The first ship-<n> branch from `n` on that is free on origin or already holds `sha`: another head is never moved.
function freeBranch(git, planId, n, sha) {
  for (let k = n; k < n + 100; k += 1) {
    const branch = `orq/${planId}/ship-${k}`;
    const r = git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    if (r.code !== 0) throw new CliError(`ship: git ls-remote origin failed: ${lastLine(r.stderr)}; nothing was shipped; fix the remote and run "orq ship" again`);
    const held = r.stdout.trim().split(/\s/)[0];
    if (!held || held === sha) return { branch, n: k };
  }
  throw new CliError(`ship: orq/${planId}/ship-${n} to ship-${n + 99} all hold other heads on origin; nothing was shipped`);
}

// The host marks the pull request merged once it sees its head in the base. orq never merges it itself: a merge
// commit would put the base ahead of the integration branch. Polled for MERGE_WAIT_MS of injected sleeps.
async function confirmMerged(ctx, gh, url) {
  const sleep = ctx.sleep ?? realSleep;
  for (let waited = 0; ; waited += POLL_MS) {
    const r = gh(['pr', 'view', url, '--json', 'state,mergedAt']);
    if (r.code === 0 && json(r.stdout)?.state === 'MERGED') return null;
    if (waited >= MERGE_WAIT_MS) return `note: ${url} is not marked merged yet; GitHub marks it once it sees the push, nothing to do`;
    await sleep(POLL_MS);
  }
}

// origin's base into refs/remotes/origin/<base>: `orq ship` before it pushes, `orq wait` before it merges the base
export const fetchBase = (git, base) => git(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);

// Before anything is pushed: the head is verified, and the base on origin has not moved past it.
function preflight(git, p, base) {
  // `integrations` is rebuilt from every `integrated` event on each read, whatever mode wrote them
  if (!newerThanShipped(p, p.green)) throw new CliError(`ship: ${p.green.slice(0, 12)} is not newer than the shipped head ${String(p.shipped).slice(0, 12)}; nothing was shipped`, 4);
  if (p.greenVerdict !== 'pass') {
    throw new CliError(`ship: ${p.green.slice(0, 12)} has no passing final checks (verdict ${p.greenVerdict ?? 'unknown'}); set checks.full ("orq config set checks.full <cmd>"): only a head that passes it ships`, 4);
  }
  const fetched = fetchBase(git, base);
  if (fetched.code !== 0) throw new CliError(`ship: git fetch origin ${base} failed: ${lastLine(fetched.stderr)}; nothing was shipped; fix the remote and run "orq ship" again`);
  const behind = git(['merge-base', '--is-ancestor', `refs/remotes/origin/${base}`, p.green]);
  if (behind.code === 1) throw new CliError(`ship: ${base} moved on origin; append a fix unit that merges origin/${base} into the integration branch`, 4);
  if (behind.code !== 0) throw new CliError(`ship: git merge-base failed: ${lastLine(behind.stderr)}; nothing was shipped`);
  // commits integrated before orq removed tool or model credit: named, never blocking
  const log = git(['log', '-z', '--format=%H%n%B', `refs/remotes/origin/${base}..${p.green}`]);
  const credited = log.code === 0 ? creditedCommits(log.stdout) : [];
  return credited.length ? `note: ${credited.length} shipped commits credit a tool or model in their message (${credited.map((s) => s.slice(0, 12)).join(', ')}); orq removes it from commits it integrates from now on` : null;
}

// The `shipped` event, re-checked under the project lock: never a head older than the one shipped.
function record(ctx, p, url, n) {
  return commit(ctx.cwd, (s) => {
    if (s.plan.shipped === p.green) return [];
    if (!newerThanShipped(s.plan, p.green)) throw new CliError(`ship: ${p.green.slice(0, 12)} is not newer than the shipped head ${String(s.plan.shipped).slice(0, 12)}; not recorded`);
    return [{
      type: 'shipped', unit: null, at: ctx.now(), head: p.green, pr: url, n,
    }];
  });
}

// text: { title, body } from --title and --body-file, already checked
async function shipGreen(ctx, config, text) {
  const { plan: p } = await readState(ctx.cwd);
  const sha = p.green?.slice(0, 12);
  const idle = !p.green ? 'no integration head has passed the final checks yet' : p.green === p.shipped && `${sha} is shipped`;
  if (idle) {
    ctx.stdout.write(`nothing to ship: ${idle}; run "orq wait"\n`);
    return 0;
  }
  const ids = shipUnits(p);
  const plan = await readJson(planPath(ctx.cwd), null);
  const title = text.title ?? shipTitle(plan, ids);
  const credit = text.title ? null : creditIn(title); // the default title too: unit titles are written by hand
  if (credit) throw usage(`ship: the title made from the unit titles, "${title}", credits a tool or model ("${credit}"); pass --title; nothing was shipped`);
  const integrated = new Set(unitsIn(p, p.green)); // the head being shipped, not units integrated after it
  const base = config.base.replace(/^origin\//, '');
  const { git, gh } = tools(ctx);
  const credited = preflight(git, p, base);
  const { branch, n } = freeBranch(git, p.planId, (p.ships ?? 0) + 1, p.green);
  const pushed = git(['push', '--quiet', 'origin', `${p.green}:refs/heads/${branch}`]);
  if (pushed.code !== 0) throw new CliError(`ship: pushing ${sha} to ${branch} failed: ${lastLine(pushed.stderr)}; nothing was shipped; run "orq ship" again`);
  const url = openPr(gh, {
    base, branch, sha: p.green, title, body: shipBody(plan, ids, p.green, text.body, integrated),
  });
  const landed = git(['push', '--quiet', 'origin', `${p.green}:refs/heads/${base}`]); // never --force: git refuses a non-fast-forward
  if (landed.code !== 0) {
    throw new CliError(`ship: ${url} is open, but pushing ${sha} to ${base} failed: ${lastLine(landed.stderr)}; fix that and run "orq ship" again (it reuses the pull request)`);
  }
  const note = await confirmMerged(ctx, gh, url);
  await record(ctx, p, url, n);
  ctx.stdout.write(`shipped ${sha} as ${url}: ${ids.length} units\n${[note, credited].filter(Boolean).map((l) => `${l}\n`).join('')}`);
  return 0;
}

// --title and --body-file: the orchestrator's words for the pull request, checked before anything else
async function readText(flags, cwd) {
  const file = flags['body-file'];
  const body = file === undefined ? undefined : await fs.readFile(path.resolve(cwd, file), 'utf8').catch(() => {
    throw usage(`ship: --body-file ${file} cannot be read; nothing was shipped`);
  });
  const text = { title: flags.title?.trim(), body };
  const error = shipTextError({ title: flags.title, body });
  if (error) throw usage(error);
  return text;
}

export async function ship(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['title', 'body-file'] }, 'ship');
  if (positional.length) throw usage('ship: usage: ship [--title <text>] [--body-file <path>]');
  const text = await readText(flags, ctx.cwd);
  await assertNotArchiving(ctx.cwd);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (config.autonomy !== 'continuous') {
    throw new CliError(`ship: runs only in continuous mode (autonomy is ${config.autonomy ?? 'unset'}); "orq config set autonomy continuous" turns it on`, 4);
  }
  // the runner lock: no orq wait, archive or other ship runs meanwhile (git and gh run under it, never under the project lock)
  const file = runnerLockPath(ctx.cwd);
  try {
    return await withLock(file, () => shipGreen(ctx, config, text), { timeoutMs: 0 });
  } catch (e) {
    if (!String(e.message).startsWith(`lock busy: ${file}`)) throw e;
    const held = await readJson(file, null);
    throw new CliError(`ship: orq wait, orq plan archive or another orq ship is running (pid ${held?.pid ?? 'unknown'}); run "orq ship" when it is done`, 5);
  }
}
