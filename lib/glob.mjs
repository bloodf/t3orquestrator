const nonEmpty = (v) => typeof v === 'string' && v !== '';

export function globToRegExp(glob) {
  if (!nonEmpty(glob)) throw new Error('glob must be a non-empty string');
  let re = '';
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; } else if (glob.startsWith('**', i)) { re += '.*'; i += 2; } else if (glob[i] === '*') { re += '[^/]*'; i += 1; } else if (glob[i] === '?') { re += '[^/]'; i += 1; } else { re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  if (!nonEmpty(path)) throw new Error('path must be a non-empty string');
  if (!Array.isArray(globs)) throw new Error('globs must be an array');
  return globs.some((g) => globToRegExp(g).test(path));
}
