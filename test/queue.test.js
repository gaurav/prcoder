import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFuture, renderPrBlock, syncFromPrBlock, toggleTask } from '../queue.js';
import { TASK, fences, taskLines } from '../public/tasks.js';

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

// parseFuture outlived the format it was written for: FUTURE.md is no longer
// the queue, and these markers are read exactly once, by the import in
// server.js that moves an old queue into .prcoder/queue.json.
test('parses every item state out of FUTURE.md, for the one-time import', () => {
  assert.deepEqual(parseFuture(FUTURE), [
    { text: 'Add retry to the fetch path', done: false, inPr: false, issue: null, deleted: false },
    { text: 'Docs for the new flag', done: false, inPr: true, issue: null, deleted: false },
    { text: 'Refactor the parser', done: false, inPr: true, issue: 42, deleted: false },
    { text: 'Fix the flaky worktree test', done: true, inPr: false, issue: null, deleted: false },
  ]);
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

/**
 * The other direction, and the dangerous one. The body wins on `done`, so a
 * local tick that never reached GitHub is reverted by the next merge — which
 * is correct (unticking on github.com has to work) and is exactly why the
 * store may never move without the body moving with it. A startup race let a
 * write land before the PR was loaded, so the mirror was skipped and this
 * undid it a minute later; the load runs on the serial chain now.
 */
test('a tick the description never received is reverted by it', () => {
  const items = [{ text: 'ticked here only', done: true, inPr: true, issue: null, deleted: false }];
  const behind = [
    'Desc.', '', '<!-- prcoder:todo -->', '## TODO', '',
    '- [ ] ticked here only',
    '<!-- /prcoder:todo -->',
  ].join('\n');

  assert.deepEqual(syncFromPrBlock(items, behind), [
    { text: 'ticked here only', done: false, inPr: true, issue: null, deleted: false },
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
// An item can be tombstoned and mirrored and an issue at once, and the import
// has to bring all three across -- a dropped @deleted resurrects something the
// user threw away.
test('every marker on one line survives the import', () => {
  assert.deepEqual(parseFuture('## Queue\n\n- [ ] @pr @deleted @issue#7 buried\n'),
    [{ text: 'buried', done: false, inPr: true, issue: 7, deleted: true }]);
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

// The consequence that makes issueNumber() throw rather than pass NaN through.
// MARKERS is anchored, so a value it cannot match ends the marker run: the
// text is corrupted and @pr is lost with it, quietly and on the way back in.
test('a malformed marker value degrades into the task text and drops the rest', () => {
  const [item] = parseFuture('## Queue\n\n- [ ] @issue#NaN @pr Real text\n');
  assert.equal(item.text, '@issue#NaN @pr Real text');
  assert.equal(item.issue, null);
  assert.equal(item.inPr, false);
});

// --- checkboxes in the description ---

const BODY = [
  'Prose first, with a list that is not a checklist:',
  '',
  '- plain bullet',
  '- [ ] first task',
  '- [x] second task, already done',
  '',
  '<!-- prcoder:todo -->',
  '## TODO',
  '',
  '- [ ] a queue item',
  '<!-- /prcoder:todo -->',
].join('\n');

test('ticking a description checkbox flips that line and nothing else', () => {
  const { body, inBlock } = toggleTask(BODY, 0, true, 'first task');
  assert.equal(inBlock, false);
  assert.equal(body.split('\n')[3], '- [x] first task');
  assert.deepEqual(body.split('\n').filter((_, i) => i !== 3), BODY.split('\n').filter((_, i) => i !== 3));
  assert.equal(toggleTask(BODY, 1, false, 'second task, already done').body.split('\n')[4],
    '- [ ] second task, already done');
});

test('a line inside the prcoder block is reported so the queue can follow it', () => {
  const { body, inBlock } = toggleTask(BODY, 2, true, 'a queue item');
  assert.equal(inBlock, true);
  assert.match(body, /- \[x\] a queue item/);
});

// The index comes from a renderer that counts checklist lines with its own
// copy of the pattern, so the text is the thing that catches a body that moved.
test('a checkbox whose line has changed underneath is refused, not ticked', () => {
  assert.throws(() => toggleTask(BODY, 0, true, 'a task that was edited on github.com'),
    /description changed under that checkbox/);
  assert.throws(() => toggleTask(BODY, 9, true, 'first task'),
    /no longer in the description/);
});

// The client sends a position in this list; if the two sides ever disagree on
// which lines count, every index past the first difference ticks the wrong
// line. Walking one body through both is what keeps them in step.
const paneTasks = (body) => fences(body)
  .filter((c) => c.text !== undefined)
  .flatMap((c) => c.text.split('\n').map((l) => TASK.exec(l)).filter(Boolean).map((m) => m[2]));

test('the PR pane and queue.js pick out the same checklist lines', () => {
  const seen = paneTasks(BODY);
  assert.deepEqual(seen, ['first task', 'second task, already done', 'a queue item']);
  for (const [index, text] of seen.entries()) {
    assert.doesNotThrow(() => toggleTask(BODY, index, true, text), `index ${index} (${text})`);
  }
});

// A checklist inside a fence is a sample of markdown, not a task -- this repo's
// own README and PR description both contain one. The pane renders it as code,
// so if toggleTask still counted it, every index after the fence would be off
// by one and tick a neighbour.
const FENCED = [
  '- [ ] before the fence',
  '',
  '```markdown',
  '## Queue',
  '',
  '- [ ] not a task, an example',
  '- [x] nor this one',
  '```',
  '',
  '- [ ] after the fence',
].join('\n');

test('a checklist inside a fence is code to both sides, not a checkbox', () => {
  const seen = paneTasks(FENCED);
  assert.deepEqual(seen, ['before the fence', 'after the fence']);
  for (const [index, text] of seen.entries()) {
    assert.doesNotThrow(() => toggleTask(FENCED, index, true, text), `index ${index} (${text})`);
  }
  // Index 1 is the line after the fence, not the first line inside it.
  assert.match(toggleTask(FENCED, 1, true, 'after the fence').body, /- \[x\] after the fence/);
  assert.match(toggleTask(FENCED, 1, true, 'after the fence').body, /- \[ \] not a task, an example/);
});

// A fence someone is still typing. The pane deliberately does not let an
// unterminated one swallow the rest of the description, and for as long as
// toggleTask walked the body with a rule of its own -- toggling on every ``` --
// it counted everything after the opener as code. The pane then rendered a
// checkbox the server refused, with "no longer in the description" on a line
// that was plainly still there and a refresh that could never help.
const UNCLOSED = [
  '- [ ] before the fence',
  '',
  '```sh',
  'npm install',
  '',
  '- [ ] after the opener',
].join('\n');

test('an unterminated fence leaves both sides counting the same lines', () => {
  const seen = paneTasks(UNCLOSED);
  assert.deepEqual(seen, ['before the fence', 'after the opener']);
  assert.deepEqual(taskLines(UNCLOSED), [0, 5]);
  for (const [index, text] of seen.entries()) {
    assert.doesNotThrow(() => toggleTask(UNCLOSED, index, true, text), `index ${index} (${text})`);
  }
});

test('the fenced sample survives a tick untouched', () => {
  const { body } = toggleTask(FENCED, 0, true, 'before the fence');
  assert.match(body, /```markdown\n## Queue\n\n- \[ \] not a task, an example\n- \[x\] nor this one\n```/);
});
