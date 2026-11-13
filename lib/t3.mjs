// The only module that knows the T3 CLI. Parsers validate what they depend on so drift fails loudly.
import { spawnSync } from 'node:child_process';

const ACTIVE = ['queued', 'preparing', 'starting', 'running'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

export function resolveT3Bin({ env, homedir, exists }) {
  if (env.T3CODE_CLI_PATH && exists(env.T3CODE_CLI_PATH)) return env.T3CODE_CLI_PATH;
  const home = `${homedir}/.t3/bin/t3`;
  return exists(home) ? home : 't3';
}

export function ownThreadId(env) {
  return env.T3CODE_THREAD_ID || null;
}

export function defaultExec(bin, args, { input, cwd } = {}) {
  const r = spawnSync(bin, args, {
    input, cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, // a worker's reply can carry a large diff
  });
  if (r.error) throw new Error(`failed to run ${bin}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function status(s) {
  if (!ACTIVE.includes(s) && !TERMINAL.includes(s)) throw new Error(`unknown thread status: ${s}`);
}

export function needsShow(t) {
  status(t.status);
  return ACTIVE.includes(t.status) && t.pending === null;
}

function knownPending(t) {
  if (needsShow(t)) throw new Error(`pending unknown for thread ${t.id}; call showThread first`);
}

export function isActive(t) {
  knownPending(t);
  return ACTIVE.includes(t.status) && t.pending === 0;
}

export function isBlocked(t) {
  knownPending(t);
  return ACTIVE.includes(t.status) && t.pending > 0;
}

export function isTerminal(t) {
  status(t.status);
  return TERMINAL.includes(t.status);
}

function need(cmd, obj, field, type = 'string') {
  const v = obj?.[field];
  const ok = type === 'string' ? typeof v === 'string' && v !== '' : typeof v === type;
  if (!ok) throw new Error(`${cmd}: missing or invalid field "${field}"`);
  return v;
}

function normalizeThread(cmd, t) {
  if (!t || typeof t !== 'object') throw new Error(`${cmd}: thread entry is not an object`);
  const updatedAt = Date.parse(need(cmd, t, 'updatedAt'));
  if (Number.isNaN(updatedAt)) throw new Error(`${cmd}: invalid field "updatedAt"`);
  const out = {
    id: need(cmd, t, 'threadId'),
    projectId: need(cmd, t, 'projectId'),
    status: need(cmd, t, 'status'),
    instance: t.providerInstanceId ?? null,
    model: t.model ?? null,
    itemCount: need(cmd, t, 'itemCount', 'number'),
    updatedAt,
    pending: t.pendingRequestCount ?? null,
    runCount: t.runCount ?? null,
    activeRunId: t.activeRunId ?? null,
    worktreePath: t.worktreePath ?? null,
    branch: t.branch ?? null,
    title: t.title ?? null,
  };
  if (out.pending !== null && typeof out.pending !== 'number') throw new Error(`${cmd}: invalid field "pendingRequestCount"`);
  status(out.status);
  return out;
}

function parseJson(cmd, stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${cmd}: invalid JSON: ${stdout.slice(0, 200)}`);
  }
}

export function createT3({ bin, exec }) {
  function run(cmd, args, input) {
    const r = exec(bin, args, { input });
    if (r.code !== 0) {
      const err = new Error(`${cmd} failed (exit ${r.code}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      err.code = r.code;
      throw err;
    }
    return r.stdout;
  }
  const json = (cmd, args, input) => parseJson(cmd, run(cmd, args, input));

  return {
    version() {
      return run('version', ['--version']).trim().replace(/^t3\s+/, '');
    },
    listThreads({ project }) {
      const cmd = 'thread list';
      const rows = json(cmd, ['thread', 'list', '--project', project, '--json']);
      if (!Array.isArray(rows)) throw new Error(`${cmd}: expected a JSON array`);
      return rows.map((t) => normalizeThread(cmd, t));
    },
    showThread(id, { messages = 1 } = {}) {
      const cmd = 'thread show';
      const r = json(cmd, ['thread', 'show', id, '--messages', String(messages), '--json']);
      if (!Array.isArray(r?.messages)) throw new Error(`${cmd}: missing or invalid field "messages"`);
      return { thread: normalizeThread(cmd, r.thread), messages: r.messages };
    },
    startThread({ project, message, provider, model, worktree, branch, title }) {
      const cmd = 'thread start';
      if (Boolean(provider) !== Boolean(model)) throw new Error('provider and model must be given together');
      const args = ['thread', 'start', project, '-'];
      if (provider) args.push('--provider', provider, '--model', model);
      if (worktree) args.push('--worktree', worktree);
      if (branch) args.push('--branch', branch);
      if (title) args.push('--title', title);
      args.push('--json');
      const r = json(cmd, args, message);
      return { threadId: need(cmd, r, 'threadId'), projectId: need(cmd, r, 'projectId'), runId: need(cmd, r, 'runId') };
    },
    sendThread(id, message) {
      const cmd = 'thread send';
      const r = json(cmd, ['thread', 'send', id, '-', '--json'], message);
      return {
        threadId: need(cmd, r, 'threadId'),
        runId: need(cmd, r, 'runId'),
        status: need(cmd, r, 'status'),
        delivery: need(cmd, r, 'delivery'),
      };
    },
  };
}
