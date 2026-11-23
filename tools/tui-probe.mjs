// Check what prcoder assumes about Claude Code's screen against the real one,
// in about ten seconds. Re-run it after a Claude Code update.
//
//   node tools/tui-probe.mjs            four lines, ok or FAIL, exit 1 on a FAIL
//   node tools/tui-probe.mjs --screen   and the rendered screen, to see why
//
// Not a driver, and not part of `npm test`: it starts the real agent
// (PRCODER_AGENT_BIN, or `claude`, as the server does), logged in as you, in
// this repository, at the server's 80x24, and draws its output into a headless
// xterm. It types a line into the prompt box and never presses Enter, so no
// turn is sent and nothing reaches the prompt history; the agent is killed
// with the line still in its box. Nothing is written to disk, and the screen,
// which can carry account details on the welcome banner, is printed only with
// --screen.
//
// What it checks is everything the queue's ⤓ assumes of the TUI (Design.md,
// "nothing parses the terminal"), each pinned in a comment dated when it was
// last read:
//
// - the prompt marker `fromTerminal` (public/items.js) drops: `❯` and a
//   no-break space in 2.1.330, `> ` before;
// - the two-column gutter it drops from a wrapped prompt's later rows;
// - the two together: the prompt rows, as xterm's getSelection() would hand
//   them over, through fromTerminal and ▶'s `printable`, give back exactly
//   the line typed;
// - mouse reporting, which is why the page sets macOptionClickForcesSelection
//   (public/app.js). That one is a note, not a FAIL, when it is off: it
//   follows the `tui` setting, and nothing breaks without it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node-pty';
import xterm from '@xterm/headless';
import { fromTerminal } from '../public/items.js';
import { printable } from '../public/tasks.js';

const bin = process.env.PRCODER_AGENT_BIN || 'claude';
const [cols, rows] = [80, 24];
const showScreen = process.argv.includes('--screen');
// Long enough to wrap at 80 columns. No digits, `@`, `/` or `!` at the start,
// and no Enter: nothing a dialog or the prompt's own menus would take as a
// choice, if the box is not what has the focus.
const TYPED = 'tuiprobe: a line typed into the prompt box to see how it is drawn, '
  + 'never sent, and long enough that the box has to wrap it onto a second row';
const SLOW = 40000;

const version = await promisify(execFile)(bin, ['--version']).then((r) => r.stdout.trim(), (e) => `unknown (${e.message})`);
console.log(`${bin} ${version}, ${cols}x${rows}, in ${process.cwd()}`);

const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const agent = spawn(bin, [], { name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } });
let exited = null;
agent.onData((d) => term.write(d));
// The terminal's answers, as the page's xterm sends them: Claude Code asks
// for the cursor position every ~200ms for as long as it runs, so its output
// never goes quiet, and waiting for it to is waiting for the deadline
// (tools/CLAUDE.md, "A stub that only echoes is not a session").
term.onData((d) => exited == null && agent.write(d));
agent.onExit(({ exitCode }) => { exited = exitCode; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drawn = () => new Promise((r) => term.write('', r));
// Until `seen` holds of the screen, the agent exits, or SLOW runs out.
async function until(seen) {
  const deadline = Date.now() + SLOW;
  while (!seen(screen()) && Date.now() < deadline && exited == null) await sleep(100);
}
// The visible rows, as xterm draws them: trailing blanks cut, the no-break
// space still itself (getSelection() is what turns it into a space).
const screen = () => {
  const buf = term.buffer.active;
  return Array.from({ length: rows }, (_, y) => buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
};

let failed = false;
const report = (ok, text) => {
  if (ok === false) failed = true;
  console.log(`${ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'note'} ${text}`);
};

try {
  // Drawn at all, then a moment for the prompt box, whose look is the thing
  // under test and so cannot be what is waited on.
  await until((s) => s.some((row) => row.trim()));
  await sleep(2500);
  if (exited != null) throw new Error(`${bin} exited with ${exited} before it drew a prompt`);
  // In bursts, as a person types: one write of all of it can read as a paste,
  // which Claude Code may fold into a placeholder.
  for (let i = 0; i < TYPED.length; i += 8) {
    agent.write(TYPED.slice(i, i + 8));
    await sleep(15);
  }
  await until((s) => s.some((row) => row.includes('second row')));
  await sleep(500);
  await drawn();

  const shown = screen();
  const first = shown.findIndex((row) => row.includes('tuiprobe:'));
  const end = shown.findIndex((row, y) => y >= first && row.includes('second row'));
  if (first < 0 || end < 0) {
    report(false, 'the typed line never appeared in full: is the agent logged in, and is this folder trusted? --screen shows what it drew');
  } else {
    const prompt = shown.slice(first, end + 1);
    // xterm's selectionText, for a drag or triple-click over these rows.
    const selected = prompt.map((row) => row.replaceAll(' ', ' ')).join('\n');

    const marker = /^\s*(\S+)(\s)tuiprobe:/u.exec(prompt[0]);
    const named = marker && `${marker[1]} + U+${marker[2].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    report(!!marker && /^[❯>]$/u.test(marker[1]),
      `prompt marker: ${named ?? JSON.stringify(prompt[0])} (fromTerminal drops ❯ or > and one space)`);

    const later = prompt.slice(1);
    report(later.length > 0 && later.every((row) => /^ {2}\S/.test(row)),
      later.length ? `wrapped rows start in a two-column gutter (${later.length} of them)`
        : 'the line did not wrap, so the gutter could not be checked');

    const back = printable(fromTerminal(selected));
    report(back === TYPED, back === TYPED ? 'fromTerminal and printable give back the line typed'
      : `fromTerminal and printable give back ${JSON.stringify(back)}`);

    if (failed && !showScreen) console.log(`the prompt's rows: ${JSON.stringify(prompt, null, 1)}`);
  }

  const mouse = term.modes.mouseTrackingMode;
  report(mouse !== 'none' || null, mouse !== 'none'
    ? `mouse reporting on (${mouse}): selecting takes Option-drag on a Mac, Shift-drag elsewhere`
    : 'mouse reporting off: a plain drag selects (the `tui` setting decides; Panes.md assumes fullscreen)');
} catch (e) {
  report(false, e.message);
} finally {
  if (showScreen) console.log(`\n${screen().join('\n')}`);
  agent.kill();
}
process.exit(failed ? 1 : 0);
