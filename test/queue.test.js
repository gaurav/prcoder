import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorder } from '../public/queue.js';

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
