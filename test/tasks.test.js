import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleTask, taskLines, refs, wholeRef, resolveRef, printable, fences, TASK, HEADING, blocks, sectionize,
} from '../public/tasks.js';

// --- checkboxes in the description ---

const BODY = [
  'Prose first, with a list that is not a checklist:',
  '',
  '- plain bullet',
  '- [ ] first task',
  '- [x] second task, already done',
  '',
  '<!-- begin checklist -->',
  '## Checklist',
  '',
  '- [ ] a task between comments',
  '<!-- end checklist -->',
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
// This calls blocks(), the parser the pane draws from, rather than a walk
// written here. It used to be a third copy of the pattern -- which meant the
// one file whose whole subject is "these two walks must not diverge" was
// comparing the server against something neither side ships.

const paneTasks = (body) => blocks(body).filter((b) => b.kind === 'task').map((b) => b.text);

test('the PR pane and toggleTask pick out the same checklist lines', () => {
  const seen = paneTasks(BODY);
  assert.deepEqual(seen, ['first task', 'second task, already done', 'a task between comments']);
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

// The comment in the middle this time. The pane deletes it and sends the text
// with two spaces where it was; the server used to read the line with the
// comment blanked to spaces and compare, and those never agree -- the box
// refused every tick with "refresh", and refreshing changed nothing.
test('a checkbox with a comment in the middle of its text can be ticked', () => {
  const body = '- [ ] fix <!-- note --> the parser';
  const [seen] = paneTasks(body);
  assert.equal(toggleTask(body, 0, true, seen), '- [x] fix <!-- note --> the parser');
});

// The same disagreement over a <details> tag: the pane unwraps it, so a tag on
// a task's line is gone from the text it sends -- and one opening the line was
// a task to the pane and none to the server, putting every later index one off.
test('a <details> tag on a task line is unwrapped on both sides', () => {
  const body = '- [ ] closing one </details>\n<details>- [ ] opening one\n- [ ] last';
  const seen = paneTasks(body);
  assert.deepEqual(seen.map((t) => t.trim()), ['closing one', 'opening one', 'last']);
  assert.deepEqual(taskLines(body), [0, 1, 2]);
  for (const [index, text] of seen.entries()) {
    assert.doesNotThrow(() => toggleTask(body, index, true, text), `index ${index} (${text})`);
  }
  assert.equal(toggleTask(body, 1, true, seen[1]).split('\n')[1], '<details>- [x] opening one');
});

// A tag broken across lines is still one tag, and still leaves the lines where
// they were: the server edits the raw body at the line number the pane counted.
test('a <details> tag over two lines keeps every line after it in place', () => {
  const body = '<details\nopen>\n- [ ] inside';
  assert.deepEqual(taskLines(body), [2]);
  assert.equal(toggleTask(body, 0, true, paneTasks(body)[0]).split('\n')[2], '- [x] inside');
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

// --- headings ---

// A checklist line and a heading are told apart by the same pass, and `#hashtag`
// with no space is neither -- it is prose, and rendering it as a heading would
// eat the line.
test('a heading needs its space, and a task is not one', () => {
  assert.equal(HEADING.exec('## TODO')[1].length, 2);
  assert.equal(HEADING.exec('###### deep')[1].length, 6);
  assert.equal(HEADING.exec('#hashtag'), null);
  assert.equal(HEADING.exec('####### seven'), null);
  assert.equal(HEADING.exec('- [ ] an item'), null);
  assert.ok(TASK.exec('- [ ] an item'));
});

// --- fenced blocks ---

// A fence contains blank lines, so it has to be lifted out before paragraphs
// are split on them -- otherwise the block arrives in pieces.
test('a fence is one chunk, blank lines and all', () => {
  const out = fences('before\n\n```sh\nnpm install\n\nnpm link\n```\n\nafter');
  assert.deepEqual(out.map((c) => (c.code !== undefined ? 'code' : 'text')), ['text', 'code', 'text']);
  assert.equal(out[1].code, 'npm install\n\nnpm link');
  assert.match(out[0].text, /before/);
  assert.match(out[2].text, /after/);
});

test('a body with no fence is one chunk of text', () => {
  assert.deepEqual(fences('just prose'), [{ text: 'just prose' }]);
  assert.deepEqual(fences(''), []);
});

// An unterminated fence must not swallow the rest of the description.
test('a fence that is never closed is left as text', () => {
  const out = fences('text\n\n```sh\nnpm install\n\nstill prose');
  assert.deepEqual(out.map((c) => (c.code !== undefined ? 'code' : 'text')), ['text']);
  assert.match(out[0].text, /still prose/);
});

// --- lists ---
//
// The renderer had no list rule at all until this: every `- item` line fell
// through into the prose accumulator and came out as a literal hyphen inside a
// <p> joined by <br>, with no hanging indent. This repo's own description has
// two sections that are nothing but long bullets.

const kinds = (body) => blocks(body).map((b) => b.kind);
const only = (body, kind) => blocks(body).filter((b) => b.kind === kind);

test('a bullet list is a list, not a paragraph starting with a hyphen', () => {
  const [list] = only('- one\n- two', 'list');
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items, ['one', 'two']);
});

// The load-bearing one. TASK matches a subset of BULLET, so if the list rule
// ran first a checklist line would never be given an index -- and every tick
// after it in the body would then address the line above, silently.
test('a checklist line is a task, never a bullet', () => {
  assert.deepEqual(kinds('- [ ] a\n- b\n- [x] c'), ['task', 'list', 'task']);
  assert.deepEqual(only('- [ ] a\n- b\n- [x] c', 'task').map((b) => b.index), [0, 1]);
  assert.deepEqual(only('- [ ] a\n- b\n- [x] c', 'list')[0].items, ['b']);
});

test('an ordered list keeps the number the author started at', () => {
  const [list] = only('3. c\n4. d', 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.deepEqual(list.items, ['c', 'd']);
});

test('a marker with no space after it is prose', () => {
  for (const line of ['-flag', '--body-file -', '*emphasis* alone', '1.5 seconds']) {
    assert.deepEqual(kinds(line), ['p'], line);
  }
});

test('a nested list flattens to one level rather than being mis-parsed', () => {
  assert.deepEqual(only('- a\n  - b\n- c', 'list')[0].items, ['a', 'b', 'c']);
});

test('a wrapped bullet stays one item', () => {
  assert.deepEqual(only('- a line that\n  kept going\n- next', 'list')[0].items,
    ['a line that\nkept going', 'next']);
});

test('a change of marker starts a new list', () => {
  assert.deepEqual(kinds('- a\n1. b'), ['list', 'list']);
});

test('prose above a list stays its own paragraph', () => {
  assert.deepEqual(kinds('Some prose:\n- a\n- b'), ['p', 'list']);
});

test('a quoted line is a quote, not prose starting with a chevron', () => {
  assert.deepEqual(only('> quoted', 'quote'), [{ kind: 'quote', text: 'quoted' }]);
});

// No space needed after the `>`, unlike a bullet: `>text` is a quote on GitHub.
test('a quote needs no space after its marker, and gives up only one', () => {
  assert.deepEqual(only('>tight', 'quote')[0].text, 'tight');
  assert.deepEqual(only('>   padded', 'quote')[0].text, '  padded');
});

test('consecutive quoted lines are one quote', () => {
  assert.deepEqual(only('> one\n> two', 'quote'), [{ kind: 'quote', text: 'one\ntwo' }]);
});

test('an unmarked line under a quote is still the quote', () => {
  assert.deepEqual(only('> one\nstill quoted', 'quote')[0].text, 'one\nstill quoted');
});

// A blank line ends a paragraph, so two quoted stanzas are two quotes -- which
// is what GitHub renders, and what lets a description quote two people.
test('a blank line between quoted stanzas gives two quotes', () => {
  assert.deepEqual(kinds('> one\n\n> two'), ['quote', 'quote']);
});

test('prose and a list around a quote each stay their own block', () => {
  assert.deepEqual(kinds('lead\n> quoted\n- a'), ['p', 'quote', 'list']);
  assert.deepEqual(kinds('> quoted\ntail\n# head'), ['quote', 'heading']);
});

// The indexing argument, pinned: TASK in tasks.js does not match a quoted
// checklist line either, so neither side counts it and the tick stays in step.
test('a quoted checklist line counts on neither side', () => {
  assert.deepEqual(kinds('- [ ] a\n\n> - [ ] b\n\n- [ ] c'), ['task', 'quote', 'task']);
  assert.deepEqual(only('- [ ] a\n\n> - [ ] b\n\n- [ ] c', 'task').map((b) => b.index), [0, 1]);
  assert.deepEqual(taskLines('- [ ] a\n\n> - [ ] b\n\n- [ ] c'), [0, 4]);
});

test('a quote inside a fence is a sample, not a quote', () => {
  assert.deepEqual(kinds('```sh\n> not a quote\n```'), ['code']);
});

test('a bullet inside a fence is a sample, not a list', () => {
  assert.deepEqual(kinds('```sh\n- not a bullet\n- [ ] not a task\n```'), ['code']);
});

// --- sectioning ---
//
// A description is folded by section so that ten sections of agent-written
// prose do not bury the rest of the pane. The fold level comes from the body
// rather than being fixed here, because one description uses `##` for its
// sections while another someone typed may well start at `#`.

const fold = (body) => sectionize(blocks(body));
const titles = (body) => fold(body).sections.map((s) => s.title);

test('a description folds at the shallowest heading level it uses', () => {
  assert.deepEqual(titles('# One\n\ntext\n\n# Two'), ['One', 'Two']);
  assert.deepEqual(titles('## One\n\ntext\n\n## Two'), ['One', 'Two']);
});

test('a heading deeper than the fold level stays inside its section', () => {
  const { sections } = fold('## One\n\n#### Inner\n\ntext\n\n## Two');
  assert.deepEqual(sections.map((s) => s.title), ['One', 'Two']);
  assert.deepEqual(sections[0].nodes.map((b) => b.kind), ['heading', 'p']);
  assert.equal(sections[0].nodes[0].level, 4);
});

test('everything before the first heading is the lead', () => {
  // The shape of this repo's own description: prose, then the install fence,
  // then the first section.
  const { lead, sections } = fold('Run prcoder.\n\n```sh\nnpm install\n```\n\n## Why\n\nbecause');
  assert.deepEqual(lead.map((b) => b.kind), ['p', 'code']);
  assert.equal(sections.length, 1);
});

test('a description with no headings is all lead and no sections', () => {
  const { lead, sections } = fold('Just a sentence.');
  assert.deepEqual(lead.map((b) => b.kind), ['p']);
  assert.deepEqual(sections, []);
});

test('a heading inside a fence opens no section', () => {
  // This repo's README and its description each show a fenced `## Queue`.
  assert.deepEqual(titles('```markdown\n## Queue\n```\n\n## Real'), ['Real']);
});

test('two sections with the same title get keys that tell them apart', () => {
  assert.deepEqual(fold('## Why\n\na\n\n## Why\n\nb').sections.map((s) => s.key),
    ['Why', 'Why#2']);
});

test('sectioning loses nothing', () => {
  const body = 'lead\n\n## One\n\n- a\n- b\n\n### Deep\n\n## Two\n\n- [ ] t';
  const { lead, sections } = fold(body);
  const total = lead.length + sections.reduce((n, s) => n + s.nodes.length, 0) + sections.length;
  assert.equal(total, blocks(body).length);
});

// --- references typed into the queue ---

const shape = (text) => refs(text).map(({ owner, name, number }) => [owner, name, number]);

test('the four ways of typing a reference each read as one', () => {
  assert.deepEqual(shape('#91'), [[null, null, 91]]);
  assert.deepEqual(shape('prcoder#91'), [[null, 'prcoder', 91]]);
  assert.deepEqual(shape('gaurav/prcoder#91'), [['gaurav', 'prcoder', 91]]);
  assert.deepEqual(shape('https://github.com/gaurav/prcoder/issues/91'), [['gaurav', 'prcoder', 91]]);
  // A PR's URL, with whatever GitHub puts after the number when you copy it.
  assert.deepEqual(shape('https://github.com/cli/cli.go/pull/7/files'), [['cli', 'cli.go', 7]]);
  assert.deepEqual(shape('https://github.com/o/r/issues/5#issuecomment-12'), [['o', 'r', 5]]);
});

test('a reference is only whole when there is nothing else in the text', () => {
  assert.equal(wholeRef('  #91 ')?.number, 91);
  assert.equal(wholeRef('https://github.com/o/r/pull/3?w=1')?.number, 3);
  assert.equal(wholeRef('Fix #93'), null);
  assert.equal(wholeRef('#93 and #94'), null);
  assert.deepEqual(shape('Fix #93 and #94.'), [[null, null, 93], [null, null, 94]]);
});

// What is not one: GitHub links a `#N` only at the start of a word, and so
// does this; and a GitHub URL that is not an issue or a PR is just a link.
test('text that only contains a # or a GitHub link is not a reference', () => {
  assert.deepEqual(refs('see issue#91x and a#b'), []);
  assert.deepEqual(refs('https://github.com/o/r/blob/main/README.md'), []);
  assert.deepEqual(refs('https://github.com/o/r/issues/'), []);
  assert.deepEqual(refs('path/#5'), []);
});

test('a reference resolves against the repo prcoder is in', () => {
  const home = 'gaurav/prcoder';
  assert.deepEqual(resolveRef(refs('#91')[0], home), { repo: null, number: 91 });
  assert.deepEqual(resolveRef(refs('prcoder#91')[0], home), { repo: null, number: 91 });
  assert.deepEqual(resolveRef(refs('Gaurav/PRCoder#91')[0], home), { repo: null, number: 91 });
  assert.deepEqual(resolveRef(refs('cli/cli#123')[0], home), { repo: 'cli/cli', number: 123 });
});

// A repo with no GitHub name prcoder could read: the server passes its
// message on as the reason the text was added untagged.
test('with no home repo, only a reference that names its owner resolves', () => {
  assert.deepEqual(resolveRef(refs('cli/cli#123')[0], null), { repo: 'cli/cli', number: 123 });
  assert.throws(() => resolveRef(refs('#91')[0], null), /#91: this repo's GitHub name is not known/);
  assert.throws(() => resolveRef(refs('prcoder#91')[0], undefined), /prcoder#91: /);
});

// Any word before a #N has the short form's shape, and each of these was once
// looked up as a repo of that name and refused, so it could not be added.
test('the short form is only this repo, once the repo is known', () => {
  const home = 'gaurav/prcoder';
  assert.deepEqual(refs('Learn C#7 features', home), []);
  assert.deepEqual(refs('retry bug#12, then other#2', home), []);
  assert.deepEqual(shape('PRCoder#91'), [[null, 'PRCoder', 91]]);
  assert.equal(refs('PRCoder#91', home)[0].number, 91);
  // Every other shape names its repo outright, or is this one.
  assert.equal(refs('#4 and cli/cli#5 and https://github.com/o/r/issues/6', home).length, 3);
  assert.equal(wholeRef('C#7', home), null);
  // Unknown, nothing is dropped: the server, which knows, decides.
  assert.deepEqual(shape('C#7'), [[null, 'C', 7]]);
});

test('printable makes every run of control characters one space', () => {
  assert.equal(printable('a\r\nb\u001b[2Jc\u009bd\u007fe'), 'a b [2Jc d e');
  assert.equal(printable('plain — text'), 'plain — text');
});
