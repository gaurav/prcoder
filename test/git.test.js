import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncState, compareUrl, prScope, userDirt } from '../git.js';

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
