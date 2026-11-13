import fs from 'node:fs';
import { kitFor } from './kit-info.mjs';
import { short } from '../kit.mjs';
import { parseFlags } from './common.mjs';

export function version(args, ctx) {
  parseFlags(args, {}, 'version');
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const kit = kitFor(ctx);
  const head = kit.isCheckout() ? kit.head() : null;
  const tag = head ? kit.tagAt(head) : null;
  ctx.stdout.write(`orq ${pkg.version} kit=${head ? short(head) : 'unknown'}${tag ? ` tag=${tag}` : ''}\n`);
  return 0;
}
