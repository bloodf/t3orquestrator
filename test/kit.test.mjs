import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../lib/cli.mjs';
import { defaultExec } from '../lib/git.mjs';
import { createKit } from '../lib/kit.mjs';

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// origin (bare) <- dev (author clone) -> kit (clone the CLI would run from)
async function world(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-kit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [origin, dev, kit] = ['origin.git', 'dev', 'kit'].map((n) => path.join(root, n));
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, dev);
  git(dev, 'config', 'user.name', 'T'); git(dev, 'config', 'user.email', 't@example.invalid');
  const commit = async (name, tag) => {
    await fs.writeFile(path.join(dev, name), name);
    git(dev, 'add', '-A'); git(dev, 'commit', '-q', '-m', name);
    if (tag) git(dev, 'tag', tag);
    git(dev, 'push', '-q', 'origin', 'HEAD:main', '--tags');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const first = await commit('one', 'v0.9.0');
  git(root, 'clone', '-q', origin, kit);
  git(kit, 'checkout', '-q', '--detach', first);
  return { root, dev, kit, first, commit };
}

async function orq(args, w, deps = {}) {
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { T3ORQ_HOME: path.join(w.root, 'home') }, cwd: w.root,
    now: () => 1, deps: { kitDir: w.kit, gitExec: defaultExec, ...deps },
  });
  return { code, out: out.join(''), err: err.join('') };
}
const s12 = (s) => s.slice(0, 12);

test('version: package version, kit sha and tag; unknown outside a checkout', async (t) => {
  const w = await world(t);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await orq(['version'], w)).out, `orq ${pkg.version} kit=${s12(w.first)} tag=v0.9.0\n`);
  const plain = await fs.mkdtemp(path.join(w.root, 'plain-'));
  assert.equal((await orq(['version'], w, { kitDir: plain })).out, `orq ${pkg.version} kit=unknown\n`);
});

test('update: picks the highest tag numerically, --check does not move', async (t) => {
  const w = await world(t);
  await w.commit('two', 'v0.10.0');
  const third = await w.commit('three', 'v0.2.0');
  const check = await orq(['update', '--check'], w);
  assert.equal(check.code, 0, check.err);
  const ten = git(w.dev, 'rev-parse', 'v0.10.0^{commit}');
  assert.equal(check.out, `update available: ${s12(w.first)} -> ${s12(ten)} (v0.10.0)\n`);
  assert.equal(git(w.kit, 'rev-parse', 'HEAD'), w.first);
  const up = await orq(['update'], w);
  assert.equal(up.out, `updated: ${s12(w.first)} -> ${s12(ten)} (v0.10.0)\nreview the changes: git -C ${w.kit} log --oneline ${s12(w.first)}..${s12(ten)}\nrunning orchestrators are told on their next "orq wait"\n`);
  assert.equal(git(w.kit, 'rev-parse', 'HEAD'), ten);
  assert.equal((await orq(['update'], w)).out, `up to date at ${s12(ten)}\n`);
  assert.ok(third);
});

test('update --to: a sha, an existing tag, and nonsense', async (t) => {
  const w = await world(t);
  const two = await w.commit('two', 'v1.0.0');
  const bySha = await orq(['update', '--to', two], w);
  assert.match(bySha.out, new RegExp(`^updated: ${s12(w.first)} -> ${s12(two)} \\(v1\\.0\\.0\\)\\n`));
  const back = await orq(['update', '--to', 'v0.9.0'], w);
  assert.match(back.out, new RegExp(`^moved \\(not a fast-forward\\): ${s12(two)} -> ${s12(w.first)}\\n`));
  for (const bad of ['main; rm -rf x', '--force', 'nope', 'abc123']) {
    const r = await orq(['update', '--to', bad], w);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /update: --to must be/);
  }
});

test('update: no tags, dirty kit, not a checkout', async (t) => {
  const w = await world(t);
  git(w.dev, 'tag', '-d', 'v0.9.0'); git(w.dev, 'push', '-q', 'origin', ':refs/tags/v0.9.0');
  git(w.kit, 'tag', '-d', 'v0.9.0');
  const none = await orq(['update'], w);
  assert.equal(none.code, 4);
  assert.match(none.err, /update: no release is tagged yet; use --to <sha>/);
  await fs.writeFile(path.join(w.kit, 'one'), 'edited');
  const dirty = await orq(['update', '--to', w.first], w);
  assert.equal(dirty.code, 4);
  assert.match(dirty.err, /update: kit has local changes; not touching it/);
  const plain = await fs.mkdtemp(path.join(w.root, 'plain-'));
  const not = await orq(['update'], w, { kitDir: plain });
  assert.equal(not.code, 4);
  assert.match(not.err, /update: kit is not a git checkout/);
});

test('update: git calls are hardened and use --end-of-options', async (t) => {
  const w = await world(t);
  const calls = [];
  await orq(['update', '--check'], w, { gitExec: (c, a, o) => { calls.push(a); return defaultExec(c, a, o); } });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((a) => a.includes('core.hooksPath=/dev/null') && a.includes('core.fsmonitor=false')));
  assert.ok(calls.some((a) => a.includes('--end-of-options')));
});

test('update: never downgrades without --to; --check reports the same cases', async (t) => {
  const w = await world(t);
  const ahead = await w.commit('two');
  git(w.kit, 'fetch', '-q', '--tags', 'origin');
  git(w.kit, 'checkout', '-q', '--detach', ahead);
  const refused = await orq(['update'], w);
  assert.equal(refused.code, 4);
  assert.match(refused.err, new RegExp(`update: ${s12(w.first)} \\(v0\\.9\\.0\\) is not ahead of the current commit ${s12(ahead)}; nothing to do\\. Use --to to move anyway\\.`));
  assert.equal((await orq(['update', '--check'], w)).code, 4);
  assert.equal(git(w.kit, 'rev-parse', 'HEAD'), ahead);
  const would = await orq(['update', '--check', '--to', 'v0.9.0'], w);
  assert.equal(would.out, `would move (not a fast-forward): ${s12(ahead)} -> ${s12(w.first)}\n`);
  assert.equal(git(w.kit, 'rev-parse', 'HEAD'), ahead);
  const moved = await orq(['update', '--to', 'v0.9.0'], w);
  assert.equal(moved.out, `moved (not a fast-forward): ${s12(ahead)} -> ${s12(w.first)}\nreview the changes: git -C ${w.kit} log --oneline ${s12(ahead)}..${s12(w.first)}\nrunning orchestrators are told on their next "orq wait"\n`);
  assert.equal((await orq(['update', '--to', 'v0.9.0'], w)).out, `up to date at ${s12(w.first)}\n`);
});

test('update --check works on a dirty kit; moving does not', async (t) => {
  const w = await world(t);
  const two = await w.commit('two', 'v1.0.0');
  await fs.writeFile(path.join(w.kit, 'one'), 'edited');
  const check = await orq(['update', '--check'], w);
  assert.equal(check.code, 0, check.err);
  assert.equal(check.out, `update available: ${s12(w.first)} -> ${s12(two)} (v1.0.0)\n`);
  assert.equal((await orq(['update'], w)).code, 4);
});

test('update: a kit on a branch is told it is now detached', async (t) => {
  const w = await world(t);
  const two = await w.commit('two', 'v1.0.0');
  git(w.kit, 'checkout', '-q', 'main');
  git(w.kit, 'reset', '-q', '--hard', w.first);
  const r = await orq(['update'], w);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`note: kit was on branch main; now detached at ${s12(two)}\\n`));
});

test('update: an unreachable origin is a clean error and leaves the kit alone', async (t) => {
  const w = await world(t);
  git(w.kit, 'remote', 'set-url', 'origin', path.join(w.root, 'nowhere.git'));
  const r = await orq(['update'], w);
  assert.equal(r.code, 4);
  assert.match(r.err, /^orq: update: could not reach the kit's origin \(.+\)\n$/);
  assert.equal(git(w.kit, 'rev-parse', 'HEAD'), w.first);
});

test('isDirty: a failed git status counts as dirty', () => {
  const kit = createKit({ exec: () => ({ code: 128, stdout: '', stderr: 'broken' }), dir: '/x' });
  assert.equal(kit.isDirty(), true);
});
