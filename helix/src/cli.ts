// The helix command, run on the machine that runs the jobs.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AnimusError } from '../../plugin/src/proc.ts';
import { addPerson, addRepo, configFile, helixHome, loadConfig } from './config.ts';
import { serve } from './server.ts';
import { openStore } from './store.ts';
import { supervise } from './supervisor.ts';

const USAGE = `helix: runs Animus jobs for several people on one machine

  helix serve
        Listen for submissions and run them, as many at once as config.yaml's slots.
  helix add-repo <name> <dir>
        A clone on this machine that jobs may be submitted for.
  helix add-person <name> [--env-file <file>]
        Let a person submit, and print their token once. The file holds
        KEY=VALUE lines set for their jobs only (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN).
        Run again to give them a new token.

Its files are under ${helixHome()} (HELIX_HOME).`;

function main(argv: string[]): number | undefined {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'env-file': { type: 'string' } } });
  switch (command) {
    case 'serve': {
      const config = loadConfig();
      if (!Object.keys(config.people).length || !Object.keys(config.repos).length) throw new AnimusError(`${configFile()} names no ${Object.keys(config.repos).length ? 'people' : 'repositories'} yet: helix add-repo and helix add-person come first`);
      const home = helixHome();
      const store = openStore(join(home, 'helix.db'));
      const supervisor = supervise({ store, config, home, say: (line) => console.error(`${new Date().toISOString().slice(0, 19)} ${line}`) });
      const server = serve({ config, store, supervisor });
      server.listen(config.port, config.host, () => console.error(`helix: listening on http://${config.host}:${config.port}, ${config.slots} job(s) at once, repositories: ${Object.keys(config.repos).join(', ')}`));
      const stop = () => { supervisor.stop(); server.close(); store.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return undefined;
    }
    case 'add-repo':
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: helix add-repo <name> <dir>');
      addRepo(positionals[0], positionals[1]);
      console.log(`${positionals[0]} added to ${configFile()}`);
      return 0;
    case 'add-person': {
      if (!positionals[0]) throw new AnimusError('usage: helix add-person <name> [--env-file <file>]');
      const token = addPerson(positionals[0], values['env-file']);
      console.log(`${positionals[0]}'s token, shown this once:\n\n  ${token}\n\nThey set HELIX_URL and HELIX_TOKEN, then: animus submit <spec.md>`);
      return 0;
    }
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return 0;
    default:
      throw new AnimusError(`unknown command ${command}\n\n${USAGE}`);
  }
}

try {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
} catch (err) {
  if (!(err instanceof AnimusError)) throw err;
  console.error(`helix: ${err.message}`);
  process.exit(2);
}
