import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFuture, renderFuture, renderPrBlock, syncFromPrBlock } from '../queue.js';

const FUTURE = `# Notes

Some longhand thinking that must survive.

## Queue

- [ ] Add retry to the fetch path
- [ ] @pr Docs for the new flag
- [ ] @pr @issue#42 Refactor the parser
- [x] Fix the flaky worktree test

## Ideas

Keep me too.
`;

test('parses every item state out of FUTURE.md', () => {
  assert.deepEqual(parseFuture(FUTURE), [
    { text: 'Add retry to the fetch path', done: false, inPr: false, issue: null, deleted: false },
    { text: 'Docs for the new flag', done: false, inPr: true, issue: null, deleted: false },
    { text: 'Refactor the parser', done: false, inPr: true, issue: 42, deleted: false },
    { text: 'Fix the flaky worktree test', done: true, inPr: false, issue: null, deleted: false },
  ]);
});

test('round-trips without losing items or surrounding prose', () => {
  const items = parseFuture(FUTURE);
  const out = renderFuture(items, FUTURE);
  assert.deepEqual(parseFuture(out), items);
  assert.match(out, /Some longhand thinking that must survive/);
  assert.match(out, /## Ideas\n\nKeep me too/);
});

test('creates the section when FUTURE.md has no queue yet', () => {
  const out = renderFuture([{ text: 'first', done: false, inPr: false, issue: null, deleted: false }], '# Notes\n');
  assert.match(out, /# Notes/);
  assert.deepEqual(parseFuture(out), [{ text: 'first', done: false, inPr: false, issue: null, deleted: false }]);
});

test('checklist lines outside the queue section are left alone', () => {
  assert.deepEqual(parseFuture('## Other\n\n- [ ] not mine\n'), []);
});

test('only inPr items reach the PR body, and issues render as links', () => {
  const body = renderPrBlock([
    { text: 'local only', done: false, inPr: false, issue: null, deleted: false },
    { text: 'Docs for the new flag', done: false, inPr: true, issue: null, deleted: false },
    { text: 'Refactor the parser', done: false, inPr: true, issue: 42, deleted: false },
  ], 'Original description.');

  assert.match(body, /Original description\./);
  assert.doesNotMatch(body, /local only/);
  assert.match(body, /- \[ \] Docs for the new flag/);
  // The item became an issue, so the PR line is the link, not a duplicate.
  assert.match(body, /- \[ \] #42/);
  assert.doesNotMatch(body, /Refactor the parser/);
});

test('rewriting the block replaces it instead of appending a second one', () => {
  const first = renderPrBlock([{ text: 'one', done: false, inPr: true, issue: null, deleted: false }], 'Desc.');
  const second = renderPrBlock([{ text: 'two', done: false, inPr: true, issue: null, deleted: false }], first);
  assert.equal(second.match(/prcoder:todo/g).length, 2, 'one open + one close marker');
  assert.doesNotMatch(second, /- \[ \] one/);
  assert.match(second, /- \[ \] two/);
  assert.match(second, /Desc\./);
});

test('emptying the queue removes the block but keeps the description', () => {
  const withBlock = renderPrBlock([{ text: 'one', done: false, inPr: true, issue: null, deleted: false }], 'Desc.');
  const cleared = renderPrBlock([], withBlock);
  assert.doesNotMatch(cleared, /prcoder:todo/);
  assert.match(cleared, /Desc\./);
});

test('edits made on github.com come back: new line, ticked box, deleted line', () => {
  const items = [
    { text: 'kept', done: false, inPr: true, issue: null, deleted: false },
    { text: 'ticked there', done: false, inPr: true, issue: null, deleted: false },
    { text: 'removed there', done: false, inPr: true, issue: null, deleted: false },
    { text: 'local only', done: false, inPr: false, issue: null, deleted: false },
  ];
  const edited = [
    'Desc.', '', '<!-- prcoder:todo -->', '## TODO', '',
    '- [ ] kept',
    '- [x] ticked there',
    '- [ ] added from a phone',
    '<!-- /prcoder:todo -->',
  ].join('\n');

  assert.deepEqual(syncFromPrBlock(items, edited), [
    { text: 'kept', done: false, inPr: true, issue: null, deleted: false },
    { text: 'ticked there', done: true, inPr: true, issue: null, deleted: false },
    { text: 'removed there', done: false, inPr: false, issue: null, deleted: true },
    { text: 'local only', done: false, inPr: false, issue: null, deleted: false },
    { text: 'added from a phone', done: false, inPr: true, issue: null, deleted: false },
  ]);
});

test('a PR body with no block leaves the queue untouched', () => {
  const items = [{ text: 'a', done: false, inPr: true, issue: null, deleted: false }];
  assert.deepEqual(syncFromPrBlock(items, 'Just a description.'), items);
});

test('malformed lines are skipped rather than dropping the rest', () => {
  const items = parseFuture('## Queue\n\n- [ ] good\nnot an item\n- [] bad checkbox\n- [x] also good\n');
  assert.deepEqual(items.map((i) => i.text), ['good', 'also good']);
});

// `@deleted` had to join the marker alternation, not just be tested for. The
// regex is anchored, so an unknown marker matches zero characters and every
// other marker on the line silently becomes part of the visible text.
test('the @deleted marker survives a FUTURE.md round-trip alongside the others', () => {
  const items = parseFuture('## Queue\n\n- [ ] @pr @deleted @issue#7 buried\n');
  assert.deepEqual(items, [{ text: 'buried', done: false, inPr: true, issue: 7, deleted: true }]);
  assert.deepEqual(parseFuture(renderFuture(items, '')), items);
});

test('a deleted item never goes back into the PR body', () => {
  const body = renderPrBlock([
    { text: 'live', done: false, inPr: true, issue: null, deleted: false },
    { text: 'buried', done: false, inPr: true, issue: null, deleted: true },
  ], 'Desc.');
  assert.match(body, /- \[ \] live/);
  assert.doesNotMatch(body, /buried/);
});

// Otherwise the next sync sees it missing from the block and re-buries it.
test('re-adding a line on github.com brings the item back from deleted', () => {
  const items = [{ text: 'buried', done: false, inPr: false, issue: null, deleted: true }];
  const body = ['<!-- prcoder:todo -->', '## TODO', '', '- [ ] buried', '<!-- /prcoder:todo -->'].join('\n');
  assert.deepEqual(syncFromPrBlock(items, body), [
    { text: 'buried', done: false, inPr: true, issue: null, deleted: false },
  ]);
});

// An emptied block means the section went, not that every item was struck out.
// Without this the 60s poll would bury the whole queue the moment someone
// cleared the TODO list on github.com.
test('an emptied block un-mirrors items without burying them', () => {
  const items = [
    { text: 'a', done: false, inPr: true, issue: null, deleted: false },
    { text: 'b', done: false, inPr: true, issue: null, deleted: false },
  ];
  const emptied = ['<!-- prcoder:todo -->', '## TODO', '', '<!-- /prcoder:todo -->'].join('\n');
  assert.deepEqual(syncFromPrBlock(items, emptied), items);
});

// Matching by text alone let a local-only twin absorb the body's line, which
// left the real mirrored item unmatched and tombstoned it.
test('a body line matches the mirrored twin, not the local-only one', () => {
  const items = [
    { text: 'same', done: false, inPr: false, issue: null, deleted: false },
    { text: 'same', done: false, inPr: true, issue: null, deleted: false },
  ];
  const body = ['<!-- prcoder:todo -->', '## TODO', '', '- [x] same', '<!-- /prcoder:todo -->'].join('\n');
  assert.deepEqual(syncFromPrBlock(items, body), [
    { text: 'same', done: false, inPr: false, issue: null, deleted: false },
    { text: 'same', done: true, inPr: true, issue: null, deleted: false },
  ]);
});
