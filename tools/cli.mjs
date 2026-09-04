// Drive the running CLI. tools/shot.mjs is this for the browser; the terminal
// needs its own because none of it exists without a tty -- the block, the keys
// and the quit prompt are all switched off the moment stdout is a pipe, which
// is exactly what a plain `node server.js` from a script gets.
//
//   node tools/cli.mjs
//
// Scratch driver, not a test: add keystrokes for whatever you are looking at.
// The rules from shot.mjs hold. CLAUDE_BIN is stubbed, because every websocket
// spawns it in a PTY and an unstubbed run leaves a real Claude session behind;
// and this stays read-only, because the queue and the description it would
// write to are this repo's live ones.
//
// Escape sequences are printed as \e so the bookkeeping is legible: `\e[6F` is
// the block claiming to be six rows, and if that number ever disagrees with the
// rows below it, the erase is eating scrollback or leaving a smear.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { WebSocket } from 'ws';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PRCODER_PORT) || 7455;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function start(label) {
  const p = spawn('node', ['server.js'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: repo,
    env: { ...process.env, PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', CLAUDE_BIN: '/bin/cat' },
  });
  p.buf = '';
  p.onData((d) => { p.buf += d; });
  p.show = (what) => {
    console.log(`\n===== ${label}: ${what} =====\n${p.buf.replaceAll('\x1b', '\\e')}`);
    p.buf = '';
  };
  p.line = (match) => p.buf.split('\n').find((l) => l.includes(match))?.trim();
  return p;
}

const first = start('first');
await wait(6000);
first.show('startup');

first.write('v');
await wait(300);
first.write('v');
await wait(300);
first.show('after v v — quiet, verbose, debug');

// A browser tab. The tab count and the quit prompt both hang off this.
const ws = new WebSocket(`ws://localhost:${port}/pty`);
await wait(1500);
console.log('with a tab: ', first.line('tab'));

// `r` polls without the browser, which is the point of it: the block otherwise
// only moves when a *visible* tab asks for a status.
first.buf = '';
first.write('r');
await wait(4000);
console.log('after r:    ', first.line('refreshing') ?? 'NO refresh line');
console.log('  polled:   ', first.line('poll:') ?? 'NO poll line');

// A second prcoder in the same repo: the case the port note is for.
const second = start('second');
await wait(8000);
console.log('port taken: ', second.line('is taken'));
second.kill();

// Quitting has to say what it costs, and take the PTYs with it.
first.buf = '';
first.write('\x03');
await wait(600);
console.log('quit prompt:', first.line('quit?'));
first.write('n');
await wait(400);
first.show('declined');

first.write('\x03');
await wait(400);
first.write('y');
await wait(1500);
// The stub stands in for `claude`: anything left here is an orphaned session.
console.log('stubs left: ', execSync('pgrep -f "^/bin/cat$" | wc -l').toString().trim());
ws.close();
first.kill();
process.exit(0);
