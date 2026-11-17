// Gate checkouts no gate uses any more: .orq/gate/<unit>, and the <unit>.gate-<pid>-<ms> a gate made beside it
// when that one could not be cleared. Removed with their links (never a link's target); see cleanup.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { unitOf } from './ledger.mjs';
import { lastSafeLine, pidAlive } from './gaterun.mjs';
import { diskBytes } from './salvage.mjs';
import { projectDir, unitDir } from './paths.mjs';

// Unless a gate of that unit may be running.
function gateBusy(cwd, state, name) {
  const m = /^(.*)\.gate-(\d+)-\d+$/.exec(name);
  const unit = m ? m[1] : name;
  if ((m && pidAlive(Number(m[2]))) || unitOf(state, unit).state === 'gating') return true;
  let pids = [];
  try {
    pids = fs.readdirSync(unitDir(cwd, unit)).filter((f) => /^gate-\d+\.pid$/.test(f));
  } catch {
    return false;
  }
  return pids.some((f) => {
    let text;
    try {
      text = fs.readFileSync(path.join(unitDir(cwd, unit), f), 'utf8');
    } catch {
      return false; // gone since the listing: that gate finished
    }
    const pid = Number(text.trim());
    return !(pid > 0) || pidAlive(pid); // an empty pid file: a gate being started
  });
}

export function gateLeftovers(cwd, state) {
  const root = path.join(projectDir(cwd), 'gate');
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => !gateBusy(cwd, state, n)).map((n) => path.join(root, n));
}

export function removeGate(dir, measure = true) {
  const bytes = measure ? diskBytes(dir) : 0;
  try {
    fs.rmSync(dir, { recursive: true, force: true }); // a shared dependency link goes as a link, never its target
    return { path: dir, bytes };
  } catch (e) {
    return { error: lastSafeLine(e.message) };
  }
}
