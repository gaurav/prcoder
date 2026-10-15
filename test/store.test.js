import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalise, pick, toDisk, readStore, writeStore, readPort, writePort, readPrs, writePrs, replaceItems, useQueueFile } from '../store.js';

const repo = () => fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-store-'));
const item = (over = {}) =>
  ({ text: 'a task', done: false, doneAt: null, issue: null, repo: null, kind: null, deleted: false, deletedAt: null, ...over });

// The client PUTs back the array it was handed, which decorate() has added an
// issueUrl to. The markdown writer dropped unknown fields for free; JSON would
// write them out and read them back forever.
test('only the fields we own are stored', () => {
  const stored = pick({ ...item(), issueUrl: 'https://github.com/o/r/issues/1', junk: 1 });
  assert.deepEqual(Object.keys(stored).sort(),
    ['deleted', 'deletedAt', 'done', 'doneAt', 'issue', 'kind', 'repo', 'text']);
});

// The queue was scoped per branch for a while, so a file written then has a
// `branch` on every item. Dropping it here is the whole migration: those items
// come back into view on the next read, which is the point of #48.
test('a branch left on an item by an older prcoder is dropped', () => {
  assert.deepEqual(Object.keys(pick(item({ branch: 'merged-and-gone' }))).sort(),
    ['deleted', 'deletedAt', 'done', 'doneAt', 'issue', 'kind', 'repo', 'text']);
  const { store } = normalise(JSON.stringify(
    { version: 1, items: [item({ branch: 'work' }), item({ text: 'b', branch: 'other' })] }));
  assert.deepEqual(store.items.map((i) => i.text), ['a task', 'b']);
});

test('fields are coerced, so a hand-edited file cannot make a half-item', () => {
  const out = pick({ text: 42, done: 'yes', issue: '7' });
  assert.deepEqual(out,
    { text: '42', done: true, doneAt: null, issue: null, repo: null, kind: null, deleted: false, deletedAt: null });
});

// The repo ends up in an href, so anything but GitHub's own characters is
// dropped rather than trusted; and neither field means anything without the
// number it describes.
test('where an item\'s issue lives is kept only when it is a repo name', () => {
  assert.deepEqual(pick(item({ issue: 3, repo: 'cli/cli', kind: 'pull' })),
    item({ issue: 3, repo: 'cli/cli', kind: 'pull' }));
  assert.equal(pick(item({ issue: 3, repo: 'javascript:alert(1)//x' })).repo, null);
  assert.equal(pick(item({ issue: 3, repo: 'a/b"c' })).repo, null);
  assert.equal(pick(item({ issue: 3, kind: 'discussion' })).kind, null);
  assert.deepEqual(pick(item({ repo: 'cli/cli', kind: 'issue' })), item({ repo: null, kind: null }));
});

// On disk an item's issue is its link (toDisk), and pick() is what reads it
// back. Anything that is not a link to an issue or pull request on github.com
// -- a hand-edit, another host, a repo name with a quote in it -- is no issue.
test('an issue\'s link is written in place of its number, and read back', () => {
  const pull = item({ issue: 3, repo: 'cli/cli', kind: 'pull' });
  const { repo: _r, kind: _k, ...rest } = item({ issue: 'https://github.com/cli/cli/pull/3' });
  assert.deepEqual(toDisk(pull, 'o/r'), rest);
  assert.deepEqual(pick(toDisk(pull, 'o/r')), pull);
  assert.deepEqual(pick(toDisk(item({ issue: 4 }), 'o/r')), item({ issue: 4, repo: 'o/r' }));
  assert.equal(toDisk(item({ issue: 4 }), undefined).issue, 4, 'no link without this repo\'s name');
  assert.equal(toDisk(item(), 'o/r').issue, null);
  for (const bad of ['https://example.com/o/r/issues/1', 'https://github.com/o/r/issues/0',
    'https://github.com/o/r"x/issues/1', 'https://github.com/o/r/discussions/1', 'github.com/o/r/issues/1']) {
    assert.deepEqual(pick(item({ issue: bad })), item(), bad);
  }
});

// The Completed tab sorts on it, so it has to mean "when this was ticked": set
// by the write that ticks it, carried through every write after, and gone with
// the tick. The client never sets it -- it only sends back what it was given.
test('an item is stamped when it is ticked, keeps the stamp, and loses it when unticked', () => {
  const store = { version: 1, items: [] };
  const [ticked] = replaceItems(store, [item({ done: true })], 1000).items;
  assert.equal(ticked.doneAt, 1000, 'a newly done item is stamped');
  const [kept] = replaceItems(store, [ticked], 2000).items;
  assert.equal(kept.doneAt, 1000, 'a later write keeps the time it was ticked');
  const [unticked] = replaceItems(store, [{ ...kept, done: false }], 3000).items;
  assert.equal(unticked.doneAt, null, 'unticking clears it');
  const [again] = replaceItems(store, [{ ...unticked, done: true }], 4000).items;
  assert.equal(again.doneAt, 4000, 'and ticking it again is a new time');
  assert.equal(replaceItems(store, [item()], 5000).items[0].doneAt, null, 'an active item has none');
});

// The Deleted tab's order, on the same terms as doneAt: stamped by the write
// that deletes, kept after, gone on a restore.
test('an item is stamped when it is deleted, keeps the stamp, and loses it when restored', () => {
  const store = { version: 1, items: [] };
  const [gone] = replaceItems(store, [item({ deleted: true })], 1000).items;
  assert.equal(gone.deletedAt, 1000, 'a newly deleted item is stamped');
  assert.equal(replaceItems(store, [gone], 2000).items[0].deletedAt, 1000, 'a later write keeps it');
  const [back] = replaceItems(store, [{ ...gone, deleted: false }], 3000).items;
  assert.equal(back.deletedAt, null, 'restoring clears it');
  const [both] = replaceItems(store, [item({ done: true, doneAt: 500, deleted: true })], 4000).items;
  assert.deepEqual([both.doneAt, both.deletedAt], [500, 4000], 'deleting a finished item keeps when it was finished');
});

// Reading is not a write: a store from before the field existed reads with no
// times, and the page puts those last until something writes the queue.
test('reading does not stamp', () => {
  const { store } = normalise(JSON.stringify({ version: 1, items: [item({ done: true })] }));
  assert.equal(store.items[0].doneAt, null);
  assert.equal(pick(item({ done: false, doneAt: 1000 })).doneAt, null, 'a stamp on an active item is dropped');
});

// A queue from when items were mirrored into the description carries `inPr` and
// `pr`. Both go, and the item stays: a line that may already be in the
// description is a duplicate you can delete, where an item dropped on the word
// of a block nobody re-read is simply gone.
test('an item from the description mirror stays in the queue, without the mirror fields', () => {
  const { store } = normalise(JSON.stringify({ version: 1, items: [
    { text: 'was mirrored', done: false, inPr: true, pr: 27, issue: null, deleted: false },
    { text: 'was filed', done: true, inPr: true, pr: null, issue: 9, deleted: false },
  ] }));
  assert.deepEqual(store.items, [
    item({ text: 'was mirrored' }),
    item({ text: 'was filed', done: true, issue: 9 }),
  ]);
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
  assert.deepEqual(store.items, [item({ text: 'bare' })]);
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

// --queue moves the queue and nothing else: the repo's own queue.json is left
// alone -- which is the whole point, for the driver that uses it -- and the
// port still lives in .prcoder/.
test('a queue file named with --queue is read and written instead of the repo\'s', async () => {
  const dir = await repo();
  const elsewhere = path.join(dir, 'data', 'driver-queue.json');
  await writeStore(dir, { version: 1, items: [item({ text: 'yours' })] });
  useQueueFile(elsewhere);
  try {
    assert.deepEqual((await readStore(dir)).store.items, []);
    await writeStore(dir, { version: 1, items: [item({ text: 'the driver\'s' })] });
    assert.deepEqual((await readStore(dir)).store.items.map((i) => i.text), ['the driver\'s']);
    await writePort(dir, 12345);
    assert.equal(await readPort(dir), 12345);
    // Its directory is made for it, and it is not given a .gitignore.
    assert.deepEqual(await fs.readdir(path.join(dir, 'data')), ['driver-queue.json']);
  } finally {
    useQueueFile(null);
  }
  assert.deepEqual((await readStore(dir)).store.items.map((i) => i.text), ['yours']);
});

// .prcoder/prs.json: each branch's pull requests as the last search found
// them. A cache, so anything it cannot read is no entry, and a branch with
// none, or not searched in a month, is not kept.
const PR = { url: 'https://github.com/o/r/pull/7', repo: 'o/r', state: 'OPEN' };

test('a branch\'s pull requests come back as written, and an empty list removes the branch', async () => {
  const dir = await repo();
  assert.equal(await readPrs(dir, 'topic'), null, 'nothing remembered yet');
  const now = Date.parse('2026-10-14T12:00:00Z');
  await writePrs(dir, 'topic', { searched: now, prs: [PR] }, now);
  await writePrs(dir, 'other', { searched: now, prs: [{ ...PR, url: 'https://github.com/o/r/pull/8' }] }, now);
  assert.deepEqual(await readPrs(dir, 'topic'), { searched: now, prs: [PR] });
  assert.equal(await readPrs(dir, null), null, 'a detached HEAD has none');
  const raw = JSON.parse(await fs.readFile(path.join(dir, '.prcoder', 'prs.json'), 'utf8'));
  assert.equal(raw.branches.topic.searched, '2026-10-14T12:00:00.000Z', 'a time a person can read');
  await writePrs(dir, 'topic', { searched: now, prs: [] }, now);
  assert.equal(await readPrs(dir, 'topic'), null);
  assert.equal((await readPrs(dir, 'other')).prs.length, 1, 'the other branch is untouched');
  // A pull request whose reads have failed since a time, which comes back too.
  await writePrs(dir, 'unread', { searched: now, prs: [{ ...PR, unread: now - 60_000 }] }, now);
  assert.deepEqual(await readPrs(dir, 'unread'), { searched: now, prs: [{ ...PR, unread: now - 60_000 }] });
  await writePrs(dir, 'unread', { searched: now, prs: [] }, now);
  assert.deepEqual((await fs.readdir(path.join(dir, '.prcoder'))).sort(), ['.gitignore', 'prs.json']);
});

// A branch's name is anything git allows, Object.prototype's members included.
test('a branch named after an object\'s own members is remembered like any other', async () => {
  const dir = await repo();
  const now = Date.parse('2026-10-14T12:00:00Z');
  for (const branch of ['constructor', '__proto__', 'toString']) {
    assert.equal(await readPrs(dir, branch), null, `${branch}: nothing remembered yet`);
    await writePrs(dir, branch, { searched: now, prs: [PR] }, now);
    assert.deepEqual(await readPrs(dir, branch), { searched: now, prs: [PR] }, branch);
  }
});

test('a branch not searched for a month is dropped on the next write', async () => {
  const dir = await repo();
  const now = Date.parse('2026-10-14T12:00:00Z');
  const day = 24 * 60 * 60_000;
  await writePrs(dir, 'old', { searched: now - 31 * day, prs: [PR] }, now - 31 * day);
  await writePrs(dir, 'recent', { searched: now - 29 * day, prs: [PR] }, now - 29 * day);
  await writePrs(dir, 'topic', { searched: now, prs: [PR] }, now);
  assert.equal(await readPrs(dir, 'old'), null);
  assert.ok(await readPrs(dir, 'recent'));
  // A search in the future -- a clock set back -- is kept as now, so it ages out.
  await writePrs(dir, 'ahead', { searched: now + 365 * day, prs: [PR] }, now);
  assert.equal((await readPrs(dir, 'ahead')).searched, now);
  await writePrs(dir, 'topic', { searched: now + 31 * day, prs: [PR] }, now + 31 * day);
  assert.equal(await readPrs(dir, 'ahead'), null);
});

// The URL goes into gh's argv, so a hand-edit may not put a flag there, or
// anything that is not a pull request's whole link.
test('a remembered pull request that is not one is left out, and a file we cannot use is empty', async () => {
  const dir = await repo();
  const write = (v) => fs.mkdir(path.join(dir, '.prcoder'), { recursive: true })
    .then(() => fs.writeFile(path.join(dir, '.prcoder', 'prs.json'), typeof v === 'string' ? v : JSON.stringify(v)));
  const searched = '2026-10-14T12:00:00Z';
  await write({ version: 1, branches: { topic: { searched, prs: [
    PR,
    { ...PR, url: '--repo=evil/x' },
    { ...PR, url: 'https://github.com/o/r/pull/7 --web' },
    { ...PR, url: 'https://github.com/o/r/issues/7' },
    { ...PR, repo: '-o/r x' },
    // A trusted repository beside a URL in another: gh would be sent there.
    { ...PR, url: 'https://github.com/evil/x/pull/7' },
    { ...PR, state: 'DRAFT' },
  ] }, none: { searched, prs: [{ ...PR, url: 'x' }] }, undated: { prs: [PR] } } });
  assert.deepEqual((await readPrs(dir, 'topic')).prs, [PR]);
  assert.equal(await readPrs(dir, 'none'), null);
  assert.equal(await readPrs(dir, 'undated'), null);
  // A remote may spell the repository in other case than the link does.
  await write({ version: 1, branches: { topic: { searched, prs: [{ ...PR, repo: 'O/R' }] } } });
  assert.deepEqual((await readPrs(dir, 'topic')).prs, [{ ...PR, repo: 'O/R' }]);
  for (const bad of ['{', '[]', JSON.stringify({ version: 2, branches: { topic: { searched, prs: [PR] } } })]) {
    await write(bad);
    assert.equal(await readPrs(dir, 'topic'), null, bad);
  }
  // Overwritten, not moved aside: it is a cache.
  await writePrs(dir, 'topic', { searched: Date.now(), prs: [PR] });
  assert.equal((await readPrs(dir, 'topic')).prs.length, 1);
});
