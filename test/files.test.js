import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket, groupFiles, diffAnchor, fileUrl, fileViews } from '../files.js';

test('tests are recognised across language conventions', () => {
  for (const p of [
    'tests/x.py', 'test/x.js', 'spec/x.rb', 'src/__tests__/x.tsx',
    'src/foo_test.go', 'src/foo.test.ts', 'src/foo.spec.ts', 'app/test_parser.py',
  ]) assert.equal(bucket(p), 'tests', p);
});

test('config and docs are separated from code', () => {
  for (const p of [
    'README.md', 'docs/guide.rst', 'package.json', 'ci.yml', 'pyproject.toml',
    'LICENSE', '.gitignore', '.github/workflows/ci.yml', 'package-lock.json',
  ]) assert.equal(bucket(p), 'docs', p);
});

test('everything else is code', () => {
  for (const p of ['src/parser.js', 'lib/attest.go', 'main.py', 'Makefile'])
    assert.equal(bucket(p), 'code', p);
});

test('a path containing "test" as a word fragment is not a test', () => {
  assert.equal(bucket('src/latest.js'), 'code');
  assert.equal(bucket('src/contest/view.js'), 'code');
});

test('groupFiles keeps every file exactly once', () => {
  const files = ['a.test.js', 'b.js', 'c.md'].map((path) => ({ path }));
  const g = groupFiles(files);
  assert.deepEqual(g.tests.map((f) => f.path), ['a.test.js']);
  assert.deepEqual(g.code.map((f) => f.path), ['b.js']);
  assert.deepEqual(g.docs.map((f) => f.path), ['c.md']);
});

// Verified against https://github.com/cli/cli/pull/9000/files on 2026-08-20.
test('diffAnchor matches the anchors GitHub actually renders', () => {
  assert.equal(
    diffAnchor('pkg/cmd/attestation/verify/verify.go'),
    'diff-84cf161d364effa25914785d22d193f33133a448d02e5f1559cd41ef6b48eff4',
  );
  assert.equal(
    fileUrl('https://github.com/cli/cli/pull/9000', 'pkg/cmd/attestation/verify/verify_test.go'),
    'https://github.com/cli/cli/pull/9000/files#diff-a66a0a835797250cd9db8a466dc2d263f4f19f673e6d25eb40b66163b1100084',
  );
});

// The other way to read the file, pinned to the commit so it keeps saying what
// the pane was showing after the next push. A fork's head resolves under the
// base repository, which is why one rule covers both: checked 2026-09-16
// against cli/cli#14373, whose head lives in a fork, and the base repo's blob
// URL at that sha answered 200.
test('the file links are the whole file at the head commit', () => {
  const sha = '682398a89f408d305fba87c2be1c25864aab4077';
  assert.deepEqual(fileViews('https://github.com/cli/cli/pull/9000', sha, 'docs/install_linux.md'), {
    blob: `https://github.com/cli/cli/blob/${sha}/docs/install_linux.md`,
    blame: `https://github.com/cli/cli/blame/${sha}/docs/install_linux.md`,
    // GitHub's path for a file's history is /commits/, not /history/.
    history: `https://github.com/cli/cli/commits/${sha}/docs/install_linux.md`,
  });
});
