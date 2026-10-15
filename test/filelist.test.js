// public/filelist.js: the Files tab's counts and pie, the order it lays the
// files out in, and the walk the keyboard takes through them. All of it runs
// in Node without a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewedCount, viewedLines, filesProgress, byPath, bySize, byDir, fileTree, fileOrder, fileFrom, nextUnviewed, nums,
} from '../public/filelist.js';

test('the file count is files viewed on GitHub, over files changed', () => {
  assert.deepEqual(viewedCount([{ viewed: true }, { viewed: false }, { viewed: true }]),
    { done: 2, total: 3 });
  // A pull request whose files have not loaded yet must name the tab rather
  // than throw at it -- renderPrHead runs on the first paint either way.
  assert.deepEqual(viewedCount(), { done: 0, total: 0 });
  assert.deepEqual(viewedCount([]), { done: 0, total: 0 });
});

// The Files pie says how much reviewing is left, not how many files: a big file
// left unviewed keeps it mostly empty however many small ones are ticked.
test('the files pie fills by changed lines viewed', () => {
  const big = { additions: 100, deletions: 100, viewed: false };
  const small = { additions: 30, deletions: 5, viewed: true };
  assert.deepEqual(viewedLines([big, small]), { done: 35, total: 235 });
  assert.deepEqual(filesProgress([big, small]),
    { p: 35 / 235, full: false, label: '1 of 2 files, 35 of 235 changed lines viewed',
      count: { done: 1, total: 2 }, lines: '35 of 235 changed lines viewed' });
  // GitHub's count can be missing, as bySize allows for.
  assert.deepEqual(viewedLines([{ viewed: true }]), { done: 0, total: 0 });
  assert.deepEqual(viewedLines(), { done: 0, total: 0 });
});

test('a files pie with no lines to weigh fills by files', () => {
  const rename = (viewed) => ({ additions: 0, deletions: 0, viewed });
  assert.deepEqual(filesProgress([rename(true), rename(false)]),
    { p: 0.5, full: false, label: '1 of 2 files viewed', count: { done: 1, total: 2 }, lines: null });
  assert.deepEqual(filesProgress([]), { p: 0, full: false, label: '0 of 0 files viewed', count: { done: 0, total: 0 }, lines: null });
});

// GitHub can list fewer files than the pull request changes: the Files tab
// counts against the whole, so ticking every listed file is not done.
test('the Files tab counts the files GitHub did not list as unviewed', () => {
  const listed = [{ additions: 10, deletions: 0, viewed: true }, { additions: 5, deletions: 5, viewed: true }];
  const whole = { changedFiles: 3, additions: 30, deletions: 5 };
  assert.deepEqual(filesProgress(listed, whole), { p: 20 / 35, full: false, label: '2 of 3 files, 20 of 35 changed lines viewed',
    count: { done: 2, total: 3 }, lines: '20 of 35 changed lines viewed' });
  // Listed in full, the totals agree and change nothing.
  assert.equal(filesProgress(listed, { changedFiles: 2, additions: 15, deletions: 5 }).full, true);
  // And without them -- a group, a directory -- it is the list alone.
  assert.equal(filesProgress(listed).full, true);
});

// Every line viewed is not every file: an unviewed rename weighs nothing, and
// must not let the pie say it is finished.
test('a files pie is full only when every file is viewed', () => {
  const files = [{ additions: 9, deletions: 0, viewed: true }, { additions: 0, deletions: 0, viewed: false }];
  assert.deepEqual(filesProgress(files), { p: 1, full: false, label: '1 of 2 files, 9 of 9 changed lines viewed',
    count: { done: 1, total: 2 }, lines: '9 of 9 changed lines viewed' });
  assert.equal(filesProgress(files.map((f) => ({ ...f, viewed: true }))).full, true);
});

test('paths order like a tree, a directory ahead of what is inside it', () => {
  assert.deepEqual(['gamma/', 'alpha/beta/', 'alpha/', '.github/'].sort(byPath),
    ['.github/', 'alpha/', 'alpha/beta/', 'gamma/']);
  // The case the obvious implementation gets wrong. `-` is 45 and `/` is 47, so
  // comparing the whole strings sorts `alpha-x/` *between* a directory and its
  // own child; comparing segment by segment puts it after both.
  assert.deepEqual(['alpha-x/', 'alpha/beta/', 'alpha/'].sort(byPath),
    ['alpha/', 'alpha/beta/', 'alpha-x/']);
  // And the contrast, pinned so the claim above stays checkable: the default
  // sort does put it between them.
  assert.deepEqual(['alpha/beta/', 'alpha-x/', 'alpha/'].sort(),
    ['alpha-x/', 'alpha/', 'alpha/beta/']);
  // Every key a fold carries ends in `/`, but the comparator is handed bare
  // file paths too, and two files in one directory are decided by the name.
  assert.deepEqual(['a/z.js', 'a/b.js'].sort(byPath), ['a/b.js', 'a/z.js']);
});

test('a group splits into its root files and its directories, directories in path order', () => {
  // Deliberately unsorted: the order is the pane's own now, not whatever order
  // `gh` handed the files over in.
  const f = (path) => ({ path });
  const { root, dirs } = byDir([
    f('docs/Verifying.md'), f('server.js'), f('alpha/beta/two.js'),
    f('CLAUDE.md'), f('alpha/one.js'), f('docs/Design.md'),
  ]);
  assert.deepEqual(root.map((x) => x.path), ['CLAUDE.md', 'server.js']);
  assert.deepEqual(dirs.map(([dir]) => dir), ['alpha/', 'alpha/beta/', 'docs/']);
  assert.deepEqual(dirs.map(([, list]) => list.map((x) => x.path)),
    [['alpha/one.js'], ['alpha/beta/two.js'], ['docs/Design.md', 'docs/Verifying.md']]);
});

test('files are ordered by lines changed, additions plus deletions, and by path on a tie', () => {
  const f = (path, additions, deletions) => ({ path, additions, deletions });
  const { root, dirs } = byDir([
    f('a.js', 3, 0), f('b.js', 10, 5), f('c.js', 0, 14), f('d.js', 1, 2),
    f('lib/x.js', 1, 1), f('lib/y.js', 40, 0),
  ]);
  // 15 beats 14 only because deletions count: by additions alone c.js is last.
  assert.deepEqual(root.map((x) => x.path), ['b.js', 'c.js', 'a.js', 'd.js']);
  assert.deepEqual(dirs.map(([, list]) => list.map((x) => x.path)), [['lib/y.js', 'lib/x.js']]);
  // A file with no counts (a binary, or one gh has not answered for) sorts as none.
  assert.deepEqual([{ path: 'z' }, f('y', 0, 1)].sort(bySize).map((x) => x.path), ['y', 'z']);
});

test('a root file is never a directory of its own', () => {
  const { root, dirs } = byDir([{ path: 'README.md' }, { path: '.gitignore' }]);
  // The old shape gave them a `(root)` fold that sorted wherever their first
  // file fell. They are rows now, and nothing below is left to fold.
  assert.deepEqual(root.map((x) => x.path), ['.gitignore', 'README.md']);
  assert.deepEqual(dirs, []);
});

// The keyboard's list (Alt+J, Alt+K, Alt+X in app.js) is the Files tab's
// drawn order, and nothing else: groups in GROUPS' order, root files ahead of
// the directories, the biggest change first inside each. These files are
// deliberately out of order, and their sizes are set so that size alone would
// give a different answer from the tab's.
const walk = [
  { path: 'lib/x.js', group: 'code', additions: 1, deletions: 0 },
  { path: 'README.md', group: 'docs', additions: 1, deletions: 0 },
  { path: 'a.js', group: 'code', additions: 2, deletions: 0 },
  { path: 'test/a.test.js', group: 'tests', additions: 9, deletions: 0 },
  { path: 'b.js', group: 'code', additions: 5, deletions: 0 },
  { path: 'lib/sub/y.js', group: 'code', additions: 7, deletions: 0 },
];
const paths = (list) => list.map((f) => f.path);

test('the keyboard walks the files in the order the Files tab draws them', () => {
  assert.deepEqual(paths(fileOrder(walk)),
    ['README.md', 'test/a.test.js', 'b.js', 'a.js', 'lib/x.js', 'lib/sub/y.js']);
  assert.deepEqual(fileOrder([]), []);
  assert.deepEqual(fileOrder(), []);
});

// What the tab draws, from which fileOrder is read: every group, empty ones
// included, each with its root files as rows and then a fold per directory.
test('the Files tab is laid out once, as groups of rows and directory folds', () => {
  const tree = fileTree(walk);
  assert.deepEqual(tree.map((g) => [g.key, g.label, paths(g.files).length]),
    [['docs', 'Config & docs', 1], ['tests', 'Tests', 1], ['code', 'Code', 4]]);
  const code = tree[2].rows.map((r) => (r.path ? r.path : [r.dir, paths(r.files)]));
  assert.deepEqual(code, ['b.js', 'a.js', ['lib/', ['lib/x.js']], ['lib/sub/', ['lib/sub/y.js']]]);
  assert.deepEqual(tree[1].rows.map((r) => r.dir), ['test/']);
  assert.deepEqual(fileTree().map((g) => g.rows), [[], [], []]);
});

test('a step forward or back is the neighbouring row, and the ends stop', () => {
  assert.equal(fileFrom(walk, 'b.js', 1)?.path, 'a.js');
  assert.equal(fileFrom(walk, 'b.js', -1)?.path, 'test/a.test.js');
  // Across a group and across a fold: the list is flat.
  assert.equal(fileFrom(walk, 'test/a.test.js', 1)?.path, 'b.js');
  assert.equal(fileFrom(walk, 'lib/x.js', 1)?.path, 'lib/sub/y.js');
  assert.equal(fileFrom(walk, 'lib/sub/y.js', 1), null, 'no wrap past the last');
  assert.equal(fileFrom(walk, 'README.md', -1), null, 'nor before the first');
  // Nothing open: forward opens the first, back the last.
  assert.equal(fileFrom(walk, null, 1)?.path, 'README.md');
  assert.equal(fileFrom(walk, null, -1)?.path, 'lib/sub/y.js');
  // A file the list no longer has -- the PR moved under an open diff -- is as
  // good as nothing open.
  assert.equal(fileFrom(walk, 'gone.js', 1)?.path, 'README.md');
  assert.equal(fileFrom([], null, 1), null);
});

test('the next unviewed file skips viewed ones, goes round to the top, and is never the file itself', () => {
  const viewed = (...done) => walk.map((f) => ({ ...f, viewed: done.includes(f.path) }));
  assert.equal(nextUnviewed(viewed('test/a.test.js', 'b.js'), 'README.md')?.path, 'a.js');
  // Past the end, round to the top.
  assert.equal(nextUnviewed(viewed('README.md', 'lib/sub/y.js'), 'lib/x.js')?.path, 'test/a.test.js');
  // The open file is the only one left: it is never its own next, even unviewed.
  assert.equal(nextUnviewed(viewed('README.md', 'test/a.test.js', 'b.js', 'a.js', 'lib/x.js'), 'lib/sub/y.js'), null);
  // Every file viewed, including the open one: none.
  assert.equal(nextUnviewed(viewed(...paths(walk)), 'a.js'), null);
  // Nothing open: the first unviewed, in the tab's order.
  assert.equal(nextUnviewed(viewed('README.md'), null)?.path, 'test/a.test.js');
  assert.equal(nextUnviewed([], null), null);
});

test('a file row leaves out the side that did not change', () => {
  assert.deepEqual(nums({ additions: 101, deletions: 0 }), [['add', '+101']]);
  assert.deepEqual(nums({ additions: 0, deletions: 101 }), [['del', '−101']]);
  assert.deepEqual(nums({ additions: 2, deletions: 3 }),
    [['add', '+2'], ['del', '−3']]);
  // A rename or a mode change touches no lines and gets no counts.
  assert.deepEqual(nums({ additions: 0, deletions: 0 }), []);
});
