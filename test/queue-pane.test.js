// The queue pane's tabs. test/queue.test.js next door is the *server's*
// queue.js -- lines moved into a description; this is the vocabulary the pane
// and the status block share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, counts } from '../public/items.js';
import { stripFor } from '../public/queue.js';

const item = (over = {}) => ({ text: 't', done: false, issue: null, deleted: false, ...over });

const LOCAL = item();
const LINKED = item({ issue: 42 });
const DONE = item({ done: true });
const GONE = item({ deleted: true });

const on = (name, list) => list.filter(TABS[name]);

// Moving an item to the PR or an issue takes it off the list, so the tabs are
// only ever your own list's states: still to do, done, thrown away. An item that
// links an issue is still yours to do.
test('every item is on exactly one tab', () => {
  const all = [LOCAL, LINKED, DONE, GONE];
  assert.deepEqual(on('local', all), [LOCAL, LINKED]);
  assert.deepEqual(on('done', all), [DONE]);
  assert.deepEqual(on('deleted', all), [GONE]);
  for (const i of all) {
    assert.equal(Object.values(TABS).filter((f) => f(i)).length, 1, JSON.stringify(i));
  }
});

// A tombstone shadows every other flag, or a deleted item would go on showing
// on Completed and the Deleted tab would not be a way out.
test('a deleted item shows only in Deleted, whatever else it was', () => {
  const buried = item({ deleted: true, done: true, issue: 7 });
  assert.deepEqual(on('local', [buried]), []);
  assert.deepEqual(on('done', [buried]), []);
  assert.deepEqual(on('deleted', [buried]), [buried]);
});

// counts() is what the terminal's status block reads, so the block and the tab
// strip cannot disagree about the queue -- and, the tabs being exclusive, they
// add up to it.
test('counts answers every tab, and adds up to the list', () => {
  assert.deepEqual(counts([LOCAL, LINKED, DONE, GONE]), { local: 2, done: 1, deleted: 1 });
  assert.deepEqual(counts([]), { local: 0, done: 0, deleted: 0 });
  assert.deepEqual(counts(), { local: 0, done: 0, deleted: 0 });
});

// A hand-edited store can carry anything; a predicate that returned a number or
// undefined would put junk in a tab count.
test('every predicate answers a boolean, whatever the item carries', () => {
  for (const [name, pred] of Object.entries(TABS)) {
    for (const i of [item(), item({ done: 1 }), item({ deleted: undefined })]) {
      assert.equal(typeof pred(i), 'boolean', `${name} on ${JSON.stringify(i)}`);
    }
  }
});

// The strip itself: which tabs are drawn at all. Deleted hides when it holds
// nothing, which is also the rule tools/browser.mjs seeds a fixture against -- a
// tab that is not drawn is not clickable, and the driver waits 30s on the
// missing locator rather than failing.
test('Deleted is drawn only when it holds something', () => {
  assert.deepEqual(stripFor([], 'local').strip, ['local', 'done']);
  assert.deepEqual(stripFor([LOCAL, DONE, GONE], 'local').strip, ['local', 'done', 'deleted']);
});

// The sources sit between Local and your list's other tabs, and only when they
// exist: no PR on screen, no PR tab. Standing on one that goes away -- a switch
// to a branch with no PR -- lands you back on Local like any emptied tab.
test('source tabs sit after Local, and only the available ones are drawn', () => {
  assert.deepEqual(stripFor([LOCAL, GONE], 'local', ['pr', 'issues']).strip,
    ['local', 'pr', 'issues', 'done', 'deleted']);
  assert.deepEqual(stripFor([], 'local', ['issues']).strip, ['local', 'issues', 'done']);
  assert.equal(stripFor([], 'pr', ['pr', 'issues']).tab, 'pr');
  assert.equal(stripFor([], 'pr', ['issues']).tab, 'local');
});

// Restoring the last tombstone empties Deleted while you are standing on it.
// Without the fallback the pane keeps a `tab` no button matches: nothing is
// highlighted and the list below is empty with no way back.
test('emptying the tab you are on falls back to Local', () => {
  assert.equal(stripFor([GONE], 'deleted').tab, 'deleted');
  assert.equal(stripFor([LOCAL], 'deleted').tab, 'local');
  assert.equal(stripFor([], 'done').tab, 'done');
  assert.equal(stripFor([], 'local').tab, 'local');
});
