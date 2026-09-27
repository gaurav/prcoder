// The queue lives in .prcoder/ and nowhere else: no route that reads or writes
// it may reach GitHub, or even git. That used to be false by design -- a queue
// write rendered the list into the PR description -- and this is what says it
// has stayed false. Driven over real HTTP, in a process of its own, because the
// server takes its repo from the working directory at import: this file moves
// into a scratch directory first, so the store it writes is a throwaway one.
//
// `gh` and `git` are shell scripts on PATH that log their arguments and fail.
// A route that shells out either leaves a line in the log or fails on the exit
// code, and both are assertions below. POSIX shell, so not on Windows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const skip = process.platform === 'win32' ? 'the gh and git stubs are sh scripts' : false;

let base;
let server;
let dir;
let log;

before(async () => {
  if (skip) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-queue-local-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  log = path.join(dir, 'calls.log');
  for (const name of ['gh', 'git']) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.chdir(dir);
  ({ server } = await import('../server.js'));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  await new Promise((res) => server.close(res));
  await fs.rm(dir, { recursive: true, force: true });
});

const calls = () => fs.readFile(log, 'utf8').then((s) => s.trim().split('\n'), () => []);
const queue = (items) => fetch(`${base}/api/queue`, items === undefined ? {} : {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
}).then(async (r) => [r.status, await r.json()]);

test('adding, ticking, reordering and deleting queue items runs neither gh nor git', { skip }, async () => {
  const a = { text: 'first', done: false, issue: null, deleted: false };
  const b = { text: 'second', done: false, issue: null, deleted: false };
  for (const items of [[a], [a, b], [{ ...a, done: true }, b], [b, { ...a, done: true }],
    [{ ...b, deleted: true }, { ...a, done: true }]]) {
    const [status] = await queue(items);
    assert.equal(status, 200);
  }
  const [status, items] = await queue();
  assert.equal(status, 200);
  assert.deepEqual(items.map((i) => [i.text, i.done, i.deleted]), [['second', false, true], ['first', true, false]]);
  assert.deepEqual(await calls(), []);
  // And the list is where it says it is.
  const stored = JSON.parse(await fs.readFile(path.join(dir, '.prcoder', 'queue.json'), 'utf8'));
  assert.equal(stored.items.length, 2);
});
