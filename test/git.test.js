import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { notAWorkTree, syncState, compareUrl, githubUrl, originOwner, remoteRepo, remoteRepos, repoInfo, pushRepo, commitsKnown, commitMemo, wholePrRepo, checkoutPr, startOnPr, isHere, trackedPr, userDirt, remoteBranchHead, trackingHead, snapshot, localPatch, branchesBelow } from '../git.js';

// git finds the repository through GIT_DIR and GIT_WORK_TREE before it looks
// at cwd, and a git hook exports them. Under a hook, `npm test` ran every
// throwaway repo's commands below against the clone it was run in: on
// 2026-10-14 that rewrote origin's URL, deleted its remote-tracking branches,
// renamed the checked-out branch and committed to it. So none of git's own
// variables reach this file's children, which are both the helpers here and
// git.js's run() -- it spreads process.env.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
// And in English: tests here match git's own words (`not a git repository`),
// which a translated git prints in the reader's language.
process.env.LC_ALL = 'C';

const git = promisify(execFile);
import { withGh, unix } from './stub-gh.js';
import { runCount } from '../github.js';
// For the throwaway repos below. The identity goes on the command, not into a
// config: a CI runner has none set, and `git commit` there is a hard failure
// rather than a warning. Signing is turned off the same way: a machine that
// signs every commit hands a throwaway repo's commit to its signer, and a
// locked 1Password agent failed a test after a minute's wait with nothing to do
// with what it was testing.
const TEST_CONFIG = ['-c', 'user.name=prcoder tests', '-c', 'user.email=tests@prcoder.invalid', '-c', 'commit.gpgsign=false'];
const testGit = (cwd, ...args) => git('git', [...TEST_CONFIG, ...args], { cwd });

// The four inputs come from `git rev-parse --verify` and `git merge-base
// --is-ancestor`; the exit codes those return are checked in git.js, not here.
const state = (o) => syncState({ head: 'aaa', remoteHead: 'bbb', remoteKnownLocally: true, remoteIsAncestor: true, ...o });

// The page's switch request on its way to gh's argv: the whole string is the
// URL, or it is refused.
test('a switch takes the whole of a pull request URL, and nothing with one inside it', () => {
  assert.equal(wholePrRepo('https://github.com/heal-data-stewards/heal-vlmd.AI_pipeline/pull/12'), 'heal-data-stewards/heal-vlmd.AI_pipeline');
  for (const url of ['140', undefined, '--flag https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1 --flag',
    'https://elsewhere.example/github.com/a/b/pull/1', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/1/files']) {
    assert.throws(() => wholePrRepo(url), /not a pull request URL/, String(url));
  }
});

test('a branch GitHub has never seen is unpushed, not behind', () => {
  assert.equal(state({ remoteHead: null }), 'unpushed');
});

test('the same commit on both sides is synced', () => {
  assert.equal(state({ remoteHead: 'aaa' }), 'synced');
});

test('local commits on top of the remote head are ahead', () => {
  assert.equal(state({ remoteKnownLocally: true, remoteIsAncestor: true }), 'ahead');
});

test('a remote commit we do not have locally reads as behind', () => {
  assert.equal(state({ remoteKnownLocally: false }), 'behind');
});

// Both sides moved. Only reachable once the remote commit is in the object
// store, so a fresh clone that is genuinely diverged still reports "behind".
test('a remote head we have but have not built on is diverged', () => {
  assert.equal(state({ remoteKnownLocally: true, remoteIsAncestor: false }), 'diverged');
});

test('unpushed wins over everything: there is nothing to compare against', () => {
  assert.equal(state({ remoteHead: null, remoteKnownLocally: false, remoteIsAncestor: false }), 'unpushed');
});

test('the compare URL opens GitHub with the form already expanded', () => {
  assert.equal(
    compareUrl('gaurav/prcoder', 'main', 'my-branch'),
    'https://github.com/gaurav/prcoder/compare/main...my-branch?expand=1');
});

// In a fork clone gh's base repo is upstream's, and the branch is only on
// origin: a bare name there was GitHub's 404.
test('the compare URL names the fork the branch was pushed to', () => {
  assert.equal(
    compareUrl('uc-cdis/heal-platform-sdk', 'master', 'my-branch', 'gaurav'),
    'https://github.com/uc-cdis/heal-platform-sdk/compare/master...gaurav:my-branch?expand=1');
});

// git allows a `#` in a branch name, and raw in the URL it ends the path: the
// compare page opened for whatever came before it. `/` stays a separator.
test('a branch name is encoded in the compare URL, its slashes kept', () => {
  assert.equal(
    compareUrl('gaurav/prcoder', 'main', 'fix/issue#12'),
    'https://github.com/gaurav/prcoder/compare/main...fix/issue%2312?expand=1');
});

// `g`: the PR when there is one, the repo where there is nothing to compare,
// and a refusal for a branch GitHub has never seen, whose compare page is empty.
test('the g key opens the PR, the compare page, or the repo', () => {
  const at = { nameWithOwner: 'o/r', defaultBranch: 'main', branch: 'feat', pushed: true, owner: 'me' };
  assert.equal(githubUrl({ ...at, prUrl: 'https://github.com/o/r/pull/7' }), 'https://github.com/o/r/pull/7');
  assert.equal(githubUrl(at), 'https://github.com/o/r/compare/main...me:feat?expand=1');
  assert.equal(githubUrl({ ...at, branch: 'main' }), 'https://github.com/o/r');
  assert.equal(githubUrl({ ...at, branch: null }), 'https://github.com/o/r');
  assert.throws(() => githubUrl({ ...at, pushed: false }), /feat is not on GitHub yet/);
});

// What server.js refuses to start in. The tmpdir is outside any repo; a
// GIT_CEILING_DIRECTORIES would be needed if it ever were not, since git
// searches upward and would find that repo instead.
test('only a checkout, or a directory inside one, is a work tree', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-worktree-'));
  try {
    assert.match(await notAWorkTree(dir), /not a git repository/);
    await git('git', ['init', '-q', dir]);
    assert.equal(await notAWorkTree(dir), null);
    await fs.mkdir(path.join(dir, 'sub'));
    assert.equal(await notAWorkTree(path.join(dir, 'sub')), null, 'a subdirectory');
    assert.match(await notAWorkTree(path.join(dir, '.git')), /bare repository, not a checkout/);
    await git('git', ['init', '-q', '--bare', path.join(dir, 'bare.git')]);
    assert.match(await notAWorkTree(path.join(dir, 'bare.git')), /bare repository, not a checkout/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("origin's owner comes off every shape of GitHub remote URL", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-origin-'));
  try {
    await git('git', ['init', '-q', dir]);
    for (const url of ['git@github.com:gaurav/heal-platform-sdk.git',
      'https://github.com/gaurav/heal-platform-sdk', 'https://github.com/gaurav/heal-platform-sdk.git/',
      'ssh://git@github.com/gaurav/heal-platform-sdk.git']) {
      await git('git', ['remote', 'remove', 'origin'], { cwd: dir }).catch(() => {});
      await git('git', ['remote', 'add', 'origin', url], { cwd: dir });
      assert.equal(await originOwner(dir), 'gaurav', url);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a remote URL on GitHub names its repository, and one elsewhere names nothing', () => {
  for (const url of ['git@github.com:gaurav/heal-platform-sdk.git', 'https://github.com/gaurav/heal-platform-sdk',
    'https://github.com/gaurav/heal-platform-sdk.git/', 'ssh://git@github.com/gaurav/heal-platform-sdk.git\n']) {
    assert.equal(remoteRepo(url), 'gaurav/heal-platform-sdk', url);
  }
  // A mirror elsewhere is no repository to ask gh about (#53).
  assert.equal(remoteRepo('git@gitlab.com:gaurav/heal-platform-sdk.git'), null);
  assert.equal(remoteRepo('/srv/git/heal-platform-sdk.git'), null);
});

// origin first whatever `git remote` sorts it as, and a remote off GitHub left
// out, so the lookup never asks gh about a repository that is not there.
test('the remotes are listed origin first, GitHub ones only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-remotes-'));
  try {
    await git('git', ['init', '-q', dir]);
    await git('git', ['remote', 'add', 'upstream', 'https://github.com/biothings/NodeNormalizationAPI'], { cwd: dir });
    await git('git', ['remote', 'add', 'mirror', 'git@gitlab.com:TranslatorSRI/NodeNormalizationAPI.git'], { cwd: dir });
    await git('git', ['remote', 'add', 'origin', 'git@github.com:TranslatorSRI/NodeNormalizationAPI.git'], { cwd: dir });
    assert.deepEqual(await remoteRepos(dir), [
      { name: 'origin', repo: 'TranslatorSRI/NodeNormalizationAPI' },
      { name: 'upstream', repo: 'biothings/NodeNormalizationAPI' },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The lookup's stranger check, a page of heads at a time: one git call, line
// for line, and a name that is not an oid never sent, since one with a
// newline in it would shift the answers after it.
test('which commits this clone has is one git call for the lot, and asked once each per memo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-commits-'));
  try {
    await git('git', ['init', '-q', dir]);
    await testGit(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
    const head = (await testGit(dir, 'rev-parse', 'HEAD')).stdout.trim();
    const tree = (await testGit(dir, 'rev-parse', 'HEAD^{tree}')).stdout.trim();
    const gone = 'e'.repeat(40);
    let calls = runCount();
    assert.deepEqual(await commitsKnown([gone, `${head}\nHEAD`, tree, head], dir), new Set([head]));
    assert.equal(runCount() - calls, 1);
    assert.deepEqual(await commitsKnown(['HEAD'], dir), new Set(), 'not an oid: not asked');
    const memo = commitMemo(dir);
    calls = runCount();
    assert.deepEqual(await memo.many([head, gone]), new Set([head]));
    assert.equal(await memo.one(head), true);
    assert.equal(await memo.one(gone), false);
    assert.equal(runCount() - calls, 1, 'each commit asked about once');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Where a plain push of the branch goes, when it goes to a branch of the same
// name: what tells the fork's own `main` from the parent's in branchPrs.
test('a branch pushes to the repository of the remote a push would go to, under its own name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-push-'));
  const run = (...args) => testGit(dir, ...args);
  const repoOf = { origin: 'me/repo', upstream: 'up/repo' };
  try {
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await run('commit', '-q', '--allow-empty', '-m', 'x');
    for (const [name, url] of [['origin', 'git@github.com:me/repo.git'], ['upstream', 'https://github.com/up/repo']]) {
      await run('remote', 'add', name, url);
      await run('update-ref', `refs/remotes/${name}/main`, 'main');
    }
    // No upstream, under push.default simple: a push goes nowhere.
    assert.equal(await pushRepo(dir, 'main', repoOf), null);
    await run('branch', '-q', '--set-upstream-to=origin/main', 'main');
    assert.equal(await pushRepo(dir, 'main', repoOf), 'me/repo');
    // A push remote of its own wins over the upstream's, where git resolves
    // one: under push.default current, not simple, which leaves %(push) empty
    // for a pushRemote though a push would go there -- the lookup's old rule
    // then, not a wrong answer.
    await run('config', 'branch.main.pushRemote', 'upstream');
    assert.equal(await pushRepo(dir, 'main', repoOf), null);
    await run('config', 'push.default', 'current');
    assert.equal(await pushRepo(dir, 'main', repoOf), 'up/repo');
    await run('config', '--unset', 'push.default');
    // Tracking another name: a plain push would not go to `topic` anywhere.
    await run('checkout', '-q', '-b', 'topic', '--track', 'origin/main');
    assert.equal(await pushRepo(dir, 'topic', repoOf), null);
    // A remote off GitHub is not in `repoOf`, and nothing is not a branch.
    assert.equal(await pushRepo(dir, 'main', { origin: 'me/repo' }), null);
    assert.equal(await pushRepo(dir, '', repoOf), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Real `git status --porcelain` output: two leading status columns then the
// path, and the first line has a leading space that a trim would eat.
const STATUS = [
  ' M server.js',
  'M  staged.js',
  'MM both.js',
  ' M FUTURE.md',
].join('\n');

test('the status prefix is sliced, not trimmed, so the first path survives', () => {
  assert.deepEqual(userDirt(STATUS), ['server.js', 'staged.js', 'both.js', 'FUTURE.md']);
});

// FUTURE.md used to be exempt here, because prcoder rewrote it within seconds
// of normal use and counting it left the branch switcher permanently disabled.
// The queue lives in an ignored .prcoder/ now, so prcoder writes nothing
// tracked and an edit to FUTURE.md is the user's work like any other -- it
// should block a checkout, because a checkout would overwrite it.
test('the old queue file is ordinary uncommitted work now', () => {
  assert.deepEqual(userDirt(' M FUTURE.md'), ['FUTURE.md']);
  assert.deepEqual(userDirt(''), []);
});

// ls-remote's argument is a pattern matched against the *tail* of a ref on
// slash boundaries, not a ref name -- so a bare `topic` answers for origin's
// `refs/heads/feature/topic`. Verified against real git, 2026-09-11: reported
// a head for a branch that was never pushed, which told /api/pr/create the
// branch was already on origin and sent the sync light comparing against a
// stranger. Real repos rather than a stub, because the whole bug was a belief
// about what git does with that argument.
test('a branch name that is the tail of another branch is not mistaken for it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-lsremote-'));
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const run = testGit;
  try {
    await git('git', ['init', '-q', '--bare', bare]);
    await git('git', ['init', '-q', work]);
    await run(work, 'commit', '-q', '--allow-empty', '-m', 'x');
    await run(work, 'branch', '-M', 'feature/topic');
    await run(work, 'remote', 'add', 'origin', bare);
    await run(work, 'push', '-q', 'origin', 'feature/topic');

    const pushed = await remoteBranchHead(work, 'feature/topic');
    assert.match(pushed, /^[0-9a-f]{40}$/);
    assert.equal(await remoteBranchHead(work, 'topic'), null);

    // The push also left git's own record of origin's head, which is what the
    // poll reads on a branch with no pull request: the same answer, and the
    // same tail-of-a-ref guard, since `refs/remotes/origin/topic` is its own ref.
    assert.equal(await trackingHead(work, 'feature/topic'), pushed);
    assert.equal(await trackingHead(work, 'topic'), null);

    // An origin that cannot be reached is not an answer about the branch.
    await run(work, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'));
    await assert.rejects(remoteBranchHead(work, 'feature/topic'));

    // The tracking ref needs no origin at all: with it unreachable, one more
    // local commit reads as one unpushed, from git's memory alone.
    await run(work, 'commit', '-q', '--allow-empty', '-m', 'y');
    const snap = await snapshot(work, await trackingHead(work, 'feature/topic'), 'feature/topic');
    assert.equal(snap.sync, 'ahead');
    assert.equal(snap.ahead, 1);
    // Its own read of HEAD, taken with the status: the poll's earlier one can
    // be from before a commit made during the branch lookup.
    assert.equal(snap.head, (await testGit(work, 'rev-parse', 'HEAD')).stdout.trim());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// #93: what a branch with no pull request is built on, from git alone. Against
// a real repo, because the claims are about which commits git names from where.
test('the branches under a branch are found even after the one below took more commits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-below-'));
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const run = testGit;
  // A second apart, in the order they are made: name-rev breaks a tie between
  // branches by the older tip, so commits that share a second -- the usual case
  // in a test, never outside one -- hid that this picked `a`'s sibling.
  let at = 1700000000;
  const commit = (m) => {
    const date = `${at++} +0000`;
    return git('git', [...TEST_CONFIG, 'commit', '-q', '--allow-empty', '-m', m],
      { cwd: work, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  try {
    await git('git', ['init', '-q', '--bare', bare]);
    await git('git', ['init', '-q', '-b', 'main', work]);
    await run(work, 'remote', 'add', 'origin', bare);
    await commit('root');
    await run(work, 'checkout', '-q', '-b', 'a');
    await commit('a1');
    await run(work, 'checkout', '-q', '-b', 'b');
    await commit('b1');
    // `c` is cut from `a` before a2, so it has a1 and would name it as its own.
    await run(work, 'checkout', '-q', '-b', 'c', 'a');
    await commit('c1');
    await run(work, 'checkout', '-q', 'a');
    await commit('a2');
    await run(work, 'push', '-q', 'origin', 'main', 'a', 'b', 'c');

    // The tip of `a` is no ancestor of `b` any more; its a1 still is, and so
    // is `c`'s, at the same distance. Git alone takes `c`, whose tip is older,
    // and finds `a` under it: the two histories are the same shape either way
    // round (the ponytail note on parentBranch). The pull request `c` would
    // have says which way round it is.
    const cOnA = [{ headRefName: 'c', baseRefName: 'a' }];
    assert.deepEqual(await branchesBelow(work, 'b', 'main', { prs: cOnA }), { names: ['a'], toDefault: true });
    assert.deepEqual(await branchesBelow(work, 'b', 'main'), { names: ['c', 'a'], toDefault: true });
    // A pull request's head is where git stops: its base is GitHub's to say.
    assert.deepEqual(await branchesBelow(work, 'b', 'main', { prs: [...cOnA, { headRefName: 'a', baseRefName: 'main' }] }),
      { names: ['a'], toDefault: false });

    // Cut and not pushed: HEAD, sitting exactly on the branch it came from.
    await run(work, 'checkout', '-q', '-b', 'fresh', 'b');
    assert.deepEqual(await branchesBelow(work, 'fresh', 'main', { current: true, prs: cOnA }), { names: ['b', 'a'], toDefault: true });
    assert.deepEqual(await branchesBelow(work, 'main', 'main'), { names: [], toDefault: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The stand-in for a patch GitHub stopped sending, against a real repo because
// the claims are about git's output: that it comes out in GitHub's shape, from
// the merge base rather than the base's tip, and not at all for a binary file,
// a commit this clone lacks, a pathspec the page made up, or a patch whose line
// counts are not the ones GitHub has for the file.
test('a local patch is GitHub-shaped, from the merge base, and null when git cannot say', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-patch-'));
  const run = (...args) => testGit(dir, ...args);
  const oid = async (rev) => (await run('rev-parse', rev)).stdout.trim();
  const write = (name, body) => fs.writeFile(path.join(dir, name), body);
  // GitHub's counts for a one-line change, which is what a.js is throughout.
  const oneLine = { additions: 1, deletions: 1 };
  try {
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await write('a.js', 'one\ntwo\n');
    await run('add', '.');
    await run('commit', '-q', '-m', 'base');
    await run('checkout', '-q', '-b', 'topic');
    await write('a.js', 'one\n2\n');
    await write('new.js', 'x');
    await write('blob.bin', Buffer.from([0, 1, 2, 0]));
    await run('add', '.');
    await run('commit', '-q', '-m', 'topic');
    const head = await oid('HEAD');
    // The base moves on after the branch left it; the pull request still shows
    // only the branch's own change.
    await run('checkout', '-q', 'main');
    await write('a.js', 'zero\none\ntwo\n');
    await run('commit', '-q', '-am', 'later');
    const pr = { baseOid: await oid('main'), baseRef: 'main', baseRemote: 'origin', head };

    assert.equal(await localPatch(dir, { ...pr, ...oneLine, path: 'a.js' }), '@@ -1,2 +1,2 @@\n one\n-two\n+2');
    assert.equal(await localPatch(dir, { ...pr, additions: 1, deletions: 0, path: 'new.js' }),
      '@@ -0,0 +1 @@\n+x\n\\ No newline at end of file');
    assert.equal(await localPatch(dir, { ...pr, additions: 0, deletions: 0, path: 'blob.bin' }), null);
    assert.equal(await localPatch(dir, { ...pr, ...oneLine, path: '*.js' }), null, 'a glob is a name, not a pattern');
    assert.equal(await localPatch(dir, { ...pr, ...oneLine, head: 'f'.repeat(40), path: 'a.js' }), null);
    // A base tip this clone never fetched falls back to its own record of the
    // base branch -- none yet, so nothing to fall back to, and then one.
    const unfetched = { ...pr, ...oneLine, baseOid: 'e'.repeat(40), path: 'a.js' };
    assert.equal(await localPatch(dir, unfetched), null);
    await run('update-ref', 'refs/remotes/origin/main', 'main');
    assert.equal(await localPatch(dir, unfetched), '@@ -1,2 +1,2 @@\n one\n-two\n+2');
    // The record is the pull request's own repository's: a fork's pull request
    // into its parent falls back to upstream's main, never origin's -- the
    // fork's -- and with no remote for that repository, to nothing.
    assert.equal(await localPatch(dir, { ...unfetched, baseRemote: 'upstream' }), null);
    await run('update-ref', 'refs/remotes/upstream/main', 'main');
    assert.equal(await localPatch(dir, { ...unfetched, baseRemote: 'upstream' }), '@@ -1,2 +1,2 @@\n one\n-two\n+2');
    assert.equal(await localPatch(dir, { ...unfetched, baseRemote: null }), null);

    // And the case the counts are for. A branch built on a base commit this
    // clone's record of the base does not have yet: GitHub diffs from that
    // commit and shows c.txt gaining a line, but the fallback's merge base is
    // older, and shows c.txt being added whole. Same file, a different change.
    await write('c.txt', 'c\n');
    await run('add', '.');
    await run('commit', '-q', '-m', 'newer base, not fetched');
    await run('checkout', '-q', '-b', 'rebased');
    await write('c.txt', 'c\nmore\n');
    await run('commit', '-q', '-am', 'on the newer base');
    const stale = { ...unfetched, head: await oid('HEAD'), path: 'c.txt' };
    assert.equal(await localPatch(dir, { ...stale, additions: 1, deletions: 0 }), null);
    assert.equal(await localPatch(dir, { ...stale, additions: 2, deletions: 0 }), '@@ -0,0 +1,2 @@\n+c\n+more',
      'the counts, and nothing else, are what refused it');

    // A rename is one patch between the two paths, the way GitHub sends it.
    await run('checkout', '-q', 'topic');
    await run('mv', 'a.js', 'b.js');
    await run('commit', '-q', '-m', 'rename');
    const renamed = { ...pr, ...oneLine, head: await oid('HEAD'), path: 'b.js', from: 'a.js' };
    assert.equal(await localPatch(dir, renamed), '@@ -1,2 +1,2 @@\n one\n-two\n+2');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Where the branch's pull request is looked for, in the order pickPr prefers:
// gh's base repository, its parent when it is a fork, then each remote's,
// once each -- here `upstream` names the base again and is not listed twice.
// A clone of a fork with only `origin` still gets the parent, which is where
// its pull requests are.
test('repoInfo lists gh\'s base repository, its parent, then the remotes, once each', { skip: unix }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-repoinfo-'));
  const view = () => `cat <<'JSON'\n{"defaultBranchRef":{"name":"main"},"nameWithOwner":"up/repo","parent":{"nameWithOwner":"grand/repo"}}\nJSON`;
  try {
    await git('git', ['init', '-q', dir]);
    await git('git', ['remote', 'add', 'origin', 'git@github.com:me/repo.git'], { cwd: dir });
    await git('git', ['remote', 'add', 'upstream', 'https://github.com/up/repo'], { cwd: dir });
    await git('git', ['remote', 'add', 'mirror', 'git@gitlab.com:me/repo.git'], { cwd: dir });
    // A second name for origin's repository, listed after it: origin keeps it.
    await git('git', ['remote', 'add', 'backup', 'git@github.com:me/repo.git'], { cwd: dir });
    const info = await withGh(view, () => repoInfo(dir));
    assert.deepEqual(info.repos, ['up/repo', 'grand/repo', 'me/repo']);
    assert.deepEqual(info.remotes, { 'me/repo': 'origin', 'up/repo': 'upstream' });
    assert.deepEqual(info.repoOf, { origin: 'me/repo', upstream: 'up/repo', backup: 'me/repo' });
    assert.equal(info.nameWithOwner, 'up/repo');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(info.prefix, '');
    // Not a fork: no parent to add, and gh's base is origin itself.
    const plain = () => `cat <<'JSON'\n{"defaultBranchRef":{"name":"main"},"nameWithOwner":"me/repo","parent":null}\nJSON`;
    await git('git', ['remote', 'remove', 'upstream'], { cwd: dir });
    assert.deepEqual((await withGh(plain, () => repoInfo(dir))).repos, ['me/repo']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// gh on a local branch that has commits the pull request's head lacks: it
// checks the branch out, then its `merge --ff-only` fails -- "Switched to
// branch" and then "Not possible to fast-forward", exit 1, as gh 2.x did on
// 2026-11-06 for TranslatorSRI/babel-validation#76. The branch is checked out,
// so that is a start with a diverged branch, not a failure. A gh that fails
// without switching is still one.
test('a checkout that switched branches and then could not fast-forward is still a checkout', { skip: unix }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-checkout-'));
  const run = (...args) => testGit(dir, ...args);
  const url = 'https://github.com/o/r/pull/76';
  try {
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await run('commit', '-q', '--allow-empty', '-m', 'x');
    await run('branch', 'topic');
    const fails = 'echo "fatal: Not possible to fast-forward, aborting." >&2\nexit 1';
    await withGh(() => `git checkout -q topic\n${fails}`, async () => {
      assert.match((await checkoutPr(dir, url)).unfinished, /fast-forward/);
    });
    assert.equal((await git('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })).stdout.trim(), 'topic');
    await withGh(() => fails, async () => {
      await assert.rejects(checkoutPr(dir, url), /fast-forward/);
    });
    await withGh(() => 'true', async () => assert.deepEqual(await checkoutPr(dir, url), {}));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A merged pull request whose branch GitHub deleted: gh's checkout fetches the
// branch first and fails, and the start makes it from what is left -- a local
// branch of that name, or refs/pull/<n>/head -- but only once the repository
// has said the branch is not there. A bare repo stands in for GitHub, by
// insteadOf, so nothing here reaches the network.
test('a start on a pull request whose branch is gone makes it from refs/pull', { skip: unix }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-gone-'));
  const work = path.join(dir, 'work');
  const hub = path.join(dir, 'hub.git');
  const run = (...args) => testGit(work, ...args);
  const branch = async () => (await git('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: work })).stdout.trim();
  const p = { url: 'https://github.com/o/r/pull/1', number: 1, headRefName: 'topic', isCrossRepository: false };
  const gh = () => `echo "fatal: couldn't find remote ref refs/heads/topic" >&2\nexit 1`;
  try {
    await git('git', ['init', '-q', '--bare', hub]);
    await git('git', ['init', '-q', '-b', 'main', work]);
    await run('config', `url.${hub}.insteadOf`, 'https://github.com/o/r.git');
    await fs.writeFile(path.join(work, 'a.txt'), 'a\n');
    await run('add', 'a.txt');
    await run('commit', '-q', '-m', 'main');
    await run('checkout', '-q', '-b', 'topic');
    await fs.writeFile(path.join(work, 'a.txt'), 'b\n');
    await run('commit', '-q', '-am', 'topic');
    const head = (await run('rev-parse', 'HEAD')).stdout.trim();
    await run('push', '-q', 'https://github.com/o/r.git', 'main', `topic:refs/pull/1/head`);
    await run('checkout', '-q', 'main');
    await run('branch', '-q', '-D', 'topic');
    await withGh(gh, async () => {
      assert.deepEqual(await startOnPr(work, p), { branch: 'topic', said: 'checked out topic for #1; its branch is gone from' +
        " GitHub, so it was made from the pull request's head, tracking nothing" });
      assert.equal((await run('rev-parse', 'HEAD')).stdout.trim(), head);
      // A local branch of the name that has the head is checked out as it is.
      await run('checkout', '-q', 'main');
      assert.deepEqual(await startOnPr(work, p), { branch: 'topic', said: 'checked out topic for #1; its branch is gone from' +
        ' GitHub, so it is as this clone last had it' });
      // One behind it is brought up to it.
      await run('checkout', '-q', 'main');
      await run('branch', '-q', '-f', 'topic', 'main');
      assert.deepEqual(await startOnPr(work, p), { branch: 'topic', said: 'checked out topic for #1; its branch is gone from' +
         " GitHub, so it was brought up to the pull request's head" });
      assert.equal((await run('rev-parse', 'HEAD')).stdout.trim(), head);
      // One with history of its own -- the name reused for other work -- is
      // left alone, and the head is checked out under another name.
      await run('checkout', '-q', 'main');
      await run('branch', '-q', '-D', 'topic');
      await run('checkout', '-q', '--orphan', 'topic');
      await run('commit', '-q', '-m', 'other work');
      const other = (await run('rev-parse', 'HEAD')).stdout.trim();
      await run('checkout', '-q', 'main');
      assert.deepEqual(await startOnPr(work, p), { branch: 'pr-1', said: 'checked out topic for #1; its branch is gone from' +
        " GitHub, and topic here is other work, so it is pr-1, made from the pull request's head, tracking refs/pull/1/head" });
      assert.equal((await run('rev-parse', 'HEAD')).stdout.trim(), head);
      assert.equal((await run('rev-parse', 'topic')).stdout.trim(), other);
      // Marked as gh marks a fork's checkout, so a later run knows pr-1 is #1's
      // without the name: a start on it again is already there, over
      // uncommitted work and with gh failing, and the pane reads it too.
      assert.equal(await trackedPr(work, 'pr-1'), p.url);
      await fs.writeFile(path.join(work, 'a.txt'), 'dirty\n');
      assert.deepEqual(await startOnPr(work, p), { branch: 'pr-1', said: null });
      await run('checkout', '-q', '--', 'a.txt');
      // A pr-1 of someone's own that tracks something else keeps its upstream.
      await run('checkout', '-q', 'main');
      await run('branch', '-q', '-D', 'pr-1');
      await run('branch', '-q', 'pr-1', head);
      await run('config', 'branch.pr-1.remote', 'elsewhere');
      await run('config', 'branch.pr-1.merge', 'refs/heads/mine');
      assert.equal((await startOnPr(work, p)).branch, 'pr-1');
      assert.equal((await run('config', '--get', 'branch.pr-1.merge')).stdout.trim(), 'refs/heads/mine');
      assert.equal(await trackedPr(work, 'pr-1'), null);
      // A branch checked out in another worktree cannot be checked out here,
      // and gh's words come first in the refusal, git's after.
      await run('checkout', '-q', 'main');
      await run('branch', '-q', '-D', 'topic', 'pr-1');
      await run('branch', '-q', 'topic', head);
      await run('worktree', 'add', '-q', path.join(dir, 'elsewhere'), 'topic');
      await assert.rejects(startOnPr(work, p), (e) => /^fatal: couldn't find remote ref refs\/heads\/topic\nIts branch is gone from GitHub, and checking out what is left failed too: .*topic/s.test(e.message));
      assert.equal(await branch(), 'main');
      await run('worktree', 'remove', '--force', path.join(dir, 'elsewhere'));
      // A branch still there is gh's failure to report, not a gone one.
      await run('checkout', '-q', 'main');
      await run('push', '-q', 'https://github.com/o/r.git', 'topic');
      await assert.rejects(startOnPr(work, p), /couldn't find remote ref/);
      assert.equal(await branch(), 'main');
      // As is a repository that cannot be asked.
      await run('config', `url.${path.join(dir, 'nowhere.git')}.insteadOf`, 'https://github.com/o/r.git');
      await run('config', '--unset', `url.${hub}.insteadOf`);
      await assert.rejects(startOnPr(work, p), /couldn't find remote ref/);
      // And a fork's, whose head gh fetches from refs/pull already.
      await assert.rejects(startOnPr(work, { ...p, isCrossRepository: true }), /couldn't find remote ref/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The start's one way onto a pull request (`prcoder <pr>`, a `choose` pick):
// nothing to do on its branch, a refusal over uncommitted work, since the pane
// shows only the checked-out branch's pull request, and a checkout otherwise.
test('a start is on the pull request\'s branch, or refused over uncommitted work', { skip: unix }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-start-'));
  const run = (...args) => testGit(dir, ...args);
  const branch = async () => (await git('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })).stdout.trim();
  const p = { url: 'https://github.com/o/r/pull/76', number: 76, headRefName: 'topic', isCrossRepository: false };
  try {
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    await run('add', 'a.txt');
    await run('commit', '-q', '-m', 'x');
    await run('branch', 'topic');
    // gh would fail the test if it were asked anything here.
    await withGh(() => 'exit 9', async () => {
      assert.deepEqual(await startOnPr(dir, { ...p, headRefName: 'main' }), { branch: 'main', said: null });
      await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
      await assert.rejects(startOnPr(dir, p),
        { message: '#76 is on topic, and 1 uncommitted file on main is in the way; commit or stash it first' });
    });
    assert.equal(await branch(), 'main');
    await run('checkout', '-q', '--', 'a.txt');
    // Another prcoder running here refuses the checkout, which would move its
    // agent's working copy, and is asked only when there is one to make.
    let asked = 0;
    const inUse = async () => (asked++, 'another prcoder is running in this directory');
    await withGh(() => 'exit 9', async () => {
      assert.deepEqual(await startOnPr(dir, { ...p, headRefName: 'main' }, { inUse }), { branch: 'main', said: null });
      assert.equal(asked, 0);
      await assert.rejects(startOnPr(dir, p, { inUse }), { message: '#76 is on topic, and another prcoder is running in' +
        ' this directory; a checkout would move the working copy under its agent. Quit that one first, or start this one in a worktree on topic' });
      assert.equal(asked, 1);
    });
    assert.equal(await branch(), 'main');
    await withGh(() => 'git checkout -q topic', async () => {
      assert.deepEqual(await startOnPr(dir, p), { branch: 'topic', said: 'checked out topic for #76' });
    });
    assert.equal(await branch(), 'topic');
    // A fork's pull request on the branch gh checked it out to, whatever that
    // is called: gh says so, and there is nothing to check out or refuse.
    const fork = { url: 'https://github.com/o/r/pull/80', number: 80, headRefName: 'main', isCrossRepository: true };
    await fs.writeFile(path.join(dir, 'a.txt'), 'changed again\n');
    await withGh(() => `echo '{"url":"${fork.url}"}'`, async () =>
      assert.deepEqual(await startOnPr(dir, fork), { branch: 'topic', said: null }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The pull request a branch's config says it was checked out for: gh's mark
// on a fork's checkout, and checkoutGone's on a pr-<n>. Only refs/pull/<n>/head
// is one; the remote is a remote's name or the repository's URL, and the
// repository is spelled as `repos` spells it.
test('a branch tracking refs/pull/<n>/head is that pull request\'s', { skip: unix }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-tracked-'));
  const run = (...args) => testGit(dir, ...args);
  try {
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await run('remote', 'add', 'upstream', 'git@github.com:Owner/Repo.git');
    assert.equal(await trackedPr(dir, 'main'), null);
    await run('config', 'branch.someone/main.remote', 'upstream');
    await run('config', 'branch.someone/main.merge', 'refs/pull/80/head');
    assert.equal(await trackedPr(dir, 'someone/main'), 'https://github.com/Owner/Repo/pull/80');
    assert.equal(await trackedPr(dir, 'someone/main', ['owner/repo']), 'https://github.com/owner/repo/pull/80');
    await run('config', 'branch.someone/main.remote', 'https://github.com/o/r.git');
    assert.equal(await trackedPr(dir, 'someone/main'), 'https://github.com/o/r/pull/80');
    // A branch's own upstream, or a remote off GitHub, names no pull request.
    await run('config', 'branch.someone/main.merge', 'refs/heads/main');
    assert.equal(await trackedPr(dir, 'someone/main'), null);
    await run('config', 'branch.someone/main.merge', 'refs/pull/80/head');
    await run('config', 'branch.someone/main.remote', 'https://example.com/o/r.git');
    assert.equal(await trackedPr(dir, 'someone/main'), null);
    assert.equal(await trackedPr(dir, ''), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// gh's answer for the branch it checked a fork's pull request out to: that
// pull request, whatever the branch is called. No git here, only the gh stub.
test('a fork\'s pull request is here when gh says it is the branch\'s', { skip: unix }, async () => {
  const fork = { url: 'https://github.com/o/r/pull/200', number: 200, headRefName: 'main', isCrossRepository: true };
  await withGh(() => `echo '{"url":"${fork.url}"}'`, async () => {
    assert.equal(await isHere('.', fork, 'someone/main'), true);
    assert.equal(await isHere('.', { ...fork, url: 'https://github.com/o/r/pull/201' }, 'someone/main'), false);
    // Not gh's question on a detached HEAD.
    assert.equal(await isHere('.', fork, null), false);
  });
  await withGh(() => `echo 'error connecting to api.github.com' >&2\nexit 1`, async () =>
    assert.equal(await isHere('.', fork, 'someone/main'), false));
});
