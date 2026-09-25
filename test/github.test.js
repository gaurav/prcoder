import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollup, linkedIssues, linksFrom, parsePrUrl, run, issueNumber, lf } from '../github.js';
import { taskLines } from '../public/tasks.js';
import { syncFromPrBlock } from '../queue.js';

test('check states collapse into passed, failed and pending', () => {
  const { list, ...counts } = rollup([
    { conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' },
    { conclusion: 'FAILURE' }, { conclusion: 'TIMED_OUT' },
    { state: 'PENDING' }, { conclusion: '' },
  ]);
  assert.deepEqual(counts, { passed: 3, failed: 2, pending: 2 });
  assert.deepEqual(list.map((c) => c.state),
    ['pass', 'pass', 'pass', 'fail', 'fail', 'pend', 'pend']);
});

test('a PR with no checks reports nothing rather than zeroes everywhere', () => {
  assert.deepEqual(rollup(undefined), { passed: 0, failed: 0, pending: 0, list: [] });
  assert.deepEqual(rollup([]), { passed: 0, failed: 0, pending: 0, list: [] });
});

// The two shapes GitHub answers with for the same thing: a CheckRun from
// Actions, and the StatusContext an external service posts. The pane is given
// one row shape and never learns which it came from.
test('a check run and a status context flatten to the same row', () => {
  assert.deepEqual(rollup([
    { workflowName: 'CI', name: 'test (26.x)', conclusion: 'SUCCESS', detailsUrl: 'https://gh/run/1' },
    { context: 'netlify/deploy', state: 'FAILURE', targetUrl: 'https://netlify/deploy/2' },
    { name: 'no link', status: 'IN_PROGRESS' },
  ]).list, [
    { name: 'CI / test (26.x)', state: 'pass', url: 'https://gh/run/1' },
    { name: 'netlify/deploy', state: 'fail', url: 'https://netlify/deploy/2' },
    { name: 'no link', state: 'pend', url: null },
  ]);
});

const pr = (body, closing = []) => ({
  url: 'https://github.com/o/r/pull/7', body, closingIssuesReferences: closing,
});

// No title anywhere in here: `gh pr view --json closingIssuesReferences` returns
// id, number, repository and url and nothing else, so the titles are a separate
// call (issueLinks) and linkedIssues stays about which numbers and which kind.
test('closing references are marked and sorted alongside body mentions', () => {
  assert.deepEqual(
    linkedIssues(pr('Fixes the thing, see #12 and #3.',
      [{ number: 9, url: 'https://github.com/o/r/issues/9' }])),
    [
      { number: 3, url: 'https://github.com/o/r/issues/3', closes: false },
      { number: 9, url: 'https://github.com/o/r/issues/9', closes: true },
      { number: 12, url: 'https://github.com/o/r/issues/12', closes: false },
    ],
  );
});

test('an issue both closed and mentioned is listed once, as closing', () => {
  const issues = linkedIssues(pr('Closes #9.',
    [{ number: 9, url: 'https://github.com/o/r/issues/9' }]));
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

// Captured from the real API on 2026-09-18, against gaurav/prcoder: a number
// that resolves to nothing is an error *beside* the data rather than a null
// inside it, and gh exits 1 with this whole body still on stdout. Everything
// that did resolve is in there, which is why the failure is read rather than
// swallowed -- one typo'd #N may not cost every other title.
//
// #27 is a pull request, and its URL says so: the number alone cannot be told
// apart from an issue's, which is why the URL is taken from here rather than
// built from the repository and the number.
const PARTIAL = JSON.stringify({
  data: {
    repository: {
      i999999: null,
      i27: { title: 'Make the queue your own list', url: 'https://github.com/gaurav/prcoder/pull/27' },
    },
  },
  errors: [{ type: 'NOT_FOUND', path: ['repository', 'i999999'] }],
});

test('what resolved survives a NOT_FOUND on what did not, pull request URL and all', () => {
  assert.deepEqual(linksFrom(PARTIAL), new Map([[27, {
    title: 'Make the queue your own list', url: 'https://github.com/gaurav/prcoder/pull/27',
  }]]));
});

test('a response that is not a response is nothing, never a throw', () => {
  for (const out of ['', 'gh: could not connect', '{}', undefined]) {
    assert.deepEqual(linksFrom(out), new Map());
  }
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

// execFile reports stderr as the third callback argument and leaves the error
// object without it, so loadPr's "no pull requests found" guard silently
// matched against undefined and every no-PR repo threw instead of returning
// null. Verified against gh 2.98.0 on 2026-08-23.
test('run() puts the child stderr on the error, where the callers look for it', async () => {
  await assert.rejects(
    () => run('sh', ['-c', 'echo no pull requests found >&2; exit 1']),
    (e) => e.stderr.includes('no pull requests found'));
});

// And stdout, for the same reason one step further on: `gh api graphql` exits 1
// whenever the response carries an `errors` array, and prints that response --
// partial data included -- anyway. issueLinks() reads its answers off that
// failure, so an error with no stdout on it loses every title that did resolve
// to the one issue number that did not.
test('run() puts the child stdout on the error too, where a partial answer lives', async () => {
  await assert.rejects(
    () => run('sh', ['-c', 'echo the-partial-answer; echo NOT_FOUND >&2; exit 1']),
    (e) => e.stdout.includes('the-partial-answer') && e.stderr.includes('NOT_FOUND'));
});

// The number goes into FUTURE.md as `@issue#N`. `@issue#NaN` does not match the
// marker pattern coming back, so it silently becomes part of the task text --
// which is why an unreadable number has to throw rather than pass through.
test('the issue number is read from the last line gh prints', () => {
  assert.deepEqual(issueNumber('https://github.com/o/r/issues/42\n'),
    { url: 'https://github.com/o/r/issues/42', number: 42 });
});

test('a notice printed before the URL does not confuse the parse', () => {
  assert.equal(issueNumber('Creating issue in o/r\n\nhttps://github.com/o/r/issues/7').number, 7);
});

test('output with no issue number throws instead of yielding NaN', () => {
  assert.throws(() => issueNumber('something unexpected'), /could not be read/);
  assert.throws(() => issueNumber(''), /no url printed/);
});

// A description saved from github.com's editor arrives CRLF, and every line
// pattern ends in `(.*)$`, which stops at the `\r`. Unconverted, the body has no
// checkboxes at all, so a box ticked on GitHub never reached the queue.
test('a CRLF description reads as the same checklist as an LF one', () => {
  const crlf = ['<!-- prcoder:todo -->', '## TODO', '', '- [x] ticked on github.com', '<!-- /prcoder:todo -->'].join('\r\n');
  assert.deepEqual(taskLines(crlf), [], 'the bug this guards against');
  assert.deepEqual(taskLines(lf(crlf)), [3]);
  const [item] = syncFromPrBlock([{ text: 'ticked on github.com', done: false, inPr: true, issue: null, deleted: false }], lf(crlf));
  assert.equal(item.done, true);
  assert.equal(lf(null), '');
});
