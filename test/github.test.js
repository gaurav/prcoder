import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollup, linkedIssues, parsePrUrl, run } from '../github.js';

test('check states collapse into passed, failed and pending', () => {
  assert.deepEqual(rollup([
    { conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' },
    { conclusion: 'FAILURE' }, { conclusion: 'TIMED_OUT' },
    { state: 'PENDING' }, { conclusion: '' },
  ]), { passed: 3, failed: 2, pending: 2 });
});

test('a PR with no checks reports nothing rather than zeroes everywhere', () => {
  assert.deepEqual(rollup(undefined), { passed: 0, failed: 0, pending: 0 });
  assert.deepEqual(rollup([]), { passed: 0, failed: 0, pending: 0 });
});

const pr = (body, closing = []) => ({
  url: 'https://github.com/o/r/pull/7', body, closingIssuesReferences: closing,
});

test('closing references are marked and sorted alongside body mentions', () => {
  assert.deepEqual(
    linkedIssues(pr('Fixes the thing, see #12 and #3.',
      [{ number: 9, title: 'Bug', url: 'https://github.com/o/r/issues/9' }])),
    [
      { number: 3, url: 'https://github.com/o/r/issues/3', closes: false },
      { number: 9, title: 'Bug', url: 'https://github.com/o/r/issues/9', closes: true },
      { number: 12, url: 'https://github.com/o/r/issues/12', closes: false },
    ],
  );
});

test('an issue both closed and mentioned is listed once, as closing', () => {
  const issues = linkedIssues(pr('Closes #9.',
    [{ number: 9, title: 'Bug', url: 'https://github.com/o/r/issues/9' }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].closes, true);
});

test('#N attached to a word is not a linked issue, but a parenthesised one is', () => {
  assert.deepEqual(linkedIssues(pr('abc#5 and colour#5')), []);
  assert.deepEqual(linkedIssues(pr('see (#5) and #6')).map((i) => i.number), [5, 6]);
});

test('an empty body links nothing', () => {
  assert.deepEqual(linkedIssues(pr(null)), []);
});

test('owner, repo and number come from the PR URL, not the local checkout', () => {
  assert.deepEqual(parsePrUrl('https://github.com/cli/cli/pull/9000'),
    { owner: 'cli', repo: 'cli', number: 9000 });
  assert.throws(() => parsePrUrl('https://github.com/cli/cli/issues/1'), /not a pull request URL/);
});

// Regression: execFile accepts `input` only in its Sync form, so writing to the
// child's stdin by hand is what stops `gh pr edit --body-file -` hanging.
test('run() writes input to the child stdin instead of hanging', async () => {
  assert.equal(await run('cat', [], { input: 'a body\n' }), 'a body\n');
});

test('run() closes stdin even with no input, so readers do not block', async () => {
  assert.equal(await run('cat', []), '');
});

test('run() rejects on a non-zero exit rather than resolving empty', async () => {
  await assert.rejects(() => run('false', []));
});
