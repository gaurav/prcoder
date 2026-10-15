import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageTitle, withoutHtml, inline, headLinks, noPrLinks, prsInto, prTree, stackOn, stackLabel, stackUnder, stackTree, stackTitle, stackBase, stackOrder, stackEmpty, intoEmpty, switcherRows, sideLabel, sides, branchGroup, lookedIn,
  tabLabel, taskCount, filesName, checkCount, checksName, worst,
} from '../public/pr.js';
import { filesProgress } from '../public/filelist.js';
import { tabDone } from '../public/ui.js';
import { blocks } from '../public/tasks.js';

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
// as a literal `## Why`, HTML comments sitting above the list they delimit, and
// a stray `</details>` mid-pane.
test('HTML comments around a block do not show up in the pane', () => {
  const body = ['Prose above.', '', '<!-- begin checklist -->', '## Checklist', '',
    '- [ ] an item', '<!-- end checklist -->', '', 'Prose below.'].join('\n');
  const out = withoutHtml(body);
  assert.doesNotMatch(out, /<!--/);
  assert.doesNotMatch(out, /checklist -->/);
  // The block's contents survive -- only the comments go.
  assert.match(out, /## Checklist/);
  assert.match(out, /- \[ \] an item/);
  assert.match(out, /Prose above[\s\S]*Prose below/);
});

// Its lines stay, though, empty: taskLines numbers the raw body's lines, and a
// comment that took its newlines with it put every line after it on a
// different number here than there.
test('a comment spanning lines goes entirely, not just its first line', () => {
  assert.equal(withoutHtml('a\n<!-- one\ntwo\nthree -->\nb'), 'a\n\n\n\nb');
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

// --- links that only mean something against a repository ---

// GitHub leaves both of these to the page they are rendered on: a relative href
// stays relative, and a bare #N is linked by the repository the body belongs
// to. This pane is not that page, so inline() is handed the repository and the
// ref instead -- and without one, both stay as their own source rather than
// becoming a link to nowhere.
const where = { repo: 'https://github.test/o/r', ref: 'topic' };
const href = (s) => s.match(/href="([^"]*)"/)?.[1];

test('a relative link resolves against the head branch of the repository', () => {
  assert.equal(href(inline('[README](README.md)', where)),
    'https://github.test/o/r/blob/topic/README.md');
  assert.equal(href(inline('[why](docs/Design.md#guards)', where)),
    'https://github.test/o/r/blob/topic/docs/Design.md#guards');
  // A leading ./ or / is written as often as a bare path and means the same
  // thing here -- both are the repository root.
  assert.equal(href(inline('[a](./x.md)', where)), 'https://github.test/o/r/blob/topic/x.md');
  assert.equal(href(inline('[a](/x.md)', where)), 'https://github.test/o/r/blob/topic/x.md');
  // An absolute link is nobody's relative path and is left exactly as it was.
  assert.equal(href(inline('[docs](https://x.test/a)', where)), 'https://x.test/a');
});

// The ref is a branch name, which is not the description's text and so never
// went through the escaper -- and git allows a `"` in one. That closed the href
// and let the rest of the name add attributes (found in review, 2026-09-26).
test("a branch name in a relative link cannot leave the link's href", () => {
  const out = inline('[a](docs/a.md)', { ...where, ref: 'a"/style="color:red' });
  assert.doesNotMatch(out, /style=/);
  assert.equal(href(out), 'https://github.test/o/r/blob/a%22/style%3D%22color%3Ared/docs/a.md');
  // A `#` or `%` would otherwise end the path or start an escape; `/` stays a path.
  assert.equal(href(inline('[a](x.md)', { ...where, ref: 'feature/50%#1' })),
    'https://github.test/o/r/blob/feature/50%25%231/x.md');
});

test('a bare #N becomes a link to the issue of that number', () => {
  assert.equal(href(inline('Closes #28.', where)), 'https://github.test/o/r/issues/28');
  assert.equal(inline('(#28)', where).includes('>#28</a>)'), true);
  // Not a mention: a fragment inside a link this same call just built, and a
  // colour in prose, neither of which starts a word.
  assert.equal(href(inline('[x](y.md#3)', where)), 'https://github.test/o/r/blob/topic/y.md#3');
  assert.equal(inline('#ffcc00 is the colour', where), '#ffcc00 is the colour');
});

// The row under the badges. Derived from the PR's own URL rather than from the
// status's nameWithOwner, which carries no host -- so this is also the test that
// a GitHub Enterprise install is not quietly sent to github.com.
//
// The repository is not in the row. It is the one link with no bound on its
// width, and it wrapped the row; it comes back separately for the line below.
test('the head links point at the repository the pull request is in', () => {
  const pr = { number: 7, url: 'https://github.test/o/r/pull/7', headRefName: 'topic', baseRefName: 'main' };
  const { links, repo } = headLinks(pr);
  assert.deepEqual(links.map((l) => [l.text, l.href]), [
    ['PR #7', 'https://github.test/o/r/pull/7'],
    ['issues', 'https://github.test/o/r/issues'],
    ['pulls', 'https://github.test/o/r/pulls'],
    ['milestones', 'https://github.test/o/r/milestones'],
  ]);
  assert.deepEqual(repo, { href: 'https://github.test/o/r', slug: 'o/r', owner: 'o', rest: '/r' });
  // The pull request is the one drawn as a button; the lists stay links.
  assert.deepEqual(links.map((l) => l.className), ['primary', undefined, undefined, undefined]);
});

// The line clips on purpose, and the two spans are what decide which half goes.
// The slash belongs to the name: clipping a span that ended with it would give
// `heal-data-...heal-vlmd-AI-pipeline`, with nothing to say a level was
// dropped. A repository name can hold slashes in other forges, so the split is
// at the first one and the rest is one piece.
test('the repository line splits at the first slash, keeping the slash with the name', () => {
  const { repo } = headLinks({ number: 1, url: 'https://github.com/heal-data-stewards/heal-vlmd-AI-pipeline/pull/1' });
  assert.deepEqual([repo.owner, repo.rest], ['heal-data-stewards', '/heal-vlmd-AI-pipeline']);
  assert.equal(repo.owner + repo.rest, repo.slug);
});

// A fork's pull request is opened *against* this repository, and its issues and
// milestones are here rather than in the fork. The URL is the base repo's
// either way, which is the whole reason these are derived from it. The repo
// line is in this too -- it is the same derivation, off to one side.
test('a pull request from a fork links to the repository it was opened against', () => {
  const fork = {
    number: 9, url: 'https://github.test/o/r/pull/9', isCrossRepository: true,
    headRefName: 'contributor:patch', baseRefName: 'main',
  };
  const { links, repo } = headLinks(fork);
  for (const l of [...links, repo]) assert.match(l.href, /^https:\/\/github\.test\/o\/r(\/|$)/);
});

// The pane with no pull request offers the same lists, minus the pull request
// itself -- and in the same shape, because both panes render it with the same
// two calls.
test('with no pull request the repository and its lists are still linked', () => {
  const { links, repo } = noPrLinks(status());
  assert.deepEqual(links.map((l) => [l.text, l.href]), [
    ['issues', 'https://github.com/ggvaidya/prcoder/issues'],
    ['pulls', 'https://github.com/ggvaidya/prcoder/pulls'],
    ['milestones', 'https://github.com/ggvaidya/prcoder/milestones'],
  ]);
  assert.deepEqual(repo,
    { href: 'https://github.com/ggvaidya/prcoder', slug: 'ggvaidya/prcoder', owner: 'ggvaidya', rest: '/prcoder' });
});

// Before `gh repo view` has answered -- or outside a GitHub remote entirely --
// there is nothing to build a URL from, and a row of links to
// `https://github.com/undefined` is worse than no row at all. A null repo is
// what both panes check before drawing either line.
test('no repository means no links rather than links to nowhere', () => {
  assert.deepEqual(noPrLinks(status({ nameWithOwner: undefined })), { links: [], repo: null });
});

// The list the switcher fetches, which carries every open pull request in the
// repository -- the pane wants the ones that land on the branch you are on.
const at = (n) => `https://github.com/gaurav/prcoder/pull/${n}`;
// Each with its URL, which is what the switcher values its options by and
// switcherRows pins the one on screen by.
const OPEN = [
  { number: 1, headRefName: 'initial-implementation', baseRefName: 'main', title: 'The one into main', url: at(1) },
  { number: 27, headRefName: 'queue-tabs', baseRefName: 'initial-implementation', title: 'One of three', url: at(27) },
  { number: 60, headRefName: 'checks-tab', baseRefName: 'initial-implementation', title: 'Another', url: at(60) },
];

test('the pane lists the pull requests that merge into this branch, and no others', () => {
  assert.deepEqual(prsInto(OPEN, 'main').map((p) => p.number), [1]);
  assert.deepEqual(prsInto(OPEN, 'initial-implementation').map((p) => p.number), [27, 60]);
  assert.deepEqual(prsInto(OPEN, 'a-branch-nothing-targets'), []);
});

// A detached HEAD is no branch to merge into. Falsy rather than absent is the
// case that matters: `p.baseRefName === undefined` is false for every real pull
// request, but the guard says so instead of relying on it.
test('a detached HEAD lists nothing, not everything', () => {
  assert.deepEqual(prsInto(OPEN, null), []);
  assert.deepEqual(prsInto(OPEN, undefined), []);
});

// Numbers only, so a failure reads as the tree it got: [1, [27, 60]].
const shape = (nodes) => nodes.flatMap(({ pr, kids }) => (kids.length ? [pr.number, shape(kids)] : [pr.number]));

// This repository's own shape on 2026-09-25: #1 into main, the rest stacked on it.
test('each pull request carries the ones stacked on its branch', () => {
  assert.deepEqual(shape(prTree(OPEN, 'main')), [1, [27, 60]]);
  assert.deepEqual(shape(prTree(OPEN, 'initial-implementation')), [27, 60]);
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' }];
  assert.deepEqual(shape(prTree(deeper, 'main')), [1, [27, 60, [61]]]);
  assert.deepEqual(prTree(OPEN, null), []);
});

test('the Stack tab counts the whole tree, and a fork has no stack here', () => {
  assert.equal(stackLabel(stackOn({ headRefName: 'initial-implementation' }, OPEN)), 'Stack (↑2)');
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' }];
  assert.equal(stackLabel(stackOn({ headRefName: 'initial-implementation' }, deeper)), 'Stack (↑3)');
  assert.equal(stackLabel(stackOn({ headRefName: 'queue-tabs' }, OPEN)), 'Stack');
  // A fork's head is often `main`, which every PR here is into -- none of them
  // is built on the fork's branch.
  assert.deepEqual(stackOn({ headRefName: 'main', isCrossRepository: true }, OPEN), []);
});

// Four empties, four sentences. The other-repo one used to say "Nothing is
// stacked", which was a claim about a repository prcoder had not looked in; and
// with no list yet -- the first fetch still out, or every one failed -- the tab
// said the same, because the list it had was an empty one standing in for none.
// `{ branch }` parts become <code> in the pane; here, a backticked name.
const said = (parts) => parts.map((p) => (typeof p === 'string' ? p : `\`${p.branch}\``)).join('');

test('an empty Stack tab says why it is empty', () => {
  const here = { number: 70, headRefName: 'queue-tabs' };
  assert.equal(said(stackEmpty(here, OPEN)), 'Nothing is stacked on PR #70 (branch `queue-tabs`).');
  assert.equal(said(stackEmpty({ number: 80, headRefName: 'main', isCrossRepository: true }, OPEN)),
    'Nothing here can be built on PR #80 (branch `main`): the branch is in a fork.');
  assert.equal(said(stackEmpty(here, null, true)), 'Stacks are listed only for pull requests in this repository.');
  assert.equal(said(stackEmpty(here, null)), 'No list of open pull requests yet.');
  assert.deepEqual(stackOn(here, null), []);
});

test('the branch-only pane does not say nothing merges in when it has no list', () => {
  assert.equal(said(intoEmpty('main', [])), 'No pull requests into branch `main`.');
  assert.equal(said(intoEmpty('main', null)), 'No list of open pull requests yet.');
});

// #93: going down. `under` is bottom first; a node is its #N or its bare branch.
const down = ({ nodes, into, ask }) => ({ nodes: nodes.map((n) => (n.pr ? n.pr.number : n.branch)), into, ask });

test('a stacked pull request lists the ones under it, down to the default branch', () => {
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' }];
  assert.deepEqual(down(stackUnder({ pr: deeper[3] }, deeper, [], 'main')), { nodes: [1, 60], into: 'main', ask: null });
  assert.deepEqual(down(stackUnder({ pr: OPEN[0] }, OPEN, [], 'main')), { nodes: [], into: 'main', ask: null });
  // No list, or a list prcoder was not given (another repository): nothing, not "into main".
  assert.deepEqual(down(stackUnder({ pr: deeper[3] }, null, [], 'main')), { nodes: [], into: null, ask: null });
});

// gh pr list is open PRs only, so a base whose PR merged is a bare branch, and
// only git can say what is under it.
test('a base with no open pull request is asked of git, and followed once it answers', () => {
  const onMerged = [...OPEN, { number: 70, headRefName: 'on-merged', baseRefName: 'merged-topic' }];
  assert.deepEqual(down(stackUnder({ pr: onMerged[3] }, onMerged, [], 'main')),
    { nodes: ['merged-topic'], into: null, ask: 'merged-topic' });
  // git says it was cut from queue-tabs, which has #27, which the list follows.
  const git = [{ branch: 'merged-topic', names: ['queue-tabs'], toDefault: false }];
  assert.deepEqual(down(stackUnder({ pr: onMerged[3] }, onMerged, git, 'main')),
    { nodes: [1, 27, 'merged-topic'], into: 'main', ask: null });
  // git found nothing it could name under it.
  const lost = [{ branch: 'merged-topic', names: [], toDefault: false }];
  const under = stackUnder({ pr: onMerged[3] }, onMerged, lost, 'main');
  assert.deepEqual(down(under), { nodes: ['merged-topic'], into: null, ask: null });
  assert.equal(said(stackTitle(stackBase(onMerged[3]), under)),
    'The stack PR #70 (branch `on-merged`) is in. Nothing was found below `merged-topic`.');
});

test('the branch-only pane asks git what the branch is on, and not on the default branch', () => {
  assert.deepEqual(down(stackUnder({ branch: 'mine' }, OPEN, [], 'main')), { nodes: [], into: null, ask: 'mine' });
  const git = [{ branch: 'mine', names: ['queue-tabs'], toDefault: false }];
  assert.deepEqual(down(stackUnder({ branch: 'mine' }, OPEN, git, 'main')), { nodes: [1, 27], into: 'main', ask: null });
  assert.deepEqual(down(stackUnder({ branch: 'mine' }, OPEN, [{ branch: 'mine', names: [], toDefault: true }], 'main')),
    { nodes: [], into: 'main', ask: null });
  assert.deepEqual(down(stackUnder({ branch: 'main' }, OPEN, [], 'main')), { nodes: [], into: null, ask: null });
  assert.deepEqual(down(stackUnder({ branch: '' }, OPEN, [], 'main')), { nodes: [], into: null, ask: null });
});

test('going down stops at a cycle of bases, and never at a fork', () => {
  const loop = [
    { number: 2, headRefName: 'a', baseRefName: 'b' },
    { number: 3, headRefName: 'b', baseRefName: 'a' },
  ];
  assert.deepEqual(down(stackUnder({ pr: loop[0] }, loop, [], 'main')), { nodes: [3], into: null, ask: null });
  // A fork's `topic` is not this repository's `topic`.
  const fork = [{ number: 80, headRefName: 'topic', baseRefName: 'main', isCrossRepository: true },
    { number: 81, headRefName: 'on-topic', baseRefName: 'topic' }];
  assert.deepEqual(down(stackUnder({ pr: fork[1] }, fork, [], 'main')), { nodes: ['topic'], into: null, ask: 'topic' });
});

// Nested: the bottom of the chain, each step with the other PRs built on it,
// and `here` marked, with what is built on it under it as before.
const tree = (nodes) => nodes.flatMap((n) => {
  const id = n.pr ? n.pr.number : n.branch;
  const me = n.here ? `${id}*` : id;
  return n.kids.length ? [me, tree(n.kids)] : [me];
});

test('the Stack tab of a stacked pull request is the whole stack, with this one marked', () => {
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' }];
  const here = { pr: OPEN[2] };
  const under = stackUnder(here, deeper, [], 'main');
  assert.deepEqual(tree(stackTree(here, deeper, under)), [1, ['60*', [61], 27]]);
  assert.equal(said(stackTitle(stackBase(OPEN[2]), under)), 'The stack PR #60 (branch `checks-tab`) is in, from `main`.');
  // With nothing under it the pane is as it was.
  assert.equal(stackTree({ pr: OPEN[0] }, OPEN, stackUnder({ pr: OPEN[0] }, OPEN, [], 'main')), null);
  // The branch-only pane: the branch marked, the PRs into it under it.
  const mine = [...OPEN, { number: 90, headRefName: 'on-mine', baseRefName: 'mine' }];
  const git = [{ branch: 'mine', names: ['queue-tabs'], toDefault: false }];
  const at = { branch: 'mine' };
  assert.deepEqual(tree(stackTree(at, mine, stackUnder(at, mine, git, 'main'))), [1, [27, ['mine*', [90]], 60]]);
  // Cut straight from main, it is still a stack of its own, saying so.
  const onMain = stackUnder(at, mine, [{ branch: 'mine', names: [], toDefault: true }], 'main');
  assert.deepEqual(tree(stackTree(at, mine, onMain)), ['mine*', [90]]);
  assert.equal(said(stackTitle(['branch ', { branch: 'mine' }], onMain)), 'The stack branch `mine` is in, from `main`.');
  // Until git has said, and on the default branch itself, the pane is as it was.
  assert.equal(stackTree(at, mine, stackUnder(at, mine, [], 'main')), null);
  assert.equal(stackTree({ branch: 'main' }, mine, stackUnder({ branch: 'main' }, mine, [], 'main')), null);
});

test('the Stack tab counts down and up apart, and leaves out a part that is nothing', () => {
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' }];
  const label = (pr, git = []) => stackLabel(stackOn(pr, deeper), stackUnder({ pr }, deeper, git, 'main').nodes);
  assert.equal(label(OPEN[2]), 'Stack (↓1 ↑1)');
  assert.equal(label(deeper[3]), 'Stack (↓2)');
  assert.equal(label(OPEN[0]), 'Stack (↑3)');
  assert.equal(label(OPEN[1]), 'Stack (↓1)');
  // A bare branch under it is drawn, and is nothing to switch to, so not counted.
  const onMerged = { number: 70, headRefName: 'on-merged', baseRefName: 'merged-topic' };
  assert.equal(label(onMerged), 'Stack');
});

const order = (prs) => stackOrder(prs).map(({ pr, depth }) => `${'-'.repeat(depth)}${pr.number}`);

test('the switcher lists each pull request with its stack under it', () => {
  const deeper = [...OPEN, { number: 61, headRefName: 'tabs-2', baseRefName: 'checks-tab' },
    { number: 9, headRefName: 'elsewhere', baseRefName: 'release' }];
  assert.deepEqual(order(deeper), ['1', '-27', '-60', '--61', '9']);
});

// gh pr list has only open PRs, so a merged one on screen is added -- into the
// tree, so what is still open on its branch nests under it, as in its Stack tab.
test('a merged pull request on screen parents the ones still open on its branch', () => {
  const merged = { number: 5, title: 'Merged', headRefName: 'merged-topic', baseRefName: 'initial-implementation', url: at(5) };
  const built = [...OPEN, { number: 70, headRefName: 'built-on-merged', baseRefName: 'merged-topic' }];
  const rows = (prs, pr) => switcherRows(prs, pr).map(({ pr: p, depth }) => `${'-'.repeat(depth)}${p.number}`);
  assert.deepEqual(rows(built, merged), ['1', '-5', '--70', '-27', '-60']);
  // Open, it is already in the list, and nothing is added.
  assert.deepEqual(rows(OPEN, OPEN[1]), ['1', '-27', '-60']);
  // Into a branch no open PR is on, it leads.
  assert.deepEqual(rows(OPEN, { ...merged, baseRefName: 'main' }), ['5', '1', '-27', '-60']);
});

// The parent's #27 on screen, beside the list's own #27: by number the walk
// took them for one and the list's lost its option. In another repository it
// leads, unnested -- its branches are not the list's either.
test('a pull request on screen from another repository leads, and costs the list nothing', () => {
  const parents = { number: 27, title: 'Theirs', headRefName: 'initial-implementation', baseRefName: 'main',
    url: 'https://github.com/upstream/prcoder/pull/27' };
  const rows = (pr, repo) => switcherRows(OPEN, pr, repo).map(({ pr: p, depth }) => `${'-'.repeat(depth)}${p.url}`);
  assert.deepEqual(rows(parents, 'gaurav/prcoder'), [parents.url, at(1), `-${at(27)}`, `-${at(60)}`]);
  // From the list's own repository, it still goes into the tree.
  assert.deepEqual(switcherRows(OPEN, { ...OPEN[1], url: at(5), number: 5 }, 'gaurav/prcoder').map(({ pr }) => pr.number),
    [1, 5, 27, 60]);
});

// A fork's head is a branch in the fork. Named `main`, it would otherwise make
// every PR into main look stacked on it and leave the switcher with no roots.
test('a fork does not parent the PRs into a branch of the same name', () => {
  const fork = [{ number: 80, headRefName: 'main', baseRefName: 'main', isCrossRepository: true }, ...OPEN];
  assert.deepEqual(order(fork), ['80', '1', '-27', '-60']);
});

test('a cycle of bases still lands in the switcher', () => {
  const loop = [
    { number: 2, headRefName: 'a', baseRefName: 'b' },
    { number: 3, headRefName: 'b', baseRefName: 'a' },
  ];
  assert.deepEqual(order([...OPEN, ...loop]), ['1', '-27', '-60', '2', '3']);
});

// A fork PR from `someone:main` into main is not the parent of every PR into main.
test('a fork has no stack under it', () => {
  const fork = [{ number: 80, headRefName: 'main', baseRefName: 'main', isCrossRepository: true }, ...OPEN];
  assert.deepEqual(shape(prTree(fork, 'main')), [80, 1, [27, 60]]);
});

// GitHub lets two open pull requests base on each other's heads.
test('a cycle of bases ends instead of recursing forever', () => {
  const loop = [
    { number: 2, headRefName: 'a', baseRefName: 'b' },
    { number: 3, headRefName: 'b', baseRefName: 'a' },
  ];
  assert.deepEqual(shape(prTree(loop, 'a')), [3, [2]]);
});

// prTree from a bare branch reaches round to #2, above; from #2 itself it must
// not, or #2's Stack tab lists #2 with a Switch to the pull request on screen.
test('a cycle of bases does not stack a pull request on itself', () => {
  const loop = [
    { number: 2, headRefName: 'a', baseRefName: 'b' },
    { number: 3, headRefName: 'b', baseRefName: 'a' },
  ];
  assert.deepEqual(shape(stackOn(loop[0], loop)), [3]);
  assert.equal(stackLabel(stackOn(loop[0], loop)), 'Stack (↑1)');
});

test('without a repository to resolve against, neither becomes a link', () => {
  assert.equal(inline('[README](README.md) and #28', null),
    '[README](README.md) and #28');
});

// The href is interpolated into an attribute and set with innerHTML, so a
// target this pane will not open has to stay text rather than become an <a>.
// The relative rule is what makes this a live question: before it, anything
// that was not http(s) simply did not match.
test('a link to a scheme that is not http(s) is left as its own source', () => {
  for (const s of ['[x](javascript:alert(1))', '[x](data:text/html,<b>)', '[x](vbscript:x)']) {
    assert.doesNotMatch(inline(s, where), /<a /);
  }
  // A same-page anchor is a position on a page prcoder is not, so it is left
  // alone too -- and a mailto: is a link this pane has no business opening.
  assert.doesNotMatch(inline('[top](#intro)', where), /<a /);
  assert.doesNotMatch(inline('[mail](mailto:a@b.test)', where), /<a /);
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

// A count that has run out keeps its numbers -- `(11/11)` is what says all
// eleven were viewed -- and tabDone, in test/ui.test.js, is what marks it finished.
test('a tab whose count has run out keeps the count', () => {
  assert.equal(tabLabel('Detail', { done: 10, total: 10 }), 'Detail (10/10)');
  assert.equal(tabLabel('Files', { done: 1, total: 1 }), 'Files (1/1)');
  // Distinct from the nothing-to-count case, which is the bare name.
  assert.equal(tabLabel('Detail', { done: 0, total: 0 }), 'Detail');
});

test('a tab with something to count carries done over total', () => {
  assert.equal(tabLabel('Detail', { done: 3, total: 10 }), 'Detail (3/10)');
  // Nothing done yet still counts: `(0/4)` is four things waiting, and reads
  // very differently from a bare `Files`.
  assert.equal(tabLabel('Files', { done: 0, total: 4 }), 'Files (0/4)');
});

// A failure is counted in the total and not in the done, so the fraction stays
// short of the total for as long as anything is red -- a done Checks tab is
// reachable only by everything passing.
test('the checks count is passing over all of them', () => {
  assert.deepEqual(checkCount({ passed: 1, failed: 1, pending: 1 }), { done: 1, total: 3 });
  assert.equal(tabLabel('Checks', checkCount({ passed: 1, failed: 1, pending: 1 })), 'Checks (1/3)');
  assert.equal(tabLabel('Checks', checkCount({ passed: 3, failed: 0, pending: 0 })), 'Checks (3/3)');
  assert.equal(tabDone(checkCount({ passed: 2, failed: 1, pending: 0 })), false);
  assert.equal(tabLabel('Checks', checkCount({ passed: 0, failed: 1, pending: 0 })), 'Checks (0/1)');
});

// The fraction alone reads the same for a failure and a check still running,
// and the mark that tells them apart is not text, so the tab's name says it in
// words -- starting with the label as shown.
test('the Checks tab is named in words, so a failed 1/3 and a pending one differ', () => {
  assert.equal(checksName({ passed: 1, failed: 0, pending: 2 }), 'Checks (1/3): 2 pending');
  assert.equal(checksName({ passed: 1, failed: 1, pending: 1 }), 'Checks (1/3): 1 failed, 1 pending');
  assert.equal(checksName({ passed: 0, failed: 2, pending: 0 }), 'Checks (0/2): 2 failed');
  assert.equal(checksName({ passed: 3, failed: 0, pending: 0 }), 'Checks (3/3)');
});

// The Files tab's mark is hidden like every tab's, so what its pie says that
// the count does not -- how much of the reviewing is by lines -- goes in the
// name, after the label as shown. Nothing to add once every file is viewed, or
// when nothing has lines to weigh.
test('the Files tab is named with the changed lines its pie fills by', () => {
  const f = (additions, deletions, viewed) => ({ additions, deletions, viewed });
  assert.equal(filesName(filesProgress([f(30, 10, true), f(70, 10, false)])), 'Files (1/2): 40 of 120 changed lines viewed');
  assert.equal(filesName(filesProgress([f(30, 10, true), f(70, 10, true)])), 'Files (2/2)');
  assert.equal(filesName(filesProgress([f(0, 0, true), f(0, 0, false)])), 'Files (1/2)', 'a rename has no lines to weigh');
  assert.equal(filesName(filesProgress([])), 'Files');
});

// And the mark: one failure is the thing to know, whatever is still running.
test('a failure marks the tab even when something else is still running', () => {
  assert.equal(worst({ failed: 1, pending: 2 }), 'fail');
  assert.equal(worst({ failed: 0, pending: 2 }), 'pend');
  assert.equal(worst({ failed: 0, pending: 0 }), 'pass');
});

test('the description count walks the body, fences and all', () => {
  const count = (body) => taskCount(blocks(body));
  assert.deepEqual(count('- [x] a\n- [ ] b\n- [x] c'), { done: 2, total: 3 });
  // The same rule the tick uses: a checklist line inside a fence is a sample.
  assert.deepEqual(count('```\n- [ ] sample\n```\n\n- [x] real'), { done: 1, total: 1 });
  assert.deepEqual(count('Just prose.'), { done: 0, total: 0 });
});

// GitHub's own labelling of a branch in another repository, with the remote's
// name where this clone has one: origin's branches stay bare, so a pull
// request between them reads as it always has.
const REMOTES = { 'biothings/NodeNormalizationAPI': 'origin', 'TranslatorSRI/NodeNormalizationAPI': 'mine' };

test('a side of head → base is prefixed only when it is not in origin\'s repository', () => {
  assert.equal(sideLabel('main', { slug: 'biothings/NodeNormalizationAPI' }, REMOTES), 'main');
  assert.equal(sideLabel('topic', { slug: 'TranslatorSRI/NodeNormalizationAPI' }, REMOTES), 'mine:topic');
  // A fork no remote names: its owner, as GitHub writes it.
  assert.equal(sideLabel('topic', { slug: 'stranger/NodeNormalizationAPI' }, REMOTES), 'stranger:topic');
  // A deleted fork has no repository left, only the owner GitHub remembers.
  assert.equal(sideLabel('topic', { slug: null, owner: 'gone' }, REMOTES), 'gone:topic');
  // No remotes known at all (the first poll's fixture, a clone off GitHub): the owner.
  assert.equal(sideLabel('main', { slug: 'o/r' }), 'o:main');
});

test('both sides of a pull request, from where its head and base live', () => {
  const inOrigin = { url: 'https://github.com/biothings/NodeNormalizationAPI/pull/52', headRefName: 'run-tests', baseRefName: 'main',
    isCrossRepository: true, headRepo: 'TranslatorSRI/NodeNormalizationAPI', headOwner: 'TranslatorSRI' };
  assert.deepEqual(sides(inOrigin, { 'biothings/NodeNormalizationAPI': 'origin' }), { head: 'TranslatorSRI:run-tests', base: 'main' });
  assert.deepEqual(sides(inOrigin, REMOTES), { head: 'mine:run-tests', base: 'main' });
  // From a clone of the fork: the base is upstream's, the head is here.
  const fromFork = { 'TranslatorSRI/NodeNormalizationAPI': 'origin', 'biothings/NodeNormalizationAPI': 'upstream' };
  assert.deepEqual(sides(inOrigin, fromFork), { head: 'run-tests', base: 'upstream:main' });
  // Within one repository, with no head repository on the object (an older
  // status): the pull request's own.
  const plain = { url: 'https://github.com/biothings/NodeNormalizationAPI/pull/5', headRefName: 'fix', baseRefName: 'main', isCrossRepository: false };
  assert.deepEqual(sides(plain, REMOTES), { head: 'fix', base: 'main' });
});

// The switcher's group for a branch with more than one pull request: the
// branch's own, each a pick that shows rather than checks out, with the open
// list's stack under the first. One alone is no choice, so no group.
test('a branch with two pull requests gets a group of its own, stack and all', () => {
  const mine = { number: 1, url: at(1), state: 'OPEN', headRefName: 'initial-implementation', baseRefName: 'main', repo: 'gaurav/prcoder' };
  const theirs = { number: 9, url: 'https://github.com/upstream/prcoder/pull/9', state: 'OPEN', headRefName: 'initial-implementation',
    baseRefName: 'main', repo: 'upstream/prcoder', isCrossRepository: true };
  const rows = (g) => g.map(({ pr, depth, own }) => `${'-'.repeat(depth)}${pr.number}${own ? '!' : ''}`);
  assert.deepEqual(rows(branchGroup([mine, theirs], OPEN, mine)), ['1!', '-27', '-60', '9!']);
  // The stack hangs off whichever comes first; a fork's head carries none.
  assert.deepEqual(rows(branchGroup([theirs, mine], OPEN, theirs)), ['9!', '1!', '-27', '-60']);
  assert.deepEqual(branchGroup([mine], OPEN, mine), []);
  assert.deepEqual(branchGroup([], OPEN, null), []);
  // A merged one is in the group only while it is the one on screen.
  const merged = { ...theirs, state: 'MERGED' };
  assert.deepEqual(rows(branchGroup([mine, merged], OPEN, mine)), []);
  assert.deepEqual(rows(branchGroup([mine, merged], OPEN, merged)), ['1!', '-27', '-60', '9!']);
  // One in the parent between the parent's own branches is not cross-repository,
  // and still not the list's: no stack under it, and it leaves the stack to mine.
  const inParent = { ...theirs, isCrossRepository: false };
  assert.deepEqual(rows(branchGroup([inParent, mine], OPEN, inParent, 'gaurav/prcoder')), ['9!', '1!', '-27', '-60']);
});

test('the repositories looked in read as a list', () => {
  assert.equal(lookedIn(['a/b']), 'a/b');
  assert.equal(lookedIn(['a/b', 'c/d']), 'a/b or c/d');
  assert.equal(lookedIn(['a/b', 'c/d', 'e/f']), 'a/b, c/d or e/f');
});
