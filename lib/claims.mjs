// Plan claims: a plan names the issues and pull requests it works on (`claims` in plan.json, numbers), so two
// orchestrators on one repository, on this machine or a peer, do not build the same thing twice. Notes, never stops.
// `orq plan check` registers the project in <T3ORQ_HOME>/claims/ (its path and repository); claims are always read
// from the live plan.json, so an archived or rewritten plan claims nothing more. `orq peers --self` publishes this
// machine's claims as "owner/repo#N" for its peers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homeDir, planPath } from './paths.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { defaultExec as gitExec } from './git.mjs';

export const CLAIM = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d{0,9}$/;
const MAX_CLAIMS = 500;
const claimsDir = (env) => path.join(homeDir(env), 'claims');
const fileOf = (env, cwd) => path.join(claimsDir(env), `${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);

// A plan's `claims`: why it is invalid, or null.
export function claimsError(v) {
  if (v === undefined) return null;
  return Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0) ? null : 'claims must be a list of issue or pull request numbers';
}

// "owner/repo" from origin's URL (https or ssh), or the folder name when there is no origin.
export function repoOf(cwd, exec = gitExec) {
  try {
    const r = exec('git', ['remote', 'get-url', 'origin'], { cwd });
    const m = r.code === 0 && /[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(r.stdout.trim());
    if (m) return m[1];
  } catch { /* no git */ }
  return `local/${path.basename(path.resolve(cwd)).replace(/[^A-Za-z0-9_.-]/g, '-') || 'project'}`;
}

const planClaims = async (cwd) => {
  const plan = await readJson(planPath(cwd), null).catch(() => null);
  return claimsError(plan?.claims) === null ? [...new Set(plan?.claims ?? [])] : [];
};

export async function registerProject(env, cwd, repo) {
  await writeJsonAtomic(fileOf(env, cwd), { project: path.resolve(cwd), repo });
}

// -> [{project, claim}] for every registered project on this machine, its claims read now
export async function localClaims(env) {
  const names = await fs.readdir(claimsDir(env)).catch(() => []);
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const rec = await readJson(path.join(claimsDir(env), n), null).catch(() => null);
    if (typeof rec?.project !== 'string' || typeof rec.repo !== 'string') continue;
    for (const num of await planClaims(rec.project)) {
      const claim = `${rec.repo}#${num}`;
      if (CLAIM.test(claim)) out.push({ project: rec.project, claim });
    }
  }
  return out;
}

// What this machine publishes: its claims, deduplicated.
export const selfClaims = async (env) => [...new Set((await localClaims(env)).map((c) => c.claim))].sort().slice(0, MAX_CLAIMS);

// A peer's list, kept only as far as it matches the claim pattern (it is another machine's text).
export const cleanClaims = (v) => (Array.isArray(v) ? v.filter((c) => typeof c === 'string' && CLAIM.test(c)).slice(0, MAX_CLAIMS) : []);

// Warnings for `orq plan check`: each of this plan's claims another orchestrator holds too.
// peers: readPeers' answers (status.claims)
export function overlapWarnings({ cwd, repo, claims, local, peers }) {
  const mine = new Set((claims ?? []).map((n) => `${repo}#${n}`));
  const here = path.resolve(cwd);
  const by = [
    ...local.filter((c) => c.project !== here).map((c) => ({ claim: c.claim, who: `the orchestrator in ${c.project}` })),
    ...peers.filter((p) => p.ok).flatMap((p) => (p.status.claims ?? []).map((claim) => ({ claim, who: `an orchestrator on ${p.host}` }))),
  ];
  return by.filter((b) => mine.has(b.claim)).map((b) => `claim ${b.claim} is also claimed by ${b.who}; check it is not the same work before it starts`);
}
