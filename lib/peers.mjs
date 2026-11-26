// Cross-machine balance, kept simple. Each machine publishes its own status in ~/.t3orq/peers/self.json (pressure,
// free slots, protected services); a machine reads its peers' over ssh (machine config `peers`, a list of
// {host, ssh}) and caches each answer in ~/.t3orq/peers/<host>.json. orq never starts anything on a peer: it names
// the best one, and the orchestrator hands work over with T3's own tools (playbook, `balance:` row).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson, writeJsonAtomic } from './store.mjs';
import { peersDir } from './paths.mjs';
import { pressureText } from './pressure.mjs';
import { cleanQuota } from './easycli.mjs';

export const FRESH_MS = 5 * 60_000; // an older status says nothing about now
const READ_EVERY_MS = 60_000;
const RETRY_FAILED_MS = 5 * 60_000; // an unreachable peer is asked less often: each try can take the ssh timeout
const SSH_TIMEOUT_MS = 12_000;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,120}$/; // never an option: it cannot start with a dash
// The peer computes a fresh status (so one with no `orq wait` running still answers); an older kit serves its file.
export const REMOTE_COMMAND = 'node .t3orq/kit/bin/orq.mjs peers --self 2>/dev/null || cat .t3orq/peers/self.json';

export const selfPath = (env) => path.join(peersDir(env), 'self.json');

// quota: this machine's EasyCLI snapshot (quota.mjs localQuota), for peers that have no EasyCLI
export function selfStatus({
  host, now, facts, sample, held, since, holding, reasons, cap, active, services, quota,
}) {
  return {
    v: 1, host, at: now, cores: facts.cores, load: facts.load1 / facts.cores, pressure: sample ?? {}, held, since, holding, reasons,
    cap, active, free: held ? 0 : Math.max(0, cap - active), protect: Object.fromEntries(Object.entries(services).map(([k, s]) => [k, s.ok === true])),
    ...(quota ? { quota } : {}),
  };
}

const num = (v) => Number.isFinite(v);
const METRICS = ['cpu', 'io', 'mem', 'memLevel', 'busy'];
// A peer's answer is another machine's data, and what is shown of it reaches the orchestrator: only its numbers and
// booleans are kept, under names from this file. None of its text, not even a key. The one exception is its quota
// snapshot, rebuilt by easycli.mjs cleanQuota: known provider names, and account and window names of a strict charset.
// protectOk: read from a peer's answer (its `protect` map) or, for a status this file cached, the flag it stored.
function named(s, protectOk) {
  if (s === null || typeof s !== 'object' || ![s.at, s.cores, s.load, s.cap, s.active, s.free].every(num) || typeof s.held !== 'boolean' || typeof protectOk !== 'boolean') return null;
  const pressure = Object.fromEntries(METRICS.filter((k) => num(s.pressure?.[k])).map((k) => [k, s.pressure[k]]));
  const quota = cleanQuota(s.quota);
  return {
    at: s.at, cores: s.cores, load: s.load, cap: s.cap, active: s.active, free: s.free, held: s.held, pressure: { load: s.load, ...pressure }, protectOk, ...(quota ? { quota } : {}),
  };
}
export const cleanStatus = (raw) => named(raw, Object.values(raw?.protect && typeof raw.protect === 'object' ? raw.protect : {}).every((v) => v === true));
// A cached status, rebuilt the same way: a file that is not what this module wrote (a hand edit) gives null.
const cleanStatusKept = (s) => named(s, s?.protectOk);

// Why ssh failed, in this file's words: the text itself may come from the peer (its sshd banner, its shell).
const SSH_ERRORS = [
  [/permission denied/i, 'permission denied'], [/host key verification failed/i, 'host key not known'], [/timed out|timeout/i, 'timed out'],
  [/connection refused/i, 'connection refused'], [/could not resolve|name or service not known/i, 'host name not found'], [/no route to host|network is unreachable/i, 'no route'],
];
const sshError = (text) => SSH_ERRORS.find(([re]) => re.test(String(text ?? '')))?.[1] ?? 'ssh failed';
const NO_STATUS = 'no readable status (is the kit there at v0.17.0 or later?)';
const ERRORS = [...SSH_ERRORS.map(([, words]) => words), 'ssh failed', NO_STATUS]; // all a cache may say

// The status is the whole output (a file served by `cat`) or its last line (a shell that greets first).
function parseStatus(stdout) {
  const text = String(stdout ?? '').trim();
  for (const candidate of [text, text.split('\n').at(-1)]) {
    try {
      const status = cleanStatus(JSON.parse(candidate));
      if (status) return status;
    } catch { /* not JSON */ }
  }
  return null;
}

const defaultSsh = (target) => new Promise((resolve) => {
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', target, REMOTE_COMMAND], { timeout: SSH_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr: stderr || error?.message || '' }));
});

async function ask(peer, ssh, now) {
  let r;
  try {
    r = await ssh(peer.ssh);
  } catch (e) {
    r = { code: 1, stdout: '', stderr: e.message };
  }
  if (r.code !== 0) return { fetchedAt: now, ok: false, error: sshError(r.stderr) };
  const status = parseStatus(r.stdout);
  return status ? { fetchedAt: now, ok: true, status } : { fetchedAt: now, ok: false, error: NO_STATUS };
}

// a cache that is not what this file writes (a hand edit, another version) is asked again
const due = (c, now) => !c || typeof c !== 'object' || !num(c.fetchedAt) || now < c.fetchedAt || (c.ok === true && cleanStatusKept(c.status) === null)
  || now - c.fetchedAt >= (c.ok === true ? READ_EVERY_MS : RETRY_FAILED_MS);

// -> [{host, ok, status?, error?, fetchedAt}], one per configured peer, asked in parallel when its cache is due.
// cachedOnly: never ask; what the cache holds, however old (none: left out).
export async function readPeers(ctx, list, { cachedOnly = false } = {}) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const now = ctx.now();
  const ssh = ctx.deps?.ssh ?? defaultSsh;
  return Promise.all(list.map(async (peer) => {
    const file = path.join(peersDir(ctx.env), `${peer.host}.json`);
    const cached = await readJson(file, null).catch(() => null);
    if (cachedOnly && due(cached, now) && !(cached?.ok === true && cleanStatusKept(cached.status))) return null;
    if (!due(cached, now) || cachedOnly) {
      return cached.ok === true ? { host: peer.host, fetchedAt: cached.fetchedAt, ok: true, status: cleanStatusKept(cached.status) }
        : { host: peer.host, fetchedAt: cached.fetchedAt, ok: false, error: ERRORS.includes(cached.error) ? cached.error : 'ssh failed' };
    }
    const fresh = await ask(peer, ssh, now);
    await writeJsonAtomic(file, fresh).catch(() => {}); // asked again on the next read
    return { host: peer.host, ...fresh };
  })).then((all) => all.filter(Boolean));
}

// its own clock dates the status: one from the future is as untrusted as an old one
const fresh = (s, now) => Math.abs(now - s.at) < FRESH_MS;
const usable = (p, now) => p.ok === true && fresh(p.status, now) && !p.status.held && p.status.free > 0 && p.status.protectOk;

// The least-loaded peer that can take work now, or null.
export function pickPeer(peers, now) {
  return peers.filter((p) => usable(p, now)).sort((a, b) => a.status.load - b.status.load || b.status.free - a.status.free)[0] ?? null;
}

export function peerText(p, now) {
  if (!p.ok) return `${p.host} unreachable (${p.error})`;
  const s = p.status;
  if (!fresh(s, now)) return `${p.host} stale (status ${Math.floor(Math.abs(now - s.at) / 60_000)} min ${now >= s.at ? 'old' : 'ahead of this clock'})`;
  return `${p.host} ${s.held ? 'HELD' : 'ok'} free=${s.free}/${s.cap} ${pressureText(s.pressure)}${s.protectOk ? '' : ' protect=failing'}`;
}

// A stored `peers` value: why it is invalid, or null.
export function peersError(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return 'peers must be a list of {host, ssh}';
  const seen = new Set();
  for (const p of v) {
    if (!HOST.test(p?.host ?? '') || p.host === 'self') return 'peers: host must be a short name of letters, digits, dots, dashes or underscores (not "self")';
    if (seen.has(p.host)) return `peers: duplicate host "${p.host}"`;
    seen.add(p.host);
    if (!TARGET.test(p.ssh ?? '')) return `peers: ${p.host}: ssh must be an ssh target such as user@host or a Host from ~/.ssh/config`;
  }
  return null;
}
