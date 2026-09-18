// prcoder's own command line. Everything after the first `--` is the agent's,
// untouched; everything before it is ours and parsed strictly, so a flag's
// value is never read as a PR target and an agent flag in the wrong place is
// an error that says where it goes, not a session started with the wrong PR.

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

export const VERSION = createRequire(import.meta.url)('./package.json').version;

// ponytail: one entry. The name is what #21 (a channel for the agent to drive
// prcoder) and #30 (other agents) key per-agent behaviour off; CLAUDE_BIN still
// picks the executable.
export const AGENTS = ['claude'];

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  agent: { type: 'string', default: 'claude' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
};

export function usage() {
  return `usage: prcoder [<pr>] [--port <n>] [--no-open] [-v] [--agent <name>] [-- <agent args>]

  <pr>             a pull request number, URL or branch (default: the current branch's)
  --port <n>       listen on this port for this run          env PRCODER_PORT
  --no-open        print the URL, don't open a browser        env PRCODER_NO_OPEN=1
  -v, --verbose    narrate; -vv for debug                     env PRCODER_VERBOSE=1|2
  --agent <name>   the coding agent: ${AGENTS.join(', ')}              env CLAUDE_BIN names the executable
  -h, --help       -V, --version

Everything after -- goes to the agent untouched:
  prcoder 42 --port 4000 -- --effort high --model fable

PRCODER_OPEN=<cmd> opens the URL with a command of your own instead of the platform's.`;
}

export function parseCli(argv) {
  const cut = argv.indexOf('--');
  const mine = cut < 0 ? argv : argv.slice(0, cut);
  const agentArgs = cut < 0 ? [] : argv.slice(cut + 1);
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: mine, options: OPTIONS, allowPositionals: true }));
  } catch (e) {
    // Node's own hint is about positionals ("place it after '--'"); ours is
    // about the agent, which is what a stray --effort almost always is.
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const flag = /^Unknown option '([^']+)'/.exec(e.message)?.[1] ?? '?';
      throw new Error(`unknown option ${flag}; flags for the agent go after --, as in: prcoder [pr] -- ${flag} …`);
    }
    if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw new Error(e.message);
    throw e;
  }
  if (positionals.length > 1) {
    throw new Error(`unexpected argument ${positionals[1]}; one pull request at most, and flags for the agent go after --`);
  }
  if (!AGENTS.includes(values.agent)) throw new Error(`unknown agent ${values.agent}; supported: ${AGENTS.join(', ')}`);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error(`--port wants a port number, not ${values.port}`);
  }
  return {
    target: positionals[0],
    agent: values.agent,
    agentArgs,
    port,
    noOpen: !!values['no-open'],
    verbose: values.verbose?.length ?? 0,
    help: !!values.help,
    version: !!values.version,
  };
}
