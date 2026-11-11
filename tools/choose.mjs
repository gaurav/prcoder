// Drive `prcoder choose` in a real PTY: the list, a number that is not
// listed, then `q`. tools/cli.mjs drives the block; this is the one path that
// runs before it exists.
//
//   node tools/choose.mjs
//
// Read-only on purpose: a number that *is* listed is a `gh pr checkout` of
// this working copy, so the driver never answers with one. To see a pick
// through, run `node server.js choose` yourself, in a clone under data/ if the
// pick is not the branch you are on. PRCODER_AGENT_BIN is stubbed as every
// driver stubs it, though `q` never gets as far as spawning one.

import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const p = spawn('node', ['server.js', 'choose', '--no-open'], {
  name: 'xterm-256color', cols: 100, rows: 40, cwd: repo,
  env: { ...process.env, PRCODER_AGENT_BIN: '/bin/cat' },
});
process.on('exit', () => { try { p.kill(); } catch { /* already gone */ } });
let buf = '';
p.onData((d) => { buf += d; });
const exited = new Promise((resolve) => p.onExit(resolve));
const until = async (match, ms) => {
  for (let t = 0; t < ms; t += 200) {
    if (buf.includes(match)) return true;
    await wait(200);
  }
  return false;
};

// The read can take seconds on a repository with many open.
console.log('prompt shown:', await until('PR number [', 30_000));
console.log(`\n===== the list =====\n${buf.replaceAll('\x1b', '\\e')}`);

p.write('999999\r');
console.log('refused:     ', await until('is not one of the open pull requests listed', 3000));
console.log('asked again: ', buf.split('PR number [').length > 2);

p.write('q\r');
const { exitCode } = await exited;
console.log('exit code:   ', exitCode, exitCode === 0 ? '(nothing started)' : '(WRONG)');
process.exit(0);
