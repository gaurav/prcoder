import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readQueue, writeQueue } from '../queue.js';
import { reorder } from '../public/queue.js';

const item = (over = {}) =>
  ({ text: 'a task', done: false, doneAt: null, issue: null, deleted: false, ...over });

// The store keeps an issue's number and the link is derived from owner/repo,
// which the server passes in once `gh repo view` has answered. Before then
// there is nothing to link to, and a link to github.com/undefined is worse
// than none.
test('an issue link is derived from owner/repo, and absent without one', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-queue-'));
  try {
    const items = [item({ text: 'filed', issue: 7 }), item({ text: 'not filed' })];
    const written = await writeQueue(repo, items, 'o/r');
    assert.deepEqual(written.map((i) => i.issueUrl), ['https://github.com/o/r/issues/7', null]);
    assert.deepEqual((await readQueue(repo, 'o/r')).map((i) => i.issueUrl),
      ['https://github.com/o/r/issues/7', null]);
    assert.deepEqual((await readQueue(repo, undefined)).map((i) => i.issueUrl), [null, null]);
    // Derived, never stored: the file holds the number and nothing else.
    const stored = JSON.parse(await fs.readFile(path.join(repo, '.prcoder', 'queue.json'), 'utf8'));
    assert.equal(stored.items[0].issueUrl, undefined);
    assert.equal(stored.items[0].issue, 7);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// A drop means the same thing whichever way the row was dragged: the row lands
// where the row it was dropped on is now. Unadjusted, the removal shifted the
// target out from under the insert and a downward drag overshot it by one.
test('a dragged row lands in the same place in both directions', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 2, 0), ['c', 'a', 'b', 'd']);
  // The two ends, where an off-by-one falls off the array instead of misplacing.
  assert.deepEqual(reorder(['a', 'b', 'c'], 0, 2), ['b', 'a', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});
