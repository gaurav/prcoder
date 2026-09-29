import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rollup, linkedIssues, linksFrom, parsePrUrl, run, issueNumber, lf, setViewed, listPrs, loadPr, prHeads, lookupRef, createIssue } from '../github.js';
import { taskLines } from '../public/tasks.js';

test('check states collapse into passed, failed and pending', () => {
  const { list, ...counts } = rollup([
    { conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' },
    { conclusion: 'FAILURE' }, { conclusion: 'TIMED_OUT' },
    { conclusion: 'STALE' }, { conclusion: 'STARTUP_FAILURE' },
    { state: 'PENDING' }, { conclusion: '' },
  ]);
  assert.deepEqual(counts, { passed: 3, failed: 4, pending: 2 });
  assert.deepEqual(list.map((c) => c.state),
    ['pass', 'pass', 'pass', 'fail', 'fail', 'fail', 'fail', 'pend', 'pend']);
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

// A status's URL is the poster's to choose, and the pane puts it in an href in
// the page holding /pty: anything but http(s) is dropped, and the row is plain text.
test('a check URL that is not http(s) is dropped', () => {
  assert.deepEqual(rollup([
    { context: 'a', state: 'SUCCESS', targetUrl: 'javascript:alert(1)' },
    { context: 'b', state: 'SUCCESS', targetUrl: 'data:text/html,<script>x</script>' },
    { context: 'c', state: 'SUCCESS', targetUrl: 'HTTPS://example.com' },
    { context: 'd', state: 'SUCCESS', targetUrl: 'http://example.com/ok' },
  ]).list.map((c) => c.url), [null, null, null, 'http://example.com/ok']);
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

// Only where the pane would link it. A PR template's `<!-- e.g. Fixes #123 -->`
// put #123 in the Mentions row, titled with whatever issue that was, under a
// description that never showed it.
test('#N in a comment, a fence or a code span is not a mention', () => {
  const body = '<!-- e.g. Fixes #1 -->\n```\n#2\n```\nsee `#3` and #4';
  assert.deepEqual(linkedIssues(pr(body)).map((i) => i.number), [4]);
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
// built from the repository and the number. `__typename` and `state` were
// added to the query later, and confirmed on 2026-09-27: OPEN or CLOSED on an
// issue, and MERGED too on a pull request. So was `updatedAt`, an ISO string on
// both kinds.
const PARTIAL = JSON.stringify({
  data: {
    repository: {
      i999999: null,
      i27: { __typename: 'PullRequest', title: 'Make the queue your own list',
        url: 'https://github.com/gaurav/prcoder/pull/27', state: 'OPEN', updatedAt: '2026-09-27T04:50:06Z' },
      i86: { __typename: 'Issue', title: 'Drive the diff pane',
        url: 'https://github.com/gaurav/prcoder/issues/86', state: 'CLOSED' },
    },
  },
  errors: [{ type: 'NOT_FOUND', path: ['repository', 'i999999'] }],
});

test('what resolved survives a NOT_FOUND on what did not, pull request URL and all', () => {
  assert.deepEqual(linksFrom(PARTIAL), new Map([[27, {
    title: 'Make the queue your own list', url: 'https://github.com/gaurav/prcoder/pull/27',
    state: 'OPEN', kind: 'pull', updatedAt: '2026-09-27T04:50:06Z',
  }], [86, {
    title: 'Drive the diff pane', url: 'https://github.com/gaurav/prcoder/issues/86',
    state: 'CLOSED', kind: 'issue', updatedAt: null,
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

// A move to an issue takes the item off the queue, so output prcoder cannot
// read a number from has to throw rather than pass through as a success.
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
// checkboxes at all, and the pane showed none to tick.
test('a CRLF description reads as the same checklist as an LF one', () => {
  const crlf = ['## TODO', '', '- [x] ticked on github.com', '- [ ] not yet', ''].join('\r\n');
  assert.deepEqual(taskLines(crlf), [], 'the bug this guards against');
  assert.deepEqual(taskLines(lf(crlf)), [2, 3]);
  assert.equal(lf(null), '');
});

// What reaches gh, from a stub on PATH that writes each argument on its own line
// and answers `[]`. gh's -F converts a value by its shape -- an all-digit owner
// went to GitHub as an Int and was refused, and a path starting with @ is read
// as a file -- so every string has to go as -f. And `gh pr list` stops at 30
// unless given a limit, which silently dropped the rest from the switcher.
const withGh = async (script, fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-gh-stub-'));
  await fs.writeFile(path.join(dir, 'gh'), `#!/bin/sh\n${script(dir)}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try {
    return await fn(dir);
  } finally {
    process.env.PATH = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
};
const ghArgs = (fn) => withGh((dir) => `printf '%s\\n' "$@" > "${dir}/args"\necho '[]'`, async (dir) => {
  await fn();
  return (await fs.readFile(path.join(dir, 'args'), 'utf8')).trimEnd().split('\n');
});
const unix = process.platform === 'win32' ? 'the gh stub is a sh script' : false;

test('a file path goes to gh as a string, whatever it looks like', { skip: unix }, async () => {
  for (const p of ['404', '@types/x.d.ts']) {
    const args = await ghArgs(() => setViewed(os.tmpdir(), 'PR_node', p, true));
    assert.equal(args[args.indexOf(`path=${p}`) - 1], '-f', p);
    assert.equal(args[args.indexOf('id=PR_node') - 1], '-f');
  }
});

test('the PR list asks for more than gh\'s default 30', { skip: unix }, async () => {
  const args = await ghArgs(() => listPrs(os.tmpdir()));
  assert.ok(Number(args[args.indexOf('--limit') + 1]) > 30, args.join(' '));
});

// Everything runs behind one serial lock, so a call that waits holds every
// route. A timeout stops it, with a message that says so rather than Node's
// bare `Command failed`; and neither gh nor git may stop to ask for anything.
test('run() stops a call that outlives its timeout, and says it did', { skip: unix }, async () => {
  await assert.rejects(run('sleep', ['5'], { timeout: 100 }), /sleep 5 took over 0.1s and was stopped/);
});

test('run() turns gh and git prompts off, whatever env it is given', { skip: unix }, async () => {
  const out = await run('sh', ['-c', 'echo "$GIT_TERMINAL_PROMPT $GH_PROMPT_DISABLED"'],
    { env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '1' } });
  assert.equal(out.trim(), '0 1');
});

// gh's answer on a detached HEAD with no target, verbatim from gh 2.x on
// 2026-09-26. It is "no PR here", not a failure: thrown, it 500'd every poll
// mid-rebase, which is why each caller used to check for a branch first.
test('a detached HEAD is no pull request, not an error', { skip: unix }, async () => {
  const detached = () => `echo 'could not determine current branch: failed to run git: not on any branch' >&2\nexit 1`;
  await withGh(detached, async () => {
    assert.equal(await loadPr(os.tmpdir()), null);
    assert.equal(await prHeads(os.tmpdir()), null);
  });
});

// What gh printed for each, verbatim on 2026-09-27: a found PR exits 0, and a
// missing number or repo exits 1 with GitHub's reason in the JSON on stdout --
// and a repo you cannot see says the same as one that does not exist.
const answers = {
  found: `{"data":{"repository":{"i60":{"__typename":"PullRequest","title":"Move checks into a Checks tab","url":"https://github.com/gaurav/prcoder/pull/60","state":"MERGED"}}}}`,
  number: `{"data":{"repository":{"i99999":null}},"errors":[{"type":"NOT_FOUND","path":["repository","i99999"],"message":"Could not resolve to an issue or pull request with the number of 99999."}]}`,
  repo: `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"Could not resolve to a Repository with the name 'gaurav/nope'."}]}`,
};
const answering = (json, code) => () => `cat <<'JSON'\n${json}\nJSON\necho 'gh: not what the pane should show' >&2\nexit ${code}`;

test('a typed reference is looked up, and says why when GitHub has no such thing', { skip: unix }, async () => {
  await withGh(answering(answers.found, 0), async () => {
    assert.deepEqual(await lookupRef(os.tmpdir(), 'gaurav', 'prcoder', 60), {
      title: 'Move checks into a Checks tab', url: 'https://github.com/gaurav/prcoder/pull/60',
      state: 'MERGED', kind: 'pull', updatedAt: null,
    });
  });
  await withGh(answering(answers.number, 1), () => assert.rejects(lookupRef(os.tmpdir(), 'gaurav', 'prcoder', 99999),
    { message: 'gaurav/prcoder#99999: Could not resolve to an issue or pull request with the number of 99999.' }));
  await withGh(answering(answers.repo, 1), () => assert.rejects(lookupRef(os.tmpdir(), 'gaurav', 'nope', 1),
    { message: "gaurav/nope#1: Could not resolve to a Repository with the name 'gaurav/nope'." }));
  // Not GitHub's JSON at all -- gh itself failing -- keeps gh's own words.
  await withGh(() => `echo 'error connecting to api.github.com' >&2\nexit 1`, () =>
    assert.rejects(lookupRef(os.tmpdir(), 'o', 'r', 1), { message: 'o/r#1: error connecting to api.github.com' }));
});

// The owner and name come from text someone typed, so they go as variables.
test('a typed reference reaches GitHub as variables, not inside the query', { skip: unix }, async () => {
  const args = await ghArgs(() => lookupRef(os.tmpdir(), '12345', 'x"){ viewer', 7).catch(() => {}));
  assert.equal(args[args.indexOf('owner=12345') - 1], '-f');
  assert.equal(args[args.indexOf('repo=x"){ viewer') - 1], '-f');
  assert.ok(args.find((a) => a.startsWith('query=')).includes('issueOrPullRequest(number:7)'));
});

// A title becomes a queue item that ▶ types into the PTY, where a \r would
// submit the turn: whatever GitHub holds, no control character gets through.
test('a title from GitHub arrives without control characters', () => {
  const out = JSON.stringify({ data: { repository: { i5: { __typename: 'Issue', title: 'looks fine\r\u001b[2Jrm -rf', url: 'u', state: 'OPEN' } } } });
  // The ESC goes, which leaves the rest of the sequence as harmless text.
  assert.equal(linksFrom(out).get(5).title, 'looks fine [2Jrm -rf');
});

// ◎ on an item about another repo's issue files here, with that link as the
// body; an ordinary item still files with an empty one, which gh needs to be
// told about or it opens an editor.
test('an issue is filed with the body it is given, and an empty one otherwise', { skip: unix }, async () => {
  const filed = (...a) => ghArgs(() => createIssue(os.tmpdir(), 'o/r', 't', ...a).catch(() => {}));
  const body = (args) => args[args.indexOf('--body') + 1];
  assert.equal(body(await filed('https://github.com/cli/cli/issues/9')), 'https://github.com/cli/cli/issues/9');
  // Last, and ghArgs trims the line an empty last argument would be.
  const plain = await filed();
  assert.equal(plain.at(-1), '--body');
});
