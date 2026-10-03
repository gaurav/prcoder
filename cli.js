// What prcoder takes and shows at the command line: its own flags, the port a
// repo gets, and the status block pinned under the log.
//
// Everything after the first `--` is the agent's, untouched; everything before
// it is ours and parsed strictly, so a flag's value is never read as a PR
// target and an agent flag in the wrong place is an error that says where it
// goes, not a session started with the wrong PR.
//
// All of it pure, so test/cli.test.js checks it without starting a server;
// server.js does the listening and term.js does the drawing.

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { syncPhrase } from './public/pr.js';
import { counts } from './public/items.js';

export const VERSION = createRequire(import.meta.url)('./package.json').version;

// ponytail: one entry. The name is what #21 (a channel for the agent to drive
// prcoder) and #30 (other agents) key per-agent behaviour off;
// PRCODER_AGENT_BIN still picks the executable.
export const AGENTS = ['claude'];

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  agent: { type: 'string', default: 'claude' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  queue: { type: 'string' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
};

export function usage() {
  return `usage: prcoder [<pr>] [--port <n>] [--no-open] [--queue <file>] [-v] [--agent <name>] [-- <agent args>]

  <pr>             a pull request number, URL or branch (default: the current branch's)
  --port <n>       listen on this port for this run          env PRCODER_PORT
  --no-open        print the URL, don't open a browser        env PRCODER_NO_OPEN=1
  --queue <file>   keep the queue here, not .prcoder/        env PRCODER_QUEUE
  -v, --verbose    narrate; -vv for debug                     env PRCODER_VERBOSE=1|2
  --agent <name>   the coding agent: ${AGENTS.join(', ')}              env PRCODER_AGENT_BIN names the executable
  -h, --help       -V, --version

Everything after -- goes to the agent untouched:
  prcoder 42 --port 4000 -- --effort high --model fable

PRCODER_BROWSER=<cmd> opens the URL with a command of your own instead of the platform's,
PRCODER_TERMINAL=<cmd> is the terminal t opens, and PRCODER_OPEN=<cmd> what f opens the repo with.`;
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
  if (values.queue === '') throw new Error('--queue wants a file path');
  return {
    target: positionals[0],
    agent: values.agent,
    agentArgs,
    port,
    noOpen: !!values['no-open'],
    queue: values.queue,
    verbose: values.verbose?.length ?? 0,
    help: !!values.help,
    version: !!values.version,
  };
}

/**
 * Where a repo's port starts from: a hash of its path, so the first run in a
 * clone picks a port of its own without asking anyone. What the repo then
 * *uses* is `.prcoder/port.json` -- see listenOnRepoPort() in server.js. This
 * stays pure so the seed can be checked without a disk.
 *
 * The range is above 10080 on purpose. Browsers refuse a fixed list of
 * well-known ports outright, and Firefox says only "This address is
 * restricted" -- nothing on screen connects that to prcoder, and the old
 * 1618-2617 range held four of them (1719, 1720, 1723, 2049). The list is the
 * WHATWG fetch standard's, shared by Firefox, Chrome and Safari, and 10080 is
 * its highest entry. macOS hands out ephemeral ports from 49152, so 10240-14335
 * is clear at both ends.
 */
export const PORT_BASE = 10240;
export const PORT_SPAN = 4096;

export function portFor(repo) {
  return PORT_BASE + createHash('sha1').update(repo).digest().readUInt16BE(0) % PORT_SPAN;
}

/**
 * Every port in the range, starting at this repo's seed and wrapping. Only a
 * first run walks past the first entry, and only until something binds.
 */
export function portCandidates(repo) {
  const first = portFor(repo) - PORT_BASE;
  return Array.from({ length: PORT_SPAN }, (_, n) => PORT_BASE + (first + n) % PORT_SPAN);
}

/**
 * How long ago the block was last true. Nothing under two minutes, because a
 * poll runs every sixty seconds and an age that is always on screen is an age
 * nobody reads.
 */
export const ago = (ms) => {
  if (!(ms >= 120_000)) return null;
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `checked ${mins}m ago` : `checked ${Math.round(mins / 60)}h ago`;
};

/**
 * The block pinned under the log: everything status() worked out anyway, for
 * the terminal that is otherwise sat idle for the whole session. Pure, so the
 * wording is testable without a tty.
 */
export function statusLines(s, u = {}) {
  // padEnd, not a slice: a label longer than the column has to push the row out
  // rather than lose its tail, or `PR #10000` prints as a real-looking `PR #1000`.
  const row = (label, ...rest) => `${label.padEnd(8)} ${rest.filter(Boolean).join('   ')}`;
  // The same predicates the pane's tabs use, so the block and the tab strip
  // cannot report the queue differently.
  const q = counts(s.queue ?? []);

  return [
    row('prcoder', s.nameWithOwner,
      s.branch ? `${s.branch} → ${s.pr?.baseRefName ?? s.defaultBranch}` : 'detached HEAD',
      [syncPhrase(s), s.dirtyFiles?.length && `${s.dirtyFiles.length} uncommitted`]
        .filter(Boolean).join(' · ')),
    s.pr ? row(`PR #${s.pr.number}`, s.pr.title) : row('PR', 'none for this branch'),
    s.pr && row('', s.pr.url),
    row('queue', `${q.local} local · ${q.done} done`),
    // The age belongs next to the tab count because the tab is the cause: the
    // browser polls only while its tab is visible, so backgrounding it stops
    // the clock on every number above while the socket stays open and the count
    // keeps cheerfully saying `1 tab`.
    row('serving', u.local, u.tabs ? `${u.tabs} tab${u.tabs > 1 ? 's' : ''}` : 'no tab open', ago(u.age)),
    // A row of its own: on the serving row the legend ran past 80 columns and
    // clip() cut it off at exactly the keys someone had not found yet.
    row('keys', 'q quit · r refresh · v verbose · o open · t terminal · f folder'),
    u.moved && row('', u.moved),
  ].filter(Boolean);
}

/** The variable that overrides each of `t` and `f` with a command of your own. */
export const OPEN_REPO_VARS = { terminal: 'PRCODER_TERMINAL', folder: 'PRCODER_OPEN' };

/** Where an override from OPEN_REPO_VARS finds the repo's path: see openRepoArgs. */
export const REPO_ENV = 'PRCODER_REPO';

/**
 * The argv that opens the repo in the platform's file manager (`folder`) or in
 * a terminal there (`terminal`), or null where prcoder has no command for it
 * yet. Pure, so the table is testable off the platform it names.
 *
 * `custom` is that one's variable from OPEN_REPO_VARS: a command line of your
 * own, on any platform, run through the shell like PRCODER_BROWSER with the repo's
 * path appended -- so it comes back as one string, not an argv. The path goes in
 * as a reference to REPO_ENV, which the caller sets, rather than as text: a
 * shell expands a variable's value once and never again, so no character in the
 * path can do anything. Quoting the text would do for sh, but there is no
 * quoting in cmd.exe that stops %NAME% expanding, and % is legal in a Windows
 * directory name.
 *
 * ponytail: Terminal.app is the only built-in terminal. iTerm, a Linux terminal
 * (there is no one command for one) or Windows Terminal are PRCODER_TERMINAL
 * until someone wants one without setting it.
 */
export function openRepoArgs(what, platform, dir, custom) {
  if (custom) return `${custom} ${platform === 'win32' ? `"%${REPO_ENV}%"` : `"$${REPO_ENV}"`}`;
  return {
    // xdg-open where it is the desktop's standard, and nowhere else: on AIX,
    // SunOS or Android it would be a guess, not a command.
    folder: {
      darwin: ['open', dir], win32: ['explorer', dir],
      linux: ['xdg-open', dir], freebsd: ['xdg-open', dir], openbsd: ['xdg-open', dir],
    }[platform] ?? null,
    terminal: { darwin: ['open', '-a', 'Terminal', dir] }[platform] ?? null,
  }[what];
}
