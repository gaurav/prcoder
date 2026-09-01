import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle } from '../public/pr.js';

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
    'ggvaidya/prcoder#12 · Name the tab after the pull request');
});

test('the short URL comes from the pull request, not the checkout', () => {
  const forked = pr({ url: 'https://github.com/someone/prcoder/pull/3', number: 3 });
  assert.match(pageTitle(status({ pr: forked, scope: 'other-repo' })), /^someone\/prcoder#3 /);
});

test('a long pull request title is cut to a tab-sized name', () => {
  const long = pr({ title: 'Fetch each file’s patch from GitHub and serve it from POST /api/diff, with a cache' });
  const title = pageTitle(status({ pr: long }));
  assert.ok(title.length <= 72, `${title.length} chars: ${title}`);
  assert.ok(title.startsWith('ggvaidya/prcoder#12 · Fetch each file'));
  assert.ok(title.endsWith('…'));
});

test('with no pull request the branch names the tab', () => {
  assert.equal(pageTitle(status()), 'ggvaidya/prcoder · initial-implementation (no PR)');
  assert.equal(pageTitle(status({ detached: true, branch: '' })),
    'ggvaidya/prcoder · detached HEAD (no PR)');
});

test('a first load that failed has nothing to name the tab with', () => {
  assert.equal(pageTitle({ error: 'gh: not logged in' }), 'prcoder');
  assert.equal(pageTitle(null), 'prcoder');
});
