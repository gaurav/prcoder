import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, diffKind, outline, language, grammars, highlightLines } from '../public/diff.js';

const modified = '@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n\\ No newline at end of file';

test('diff lines are classified by their leading character', () => {
  const rows = diffRows(modified);
  assert.deepEqual(rows.map((r) => r.cls), ['hunk', 'ctx', 'del', 'add', 'ctx']);
  assert.equal(rows[3].text, '+new');
  assert.equal(diffKind(modified), null);
});

// GitHub's patch for a file the PR adds is one hunk from nothing; every line is
// `+`, so the pane shows it plain and says NEW in the title instead.
test('an added file is plain text with the + column and hunk header gone', () => {
  const patch = '@@ -0,0 +1,2 @@\n+a\n+ b\n\\ No newline at end of file';
  assert.equal(diffKind(patch), 'add');
  assert.deepEqual(diffRows(patch), [
    { cls: 'ctx', text: 'a' }, { cls: 'ctx', text: ' b' },
    { cls: 'hunk', text: '\\ No newline at end of file' },
  ]);
});

test('a removed file is the same, read off a hunk to nothing', () => {
  const patch = '@@ -1,2 +0,0 @@\n-a\n-b';
  assert.equal(diffKind(patch), 'del');
  assert.deepEqual(diffRows(patch).map((r) => r.text), ['a', 'b']);
});

// The outline is git's funcname context, which GitHub keeps after the second
// @@; a hunk without one is named by its new-side start line.
test('the outline names each hunk by its context, or its line', () => {
  const rows = diffRows('@@ -1,7 +1,7 @@\n ctx\n@@ -63,22 +63,20 @@ def note(row):\n-x\n@@ -9 +10 @@ ## Heading');
  assert.deepEqual(outline(rows), [
    { at: 0, text: 'line 1' }, { at: 2, text: 'def note(row):' }, { at: 4, text: '## Heading' },
  ]);
});

test('one hunk, or a whole file, has no outline', () => {
  assert.deepEqual(outline(diffRows(modified)), []);
  assert.deepEqual(outline(diffRows('@@ -0,0 +1,2 @@\n+a\n+b')), []);
  assert.deepEqual(outline(diffRows('@@ -1 +1 @@\n-a\n+b', 'old.md')), []);
});

// GitHub says `previous_filename` for a rename; a pure rename has no patch at
// all, which the pane must not read as binary.
test('a renamed file leads with its old name, and a pure rename is only that', () => {
  assert.deepEqual(diffRows('@@ -1 +1 @@\n-a\n+b', 'old.md').map((r) => r.text),
    ['renamed from old.md', '@@ -1 +1 @@', '-a', '+b']);
  assert.deepEqual(diffRows(null, 'old.md'), [{ cls: 'hunk', text: 'renamed from old.md' }]);
  assert.deepEqual(diffRows(null), []);
});

// A hunk that happens to start at line 0 of neither side is a change, and a
// one-line patch has no newline to find.
test('diffKind reads only the first hunk header', () => {
  assert.equal(diffKind('@@ -1,3 +1,4 @@\n ctx\n+x\n@@ -0,0 +9,1 @@\n+y'), null);
  assert.equal(diffKind('@@ -0,0 +1 @@'), 'add');
});

// The language is read off the extension alone -- never off the content, which
// would run every grammar over a stranger's file -- and a file with no known
// one stays plain.
test('language is by extension only, or nothing', () => {
  assert.equal(language('src/app.mjs'), 'javascript');
  assert.equal(language('types/index.d.ts'), 'typescript');
  assert.equal(language('.github/workflows/ci.YML'), 'yaml');
  // Its own grammar, not typescript's: typescript does not parse JSX.
  assert.equal(language('src/App.tsx'), 'tsx');
  assert.equal(language('Makefile'), null);
  assert.equal(language('notes.txt'), null);
  assert.equal(language('.bashrc'), null);
});

// A dotless name is a name, not an extension. `Makefile` above passes whatever
// the rule is, because `makefile` happens not to be in the map; these do not.
// Each is a real extensionless file with a key of the map for a name, and each
// was highlighted as that language before the extension was taken off the
// basename after a dot that is not its first character.
test('a name with no extension is no language', () => {
  assert.equal(language('patch'), null);
  assert.equal(language('sh'), null);
  assert.equal(language('scripts/bash'), null);
  assert.equal(language('doc/md'), null);
  assert.equal(language('src/json'), null);
});

// What server.js builds the Prism half of its vendor map from, derived from the
// map above rather than written out beside it. Two things hold it together:
// what core already carries is not asked for as a file of its own, and a
// grammar built on others brings them along -- prism-tsx registers nothing
// without jsx and typescript under it. A name missing here is a 404 the pane
// shows as a plain file and a console line, which is why api.test.js fetches
// every one of them.
test('the grammar list brings prerequisites and leaves out what core carries', () => {
  for (const core of ['markup', 'css', 'clike', 'javascript']) {
    assert.ok(!grammars.includes(core), `${core} is in Prism core, not a file of its own`);
  }
  for (const l of ['tsx', 'jsx', 'typescript', 'markdown', 'yaml']) {
    assert.ok(grammars.includes(l), `${l} is missing from the vendor list`);
  }
  assert.deepEqual(grammars, [...new Set(grammars)].sort(), 'sorted, and each named once');
});

// The real tokenizer, so a Prism upgrade that changes the token shape fails
// here rather than in the pane. Two properties matter: every line joins back
// to the source exactly (no character invented or dropped between the spans),
// and a token that spans lines keeps its class on each of them.
test('highlightLines splits Prism tokens per line without losing a character', async () => {
  const { default: Prism } = await import('prismjs');
  const src = '/* a\n b */ const x = "<s>";\n\nf(1)';
  const lines = highlightLines(src, Prism.languages.javascript, Prism.tokenize);
  assert.equal(lines.map((l) => l.map((s) => s.text).join('')).join('\n'), src);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], [{ cls: 'tok-comment', text: '/* a' }]);
  assert.equal(lines[1][0].cls, 'tok-comment');
  assert.deepEqual(lines[2], []);
  assert.deepEqual(lines[3].map((s) => s.cls), ['tok-function', 'tok-punctuation', 'tok-number', 'tok-punctuation']);
  assert.equal(lines[1].find((s) => s.text === '"<s>"').cls, 'tok-string');
});

// A nested token -- a template string's interpolation -- takes the innermost
// class, and an alias comes along as a second class.
test('highlightLines uses the innermost token and carries aliases', async () => {
  const { default: Prism } = await import('prismjs');
  const lines = highlightLines('`a${b}`', Prism.languages.javascript, Prism.tokenize);
  const classes = lines[0].map((s) => s.cls);
  assert.ok(classes.includes('tok-template-punctuation tok-string'), classes.join());
  assert.deepEqual(lines[0].find((s) => s.text === 'b'), { cls: 'tok-interpolation', text: 'b' });
  assert.ok(classes.every((c) => /^tok-[\w-]+( tok-[\w-]+)*$/.test(c)), classes.join());
});
