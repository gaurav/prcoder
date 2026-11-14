// The picker's rules that need no browser: what a query matches and where the
// highlight goes. The rest of it is driven in test/browser/suite.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsIn, matchRows, stepRow } from '../public/picker.js';

test('a query matches when every word of it is in the text, in any case and order', () => {
  assert.equal(wordsIn('Built on the fixture', 'FIXTURE built'), true);
  assert.equal(wordsIn('Built on the fixture', 'built that'), false);
  assert.equal(wordsIn('anything', '   '), true, 'no words is no test');
});

// With nothing typed the rows are the caller's own, groups and indents and
// all. A match is listed flat: its parent may not be one, and an indent under
// nothing says it is stacked on the row above.
test('rows narrow to the ones that match, flat, by their search text where they have one', () => {
  const rows = [{ key: 'a', text: 'Alpha', depth: 0, group: 'G' }, { key: 'b', text: 'Beta', depth: 1, search: 'Beta alphabet' }, { key: 'c', text: 'Gamma', depth: 2 }];
  assert.equal(matchRows(rows, ''), rows);
  assert.equal(matchRows(rows, '  '), rows);
  assert.deepEqual(matchRows(rows, 'alpha'), [{ key: 'a', text: 'Alpha', depth: 0, group: undefined }, { key: 'b', text: 'Beta', depth: 0, search: 'Beta alphabet', group: undefined }]);
  assert.deepEqual(matchRows(rows, 'delta'), []);
});

// The highlight steps over a row that cannot be picked and stops at the ends.
// Wrapping round put it on the first row for one press too many of a held ↓.
test('the highlight skips disabled rows and stops at the ends', () => {
  const rows = [{ disabled: true }, {}, { disabled: true }, { disabled: true }, {}, { disabled: true }];
  assert.equal(stepRow(rows, -1, 1), 1, 'the first that can be picked');
  assert.equal(stepRow(rows, -1, -1), 4, 'and the last');
  assert.equal(stepRow(rows, 1, 1), 4);
  assert.equal(stepRow(rows, 4, 1), 4, 'stays at the end');
  assert.equal(stepRow(rows, 4, -1), 1);
  assert.equal(stepRow(rows, 1, -1), 1, 'and at the start');
  assert.equal(stepRow([{ disabled: true }], -1, 1), -1, 'nothing to pick');
  assert.equal(stepRow([], -1, 1), -1);
});
