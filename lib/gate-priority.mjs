// Gate steps run at low CPU and I/O priority, so a machine's gates never starve its agents or a service it hosts:
// `ionice -c2 -n7 nice -n10` on Linux, `taskpolicy -b` (background: throttled I/O, efficiency cores) on macOS.
// Machine config `gatePriority`: unset = this default when the tools are there, false = off, a list = the argv prefix.
// Each tool execs the next, so the step's shell keeps the process group orq kills when the step ends.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  linux: [['ionice', '-c2', '-n7'], ['nice', '-n10']],
  darwin: [['taskpolicy', '-b']],
};

const onPath = (env = process.env) => (cmd) => (env.PATH ?? '').split(path.delimiter).some((dir) => {
  try {
    fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

// -> the argv prefix for gate steps ([] for none). A default tool that is not installed is left out.
export function gatePrefix(setting, { platform = process.platform, has = onPath() } = {}) {
  if (setting === false) return [];
  if (Array.isArray(setting)) return setting;
  return (DEFAULTS[platform] ?? []).filter(([cmd]) => has(cmd)).flat();
}

// A stored `gatePriority` value: why it is invalid, or null.
export function gatePriorityError(v) {
  if (v === undefined || v === false) return null;
  const ok = Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' && a !== '' && !a.includes('\0'));
  return ok ? null : 'gatePriority must be false or a non-empty list of strings (the command prefix, e.g. ["nice","-n10"])';
}
