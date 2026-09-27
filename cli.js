// What prcoder takes and shows at the command line: its arguments, the port a
// repo gets, and the status block pinned under the log.
//
// All of it pure, so test/cli.test.js checks it without starting a server;
// server.js does the listening and term.js does the drawing.

import { createHash } from 'node:crypto';
import { syncPhrase } from './public/pr.js';
import { counts } from './public/items.js';

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

// Args split at the first flag: everything before it is ours (an optional PR
// number, URL or branch), everything from it on is handed to `claude` verbatim.
// No table of Claude's flags to keep in sync, and no collisions to arbitrate.
export function splitArgs(argv) {
  const cut = argv.findIndex((a) => a.startsWith('-'));
  return { target: cut === 0 ? undefined : argv[0], claudeArgs: cut === -1 ? [] : argv.slice(cut) };
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
    row('serving', u.local, u.tabs ? `${u.tabs} tab${u.tabs > 1 ? 's' : ''}` : 'no tab open',
      ago(u.age), 'q quit · r refresh · v verbose · o open'),
    u.moved && row('', u.moved),
  ].filter(Boolean);
}
