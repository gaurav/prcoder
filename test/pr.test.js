import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageTitle, withoutHtml, inline, queueSync, HEADING, blocks, sectionize,
  tabLabel, taskCount, viewedCount,
} from '../public/pr.js';
import { fences, TASK, taskLines } from '../public/tasks.js';

const status = (over = {}) => ({
  nameWithOwner: 'ggvaidya/prcoder',
  branch: 'initial-implementation',
  detached: false,
  pr: null,
  ...over,
});

const pr = (over = {}) => ({
  number: 12,
  title: 'Name the tab after the pull request',
  url: 'https://github.com/ggvaidya/prcoder/pull/12',
  ...over,
});

test('the tab is named for the pull request, short URL first', () => {
  assert.equal(pageTitle(status({ pr: pr() })),
    'ggvaidya/prcoder#12 · Name the tab after the pull request · prcoder');
});

test('the short URL comes from the pull request, not the checkout', () => {
  const forked = pr({ url: 'https://github.com/someone/prcoder/pull/3', number: 3 });
  assert.match(pageTitle(status({ pr: forked, scope: 'other-repo' })), /^someone\/prcoder#3 /);
});

test('a long pull request title is cut to a tab-sized name', () => {
  const long = pr({ title: 'Fetch each file’s patch from GitHub and serve it from POST /api/diff, with a cache' });
  const title = pageTitle(status({ pr: long }));
  assert.ok(title.length <= 72 + ' · prcoder'.length, `${title.length} chars: ${title}`);
  assert.ok(title.startsWith('ggvaidya/prcoder#12 · Fetch each file'));
  assert.ok(title.endsWith('… · prcoder'));
});

test('with no pull request the branch names the tab', () => {
  assert.equal(pageTitle(status()), 'ggvaidya/prcoder · initial-implementation (no PR) · prcoder');
  assert.equal(pageTitle(status({ detached: true, branch: '' })),
    'ggvaidya/prcoder · detached HEAD (no PR) · prcoder');
});

test('a first load that failed has nothing to name the tab with', () => {
  assert.equal(pageTitle({ error: 'gh: not logged in' }), 'prcoder');
  assert.equal(pageTitle(null), 'prcoder');
});

// --- the raw HTML a description actually contains ---

// The pane escapes everything, which is right for safety and wrong for the
// three constructs a real description uses. All three shipped visible: `## Why`
// as a literal `## Why`, prcoder's own markers sitting above the list they
// delimit, and a stray `</details>` mid-pane.
test("prcoder's own block markers do not show up in the pane", () => {
  const body = ['Prose above.', '', '<!-- prcoder:todo -->', '## TODO', '',
    '- [ ] an item', '<!-- /prcoder:todo -->', '', 'Prose below.'].join('\n');
  const out = withoutHtml(body);
  assert.doesNotMatch(out, /<!--/);
  assert.doesNotMatch(out, /prcoder:todo/);
  // The block's contents survive -- only the markers go.
  assert.match(out, /## TODO/);
  assert.match(out, /- \[ \] an item/);
  assert.match(out, /Prose above[\s\S]*Prose below/);
});

test('a comment spanning lines goes entirely, not just its first line', () => {
  assert.equal(withoutHtml('a\n<!-- one\ntwo\nthree -->\nb').trim(), 'a\n\nb'.trim());
});

// A <details> block is how this repo's own PR keeps its history out of the way.
// Unwrapped rather than reproduced: the pane scrolls, and the summary is the
// heading of whatever it was hiding.
test('a details block is unwrapped and its summary becomes a heading', () => {
  const out = withoutHtml('<details>\n<summary><b>History</b> — why this looks like this</summary>\n\nThe story.\n\n</details>');
  assert.doesNotMatch(out, /<\/?(details|summary|b)>/);
  assert.match(out, /^#### History — why this looks like this$/m);
  assert.match(out, /The story\./);
});

test('a summary broken across lines still yields one heading line', () => {
  const out = withoutHtml('<details>\n<summary>\n  A summary\n  over three lines\n</summary>\nbody\n</details>');
  assert.match(out, /^#### A summary over three lines$/m);
});

// Everything else stays escaped and shows as text: an allowlist of three, not
// the start of an HTML renderer.
test('other HTML is left alone for the escaper to deal with', () => {
  assert.equal(withoutHtml('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(withoutHtml('<b>bold</b> and <img src=x>'), '<b>bold</b> and <img src=x>');
});

test('nothing to strip leaves the text untouched', () => {
  assert.equal(withoutHtml('## Why\n\nPlain prose.'), '## Why\n\nPlain prose.');
  assert.equal(withoutHtml(null), '');
  assert.equal(withoutHtml(undefined), '');
});

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

// --- emphasis, and what it must not reach into ---

// The reason code spans are lifted out first: this repo's own prose is full of
// `PRCODER_NO_OPEN` and `--body-file`, and an underscore rule that ran over a
// code span would italicise the middle of an environment variable.
test('a code span is never reached into by another rule', () => {
  assert.equal(inline('`PRCODER_NO_OPEN` and `CLAUDE_BIN`'),
    '<code>PRCODER_NO_OPEN</code> and <code>CLAUDE_BIN</code>');
  assert.equal(inline('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inline('`https://example.com`'), '<code>https://example.com</code>');
});

test('emphasis renders in both spellings, bold before italic', () => {
  assert.equal(inline('**bold** and *italic* and _also italic_'),
    '<strong>bold</strong> and <em>italic</em> and <em>also italic</em>');
  // Prettier rewrites *x* to _x_ when it touches a PR body, so both spellings
  // turn up in the same description.
  assert.equal(inline('review _for_ you'), 'review <em>for</em> you');
});

test('an underscore inside a word is not emphasis', () => {
  assert.equal(inline('some_var_name stays whole'), 'some_var_name stays whole');
  assert.equal(inline('PRCODER_NO_OPEN=1'), 'PRCODER_NO_OPEN=1');
});

test('escaping still happens, and happens first', () => {
  assert.equal(inline('<script>'), '&lt;script&gt;');
  assert.equal(inline('`<b>`'), '<code>&lt;b&gt;</code>');
});

// A quote is as dangerous as an angle bracket here, because inline() is the
// only thing between a PR body and an href="..." set with innerHTML -- and an
// event-handler attribute smuggled in that way does fire. The pane shares a
// page with the /pty socket, so it would be a typed turn into the running
// claude session, from a description anyone opening a PR can write.
test('a quote in a link cannot break out of the attribute it is written into', () => {
  // An attribute the renderer never writes, opening its own quoted value: the
  // shape of the escape, rather than the word, which survives harmlessly inside
  // the href as text.
  const broke = /\son\w+=["']/;
  assert.doesNotMatch(inline('[docs](https://x.test/a" onmouseover="alert(1))'), broke);
  assert.match(inline('[docs](https://x.test/a" x)'), /&quot;/);
  // Same for a bare URL, which is linkified by the other rule.
  assert.doesNotMatch(inline('https://x.test/a" onmouseover="alert(1)'), broke);
  // And for single-quoted attributes, which are as valid as double-quoted ones.
  assert.doesNotMatch(inline("[d](https://x.test/a' onmouseover='alert(1))"), broke);
});

test('a quote in ordinary prose still reads as a quote', () => {
  assert.equal(inline('he said "no"'), 'he said &quot;no&quot;');
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

// The queue pane's light. "Nothing to mirror" and "GitHub has it" are both
// fine, and only one of them earns a dot.
test('the queue light shows only what is worth acting on', () => {
  const q = [{ text: 'a', inPr: true }];
  assert.equal(queueSync({ queue: [{ text: 'a', inPr: false }], scope: 'current' }), null);
  assert.equal(queueSync({ queue: q, scope: 'current' }).text, 'in the PR');
  // A tombstoned item is not evidence of anything still mirrored.
  assert.equal(queueSync({ queue: [{ text: 'a', inPr: true, deleted: true }], scope: 'current' }), null);
  // The one that matters: the store took it, GitHub did not.
  assert.match(queueSync({ queue: q, scope: 'current', mirrorFailed: true }).className, /bad/);
  assert.equal(queueSync({ queue: q, scope: 'other-branch' }).text, 'not mirroring');
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
// rather than being fixed here, because prcoder's own mirrored block writes
// `## TODO` while a description someone typed may well start at `#`.

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

// --- the tab labels ---
//
// The count on each tab is the one thing it can tell you while you are looking
// at the other one, which is the whole reason the pane can afford to show only
// half of itself at a time.

test('a tab with nothing to count is named, not numbered', () => {
  assert.equal(tabLabel('Detail', { done: 0, total: 0 }), 'Detail');
  assert.equal(tabLabel('Files', { done: 0, total: 0 }), 'Files');
});

// A fraction that has run out says the wrong thing: `(10/10)` reads as a
// proportion you would want to be larger, when it means there is nothing left.
test('a tab whose count has run out says so rather than showing 10/10', () => {
  assert.equal(tabLabel('Detail', { done: 10, total: 10 }), 'Detail ✓');
  assert.equal(tabLabel('Files', { done: 1, total: 1 }), 'Files ✓');
  // Distinct from the nothing-to-count case, which is the bare name -- so a
  // description with no checklist never claims to have finished one.
  assert.equal(tabLabel('Detail', { done: 0, total: 0 }), 'Detail');
});

test('a tab with something to count carries done over total', () => {
  assert.equal(tabLabel('Detail', { done: 3, total: 10 }), 'Detail (3/10)');
  // Nothing done yet still counts: `(0/4)` is four things waiting, and reads
  // very differently from a bare `Files`.
  assert.equal(tabLabel('Files', { done: 0, total: 4 }), 'Files (0/4)');
});

test('the description count walks the body, fences and all', () => {
  assert.deepEqual(taskCount('- [x] a\n- [ ] b\n- [x] c'), { done: 2, total: 3 });
  // The same rule the tick uses: a checklist line inside a fence is a sample.
  assert.deepEqual(taskCount('```\n- [ ] sample\n```\n\n- [x] real'), { done: 1, total: 1 });
  assert.deepEqual(taskCount('Just prose.'), { done: 0, total: 0 });
});

test('the file count is files viewed on GitHub, over files changed', () => {
  assert.deepEqual(viewedCount([{ viewed: true }, { viewed: false }, { viewed: true }]),
    { done: 2, total: 3 });
  // A pull request whose files have not loaded yet must name the tab rather
  // than throw at it -- renderPrHead runs on the first paint either way.
  assert.deepEqual(viewedCount(), { done: 0, total: 0 });
  assert.deepEqual(viewedCount([]), { done: 0, total: 0 });
});
