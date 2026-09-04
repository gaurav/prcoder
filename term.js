// The terminal prcoder is started from. A log that scrolls, and a status block
// pinned under it.
//
// Nothing here knows what prcoder is; server.js hands it lines. The pinning is
// the only trick: the cursor always ends up at column 1 on the line *after* the
// block, so the block is pinned by being the most recent thing written. No
// absolute positioning, no terminal-height arithmetic, and the scrollback above
// it is never touched -- which is the whole point, since the log is the part
// worth reading back.
//
// The alternative, a DECSTBM scroll region, needs row arithmetic redone on
// every resize, and terminals disagree about whether a resize clears it. Worse,
// any write that escapes this module corrupts it for good. Erase-and-redraw is
// stateless: every repaint rebuilds the block, so a smear heals itself on the
// next line.

import fs from 'node:fs';
import { format } from 'node:util';

const QUIET = 0, VERBOSE = 1, DEBUG = 2;
const NAMES = ['quiet', 'verbose', 'debug'];

// Set before the first key can be pressed, which is the only way to see what
// happens during startup -- by the time there is a prompt to press `v` at, the
// repo has been read, the PR loaded and FUTURE.md imported.
let level = Math.min(DEBUG, Math.max(QUIET, Number(process.env.PRCODER_VERBOSE) || 0));

let out = process.stdout;
let footer = [];
let painted = 0;     // rows the block occupies right now
let prompt = null;   // { text, onYes } while a confirm is up

/**
 * Tests point the module at a fake stream; nothing else calls this. The
 * verbosity goes back to quiet too, or `npm test` run in a shell that exports
 * PRCODER_VERBOSE fails on assertions about what is printed.
 */
export function sink(stream) {
  out = stream;
  footer = [];
  painted = 0;
  prompt = null;
  level = QUIET;
}

const live = () => Boolean(out.isTTY) && process.env.TERM !== 'dumb';
const cols = () => (out.columns || 80) - 1;
const rows = () => out.rows || 24;

// CPL (up N, column 1) then erase-to-end-of-display. Only when something is
// painted: `CSI 0 F` is coerced to 1 by most terminals, which would eat a line
// of scrollback every time the block was empty.
const ERASE = (n) => (n ? `\x1b[${n}F\x1b[0J` : '');

export function paint() {
  if (!live()) return;
  const body = [...footer, ...(prompt ? ['', prompt.text] : [])].map((l) => l.slice(0, cols()));
  // Nothing to say, nothing drawn -- otherwise every line logged before the
  // first status() trails a rule under itself with no block beneath it.
  if (!body.length) return void (out.write(ERASE(painted)), painted = 0);
  // Truncated before the rule is styled, so slice() stays a width measure: SGR
  // is zero-width, and cutting through an escape sequence would print garbage.
  const lines = [`\x1b[2m${'─'.repeat(cols())}\x1b[0m`, ...body].slice(0, Math.max(1, rows() - 1));
  out.write(`${ERASE(painted)}\x1b[?25l${lines.map((l) => `${l}\n`).join('')}\x1b[?25h`);
  painted = lines.length;
}

/** The status block. Lines only; paint() owns the rule and the truncation. */
export function status(lines) {
  footer = lines.filter((l) => l != null);
  paint();
}

/**
 * A log line, at or above the current verbosity. Errors keep stderr when the
 * output is piped, because the README promises the busy-port note there; on a
 * real terminal the two are the same screen and the split buys nothing.
 */
export function log(line, min = QUIET, err = false) {
  if (min > level) return;
  if (!live()) return void (err ? process.stderr : out).write(`${line}\n`);
  out.write(ERASE(painted));
  painted = 0;
  out.write(`${line}\n`);
  paint();
}

export const verbose = (line) => log(line, VERBOSE);
export const debug = (line) => log(line, DEBUG);

export function cycleVerbosity() {
  level = (level + 1) % NAMES.length;
  log(`verbosity: ${NAMES[level]}`);
}

/**
 * A yes/no question, asked as two more lines of the status block rather than as
 * a write of its own. That is what makes it safe: a poll landing mid-question
 * repaints the question along with everything else, instead of scribbling over
 * it.
 */
export function confirm(text, onYes) {
  prompt = { text, onYes };
  paint();
}

/**
 * Raw mode turns ISIG off, so Ctrl-C arrives as byte 3 and *no SIGINT is
 * delivered* -- this handler is the only Ctrl-C there is. Which is the point:
 * quitting kills the browser's Claude session, so it gets asked about first.
 *
 * With no tty there is nobody to ask, and the default death is right.
 */
export function keys({ quit, key }) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    for (const b of buf) {
      const ch = String.fromCharCode(b);
      if (prompt) {
        // The escape hatch. A second Ctrl-C goes, no matter what is wrong with
        // the rest of this: nothing here may make the process unkillable.
        if (b === 3) process.exit(130);
        const { onYes } = prompt;
        prompt = null;
        paint();
        if (ch === 'y' || ch === 'Y') onYes();
      } else if (b === 3 || ch === 'q') quit();
      else key(ch);
    }
  });
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* already gone */ }
  // Synchronous: an exit handler is too late for the stream's own queue.
  if (live()) try { fs.writeSync(1, `${ERASE(painted)}\x1b[?25h`); } catch { /* closed */ }
}

/**
 * Called once from server.js, never on import, so a test can load this module
 * without inheriting a patched console and a fistful of signal handlers.
 *
 * ponytail: patching console rather than editing the eleven call sites in
 * server.js. The eleven are not the problem -- a twelfth added later is, and it
 * would smear the block at exactly the moment something had gone wrong.
 */
export function init() {
  console.log = (...a) => log(format(...a));
  console.error = (...a) => log(format(...a), QUIET, true);
  // `exit` covers a normal return, process.exit() and an uncaught exception
  // (node prints the stack, then fires it). A signal with a default action
  // never runs exit handlers at all, hence the three below.
  process.on('exit', restore);
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(130));
  // A shrink can reflow the block and leave `painted` a line or two out. The
  // smear is one-off and the next log line clears it; reflow accounting is not
  // worth what it costs to get right.
  if (live()) process.stdout.on('resize', paint);
}
