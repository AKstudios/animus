// Moves a Helix machine to the release stable points at:
// node scripts/deploy.ts <ssh-host> [--dir <checkout>]
//
// It runs `helix upgrade --follow` there over ssh (docs/releases.md):
// nothing when the machine is already on it, and refused while an upgrade is
// under way. --dir: the checkout of Animus there,
// relative to the account's home; animus unless given.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export function deploy(host: string, dir = 'animus'): number {
  console.log(`deploying to ${host}: helix upgrade --follow`);
  const r = spawnSync('ssh', [host, `${dir}/helix/bin/helix`, 'upgrade', '--follow'], { stdio: 'inherit' });
  if (r.error) { console.error(`deploy: ssh did not start: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

function main(): number {
  const usage = () => { console.error('usage: node scripts/deploy.ts <ssh-host> [--dir <checkout>]'); return 1; };
  let args;
  try { args = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' } } }); } catch { return usage(); }
  const host = args.positionals[0];
  return host && args.positionals.length === 1 ? deploy(host, args.values.dir) : usage();
}

if (import.meta.main) process.exit(main());
