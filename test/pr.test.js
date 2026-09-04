import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle, withoutHtml, inline, fences, TASK, HEADING } from '../public/pr.js';

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
