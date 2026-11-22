// orq peers: this machine's own status and what its peers say (peers.mjs). `--self` prints the status as JSON and
// publishes it: it is what a peer runs here over ssh. Also the `pressure:`, `protect:` and `peers:` lines of `orq status`.
import { loadMachineConfig } from '../config.mjs';
import { machineConfigPath } from '../paths.mjs';
import { holdText, machineAdmission } from '../admission.mjs';
import { pressureText } from '../pressure.mjs';
import { protectText } from '../protect.mjs';
import { peerText, pickPeer, readPeers } from '../peers.mjs';
import { parseFlags } from './common.mjs';

// -> {lines, json}. Display only: anything that cannot be read is said in a note, never an error.
export async function admissionView(ctx) {
  try {
    const machine = await loadMachineConfig(machineConfigPath(ctx.env));
    const a = await machineAdmission(ctx, machine);
    const peers = await readPeers(ctx, machine.peers);
    const now = ctx.now();
    const best = a.held ? pickPeer(peers, now) : null;
    const lines = [
      ...(a.sample || a.held ? [`pressure: ${pressureText(a.sample)} ${a.held ? `HELD, nothing new starts: ${holdText(a, now)}` : 'ok'}`] : []),
      ...(Object.keys(a.services).length ? [`protect: ${protectText(a.services)}`] : []),
      ...(peers.length ? [`peers: ${peers.map((p) => peerText(p, now)).join('; ')}${best ? `; least loaded with room: ${best.host}` : ''}`] : []),
    ];
    return { lines, json: { machine: { held: a.held, since: a.since, reasons: a.reasons, pressure: a.sample, protect: Object.fromEntries(Object.entries(a.services).map(([k, { url: _url, ...rest }]) => [k, rest])), peers } } }; // a URL may carry a credential
  } catch (e) {
    return { lines: [`note: this machine's pressure and peers could not be read: ${String(e.message).split('\n')[0]}`], json: {} };
  }
}

export async function peers(args, ctx) {
  const { flags } = parseFlags(args, { bool: ['self', 'json'] }, 'peers');
  if (flags.self) { // never asks this machine's own peers: two machines that name each other would ask in a circle
    ctx.stdout.write(`${JSON.stringify((await machineAdmission(ctx)).status)}\n`);
    return 0;
  }
  const view = await admissionView(ctx);
  ctx.stdout.write(flags.json ? `${JSON.stringify(view.json.machine ?? null)}\n` : `${(view.lines.length ? view.lines : ['pressure: not read; no protected services; no peers']).join('\n')}\n`);
  return 0;
}
