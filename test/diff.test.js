import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, diffKind } from '../public/diff.js';

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
