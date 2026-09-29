import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readQueue, writeQueue } from '../queue.js';
import { reorder, newestFirst } from '../public/queue.js';

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

// A pull request links to its own page, and an item about another repo's
// issue links there, owner/repo known or not.
test('an issue link follows the kind and the repo the item is about', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-queue-'));
  try {
    const items = [item({ issue: 8, kind: 'pull' }), item({ issue: 9, repo: 'cli/cli', kind: 'issue' })];
    assert.deepEqual((await writeQueue(repo, items, 'o/r')).map((i) => i.issueUrl),
      ['https://github.com/o/r/pull/8', 'https://github.com/cli/cli/issues/9']);
    assert.deepEqual((await readQueue(repo, undefined)).map((i) => i.issueUrl),
      [null, 'https://github.com/cli/cli/issues/9']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// The pane sends back whatever the last write answered, so that answer has to
// carry the times the write stamped. When it echoed the request instead, the
// next write stamped every earlier deletion again with its own time, and two
// items deleted seconds apart tied on the Deleted tab.
test('a write answers with the times it stamped, so the next one keeps them', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-queue-'));
  try {
    const first = await writeQueue(repo, [item({ text: 'a', deleted: true }), item({ text: 'b' })]);
    const aAt = first[0].deletedAt;
    assert.equal(typeof aAt, 'number');
    await new Promise((res) => setTimeout(res, 5));
    const second = await writeQueue(repo, [first[0], { ...first[1], deleted: true, done: true }]);
    assert.equal(second[0].deletedAt, aAt);
    assert.ok(second[1].deletedAt > aAt);
    assert.equal(second[1].doneAt, second[1].deletedAt);
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

// The Issues tab puts the mention with news on it first. Before the lookup
// answers there are no times at all, and the description's own order stands.
test('mentions are listed most recently updated first, the unknown last', () => {
  const list = [{ number: 3 }, { number: 7 }, { number: 12 }, { number: 20 }];
  const found = new Map([
    [7, { updatedAt: '2026-09-06T15:31:21Z' }],
    [12, { updatedAt: '2026-09-27T04:50:06Z' }],
    [20, { updatedAt: '2026-09-20T09:00:00Z' }],
  ]);
  assert.deepEqual(newestFirst(list, found).map((i) => i.number), [12, 20, 7, 3]);
  assert.deepEqual(newestFirst(list, null).map((i) => i.number), [3, 7, 12, 20]);
  // A copy: the list it was handed is the PR's own, and stays in its order.
  assert.deepEqual(list.map((i) => i.number), [3, 7, 12, 20]);
});
