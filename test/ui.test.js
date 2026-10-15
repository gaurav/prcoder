// public/ui.js: the page's building blocks. Most of them build elements and
// are driven by the browser suite; what runs in Node without a page is here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabDone } from '../public/ui.js';

// A count is done once it has run out, and never when there was nothing to
// count -- so a description with no checklist never claims to have finished one.
test('a count is done when all of it is, and never when it is nothing', () => {
  assert.equal(tabDone({ done: 10, total: 10 }), true);
  assert.equal(tabDone({ done: 9, total: 10 }), false);
  assert.equal(tabDone({ done: 0, total: 0 }), false);
});
