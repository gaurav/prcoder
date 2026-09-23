import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncState, compareUrl, prScope, userDirt, remoteBranchHead, trackingHead, snapshot, localPatch } from '../git.js';

// The four inputs come from `git rev-parse --verify` and `git merge-base
// --is-ancestor`; the exit codes those return are checked in git.js, not here.
const state = (o) => syncState({ head: 'aaa', remoteHead: 'bbb', remoteKnownLocally: true, remoteIsAncestor: true, ...o });

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

const here = { branch: 'feature', nameWithOwner: 'gaurav/prcoder' };
const pr = (url, headRefName) => ({ url, headRefName });

test('no PR at all is its own scope, not a mismatch', () => {
  assert.equal(prScope(null, here), 'none');
});

test('the PR for the checked-out branch is current', () => {
  assert.equal(prScope(pr('https://github.com/gaurav/prcoder/pull/1', 'feature'), here), 'current');
});

test('same repo, another branch — checking it out would fix it', () => {
  assert.equal(prScope(pr('https://github.com/gaurav/prcoder/pull/2', 'other'), here), 'other-branch');
});

// `prcoder <url>` can open a PR that has nothing to do with this checkout, and
// its head commit will never be in our object store — so the sync light has to
// be suppressed rather than left reporting a permanent "behind".
test('a PR in a different repo is other-repo even when the branch name matches', () => {
  assert.equal(prScope(pr('https://github.com/someone/else/pull/9', 'feature'), here), 'other-repo');
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
  const git = promisify(execFile);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-lsremote-'));
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  // The identity goes on the command, not into a config: a CI runner has none
  // set, and `git commit` there is a hard failure rather than a warning. Signing
  // is turned off the same way: a machine that signs every commit hands this
  // throwaway repo's commit to its signer, and a locked 1Password agent failed
  // the test after a minute's wait with nothing to do with ls-remote.
  const run = (cwd, ...args) => git('git', [
    '-c', 'user.name=prcoder tests', '-c', 'user.email=tests@prcoder.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd });
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
  const git = promisify(execFile);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-patch-'));
  const run = (...args) => git('git', [
    '-c', 'user.name=prcoder tests', '-c', 'user.email=tests@prcoder.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: dir });
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
    const pr = { baseOid: await oid('main'), baseRef: 'main', head };

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
