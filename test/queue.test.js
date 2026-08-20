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
    { text: 'Add retry to the fetch path', done: false, inPr: false, issue: null },
    { text: 'Docs for the new flag', done: false, inPr: true, issue: null },
    { text: 'Refactor the parser', done: false, inPr: true, issue: 42 },
    { text: 'Fix the flaky worktree test', done: true, inPr: false, issue: null },
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
  const out = renderFuture([{ text: 'first', done: false, inPr: false, issue: null }], '# Notes\n');
  assert.match(out, /# Notes/);
  assert.deepEqual(parseFuture(out), [{ text: 'first', done: false, inPr: false, issue: null }]);
});

test('checklist lines outside the queue section are left alone', () => {
  assert.deepEqual(parseFuture('## Other\n\n- [ ] not mine\n'), []);
});

test('only inPr items reach the PR body, and issues render as links', () => {
  const body = renderPrBlock([
    { text: 'local only', done: false, inPr: false, issue: null },
    { text: 'Docs for the new flag', done: false, inPr: true, issue: null },
    { text: 'Refactor the parser', done: false, inPr: true, issue: 42 },
  ], 'Original description.');

  assert.match(body, /Original description\./);
  assert.doesNotMatch(body, /local only/);
  assert.match(body, /- \[ \] Docs for the new flag/);
  // The item became an issue, so the PR line is the link, not a duplicate.
  assert.match(body, /- \[ \] #42/);
  assert.doesNotMatch(body, /Refactor the parser/);
});

test('rewriting the block replaces it instead of appending a second one', () => {
  const first = renderPrBlock([{ text: 'one', done: false, inPr: true, issue: null }], 'Desc.');
  const second = renderPrBlock([{ text: 'two', done: false, inPr: true, issue: null }], first);
  assert.equal(second.match(/prcoder:todo/g).length, 2, 'one open + one close marker');
  assert.doesNotMatch(second, /- \[ \] one/);
  assert.match(second, /- \[ \] two/);
  assert.match(second, /Desc\./);
});

test('emptying the queue removes the block but keeps the description', () => {
  const withBlock = renderPrBlock([{ text: 'one', done: false, inPr: true, issue: null }], 'Desc.');
  const cleared = renderPrBlock([], withBlock);
  assert.doesNotMatch(cleared, /prcoder:todo/);
  assert.match(cleared, /Desc\./);
});

test('edits made on github.com come back: new line, ticked box, deleted line', () => {
  const items = [
    { text: 'kept', done: false, inPr: true, issue: null },
    { text: 'ticked there', done: false, inPr: true, issue: null },
    { text: 'removed there', done: false, inPr: true, issue: null },
    { text: 'local only', done: false, inPr: false, issue: null },
  ];
  const edited = [
    'Desc.', '', '<!-- prcoder:todo -->', '## TODO', '',
    '- [ ] kept',
    '- [x] ticked there',
    '- [ ] added from a phone',
    '<!-- /prcoder:todo -->',
  ].join('\n');

  assert.deepEqual(syncFromPrBlock(items, edited), [
    { text: 'kept', done: false, inPr: true, issue: null },
    { text: 'ticked there', done: true, inPr: true, issue: null },
    { text: 'removed there', done: false, inPr: false, issue: null },
    { text: 'local only', done: false, inPr: false, issue: null },
    { text: 'added from a phone', done: false, inPr: true, issue: null },
  ]);
});

test('a PR body with no block leaves the queue untouched', () => {
  const items = [{ text: 'a', done: false, inPr: true, issue: null }];
  assert.deepEqual(syncFromPrBlock(items, 'Just a description.'), items);
});

test('malformed lines are skipped rather than dropping the rest', () => {
  const items = parseFuture('## Queue\n\n- [ ] good\nnot an item\n- [] bad checkbox\n- [x] also good\n');
  assert.deepEqual(items.map((i) => i.text), ['good', 'also good']);
});
