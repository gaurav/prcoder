import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFuture, appendTasks, toggleTask } from '../queue.js';
import { taskLines } from '../public/tasks.js';
import { reorder } from '../public/queue.js';
import { blocks, sectionize } from '../public/pr.js';

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
// the queue, but its `## Queue` section is still what a FUTURE.md tab would
// show, markers and all.
test('parses every item state out of FUTURE.md', () => {
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

// The consequence that makes issueNumber() throw rather than pass NaN through.
// MARKERS is anchored, so a value it cannot match ends the marker run: the
// text is corrupted and @pr is lost with it, quietly and on the way back in.
test('a malformed marker value degrades into the task text and drops the rest', () => {
  const [item] = parseFuture('## Queue\n\n- [ ] @issue#NaN @pr Real text\n');
  assert.equal(item.text, '@issue#NaN @pr Real text');
  assert.equal(item.issue, null);
  assert.equal(item.inPr, false);
});

// --- items moved into the description ---

// A move is one-way and has nothing to reconcile afterwards, so the one thing
// that has to be right is that the lines land as checkboxes. Under a checklist
// that already ends the body they join it; under prose they need a blank line,
// or the first one reads as part of the paragraph above.
test('moved items are appended as checklist lines, joining a list that ends the body', () => {
  assert.equal(appendTasks('Why this change.', ['first', 'second']),
    'Why this change.\n\n- [ ] first\n- [ ] second\n');
  assert.equal(appendTasks('- [x] done already\n\n', ['next']), '- [x] done already\n- [ ] next\n');
  assert.equal(appendTasks('', ['only']), '- [ ] only\n');
  // Shift-Enter puts a newline in an item, and a checklist line cannot hold one.
  assert.equal(appendTasks('Desc.', ['one\n  two']), 'Desc.\n\n- [ ] one two\n');
  assert.deepEqual(taskLines(appendTasks('Desc.', ['a', 'b'])), [2, 3]);
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
  const body = toggleTask(BODY, 0, true, 'first task');
  assert.equal(body.split('\n')[3], '- [x] first task');
  assert.deepEqual(body.split('\n').filter((_, i) => i !== 3), BODY.split('\n').filter((_, i) => i !== 3));
  assert.equal(toggleTask(BODY, 1, false, 'second task, already done').split('\n')[4],
    '- [ ] second task, already done');
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
//
// This calls the pane's real renderer rather than a walk written here. It used
// to be a third copy of the pattern -- which meant the one file whose whole
// subject is "these two walks must not diverge" was comparing the server
// against something neither side ships. public/pr.js only touches `document`
// inside function bodies, so importing it here is safe.

const paneTasks = (body) => blocks(body).filter((b) => b.kind === 'task').map((b) => b.text);

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
  assert.match(toggleTask(FENCED, 1, true, 'after the fence'), /- \[x\] after the fence/);
  assert.match(toggleTask(FENCED, 1, true, 'after the fence'), /- \[ \] not a task, an example/);
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
  const body = toggleTask(FENCED, 0, true, 'before the fence');
  assert.match(body, /```markdown\n## Queue\n\n- \[ \] not a task, an example\n- \[x\] nor this one\n```/);
});

// The pane folds a description into its sections, so the blocks the renderer
// walks are regrouped between blocks() and the DOM. That regrouping must be
// exactly that: every task keeps the index it was given by the one left-to-right
// walk of the body, whichever section it lands in.
//
// If it ever stopped being so -- a section body built lazily on first open, a
// filter that drops prcoder's own block because the queue pane already shows it
// -- every tick past the first missing line would address the line above, and
// nothing on screen would say so.
const FOLDED = [
  'A lead paragraph.',
  '',
  '- [ ] first task, in the lead',
  '',
  '## One',
  '',
  '- a bullet',
  '- [x] second task',
  '',
  '### Deeper',
  '',
  '```markdown',
  '- [ ] fenced, not a task',
  '## fenced, not a section',
  '```',
  '',
  '## Two',
  '',
  '- [ ] third task',
].join('\n');

test('folding a description into sections does not renumber its checkboxes', () => {
  const flat = blocks(FOLDED).filter((b) => b.kind === 'task');
  const { lead, sections } = sectionize(blocks(FOLDED));
  const folded = [...lead, ...sections.flatMap((s) => s.nodes)].filter((b) => b.kind === 'task');

  assert.deepEqual(folded.map((b) => [b.index, b.text]), flat.map((b) => [b.index, b.text]));
  assert.deepEqual(flat.map((b) => b.index), flat.map((_, i) => i));
  // The fenced checklist line counts for neither side.
  assert.equal(taskLines(FOLDED).length, flat.length);
  assert.deepEqual(flat.map((b) => b.text),
    ['first task, in the lead', 'second task', 'third task']);
  // One task in the lead, one in each section: the split is real, not a no-op.
  assert.equal(lead.filter((b) => b.kind === 'task').length, 1);
  assert.deepEqual(sections.map((s) => s.nodes.filter((b) => b.kind === 'task').length), [1, 1]);

  for (const b of folded) {
    assert.doesNotThrow(() => toggleTask(FOLDED, b.index, true, b.text), `${b.index} (${b.text})`);
  }
});

// A description whose template comments out an example task. The pane's
// withoutHtml() deletes the comment before it counts anything, so if taskLines
// still counted the line inside it every pane index would be one low -- and
// toggleTask's text check would then refuse every box on the page.
const COMMENTED = [
  '- [ ] a real task',
  '',
  '<!--',
  '- [ ] an example nobody ticks',
  '-->',
  '',
  '- [ ] another real task',
].join('\n');

test('a checklist line inside an HTML comment counts for neither side', () => {
  const seen = paneTasks(COMMENTED);
  assert.deepEqual(seen, ['a real task', 'another real task']);
  assert.deepEqual(taskLines(COMMENTED), [0, 6]);
  for (const [index, text] of seen.entries()) {
    assert.doesNotThrow(() => toggleTask(COMMENTED, index, true, text), `index ${index} (${text})`);
  }
  // Index 1 is the line below the comment, not the one inside it.
  assert.match(toggleTask(COMMENTED, 1, true, 'another real task'), /- \[x\] another real task/);
  assert.match(toggleTask(COMMENTED, 1, true, 'another real task'), /- \[ \] an example nobody ticks/);
});

// A <summary> is a disclosure's label, rendered inline, so a checklist line
// written inside one is text on GitHub. The pane folded the whole summary into
// one heading line while the server still counted the task in it, so every
// index after it pointed one line further down than the pane meant.
test('a checklist line inside a <summary> counts for neither side', () => {
  const body = '<details>\n<summary>\n- [ ] not a task, a label\n</summary>\n\n- [ ] a real task\n</details>\n- [ ] another';
  assert.deepEqual(paneTasks(body), ['a real task', 'another']);
  assert.deepEqual(taskLines(body), [5, 7]);
  assert.match(toggleTask(body, 0, true, 'a real task'), /- \[x\] a real task/);
});

// Same order as the pane, which strips comments before it looks for fences: a
// ``` inside a comment opens a fence on neither side.
test('a fence marker inside a comment opens no fence', () => {
  const body = '<!-- ```sh -->\n- [ ] still a task';
  assert.deepEqual(taskLines(body), [1]);
  assert.deepEqual(paneTasks(body), ['still a task']);
});

// A note left on a checklist line. The pane renders the line without the
// comment and sends that text, so reading the raw line refused every tick on it
// as "the description changed under that checkbox". A `[x]` inside a comment
// ahead of the box is not the box, either.
test('a checkbox with a comment on its line can be ticked, and only its own box flips', () => {
  const body = '- [ ] fix the parser <!-- see #12 -->\n<!-- [x] --> - [ ] and the lexer';
  const seen = paneTasks(body);
  assert.deepEqual(seen.map((t) => t.trim()), ['fix the parser', 'and the lexer']);
  assert.equal(toggleTask(body, 0, true, seen[0]).split('\n')[0], '- [x] fix the parser <!-- see #12 -->');
  assert.equal(toggleTask(body, 1, true, seen[1]).split('\n')[1], '<!-- [x] --> - [x] and the lexer');
});

// The pane used to delete a comment's newlines with it, so a comment that
// ended on a task's line joined that task onto the line the comment started on
// -- where it was no longer at the start of a line, and no longer a task. The
// server kept the line, counted it, and every index after it was off by one.
test('a comment ending on a task line leaves that task a task on both sides', () => {
  const body = 'prose <!--\nnote\n--> - [ ] after the comment\n- [ ] last';
  assert.deepEqual(paneTasks(body).map((t) => t.trim()), ['after the comment', 'last']);
  assert.deepEqual(taskLines(body), [2, 3]);
  assert.doesNotThrow(() => toggleTask(body, 1, true, 'last'));
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
