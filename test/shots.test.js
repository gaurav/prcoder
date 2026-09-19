// tools/shots.mjs deletes directories, which is the reason it has a test: the
// drivers themselves assert nothing and are read by eye, so nothing else here
// would notice the day it removed the wrong one. Every case below is about what
// it refuses to touch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { labelPath, openShots, pruneShots } from '../tools/shots.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-shots-'));
const png = (dir, name) => fs.writeFile(path.join(dir, name), '');
const names = async (root) => (await fs.readdir(root)).sort();

// The label is joined onto data/shots, so it is a directory name and nothing
// else -- a path here escapes the scratch directory, and this function is the
// only thing between argv and an fs.rm.
test('a label that is not one directory name is refused', () => {
  for (const bad of ['../elsewhere', 'a/b', '/abs', '', '.', '-leading', 'Caps', 'with space', 'dot.png']) {
    assert.throws(() => labelPath('/root', bad), /shots label/, JSON.stringify(bad));
  }
  assert.equal(labelPath('/root', 'highlighting'), path.join('/root', 'highlighting'));
  assert.equal(labelPath('/root', 'pr-69-tsx'), path.join('/root', 'pr-69-tsx'));
});

// Replaced, not added to: a shot the driver has stopped taking would otherwise
// sit beside the ones it still takes, with nothing to say it is two runs old.
test('opening a label empties it, and leaves every other label alone', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, 'other'), { recursive: true });
  await png(path.join(root, 'other'), 'kept.png');

  const first = await openShots(root, 'run');
  await png(first, 'stale.png');
  const second = await openShots(root, 'run');
  assert.equal(second, first);
  assert.deepEqual(await names(first), []);
  assert.deepEqual(await names(path.join(root, 'other')), ['kept.png']);
});

// The guard that matters. A directory holding anything else is somebody's --
// notes, a video, a nested folder -- and the driver did not put it there.
test('a label holding anything but PNGs is never emptied', async () => {
  const root = await tmp();
  const mine = path.join(root, 'notes');
  await fs.mkdir(mine, { recursive: true });
  await fs.writeFile(path.join(mine, 'why.md'), 'not a screenshot');
  await assert.rejects(() => openShots(root, 'notes'), /not a screenshot/);
  assert.deepEqual(await names(mine), ['why.md']);
});

test('the oldest labels go, the newest stay, and one with a stranger in it is kept and named', async () => {
  const root = await tmp();
  for (const [i, name] of ['oldest', 'middle', 'newest'].entries()) {
    const dir = await openShots(root, name);
    await png(dir, 'full.png');
    // mtime is the ordering, and three directories made in the same millisecond
    // would sort arbitrarily -- so they are dated apart explicitly.
    const at = new Date(Date.now() - (2 - i) * 60_000);
    await fs.utimes(dir, at, at);
  }
  const mixed = path.join(root, 'mine');
  await fs.mkdir(mixed, { recursive: true });
  await fs.writeFile(path.join(mixed, 'note.txt'), 'keep');
  await png(root, 'loose.png');

  const lines = [];
  const out = await pruneShots(root, { keep: 2, log: (...a) => lines.push(a.join(' ')) });
  assert.deepEqual(out.kept, ['newest', 'middle']);
  assert.deepEqual(out.removed, ['oldest']);
  assert.deepEqual(out.strangers, ['mine']);
  assert.equal(out.loose, 1);
  assert.deepEqual(await names(root), ['loose.png', 'middle', 'mine', 'newest']);
  assert.ok(lines.some((l) => l.includes('removed oldest')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('mine')), lines.join('\n'));
});

test('a run whose labels are all newer than the cap removes nothing', async () => {
  const root = await tmp();
  for (const name of ['a', 'b']) await png(await openShots(root, name), 'full.png');
  const out = await pruneShots(root, { keep: 5, log: () => {} });
  assert.deepEqual(out.removed, []);
  assert.deepEqual(await names(root), ['a', 'b']);
});
