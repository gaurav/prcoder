import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rollup, linkedIssues, linksFrom, parsePrUrl, run, issueNumber, lf, setViewed, listPrs, loadPr, prHeads, branchPrs, lookupPrs, ownPrs, SEARCH_EVERY, UNREAD_FOR, pickPr, lookupRef, createIssue, repoIssues, setMilestone, repoPulls, pullRow, MERGE_WORD } from '../github.js';
import { taskLines } from '../public/tasks.js';
import { withGh, ghArgs, ghCalls, unix } from './stub-gh.js';

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

// What reaches gh, from a stub on PATH (test/stub-gh.js) that writes each
// argument on its own line and answers `[]`. gh's -F converts a value by its
// shape -- an all-digit owner went to GitHub as an Int and was refused, and a
// path starting with @ is read as a file -- so every string has to go as -f.
// And `gh pr list` stops at 30 unless given a limit, which silently dropped
// the rest from the switcher.

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
    assert.equal(await loadPr(os.tmpdir(), undefined, { pause: 0 }), null);
    assert.equal(await prHeads(os.tmpdir()), null);
  });
});

// What gh printed for each: a found PR exits 0, and a missing number or repo
// exits 1 with GitHub's reason in the JSON on stdout -- and a repo you cannot
// see says the same as one that does not exist. `found` and `number` verbatim
// on 2026-10-11, `found` asked for as GAURAV/PRCoder: GitHub answers with its
// own spelling, which is what lookupRef returns as `repo`. `repo` verbatim on
// 2026-09-27, before the query asked for nameWithOwner; it has no repository.
const answers = {
  found: `{"data":{"repository":{"nameWithOwner":"gaurav/prcoder","i60":{"__typename":"PullRequest","title":"Move checks into a Checks tab and the repository into the links row, and mark finished tabs with a green ✓ circle","url":"https://github.com/gaurav/prcoder/pull/60","state":"MERGED","updatedAt":"2026-09-27T23:23:09Z"}}}}`,
  number: `{"data":{"repository":{"nameWithOwner":"gaurav/prcoder","i99999":null}},"errors":[{"type":"NOT_FOUND","path":["repository","i99999"],"locations":[{"line":1,"column":89}],"message":"Could not resolve to an issue or pull request with the number of 99999."}]}`,
  repo: `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"Could not resolve to a Repository with the name 'gaurav/nope'."}]}`,
};
const answering = (json, code) => () => `cat <<'JSON'\n${json}\nJSON\necho 'gh: not what the pane should show' >&2\nexit ${code}`;

test('a typed reference is looked up, and says why when GitHub has no such thing', { skip: unix }, async () => {
  await withGh(answering(answers.found, 0), async () => {
    assert.deepEqual(await lookupRef(os.tmpdir(), 'GAURAV', 'PRCoder', 60), {
      title: 'Move checks into a Checks tab and the repository into the links row, and mark finished tabs with a green ✓ circle',
      url: 'https://github.com/gaurav/prcoder/pull/60',
      state: 'MERGED', kind: 'pull', updatedAt: '2026-09-27T23:23:09Z', repo: 'gaurav/prcoder',
    });
  });
  await withGh(answering(answers.number, 1), () => assert.rejects(lookupRef(os.tmpdir(), 'gaurav', 'prcoder', 99999),
    { message: 'gaurav/prcoder#99999: Could not resolve to an issue or pull request with the number of 99999.', notFound: true }));
  await withGh(answering(answers.repo, 1), () => assert.rejects(lookupRef(os.tmpdir(), 'gaurav', 'nope', 1),
    { message: "gaurav/nope#1: Could not resolve to a Repository with the name 'gaurav/nope'.", notFound: true }));
  // Not GitHub's JSON at all -- gh itself failing -- keeps gh's own words,
  // and is not a no: the pane adds the text untagged rather than refusing it.
  await withGh(() => `echo 'error connecting to api.github.com' >&2\nexit 1`, () =>
    assert.rejects(lookupRef(os.tmpdir(), 'o', 'r', 1), { message: 'o/r#1: error connecting to api.github.com', notFound: false }));
});

// The owner and name come from text someone typed, so they go as variables.
test('a typed reference reaches GitHub as variables, not inside the query', { skip: unix }, async () => {
  const args = await ghArgs(() => lookupRef(os.tmpdir(), '12345', 'x"){ viewer', 7).catch(() => {}));
  assert.equal(args[args.indexOf('owner=12345') - 1], '-f');
  assert.equal(args[args.indexOf('repo=x"){ viewer') - 1], '-f');
  assert.ok(args.find((a) => a.startsWith('query=')).includes('issueOrPullRequest(number:7)'));
  assert.ok(args.find((a) => a.startsWith('query=')).includes('nameWithOwner'));
});

// The repository's open issues and milestones, as GitHub answered for
// gaurav/prcoder on 2026-10-15, two issues to a page (the query asks a hundred;
// the fixture's cursor is turned off, and the paging test below turns it on).
const ISSUES_PAGE = {"data": {"repository": {"milestones": {"nodes": [{"number": 1, "title": "PRCoder v1.0", "dueOn": "2026-10-14T00:00:00Z", "description": ""}, {"number": 2, "title": "PRCoder v0.1", "dueOn": "2026-10-02T00:00:00Z", "description": "The prototype as it stands: the four panes, the queue, and the things found while using it. Smaller than v1.0 and ahead of it — items here are fixes and finishes to what has already shipped, not new capability."}, {"number": 3, "title": "Not urgent", "dueOn": null, "description": "Worth doing eventually; nothing waiting on it."}, {"number": 4, "title": "Needed soon", "dueOn": null, "description": "Work that should land before this is used against repositories other people write in."}, {"number": 5, "title": "Needed later", "dueOn": null, "description": null}]}, "issues": {"totalCount": 78, "pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": [{"number": 149, "title": "Add a PRs pane", "url": "https://github.com/gaurav/prcoder/issues/149", "updatedAt": "2026-10-15T19:15:43Z", "body": "", "milestone": null, "labels": {"nodes": []}}, {"number": 79, "title": "Browser-test the switcher on a clean tree and the Commit button on a dirty one", "url": "https://github.com/gaurav/prcoder/issues/79", "updatedAt": "2026-10-14T20:55:57Z", "body": "Split out of #6, which asked for assertions on the pane states that have no natural fixture. The description renderer half of that is covered by `test/browser.test.js`; this is the piece nothing asserts yet.\n\nThe pull request pane shows the PR switcher when the working tree is clean and a Commit button when it is dirty. Commit asks Claude to commit the listed files (`askClaudeToCommit` in `public/app.js`), so it is both a rendering state and a write into the session. Neither state has a test: every driver run sees whatever the checkout happened to be, and `npm test` never loads either.\n\n`test/browser.test.js` already has what this needs. It serves the real page with every route mocked and the `/pty` socket stubbed, so the two states are two `/api/status` fixtures (`dirtyFiles: []` and a non-empty list), and nothing reaches GitHub or a real Claude session. Worth asserting:\n\n- A clean tree shows the switcher and no Commit button, and a dirty one the reverse.\n- The switch happens on the next status poll, without a reload: a tree that becomes dirty mid-session is the case that matters.\n- Commit sends exactly one `{type:'input'}` naming the dirty files. Read it off the mocked socket rather than wrapping `window.WebSocket` (CLAUDE.md has why).\n- A branch with two or more pull requests of its own (#144's **On this branch** group) keeps the switcher on a dirty tree, beside Commit, with every option but the group's own disabled, since a pick there checks nothing out. `test/browser/suite.js` asserts the options' `disabled` state and the pick; the question left is whether the two controls side by side read right at the pane's 375px default, which only a screenshot answers.\n\nThe sync light and the Deleted tab were also on #6's list. The light goes away in #27, and the Deleted tab is part of driving the queue pane, which is #65.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n", "milestone": {"number": 1}, "labels": {"nodes": [{"name": "enhancement"}]}}]}}}};

test('the issue listing reaches GitHub as variables, and becomes milestones and issues the tab can draw', { skip: unix }, async () => {
  const args = await ghArgs(() => repoIssues(os.tmpdir(), '12345', 'x"){ viewer').catch(() => {}));
  assert.equal(args[args.indexOf('owner=12345') - 1], '-f');
  assert.equal(args[args.indexOf('repo=x"){ viewer') - 1], '-f');
  const at = args.findIndex((a) => a.startsWith('query='));
  const query = args.slice(at, args.indexOf('-f', at)).join('\n');
  assert.ok(!query.includes('12345') && !query.includes('x"){ viewer'), query);
  assert.ok(query.includes('milestones(') && query.includes('labels('), query);

  await withGh(() => `cat <<'JSON'\n${JSON.stringify(ISSUES_PAGE)}\nJSON`, async () => {
    const got = await repoIssues(os.tmpdir(), 'gaurav', 'prcoder');
    assert.equal(got.total, 78);
    assert.equal(got.listed, 2);
    assert.deepEqual(got.milestones.map((m) => [m.number, m.title, m.dueOn]), [
      [1, 'PRCoder v1.0', '2026-10-14T00:00:00Z'], [2, 'PRCoder v0.1', '2026-10-02T00:00:00Z'],
      [3, 'Not urgent', null], [4, 'Needed soon', null], [5, 'Needed later', null]]);
    assert.equal(got.milestones[4].description, '', 'a null description is nothing');
    assert.deepEqual(got.issues[0], { number: 149, title: 'Add a PRs pane', url: 'https://github.com/gaurav/prcoder/issues/149',
      updatedAt: '2026-10-15T19:15:43Z', body: '', milestone: null, labels: [] });
    assert.equal(got.issues[1].milestone, 1);
    assert.deepEqual(got.issues[1].labels, ['enhancement']);
    assert.ok(got.issues[1].body.startsWith('Split out of #6'), got.issues[1].body.slice(0, 40));
  });

  // An open issue on a milestone that is not among the open ones -- closed
  // since, or past the first fifty -- brings it along, so the tab has a group
  // to draw the issue in.
  const stray = structuredClone(ISSUES_PAGE);
  stray.data.repository.issues.nodes[0].milestone = { number: 7, title: 'v0.0', dueOn: '2026-09-01T00:00:00Z', state: 'CLOSED' };
  stray.data.repository.issues.nodes[1].milestone = { number: 1, title: 'PRCoder v1.0', dueOn: '2026-10-14T00:00:00Z', state: 'OPEN' };
  await withGh(() => `cat <<'JSON'\n${JSON.stringify(stray)}\nJSON`, async () => {
    const got = await repoIssues(os.tmpdir(), 'gaurav', 'prcoder');
    assert.deepEqual(got.milestones.map((m) => [m.number, m.closed]), [[1, false], [2, false], [3, false], [4, false], [5, false], [7, true]]);
    assert.deepEqual(got.milestones[5], { number: 7, title: 'v0.0', dueOn: '2026-09-01T00:00:00Z', description: '', closed: true });
    assert.equal(got.issues[0].milestone, 7);
  });

  // A CRLF body reads as LF, as a description does, a title of control
  // characters is the number, as linksFrom has it, and a label is rid of them.
  const odd = structuredClone(ISSUES_PAGE);
  Object.assign(odd.data.repository.issues.nodes[0], { title: '\x1b\r', body: 'a\r\nb',
    labels: { nodes: [{ name: 'needs\x1b[2Jreview' }, { name: '\r' }] } });
  await withGh(() => `cat <<'JSON'\n${JSON.stringify(odd)}\nJSON`, async () => {
    const [first] = (await repoIssues(os.tmpdir(), 'gaurav', 'prcoder')).issues;
    assert.equal(first.title, '#149');
    assert.equal(first.body, 'a\nb');
    assert.deepEqual(first.labels, ['needs [2Jreview']);
  });
});

test('a second page of issues is read with its cursor, and the milestones come from the first', { skip: unix }, async () => {
  const first = structuredClone(ISSUES_PAGE);
  first.data.repository.issues.pageInfo = { hasNextPage: true, endCursor: 'C1' };
  const second = structuredClone(ISSUES_PAGE);
  second.data.repository.milestones.nodes = [];
  second.data.repository.issues.nodes = [{ ...ISSUES_PAGE.data.repository.issues.nodes[0], number: 3 }];
  const script = `if [ -e "$(dirname "$0")/again" ]; then cat <<'JSON'\n${JSON.stringify(second)}\nJSON\nelse\ntouch "$(dirname "$0")/again"\ncat <<'JSON'\n${JSON.stringify(first)}\nJSON\nfi`;
  const { out, calls } = await ghCalls(script, () => repoIssues(os.tmpdir(), 'gaurav', 'prcoder'));
  assert.deepEqual(out.issues.map((i) => i.number), [149, 79, 3]);
  assert.equal(out.listed, 3);
  assert.equal(out.milestones.length, 5, 'the first page\'s milestones');
  assert.equal(calls.length, 2);
  const paged = calls.find((c) => c.includes('after=C1'));
  assert.equal(paged[paged.indexOf('after=C1') - 1], '-f');
  // gh failing is a failure here, not an empty tab.
  await withGh(() => `echo 'error connecting to api.github.com' >&2\nexit 1`, () =>
    assert.rejects(repoIssues(os.tmpdir(), 'gaurav', 'prcoder'), { message: 'error connecting to api.github.com' }));
});

// The one write about an issue: its milestone, by title, with the `=` that
// keeps a title beginning with `-` a value. A pull request's is the same
// write through `gh pr edit`.
test('a milestone is set by title with =, and removed with the flag for that', { skip: unix }, async () => {
  const set = await ghArgs(() => setMilestone(os.tmpdir(), 'o/r', 58, '-weird title'));
  assert.deepEqual(set, ['issue', 'edit', '58', '--repo', 'o/r', '--milestone=-weird title']);
  const off = await ghArgs(() => setMilestone(os.tmpdir(), 'o/r', 58, null));
  assert.deepEqual(off, ['issue', 'edit', '58', '--repo', 'o/r', '--remove-milestone']);
  const pull = await ghArgs(() => setMilestone(os.tmpdir(), 'o/r', 151, '-weird title', 'pull'));
  assert.deepEqual(pull, ['pr', 'edit', '151', '--repo', 'o/r', '--milestone=-weird title']);
  const pullOff = await ghArgs(() => setMilestone(os.tmpdir(), 'o/r', 151, null, 'pull'));
  assert.deepEqual(pullOff, ['pr', 'edit', '151', '--repo', 'o/r', '--remove-milestone']);
});

// The repository's open pull requests and milestones, as GitHub answered for
// gaurav/prcoder on 2026-10-19, cut to two of the six and three files each,
// with a milestone, a label, a viewed file, a closed milestone, a review
// decision, a conflict and CRLF bodies put on them for the mapping to show.
const PULLS_PAGE = {"data": {"repository": {"milestones": {"nodes": [{"number": 1, "title": "PRCoder v1.0", "dueOn": "2026-10-14T00:00:00Z", "description": ""}, {"number": 2, "title": "PRCoder v0.1", "dueOn": "2026-10-02T00:00:00Z", "description": "The prototype as it stands: the four panes, the queue, and the things found while using it. Smaller than v1.0 and ahead of it \u2014 items here are fixes and finishes to what has already shipped, not new capability."}, {"number": 3, "title": "Not urgent", "dueOn": null, "description": "Worth doing eventually; nothing waiting on it."}, {"number": 4, "title": "Needed soon", "dueOn": null, "description": "Work that should land before this is used against repositories other people write in."}, {"number": 5, "title": "Needed later", "dueOn": null, "description": null}]}, "pullRequests": {"totalCount": 6, "pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": [{"number": 156, "title": "Mark a pull request's #N in the description, and show every mention's title on hover", "url": "https://github.com/gaurav/prcoder/pull/156", "isDraft": true, "isCrossRepository": false, "headRefName": "pr-refs-inline", "baseRefName": "issues-tab", "createdAt": "2026-10-17T08:38:19Z", "updatedAt": "2026-10-17T08:49:05Z", "author": {"login": "gaurav"}, "additions": 58, "deletions": 5, "changedFiles": 4, "mergeStateStatus": "CLEAN", "reviewDecision": null, "body": "A bare `#N` in a pull request's description links to `/issues/N` whatever it is.\r\n\r\n## Why\r\n\r\nGitHub redirects a pull request's number.", "milestone": {"number": 4, "title": "Needed soon", "dueOn": null, "state": "OPEN"}, "labels": {"nodes": [{"name": "enhancement"}]}, "closingIssuesReferences": {"nodes": []}, "files": {"nodes": [{"additions": 2, "deletions": 2, "viewerViewedState": "UNVIEWED"}, {"additions": 27, "deletions": 3, "viewerViewedState": "VIEWED"}, {"additions": 8, "deletions": 0, "viewerViewedState": "UNVIEWED"}]}}, {"number": 152, "title": "Make the queue's Issues tab the repository's open issues, grouped by milestone and searchable, and tag pull requests PR #N", "url": "https://github.com/gaurav/prcoder/pull/152", "isDraft": true, "isCrossRepository": false, "headRefName": "issues-tab", "baseRefName": "main", "createdAt": "2026-10-15T22:59:24Z", "updatedAt": "2026-10-17T08:44:42Z", "author": {"login": "gaurav"}, "additions": 942, "deletions": 109, "changedFiles": 15, "mergeStateStatus": "DIRTY", "reviewDecision": "APPROVED", "body": "## Heading first\r\n\r\nThe queue's Issues tab showed only the issues the description mentions without closing.", "milestone": {"number": 9, "title": "PRCoder v0.9", "dueOn": "2026-09-01T00:00:00Z", "state": "CLOSED"}, "labels": {"nodes": []}, "closingIssuesReferences": {"nodes": [{"number": 58, "title": "Decide what the queue's Issues tab shows beyond the description's mentions", "url": "https://github.com/gaurav/prcoder/issues/58", "milestone": {"title": "PRCoder v1.0"}}]}, "files": {"nodes": [{"additions": 4, "deletions": 4, "viewerViewedState": "UNVIEWED"}, {"additions": 3, "deletions": 2, "viewerViewedState": "UNVIEWED"}, {"additions": 8, "deletions": 3, "viewerViewedState": "UNVIEWED"}]}}]}}}};

test('the pull request listing reaches GitHub as variables, and becomes milestones and rows the tab can draw', { skip: unix }, async () => {
  const args = await ghArgs(() => repoPulls(os.tmpdir(), '12345', 'x"){ viewer').catch(() => {}));
  assert.equal(args[args.indexOf('owner=12345') - 1], '-f');
  assert.equal(args[args.indexOf('repo=x"){ viewer') - 1], '-f');
  const at = args.findIndex((a) => a.startsWith('query='));
  const query = args.slice(at, args.indexOf('-f', at)).join('\n');
  assert.ok(!query.includes('12345') && !query.includes('x"){ viewer'), query);
  for (const field of ['milestones(', 'pullRequests(', 'mergeStateStatus', 'viewerViewedState', 'closingIssuesReferences', 'author{ login }']) {
    assert.ok(query.includes(field), field);
  }
  // Nothing that costs a connection per pull request.
  assert.ok(!query.includes('reviewThreads') && !query.includes('comments'), query);

  await withGh(() => `cat <<'JSON'\n${JSON.stringify(PULLS_PAGE)}\nJSON`, async () => {
    const got = await repoPulls(os.tmpdir(), 'gaurav', 'prcoder');
    assert.equal(got.total, 6);
    assert.equal(got.listed, 2);
    // The open milestones, and the closed one a listed pull request is still on, after them.
    assert.deepEqual(got.milestones.map((m) => [m.number, m.title, m.dueOn, m.closed]), [
      [1, 'PRCoder v1.0', '2026-10-14T00:00:00Z', false], [2, 'PRCoder v0.1', '2026-10-02T00:00:00Z', false],
      [3, 'Not urgent', null, false], [4, 'Needed soon', null, false], [5, 'Needed later', null, false],
      [9, 'PRCoder v0.9', '2026-09-01T00:00:00Z', true]]);
    assert.equal(got.milestones[4].description, '', 'a null description is nothing');
    const [first, second] = got.pulls;
    // The switcher's seven fields under their names, and the rest the row draws.
    assert.deepEqual([first.number, first.title, first.url, first.isDraft, first.isCrossRepository, first.headRefName, first.baseRefName],
      [156, "Mark a pull request's #N in the description, and show every mention's title on hover", 'https://github.com/gaurav/prcoder/pull/156', true, false, 'pr-refs-inline', 'issues-tab']);
    assert.deepEqual([first.author, first.additions, first.deletions, first.changedFiles, first.lines, first.milestone, first.labels, first.merge, first.reviewDecision],
      ['gaurav', 58, 5, 4, 63, 4, ['enhancement'], 'ready', null]);
    assert.equal(first.createdAt, '2026-10-17T08:38:19Z');
    // The pie is the Files tab's: by changed lines viewed, over the files listed, against the pull request's own counts.
    assert.equal(first.viewed.label, '1 of 4 files, 30 of 63 changed lines viewed');
    assert.ok(first.viewed.p > 0.4 && first.viewed.p < 0.5 && !first.viewed.full, JSON.stringify(first.viewed));
    // The lead is the first paragraph as one line of plain text; the body is the whole of it, LF-ended.
    assert.equal(first.lead, "A bare `#N` in a pull request's description links to `/issues/N` whatever it is.");
    assert.equal(first.body, "A bare `#N` in a pull request's description links to `/issues/N` whatever it is.\n\n## Why\n\nGitHub redirects a pull request's number.");
    assert.deepEqual(first.closes, []);
    // A description that opens with a heading still has a first paragraph.
    assert.equal(second.lead, "The queue's Issues tab showed only the issues the description mentions without closing.");
    assert.deepEqual([second.merge, second.reviewDecision, second.milestone], ['conflicts', 'APPROVED', 9]);
    assert.deepEqual(second.closes, [{ number: 58, url: 'https://github.com/gaurav/prcoder/issues/58',
      title: "Decide what the queue's Issues tab shows beyond the description's mentions", milestone: 'PRCoder v1.0' }]);
    assert.ok(!('files' in first) && !('closingIssuesReferences' in first) && !('mergeStateStatus' in first), 'GitHub\'s own shapes stay here');
  });

  // Every merge state GitHub documents has a word, and one it does not is `checking…`.
  assert.deepEqual(Object.keys(MERGE_WORD).sort(), ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
  assert.equal(pullRow({ number: 1, mergeStateStatus: 'NEW_ONE' }).merge, 'checking…');
  assert.equal(pullRow({ number: 1, title: '\x1b\r' }).title, '#1', 'a title of control characters is the number');
  assert.deepEqual(pullRow({ number: 1 }).viewed.count, { done: 0, total: 0 });
});

test('a second page of pull requests is read with its cursor, and a failure is a failure', { skip: unix }, async () => {
  const first = structuredClone(PULLS_PAGE);
  first.data.repository.pullRequests.pageInfo = { hasNextPage: true, endCursor: 'C1' };
  const second = structuredClone(PULLS_PAGE);
  second.data.repository.milestones.nodes = [];
  second.data.repository.pullRequests.nodes = [{ ...PULLS_PAGE.data.repository.pullRequests.nodes[0], number: 3, milestone: null }];
  const script = `if [ -e "$(dirname "$0")/again" ]; then cat <<'JSON'\n${JSON.stringify(second)}\nJSON\nelse\ntouch "$(dirname "$0")/again"\ncat <<'JSON'\n${JSON.stringify(first)}\nJSON\nfi`;
  const { out, calls } = await ghCalls(script, () => repoPulls(os.tmpdir(), 'gaurav', 'prcoder'));
  assert.deepEqual(out.pulls.map((p) => p.number), [156, 152, 3]);
  assert.equal(out.listed, 3);
  assert.equal(out.milestones.length, 6, 'the first page\'s milestones, and the closed one');
  assert.equal(calls.length, 2);
  const paged = calls.find((c) => c.includes('after=C1'));
  assert.equal(paged[paged.indexOf('after=C1') - 1], '-f');
  await withGh(() => `echo 'error connecting to api.github.com' >&2\nexit 1`, () =>
    assert.rejects(repoPulls(os.tmpdir(), 'gaurav', 'prcoder'), { message: 'error connecting to api.github.com' }));
});

// A title becomes a queue item that ▶ types into the PTY, where a \r would
// submit the turn: whatever GitHub holds, no control character gets through.
test('a title from GitHub arrives without control characters', () => {
  const out = JSON.stringify({ data: { repository: { i5: { __typename: 'Issue', title: 'looks fine\r\u001b[2Jrm -rf', url: 'u', state: 'OPEN' } } } });
  // The ESC goes, which leaves the rest of the sequence as harmless text.
  assert.equal(linksFrom(out).get(5).title, 'looks fine [2Jrm -rf');
  // Nothing left once cleaned, it is the number, not an empty queue item.
  const bare = JSON.stringify({ data: { repository: { i6: { __typename: 'Issue', title: '\r\u001b ', url: 'u', state: 'OPEN' } } } });
  assert.equal(linksFrom(bare).get(6).title, '#6');
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

// A check finishing does not move the PR's updatedAt, so the cheap per-poll
// call is the only one that would see it: on #120 the tab said pending after CI
// had passed, because only the full reload read the checks.
test('the cheap per-poll call carries the checks, summarised', { skip: unix }, async () => {
  const rollupJson = JSON.stringify({ number: 1, updatedAt: 'x', statusCheckRollup: [
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
  ] });
  await withGh((dir) => `printf '%s\\n' "$@" > "${dir}/args"\necho '${rollupJson}'`, async (dir) => {
    const heads = await prHeads(os.tmpdir());
    const args = await fs.readFile(path.join(dir, 'args'), 'utf8');
    assert.match(args, /statusCheckRollup/);
    assert.equal(heads.statusCheckRollup, undefined);
    assert.deepEqual([heads.checks.passed, heads.checks.pending], [1, 1]);
  });
});

// gh answering `pr view` with `view` -- or the second `pr view` with `view2`,
// and so on, where a test gives one -- and the file list's GraphQL calls with
// `pages` in the order they are made, so a test can have the PR move between
// two of them. The pages are told apart by their query, not by being the
// GraphQL call that came next: loadPr reads the linked issues alongside the
// files, and a call of theirs would take a page and shift the rest by one.
// The mentions' titles query (issueLinks) gets `links.json` where a test has
// written one. Any other GraphQL call gets an empty answer. The counter is not atomic, so
// only the file pages, which prFiles asks for one at a time, may use it.
const withPr = (view, pages, fn, views = []) => withGh((dir) => [
  'case "$1" in',
  `  pr) v=$(( $(cat "${dir}/v" 2>/dev/null || echo 0) + 1 )); echo $v > "${dir}/v"`,
  `      [ $v = 1 ] && printf '%s\\n' "$@" > "${dir}/view-args"`,
  `      if [ -f "${dir}/view$v.json" ]; then cat "${dir}/view$v.json"; else cat "${dir}/view.json"; fi ;;`,
  `  *) case "$*" in`,
  `       *"files(first:100"*) n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"; cat "${dir}/page$n.json" ;;`,
  `       *"issueOrPullRequest"*) cat "${dir}/links.json" 2>/dev/null || echo '{"data":{}}' ;;`,
  `       *) echo '{"data":{}}' ;;`,
  '     esac ;;',
  'esac',
].join('\n'), async (dir) => {
  await fs.writeFile(path.join(dir, 'view.json'), JSON.stringify(view));
  for (const [i, v] of views.entries()) await fs.writeFile(path.join(dir, `view${i + 2}.json`), JSON.stringify(v));
  for (const [i, p] of pages.entries()) await fs.writeFile(path.join(dir, `page${i + 1}.json`), JSON.stringify(p));
  return fn(dir);
});
const view = { number: 1, url: 'https://github.com/o/r/pull/1', body: '',
  statusCheckRollup: [], comments: [], reviews: [], closingIssuesReferences: [] };
const file = (i) => ({ path: `src/f${i}.js`, additions: i, deletions: 1 });
const node = (f) => ({ ...f, viewerViewedState: f.path === 'src/f105.js' ? 'VIEWED' : 'UNVIEWED' });
const head = { headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), additions: 10, deletions: 2 };
const page = (files, endCursor, at = head) => ({ data: { repository: { pullRequest: { id: 'PR_node', ...at,
  files: { pageInfo: { hasNextPage: endCursor != null, endCursor }, nodes: files.map(node) } } } } });

// gh's `files` is GraphQL's `files(first: 100)`, unpaged, so a PR past 100
// files lost the rest from the Files tab without a word. Seen on
// NCATSTranslator/translator-diagram#32 (112 files, 100 shown); checked
// 2026-10-14 on gaurav/taxondna#76, whose `gh pr view --json changedFiles,files`
// says 110 and lists 100, while the paged GraphQL query answers 100 + 10. The
// stub has 112 across two pages, and `gh pr view` is not asked for any: a
// `files` back in PR_FIELDS would be the first 100 again, under whichever list
// the merge favoured.
test('a PR with more than 100 files lists every one of them', { skip: unix }, async () => {
  const all = Array.from({ length: 112 }, (_, i) => file(i));
  await withPr(view, [page(all.slice(0, 100), 'c1'), page(all.slice(100), null)], async (dir) => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.equal(pr.files.length, 112);
    assert.deepEqual(pr.files.map((f) => f.path), all.map((f) => f.path));
    const f105 = pr.files.find((f) => f.path === 'src/f105.js');
    assert.deepEqual(f105, { path: 'src/f105.js', additions: 105, deletions: 1, viewed: true });
    assert.equal(pr.files.filter((f) => f.viewed).length, 1);
    const args = (await fs.readFile(path.join(dir, 'view-args'), 'utf8')).split('\n');
    const fields = args[args.indexOf('--json') + 1].split(',');
    // headRefOid is asked for, as the commit the checks are for, and the
    // head the PR is at is still prFiles' (the test after this one).
    for (const f of ['files', 'changedFiles', 'baseRefOid', 'additions', 'deletions']) {
      assert.ok(!fields.includes(f), `gh pr view is not asked for ${f}: prFiles reads it`);
    }
  });
});

// The linked issues are read alongside the files, on GraphQL as well: a
// description that mentions one must not take one of the file pages.
test('the file pages are the file list\'s however many other calls run beside them', { skip: unix }, async () => {
  const all = Array.from({ length: 112 }, (_, i) => file(i));
  await withPr({ ...view, body: 'Follows #3 and #4.' }, [page(all.slice(0, 100), 'c1'), page(all.slice(100), null)], async (dir) => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual(pr.files.map((f) => f.path), all.map((f) => f.path));
    assert.equal(await fs.readFile(path.join(dir, 'n'), 'utf8'), '2\n');
  });
});

// The Mentions list says which numbers are pull requests (`PR #N`), from the
// same answer that titles them: GitHub's __typename, and its URL rather than
// the /issues/ guess. A number it did not answer has neither.
test('a mention carries the kind, title and URL its lookup found', { skip: unix }, async () => {
  await withPr({ ...view, body: 'Follows #3 and #4, and #5.' }, [page([file(1)], null)], async (dir) => {
    await fs.writeFile(path.join(dir, 'links.json'), JSON.stringify({ data: { repository: {
      i3: { __typename: 'PullRequest', title: 'Earlier work', url: 'https://github.com/o/r/pull/3', state: 'MERGED', updatedAt: '2026-10-01T00:00:00Z' },
      i4: { __typename: 'Issue', title: 'A bug', url: 'https://github.com/o/r/issues/4', state: 'OPEN', updatedAt: '2026-10-02T00:00:00Z' } } } }));
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual(pr.issues.map(({ number, kind, title, url }) => ({ number, kind, title, url })), [
      { number: 3, kind: 'pull', title: 'Earlier work', url: 'https://github.com/o/r/pull/3' },
      { number: 4, kind: 'issue', title: 'A bug', url: 'https://github.com/o/r/issues/4' },
      { number: 5, kind: null, title: null, url: 'https://github.com/o/r/issues/5' }]);
  });
});

// `gh pr view` and the file list are two calls, and a push can land between
// them. Each file's link is built at headRefOid and /api/diff diffs from
// baseRefOid with the file's line counts, so all of those have to be the
// answer the list came in, not the one before it.
test('the head a PR is at comes from the same answer as its files', { skip: unix }, async () => {
  const stale = { headRefOid: 'c'.repeat(40), baseRefOid: 'd'.repeat(40), additions: 1, deletions: 1 };
  await withPr({ ...view, ...stale }, [page([file(1)], null)], async () => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual([pr.headRefOid, pr.baseRefOid, pr.additions, pr.deletions],
      [head.headRefOid, head.baseRefOid, head.additions, head.deletions]);
    assert.equal(pr.nodeId, 'PR_node');
  });
});

// The checks come from `gh pr view`, and the head from the file pages after
// it: a push between the two would show the old head's checks beside the new
// head's files, so they are read again at the files' head.
test('the checks shown are for the head the files are at', { skip: unix }, async () => {
  const run = (name, conclusion) => [{ name, status: 'COMPLETED', conclusion }];
  const old = { ...view, headRefOid: 'c'.repeat(40), statusCheckRollup: run('old', 'FAILURE') };
  const atHead = { number: 1, url: view.url, headRefOid: head.headRefOid, updatedAt: 'later', statusCheckRollup: run('new', 'SUCCESS') };
  await withPr(old, [page([file(1)], null)], async (dir) => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual(pr.checks.list.map((c) => c.name), ['new']);
    assert.equal(pr.headRefOid, head.headRefOid);
    assert.equal(pr.updatedAt, old.updatedAt, 'the first call\'s, so the next poll reloads');
    assert.equal(await fs.readFile(path.join(dir, 'v'), 'utf8'), '2\n');
  }, [atHead]);
  // The same head both times: one call, as before.
  await withPr({ ...view, headRefOid: head.headRefOid }, [page([file(1)], null)], async (dir) => {
    await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.equal(await fs.readFile(path.join(dir, 'v'), 'utf8'), '1\n');
  });
});

// The pages are separate calls, so a push between two of them shifts the list
// under the cursor: here page 2 is the moved PR's, which repeats a file and
// would have lost another. A page at a different head starts the read over.
test('a PR that moves between pages of its files is read again', { skip: unix }, async () => {
  const moved = { ...head, headRefOid: 'e'.repeat(40) };
  const all = Array.from({ length: 101 }, (_, i) => file(i));
  await withPr(view, [
    page(all.slice(0, 100), 'c1'), page(all.slice(99), null, moved),
    page(all.slice(0, 100), 'c1', moved), page(all.slice(100), null, moved),
  ], async (dir) => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual(pr.files.map((f) => f.path), all.map((f) => f.path));
    assert.equal(pr.headRefOid, moved.headRefOid);
    assert.equal(await fs.readFile(path.join(dir, 'n'), 'utf8'), '4\n');
  });
});

// A base branch moving on does not move the merge base the list is the diff
// from, so it is no reason to read again: a busy `main` must not fail a read
// whose list was never at risk. Retargeting is a different diff, and is.
test('a PR whose base branch moves on is read once, and one retargeted is read again', { skip: unix }, async () => {
  const all = Array.from({ length: 101 }, (_, i) => file(i));
  const onward = { ...head, baseRefOid: 'f'.repeat(40) };
  await withPr(view, [page(all.slice(0, 100), 'c1'), page(all.slice(100), null, onward)], async (dir) => {
    const pr = await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.deepEqual(pr.files.map((f) => f.path), all.map((f) => f.path));
    assert.equal(pr.baseRefOid, head.baseRefOid, 'the first page\'s, which has the same merge base');
    assert.equal(await fs.readFile(path.join(dir, 'n'), 'utf8'), '2\n');
  });
  const retargeted = { ...head, baseRefName: 'release' };
  await withPr(view, [
    page(all.slice(0, 100), 'c1'), page(all.slice(100), null, retargeted),
    page(all.slice(0, 100), 'c1', retargeted), page(all.slice(100), null, retargeted),
  ], async (dir) => {
    await loadPr(os.tmpdir(), undefined, { pause: 0 });
    assert.equal(await fs.readFile(path.join(dir, 'n'), 'utf8'), '4\n');
  });
});

test('a PR that moves during every read of its files is an error, not a list', { skip: unix }, async () => {
  const at = (c) => ({ ...head, headRefOid: c.repeat(40) });
  const pages = ['1', '2', '3', '4', '5', '6'].map((c, i) => page([file(i)], i % 2 ? null : 'c1', at(c)));
  await withPr(view, pages, async () => {
    await assert.rejects(loadPr(os.tmpdir(), undefined, { pause: 0 }), /moved on GitHub during each of 3 reads of its files/);
  });
  // It names the pull request, which the server keeps showing (refreshPr), and
  // waits between reads -- pause, then twice it -- so a burst of pushes can settle.
  await withPr(view, pages, async () => {
    const started = Date.now();
    const e = await loadPr(os.tmpdir(), undefined, { pause: 40 }).catch((x) => x);
    assert.equal(e.moving, view.url);
    assert.ok(Date.now() - started >= 120, `${Date.now() - started}ms`);
  });
});

test('a next page of files with no cursor to it is an error, not the end', { skip: unix }, async () => {
  const lost = page([file(0)], null);
  lost.data.repository.pullRequest.files.pageInfo.hasNextPage = true;
  await withPr(view, [lost], async () => {
    await assert.rejects(loadPr(os.tmpdir(), undefined, { pause: 0 }), /has more files, but gave no cursor to them/);
  });
});

const flag = (args, name) => args[args.indexOf(name) + 1];

// What the lookup sends: one list per repository, by the branch's bare name,
// so a head in a fork no remote names still matches (gh 2.102.0, 2026-10-14);
// open ones with their checks first, and only with none anywhere a second
// pass for a merged or closed one, without the checks.
test('the branch lookup asks every repository, open first and then all without the checks', { skip: unix }, async () => {
  const { out, calls } = await ghCalls(`echo '[]'`, () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic'));
  assert.deepEqual(out, []);
  assert.deepEqual(calls.map((c) => `${flag(c, '--state')} ${flag(c, '--repo')}`).sort(),
    ['all me/repo', 'all up/repo', 'open me/repo', 'open up/repo']);
  for (const c of calls) {
    assert.deepEqual(c.slice(0, 2), ['pr', 'list']);
    assert.equal(flag(c, '--head'), 'topic');
    assert.ok(Number(flag(c, '--limit')) > 1, c.join(' '));
    assert.equal(flag(c, '--json').includes('statusCheckRollup'), flag(c, '--state') === 'open', c.join(' '));
  }
  // Nothing to look for: no branch, or nowhere to look.
  assert.deepEqual(await branchPrs(os.tmpdir(), ['up/repo'], ''), []);
  assert.deepEqual(await branchPrs(os.tmpdir(), [], 'topic'), []);
});

// Three pull requests whose head is `topic`, from `gh pr list --head topic` on
// the parent: one from a fork a remote names, one from a fork none does, one
// from a stranger's fork. Only the commit tells the last two apart.
const HEADS = [
  { number: 1, url: 'https://github.com/up/repo/pull/1', state: 'OPEN', headRefOid: 'aaa', updatedAt: '2026-10-01T00:00:00Z',
    headRepository: { nameWithOwner: 'me/repo' }, headRepositoryOwner: { login: 'me' }, isCrossRepository: true, statusCheckRollup: [] },
  { number: 2, url: 'https://github.com/up/repo/pull/2', state: 'OPEN', headRefOid: 'bbb', updatedAt: '2026-10-02T00:00:00Z',
    headRepository: { nameWithOwner: 'fork/repo' }, headRepositoryOwner: { login: 'fork' }, isCrossRepository: true, statusCheckRollup: [] },
  { number: 3, url: 'https://github.com/up/repo/pull/3', state: 'OPEN', headRefOid: 'ccc', updatedAt: '2026-10-03T00:00:00Z',
    headRepository: null, headRepositoryOwner: { login: 'stranger' }, isCrossRepository: true, statusCheckRollup: [] },
];

test('a pull request is the branch\'s by its head repository or its head commit, and a stranger\'s is dropped', { skip: unix }, async () => {
  const answer = `case "$*" in *"--repo up/repo --head topic --state open"*) cat <<'JSON'\n${JSON.stringify(HEADS)}\nJSON\n;; *) echo '[]';; esac`;
  const asked = [];
  const { out, calls } = await ghCalls(answer, () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic',
    { has: async (oids) => { asked.push(oids); return new Set(oids.filter((o) => o === 'bbb')); } }));
  assert.equal(calls.length, 2, 'open ones found: no second pass');
  assert.deepEqual(out.map((p) => p.number), [1, 2]);
  // The head a remote names is not asked about; the others are, together.
  assert.deepEqual(asked, [['bbb', 'ccc']]);
  // As the page and the poll read them: the repository looked in, the head
  // as a slug and an owner, and the checks summarised.
  assert.equal(out[0].repo, 'up/repo');
  assert.equal(out[0].headRepo, 'me/repo');
  assert.equal(out[0].headOwner, 'me');
  assert.equal('headRepository' in out[0], false);
  assert.equal('statusCheckRollup' in out[0], false);
  assert.deepEqual(out[0].checks, rollup([]));
});

// A fork's clone on `main`, pushing to the fork: the parent's own `main` into
// its `release` has its head in one of the repositories, and is still not
// this branch's. With nowhere a push goes, a head in one of them is.
test('with a push target, a head in another of the repositories is a stranger', { skip: unix }, async () => {
  const parents = { ...HEADS[0], number: 5, url: 'https://github.com/up/repo/pull/5', headRefOid: 'aaa',
    headRepository: { nameWithOwner: 'up/repo' }, headRepositoryOwner: { login: 'up' }, isCrossRepository: false };
  const answer = `case "$*" in *"--repo up/repo --head topic --state open"*) cat <<'JSON'\n${JSON.stringify([HEADS[0], parents])}\nJSON\n;; *) echo '[]';; esac`;
  const asked = [];
  const has = async (oids) => { asked.push(...oids); return new Set(oids); };
  const pushed = await ghCalls(answer, () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic', { has, home: 'me/repo' }));
  assert.deepEqual(pushed.out.map((p) => p.number), [1]);
  assert.deepEqual(asked, [], 'a head in one of the repositories is never asked about by commit');
  const unpushed = await ghCalls(answer, () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic', { has }));
  assert.deepEqual(unpushed.out.map((p) => p.number), [1, 5]);
});

// Strangers are dropped before the second pass is decided on: a stranger's
// open pull request from a `topic` of their own must not hide this branch's
// merged one.
test('a stranger\'s open pull request does not stop the lookup for a merged one', { skip: unix }, async () => {
  const merged = { ...HEADS[0], number: 4, url: 'https://github.com/up/repo/pull/4', state: 'MERGED' };
  delete merged.statusCheckRollup;
  const answer = `case "$*" in
    *"--repo up/repo --head topic --state open"*) cat <<'JSON'\n${JSON.stringify([HEADS[2]])}\nJSON\n;;
    *"--repo up/repo --head topic --state all"*) cat <<'JSON'\n${JSON.stringify([merged])}\nJSON\n;;
    *) echo '[]';; esac`;
  const { out, calls } = await ghCalls(answer, () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic',
    { has: async () => new Set() }));
  assert.equal(calls.length, 4);
  assert.deepEqual(out.map((p) => [p.number, p.state]), [[4, 'MERGED']]);
});

// gh lists the newest first, and a common name in a big parent fills the
// window with strangers' heads: microsoft/vscode had 63 open from a `main`
// (2026-10-14). A full window with none of the branch's is asked again, wider
// and without the checks, a hundred strangers' worth of them; one of the
// branch's found there gets its own from prHeads. One with the branch's in
// it, or not full, is the answer as it stands.
test('a window full of strangers is asked again, wider and without the checks', { skip: unix }, async () => {
  const strangers = Array.from({ length: 5 }, (_, i) => ({ ...HEADS[2], number: 100 + i,
    url: `https://github.com/up/repo/pull/${100 + i}`, headRefOid: `s${i}` }));
  const json = (rows) => `cat <<'JSON'\n${JSON.stringify(rows)}\nJSON`;
  const rollup1 = { number: 1, url: HEADS[0].url, headRefOid: 'aaa', updatedAt: 'x',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const answer = (first) => `case "$*" in
    *"--repo up/repo --head topic --state open --limit 5 "*) ${json(first)}\n;;
    *"--repo up/repo --head topic --state open --limit 100 "*) ${json([...strangers, HEADS[0]].map(({ statusCheckRollup, ...p }) => p))}\n;;
    "pr view ${HEADS[0].url} "*) ${json(rollup1)}\n;;
    *) echo '[]';; esac`;
  const ups = (calls) => calls.filter((c) => flag(c, '--repo') === 'up/repo');
  const wide = await ghCalls(answer(strangers), () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic'));
  assert.deepEqual(wide.out.map((p) => p.number), [1]);
  assert.deepEqual(ups(wide.calls).map((c) => [flag(c, '--limit'), flag(c, '--json').includes('statusCheckRollup')]).sort(),
    [['100', false], ['5', true]]);
  assert.deepEqual(wide.out[0].checks.passed, 1, 'its checks, from prHeads');
  assert.equal(wide.calls.filter((c) => c[1] === 'view').length, 1);
  // The branch's own in the window: no second ask.
  const found = await ghCalls(answer([...strangers.slice(1), HEADS[0]]), () => branchPrs(os.tmpdir(), ['up/repo', 'me/repo'], 'topic'));
  assert.deepEqual(found.out.map((p) => p.number), [1]);
  assert.deepEqual(ups(found.calls).map((c) => flag(c, '--limit')), ['5']);
});

// A repository past the first that cannot be read -- a parent since made
// private, a remote to nowhere -- is skipped; the first is gh's own base
// repository, and its failure is the poll's.
test('only the base repository\'s failure fails the lookup', { skip: unix }, async () => {
  const answer = `case "$*" in *"--repo gone/repo"*) echo 'gh: GraphQL: Could not resolve to a Repository' >&2; exit 1;; *) echo '[]';; esac`;
  const { out } = await ghCalls(answer, () => branchPrs(os.tmpdir(), ['up/repo', 'gone/repo'], 'topic'));
  assert.deepEqual(out, []);
  await withGh(() => answer, () =>
    assert.rejects(branchPrs(os.tmpdir(), ['gone/repo', 'up/repo'], 'topic'), /Could not resolve/));
});

// lookupPrs: what an earlier search found, read again by URL, and the search
// by name only when something might be there that the URLs cannot show.
// `search` stands in for branchPrs, so what reaches gh here is the reads.
const NOW = Date.parse('2026-10-14T12:00:00Z');
const known = (prs, searched = NOW - 60_000) => ({ searched, prs: prs.map(({ url, state }) => ({ url, repo: 'up/repo', state })) });
// gh answering `pr view <url>` with that row of `rows`, and failing for any other.
const viewing = (rows) => `case "$*" in
  ${rows.map((r) => `"pr view ${r.url} "*) cat <<'JSON'\n${JSON.stringify(r)}\nJSON\n;;`).join('\n  ')}
  *) echo 'gh: Could not resolve to a PullRequest' >&2; exit 1;; esac`;
const searching = (rows) => {
  const s = async () => { s.runs++; return rows; };
  s.runs = 0;
  return s;
};

test('remembered pull requests are read by URL, with no search, until one is due', { skip: unix }, async () => {
  const search = searching([]);
  const { out, calls } = await ghCalls(viewing([HEADS[0]]),
    () => lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), search, { now: NOW }));
  assert.equal(search.runs, 0);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['pr', 'view', HEADS[0].url]]);
  assert.ok(flag(calls[0], '--json').includes('statusCheckRollup'), 'an open one\'s checks, which keepPr takes');
  assert.equal(out.remember, undefined, 'nothing to write');
  // In branchPrs's shape: the repository it was found in, the head split, the checks summarised.
  assert.deepEqual(out.prs.map((p) => [p.number, p.repo, p.headRepo, p.headOwner]), [[1, 'up/repo', 'me/repo', 'me']]);
  assert.deepEqual(out.prs[0].checks, rollup([]));
  // Without the checks when the caller has them from elsewhere, and never for a merged one.
  const merged = { ...HEADS[0], state: 'MERGED' };
  for (const [row, checks] of [[HEADS[0], false], [merged, true]]) {
    const quiet = await ghCalls(viewing([row]), () => lookupPrs(os.tmpdir(), ['up/repo'], known([row]), search, { checks, now: NOW }));
    assert.ok(!flag(quiet.calls[0], '--json').includes('statusCheckRollup'), `${row.state} checks:${checks}`);
  }
});

test('a search runs when nothing open is known, when asked, when one is due, and when one has moved', { skip: unix }, async () => {
  const merged = { ...HEADS[0], state: 'MERGED' };
  const cases = [
    ['nothing known', null, {}, [HEADS[0]]],
    ['nothing open known: one may be opened beside the merged one', known([merged]), {}, [merged]],
    ['asked: a change of branch, r or g', known([HEADS[0]]), { fresh: true }, [HEADS[0]]],
    ['the last search is old', known([HEADS[0]], NOW - SEARCH_EVERY), {}, [HEADS[0]]],
    ['the last search is in the future: a clock set back', known([HEADS[0]], NOW + 60_000), {}, [HEADS[0]]],
    ['one is merged since', known([HEADS[0]]), {}, [merged]],
    ['one cannot be read', known([HEADS[1]]), {}, [HEADS[0]]],
    ['one is in a repository no longer looked in', { ...known([HEADS[0]]), prs: [{ ...known([HEADS[0]]).prs[0], repo: 'gone/repo' }] }, {}, [HEADS[0]]],
  ];
  for (const [why, k, opts, gh] of cases) {
    const search = searching([{ ...HEADS[0], repo: 'up/repo' }]);
    const { out } = await ghCalls(viewing(gh), () => lookupPrs(os.tmpdir(), ['up/repo'], k, search, { ...opts, now: NOW }));
    assert.equal(search.runs, 1, why);
    assert.deepEqual(out.remember, { searched: NOW, prs: [{ url: HEADS[0].url, repo: 'up/repo', state: 'OPEN' }] }, why);
  }
  // Nothing known and nothing found, every poll on a branch with none: nothing to write.
  const { out } = await ghCalls(viewing([]), () => lookupPrs(os.tmpdir(), ['up/repo'], null, searching([]), { now: NOW }));
  assert.deepEqual(out, { prs: [], remember: undefined });
  // Something known and nothing found now is remembered as nothing, which the
  // store keeps as no entry: here, one in a repository no longer looked in.
  const gone = { ...known([HEADS[0]]), prs: [{ ...known([HEADS[0]]).prs[0], repo: 'gone/repo' }] };
  const forgot = await ghCalls(viewing([]), () => lookupPrs(os.tmpdir(), ['up/repo'], gone, searching([]), { now: NOW }));
  assert.deepEqual(forgot.out, { prs: [], remember: { searched: NOW, prs: [] } });
  // None open known and the same found, every poll on a merged branch: nothing to write.
  const again = await ghCalls(viewing([]), () =>
    lookupPrs(os.tmpdir(), ['up/repo'], known([merged]), searching([{ ...merged, repo: 'up/repo' }]), { now: NOW }));
  assert.deepEqual(again.out.prs.map((p) => p.number), [1]);
  assert.equal(again.out.remember, undefined);
});

// A read that fails for a passing reason must not forget the branch's pull
// request: the search may not find it, which is why it is remembered. One gh
// says is not there is forgotten (the 'cannot be read' case above).
test('a remembered pull request that cannot be read just now is kept, unshown', { skip: unix }, async () => {
  const offline = `echo 'error connecting to api.github.com' >&2; exit 1`;
  const { out } = await ghCalls(offline, () => lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), searching([]), { now: NOW }));
  const stamped = { searched: NOW, prs: [{ ...known([HEADS[0]]).prs[0], unread: NOW }] };
  assert.deepEqual(out, { prs: [], remember: stamped }, 'remembered unread since now');
  // Failing again is no news: no search, nothing written -- or a search, a
  // file write and a failing read on every poll, for one that always fails.
  const later = NOW + 60_000;
  const search = searching([]);
  const again = await ghCalls(offline, () => lookupPrs(os.tmpdir(), ['up/repo'], stamped, search, { now: later }));
  assert.equal(search.runs, 0);
  assert.deepEqual(again.out, { prs: [], remember: undefined });
  // Through the next due search it keeps the time it first failed...
  const due = await ghCalls(offline, () => lookupPrs(os.tmpdir(), ['up/repo'], stamped, searching([]), { fresh: true, now: later }));
  assert.deepEqual(due.out.remember.prs, stamped.prs);
  // ...and is forgotten UNREAD_FOR after it, unread.
  const lapsed = await ghCalls(offline, () => lookupPrs(os.tmpdir(), ['up/repo'], stamped, searching([]), { now: NOW + UNREAD_FOR }));
  assert.deepEqual(lapsed.calls, [], 'not read again');
  assert.deepEqual(lapsed.out, { prs: [], remember: { searched: NOW + UNREAD_FOR, prs: [] } });
  // Read again after failing: news, so a search, and the mark is gone.
  const back = searching([{ ...HEADS[0], repo: 'up/repo' }]);
  const read = await ghCalls(viewing([HEADS[0]]), () => lookupPrs(os.tmpdir(), ['up/repo'], stamped, back, { now: later }));
  assert.equal(back.runs, 1);
  assert.deepEqual(read.out.remember, { searched: later, prs: known([HEADS[0]]).prs });
  // Beside one the search found, both are remembered and the found one shown.
  const beside = await ghCalls(offline, () => lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]),
    searching([{ ...HEADS[1], repo: 'up/repo' }]), { fresh: true, now: NOW }));
  assert.deepEqual(beside.out.prs.map((p) => p.number), [2]);
  assert.deepEqual(beside.out.remember.prs.map((p) => p.url), [HEADS[1].url, HEADS[0].url]);
  // Gone: a repository gh cannot see.
  const gone = `echo "GraphQL: Could not resolve to a Repository with the name 'up/repo'. (repository)" >&2; exit 1`;
  assert.deepEqual((await ghCalls(gone, () => lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), searching([]), { now: NOW }))).out,
    { prs: [], remember: { searched: NOW, prs: [] } });
});

// A search's rules can tighten under what an earlier one let in: a fork's
// clone given a push target after its `main` was handed the parent's. What
// the search did not find is held to them too, or it would never go.
test('a known pull request the search did not find is kept only while it is the branch\'s', { skip: unix }, async () => {
  const repos = ['up/repo', 'me/repo'];
  const row = { ...HEADS[0], headRefName: 'topic' };
  const run = (gh, home) => ghCalls(viewing([gh]), () => lookupPrs(os.tmpdir(), repos, known([HEADS[0]]), searching([]),
    { own: (rows) => ownPrs(rows, repos, { branch: 'topic', home }), fresh: true, now: NOW }));
  // Its head is me/repo's: the branch's while the branch pushes nowhere or there.
  for (const home of [null, 'me/repo']) assert.deepEqual((await run(row, home)).out.prs.map((p) => p.number), [1], `home ${home}`);
  // Pushing to up/repo, me/repo's branch of that name is a stranger's.
  assert.deepEqual((await run(row, 'up/repo')).out, { prs: [], remember: { searched: NOW, prs: [] } });
  // Its head renamed on github.com: no longer this branch's.
  assert.deepEqual((await run({ ...row, headRefName: 'renamed' }, null)).out.prs, []);
  // Between searches too: one that is no longer the branch's sets one off,
  // rather than being shown until the next is due.
  const search = searching([]);
  const between = await ghCalls(viewing([row]), () => lookupPrs(os.tmpdir(), repos, known([HEADS[0]]), search,
    { own: (rows) => ownPrs(rows, repos, { branch: 'topic', home: 'up/repo' }), now: NOW }));
  assert.equal(search.runs, 1);
  assert.deepEqual(between.out, { prs: [], remember: { searched: NOW, prs: [] } });
});

// Remembered closed, so read without the checks; open now, so they are asked
// for after all if the search its new state sets off misses it, and only then.
test('a remembered pull request reopened since is read with its checks', { skip: unix }, async () => {
  const closed = known([{ ...HEADS[0], state: 'CLOSED' }]);
  const search = searching([]);
  // The stub answers every field whatever --json asks, so the row carries no
  // rollup, as gh's answer to the first read does not.
  const { statusCheckRollup, ...reopened } = HEADS[0];
  const { out, calls } = await ghCalls(viewing([reopened]), () => lookupPrs(os.tmpdir(), ['up/repo'], closed, search, { now: NOW }));
  assert.equal(search.runs, 1, 'a change of state searches');
  // ghCalls hands the calls back in no fixed order.
  assert.deepEqual(calls.map((c) => flag(c, '--json').includes('statusCheckRollup')).sort(), [false, true]);
  assert.deepEqual(out.prs.map((p) => [p.number, p.state, p.checks]), [[1, 'OPEN', rollup([])]]);
  // Found by the search, which brings its checks: not read at all, since a
  // branch with none open known searches first.
  const found = await ghCalls(viewing([reopened]), () =>
    lookupPrs(os.tmpdir(), ['up/repo'], closed, searching([{ ...HEADS[0], repo: 'up/repo', checks: rollup([]) }]), { now: NOW }));
  assert.equal(found.calls.length, 0);
  assert.deepEqual(found.out.prs.map((p) => p.checks), [rollup([])]);
});

// The URL is what gh is given, so it is held to the repository, not only the
// `repo` beside it; readPrs refuses the pairing too.
test('a remembered URL outside its repository is never read', { skip: unix }, async () => {
  const evil = { ...known([HEADS[0]]), prs: [{ url: 'https://github.com/evil/x/pull/1', repo: 'up/repo', state: 'OPEN' }] };
  const search = searching([]);
  const { calls } = await ghCalls(viewing([]), () => lookupPrs(os.tmpdir(), ['up/repo'], evil, search, { now: NOW }));
  assert.deepEqual(calls, []);
  assert.equal(search.runs, 1, 'searched, as for nothing known');
});

// A remote's URL may spell the repository in other case than GitHub's link
// does, or name it from before a rename. The first is the same repository;
// the second cannot be held to its URL, so it is shown and searched for.
test('a remembered URL is held to its repository case-blind, and one renamed away is not remembered', { skip: unix }, async () => {
  const search = searching([]);
  const spelt = { ...known([HEADS[0]]), prs: [{ ...known([HEADS[0]]).prs[0], repo: 'Up/Repo' }] };
  const { out } = await ghCalls(viewing([HEADS[0]]), () => lookupPrs(os.tmpdir(), ['Up/Repo'], spelt, search, { now: NOW }));
  assert.equal(search.runs, 0, 'read by URL');
  assert.deepEqual(out.prs.map((p) => p.number), [1]);
  const renamed = { ...HEADS[0], url: 'https://github.com/up/renamed/pull/1', repo: 'up/repo' };
  const fresh = await ghCalls(viewing([]), () => lookupPrs(os.tmpdir(), ['up/repo'], null, searching([renamed]), { now: NOW }));
  assert.deepEqual(fresh.out.prs.map((p) => p.number), [1], 'still shown');
  assert.equal(fresh.out.remember, undefined, 'nothing written, poll after poll');
});

// gh lists the newest first, so strangers on a common name can push the
// branch's pull request out of the search's window long after the search
// that found it. It is kept; and an open one found stands alone, as in branchPrs.
test('a search keeps a known pull request it did not find, and open ones stand alone', { skip: unix }, async () => {
  const lost = await ghCalls(viewing([HEADS[0]]), () =>
    lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), searching([]), { fresh: true, now: NOW }));
  assert.deepEqual(lost.out.prs.map((p) => p.number), [1]);
  assert.deepEqual(lost.out.remember.prs.map((p) => p.url), [HEADS[0].url]);
  // Merged, and another opened in its place: the merged one is not shown.
  const merged = { ...HEADS[0], state: 'MERGED' };
  const replaced = await ghCalls(viewing([merged]), () =>
    lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), searching([{ ...HEADS[1], repo: 'up/repo' }]), { now: NOW }));
  assert.deepEqual(replaced.out.prs.map((p) => p.number), [2]);
  assert.equal(replaced.calls.length, 1, 'the merged one is not read twice');
  // Kept beside one found, in the repositories' order, which pickPr ranks by.
  const later = { ...HEADS[1], url: 'https://github.com/me/repo/pull/2', repo: 'me/repo' };
  const ranked = await ghCalls(viewing([HEADS[0]]), () =>
    lookupPrs(os.tmpdir(), ['up/repo', 'me/repo'], known([HEADS[0]]), searching([later]), { fresh: true, now: NOW }));
  assert.deepEqual(ranked.out.prs.map((p) => p.repo), ['up/repo', 'me/repo']);
  // Found by the search too: read once, by the search.
  const both = await ghCalls(viewing([]), () =>
    lookupPrs(os.tmpdir(), ['up/repo'], known([HEADS[0]]), searching([{ ...HEADS[0], repo: 'up/repo' }]), { fresh: true, now: NOW }));
  assert.equal(both.calls.length, 0);
});

const open = (n, extra = {}) => ({ number: n, url: `https://github.com/up/repo/pull/${n}`, state: 'OPEN', repo: 'up/repo',
  headRefOid: 'aaa', updatedAt: `2026-10-0${n}T00:00:00Z`, ...extra });

test('which of the branch\'s pull requests is shown: chosen, open, at HEAD, as before, by repository, newest', () => {
  const repos = ['up/repo', 'me/repo'];
  assert.equal(pickPr([], { repos }), null);
  // Open over merged, however new the merged one is.
  const merged = open(9, { state: 'MERGED', updatedAt: '2026-12-01T00:00:00Z' });
  assert.equal(pickPr([merged, open(1)], { repos }).number, 1);
  assert.equal(pickPr([merged], { repos }).number, 9);
  // At this clone's HEAD over one that is not.
  assert.equal(pickPr([open(1, { headRefOid: 'old' }), open(2)], { head: 'aaa', repos }).number, 2);
  // Tied there: the one the last poll showed, so a comment on the other
  // does not swap the pane.
  assert.equal(pickPr([open(1), open(2)], { head: 'aaa', shown: open(1).url, repos }).number, 1);
  assert.equal(pickPr([open(1), open(2)], { head: 'aaa', shown: open(2).url, repos }).number, 2);
  // Then gh's base repository before the fork's own.
  assert.equal(pickPr([open(1, { repo: 'me/repo' }), open(2)], { head: 'aaa', repos }).number, 2);
  // Then the newest.
  assert.equal(pickPr([open(1), open(2)], { head: 'aaa', repos }).number, 2);
  // The one picked in the switcher wins over all of it -- while it is listed.
  assert.equal(pickPr([open(1), open(2)], { head: 'aaa', chosen: open(1).url, repos }).number, 1);
  assert.equal(pickPr([open(1), open(2)], { head: 'aaa', chosen: 'https://github.com/up/repo/pull/7', repos }).number, 2);
});
