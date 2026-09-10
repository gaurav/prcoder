// The queue pane's tabs. test/queue.test.js next door is the *server's*
// queue.js -- the PR-description block; this is the vocabulary the pane and the
// status block share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, counts } from '../public/items.js';
import { stripFor } from '../public/queue.js';

const item = (over = {}) => ({ text: 't', done: false, inPr: false, issue: null, deleted: false, ...over });

const LOCAL = item();
const MIRRORED = item({ inPr: true });
const FILED = item({ issue: 42 });
const DONE = item({ done: true });
const GONE = item({ deleted: true });

const on = (name, list) => list.filter(TABS[name]);

// The whole point of the redesign: carrying an item out of Local is what empties
// Local, so an operator who has mirrored or filed everything sees nothing left.
test('promoting an item takes it out of Local', () => {
  assert.deepEqual(on('local', [LOCAL, MIRRORED, FILED, DONE, GONE]), [LOCAL]);
  assert.deepEqual(on('pr', [LOCAL, MIRRORED, FILED, DONE, GONE]), [MIRRORED]);
  assert.deepEqual(on('issues', [LOCAL, MIRRORED, FILED, DONE, GONE]), [FILED]);
  assert.deepEqual(on('done', [LOCAL, MIRRORED, FILED, DONE, GONE]), [DONE]);
  assert.deepEqual(on('deleted', [LOCAL, MIRRORED, FILED, DONE, GONE]), [GONE]);
});

// A tombstone shadows every other flag, or a deleted item would go on showing
// in the tab it was promoted to and the Deleted tab would not be a way out.
test('a deleted item shows only in Deleted, whatever else it was', () => {
  const buried = item({ deleted: true, inPr: true, issue: 7, done: true });
  for (const name of ['local', 'pr', 'issues', 'done']) {
    assert.deepEqual(on(name, [buried]), [], `${name} should not show a deleted item`);
  }
  assert.deepEqual(on('deleted', [buried]), [buried]);
});

// The counts deliberately do not sum: these two states are both true of the
// item, and hiding it from either tab would be the lie. Pinned so that a later
// change to exclusive stages has to come here and argue with it.
test('an item can be counted by two tabs at once', () => {
  const both = item({ done: true, inPr: true });
  assert.deepEqual(on('done', [both]), [both]);
  assert.deepEqual(on('pr', [both]), [both]);
  assert.deepEqual(on('local', [both]), [], 'promoted and done, so not Local');

  // Mirrored *and* filed is the case renderPrBlock's bare-#N line exists for,
  // so it has to survive as a representable state.
  const mirroredAndFiled = item({ inPr: true, issue: 9 });
  assert.deepEqual(on('pr', [mirroredAndFiled]), [mirroredAndFiled]);
  assert.deepEqual(on('issues', [mirroredAndFiled]), [mirroredAndFiled]);
});

// counts() is what the terminal's status block reads, so the block and the tab
// strip cannot disagree about a branch's queue.
test('counts answers every tab, including the ones with nothing in them', () => {
  assert.deepEqual(counts([LOCAL, MIRRORED, FILED, DONE, GONE]),
    { local: 1, pr: 1, issues: 1, done: 1, deleted: 1 });
  assert.deepEqual(counts([]), { local: 0, pr: 0, issues: 0, done: 0, deleted: 0 });
  assert.deepEqual(counts(), { local: 0, pr: 0, issues: 0, done: 0, deleted: 0 });
});

// A store written before this change has no `issue` on most rows, and a hand
// edited one can carry anything; a predicate that returned a number or
// undefined would put junk in a tab count.
test('every predicate answers a boolean, whatever the item carries', () => {
  for (const [name, pred] of Object.entries(TABS)) {
    for (const i of [item(), item({ issue: 0 }), item({ issue: undefined })]) {
      assert.equal(typeof pred(i), 'boolean', `${name} on ${JSON.stringify(i)}`);
    }
  }
  // issue 0 is not an issue number GitHub ever gives out, and `null` is the
  // stored default -- neither should land the row in Issues.
  assert.deepEqual(on('issues', [item({ issue: 0 }), item({ issue: null })]), []);
});

// The strip itself: which tabs are drawn at all. Hiding an empty tab is what
// keeps a fresh queue down to two, and it is also the rule tools/browser.mjs
// seeds a fixture against -- a tab that is not drawn is not clickable, and the
// driver waits 30s on the missing locator rather than failing.
test('a tab holding nothing is not drawn, except the two that always are', () => {
  assert.deepEqual(stripFor([], 'local').strip, ['local', 'done']);
  assert.deepEqual(stripFor([LOCAL], 'local').strip, ['local', 'done']);
  // One item per tab is the fixture the browser driver seeds, and the whole
  // strip is what it expects back.
  assert.deepEqual(stripFor([LOCAL, MIRRORED, FILED, DONE, GONE], 'local').strip,
    ['local', 'pr', 'issues', 'done', 'deleted']);
});

test('a tab appears as soon as one item lands in it', () => {
  assert.ok(!stripFor([LOCAL], 'local').strip.includes('deleted'));
  assert.ok(stripFor([LOCAL, GONE], 'local').strip.includes('deleted'));
});

// Restoring the last tombstone empties Deleted while you are standing on it.
// Without the fallback the pane keeps a `tab` no button matches: nothing is
// highlighted and the list below is empty with no way back.
test('emptying the tab you are on falls back to Local', () => {
  assert.equal(stripFor([GONE], 'deleted').tab, 'deleted');
  assert.equal(stripFor([LOCAL], 'deleted').tab, 'local');
  // The two in ALWAYS are never the ones you get dropped from, however empty.
  assert.equal(stripFor([], 'done').tab, 'done');
  assert.equal(stripFor([], 'local').tab, 'local');
});

// The strip is drawn in this order whichever tabs survive, so the pane does not
// reshuffle its buttons under the pointer as items move between tabs.
test('the tabs keep their order as ones in the middle come and go', () => {
  const order = stripFor([LOCAL, MIRRORED, FILED, DONE, GONE], 'local').strip;
  assert.deepEqual(order, Object.keys(TABS));
  assert.deepEqual(stripFor([FILED], 'local').strip, ['local', 'issues', 'done']);
});
