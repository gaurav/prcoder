import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalise, pick, readStore, writeStore, readPort, writePort, replaceItems } from '../store.js';

const repo = () => fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-store-'));
const item = (over = {}) =>
  ({ text: 'a task', done: false, inPr: false, issue: null, deleted: false, ...over });

// The client PUTs back the array it was handed, which decorate() has added an
// issueUrl to. The markdown writer dropped unknown fields for free; JSON would
// write them out and read them back forever.
test('only the fields we own are stored', () => {
  const stored = pick({ ...item(), issueUrl: 'https://github.com/o/r/issues/1', junk: 1 });
  assert.deepEqual(Object.keys(stored).sort(),
    ['deleted', 'done', 'inPr', 'issue', 'text']);
});

// The queue was scoped per branch for a while, so a file written then has a
// `branch` on every item. Dropping it here is the whole migration: those items
// come back into view on the next read, which is the point of #48.
test('a branch left on an item by an older prcoder is dropped', () => {
  assert.deepEqual(Object.keys(pick(item({ branch: 'merged-and-gone' }))).sort(),
    ['deleted', 'done', 'inPr', 'issue', 'text']);
  const { store } = normalise(JSON.stringify(
    { version: 1, items: [item({ branch: 'work' }), item({ text: 'b', branch: 'other' })] }));
  assert.deepEqual(store.items.map((i) => i.text), ['a task', 'b']);
});

test('fields are coerced, so a hand-edited file cannot make a half-item', () => {
  const out = pick({ text: 42, done: 'yes', issue: '7' });
  assert.deepEqual(out,
    { text: '42', done: true, inPr: false, issue: null, deleted: false });
});

// Absent and empty are ordinary: a repo that has never run prcoder, and one
// where the file was truncated to nothing.
test('an absent store is empty rather than an error', async () => {
  const dir = await repo();
  const { store, stale } = await readStore(dir);
  assert.deepEqual(store.items, []);
  assert.equal(stale, false);
});

// The bytes are kept, not overwritten -- but reading is not the moment to touch
// anyone's disk, so the rename waits for a write that was replacing them anyway.
test('an unreadable store reads empty and is moved aside on the next write', async () => {
  const dir = await repo();
  await fs.mkdir(path.join(dir, '.prcoder'), { recursive: true });
  const file = path.join(dir, '.prcoder', 'queue.json');
  await fs.writeFile(file, '{ this is not json');

  const { store, stale } = await readStore(dir);
  assert.deepEqual(store.items, []);
  assert.equal(stale, true);
  assert.equal(await fs.readFile(file, 'utf8'), '{ this is not json');   // untouched by the read

  await writeStore(dir, replaceItems(store, [item()]), { stale });
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), '{ this is not json');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).items.length, 1);
});

// A newer prcoder's file. Guessing at a shape we do not know is how you write
// something it then cannot read.
test('a store from a newer version is not guessed at', () => {
  const { store, stale } = normalise(JSON.stringify({ version: 99, items: [item()] }));
  assert.deepEqual(store.items, []);
  assert.equal(stale, true);
});

test('a missing field takes its default instead of failing the read', () => {
  const { store, stale } = normalise(JSON.stringify({ version: 1, items: [{ text: 'bare' }] }));
  assert.equal(stale, false);
  assert.deepEqual(store.items, [{ text: 'bare', done: false, inPr: false, issue: null, deleted: false }]);
});

// One list, whatever is checked out. The branch scoping this replaces is what
// took a merged branch's unfinished items permanently out of view.
test('a write replaces the whole list and nothing survives it', async () => {
  const dir = await repo();
  await writeStore(dir, { version: 1, items: [item({ text: 'first' }), item({ text: 'second' })] });

  const { store } = await readStore(dir);
  await writeStore(dir, replaceItems(store, [item({ text: 'only' })]));

  const { store: after } = await readStore(dir);
  assert.deepEqual(after.items, [item({ text: 'only' })]);
});

// The directory ignores itself, so the repo's own .gitignore needs no entry --
// and a hand-written one is the user's, not ours to replace.
test('the store ignores itself, and never overwrites an existing rule', async () => {
  const dir = await repo();
  await writeStore(dir, { version: 1, items: [] });
  assert.equal(await fs.readFile(path.join(dir, '.prcoder', '.gitignore'), 'utf8'), '*\n');

  await fs.writeFile(path.join(dir, '.prcoder', '.gitignore'), '# mine\n*\n');
  await writeStore(dir, { version: 1, items: [item()] });
  assert.match(await fs.readFile(path.join(dir, '.prcoder', '.gitignore'), 'utf8'), /# mine/);
});

test('no temp file is left behind', async () => {
  const dir = await repo();
  await writeStore(dir, { version: 1, items: [item()] });
  assert.deepEqual((await fs.readdir(path.join(dir, '.prcoder'))).sort(), ['.gitignore', 'queue.json']);
});

// The port the working copy listens on, so the URL survives a rename of the
// directory and can be pinned by editing one line rather than exporting a
// variable on every run.
test('a recorded port comes back, and writing one leaves no temp file', async () => {
  const dir = await repo();
  assert.equal(await readPort(dir), null, 'nothing recorded yet');

  await writePort(dir, 12345);
  assert.equal(await readPort(dir), 12345);
  assert.deepEqual((await fs.readdir(path.join(dir, '.prcoder'))).sort(), ['.gitignore', 'port.json']);
  assert.equal(await fs.readFile(path.join(dir, '.prcoder', '.gitignore'), 'utf8'), '*\n');

  await writePort(dir, 12346);
  assert.equal(await readPort(dir), 12346);
});

// Startup is not the moment to throw over a file the user may have opened. Any
// of these reads as "nothing recorded", and the seed is derived instead.
test('a port file we cannot use reads as no port at all', async () => {
  const dir = await repo();
  const write = async (raw) => {
    await fs.mkdir(path.join(dir, '.prcoder'), { recursive: true });
    await fs.writeFile(path.join(dir, '.prcoder', 'port.json'), raw);
    return readPort(dir);
  };
  assert.equal(await write(''), null, 'truncated');
  assert.equal(await write('{'), null, 'half-written');
  assert.equal(await write('null'), null, 'no object');
  assert.equal(await write('{"version":1}'), null, 'no port');
  assert.equal(await write('{"port":"12345"}'), null, 'a string, not a port');
  assert.equal(await write('{"port":12345.5}'), null, 'not an integer');
  assert.equal(await write('{"port":0}'), null, 'below the range');
  assert.equal(await write('{"port":70000}'), null, 'above the range');
  assert.equal(await write('{"port":2602}'), 2602, 'an old bookmarked port is still the user\'s to pin');
});

// The queue and the port are separate files: writing one must not conjure the
// other, or a repo that never ran gets a port and a repo mid-write gets a queue.
test('the queue and the port are written independently', async () => {
  const dir = await repo();
  await writeStore(dir, { version: 1, items: [item()] });
  assert.equal(await readPort(dir), null);
  assert.deepEqual((await fs.readdir(path.join(dir, '.prcoder'))).sort(), ['.gitignore', 'queue.json']);
});

