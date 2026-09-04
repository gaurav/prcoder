import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, portFor, statusLines } from '../server.js';

test('a leading positional is our PR target, the rest is Claude\'s', () => {
  assert.deepEqual(splitArgs([]), { target: undefined, claudeArgs: [] });
  assert.deepEqual(splitArgs(['123']), { target: '123', claudeArgs: [] });
  assert.deepEqual(splitArgs(['123', '--model', 'opus']), { target: '123', claudeArgs: ['--model', 'opus'] });
});

// The one that matters: a flag's value must not be mistaken for a PR target.
test('flag values are never read as a PR target', () => {
  assert.deepEqual(splitArgs(['--effort', 'high', '--model', 'opus']),
    { target: undefined, claudeArgs: ['--effort', 'high', '--model', 'opus'] });
  assert.deepEqual(splitArgs(['-r']), { target: undefined, claudeArgs: ['-r'] });
});

// The URL has to be the same every run for a bookmark, a Dock app or an IDE
// pane to point at it; and two repos on one machine must not share it.
test('the port is a fixed function of the repo path', () => {
  const a = portFor('/Users/x/code/prcoder', {});
  assert.equal(a, portFor('/Users/x/code/prcoder', {}));
  assert.ok(a >= 1618 && a < 2618, `${a} out of range`);
  assert.notEqual(a, portFor('/Users/x/code/other', {}));
  assert.equal(portFor('/anything', { PRCODER_PORT: '4000' }), 4000);
});

// The block under the log. Pure, so the wording is checked without a terminal.
const STATUS = {
  nameWithOwner: 'gaurav/prcoder', defaultBranch: 'main', branch: 'initial-implementation',
  sync: 'ahead', ahead: 2, dirtyFiles: ['a.js', 'b.js'], scope: 'current', mirrorFailed: false,
  pr: { number: 1, title: 'Drag the panes', url: 'https://github.com/gaurav/prcoder/pull/1', baseRefName: 'main' },
  queue: [{ text: 'a', inPr: true }, { text: 'b', done: true }, { text: 'c', deleted: true }],
};
const block = (over = {}) =>
  statusLines({ ...STATUS, ...over }, { local: 'http://localhost:1618' }).join('\n');

test('the block says where the branch, the PR and the queue stand', () => {
  const out = block();
  assert.match(out, /initial-implementation → main/);
  // The same words as the pane's sync light, which is the point of duplicating them.
  assert.match(out, /2 unpushed/);
  assert.match(out, /2 uncommitted/);
  // The PR's URL, which the CLI never used to print at all.
  assert.match(out, /https:\/\/github\.com\/gaurav\/prcoder\/pull\/1/);
  // Tombstoned items count as neither active nor done.
  assert.match(out, /1 active · 1 done · 1 in the PR · 0 issues/);
  assert.match(out, /queue mirrored/);
});

// The state the light exists for: the store took the change and GitHub did not.
test('a failed mirror is the loudest thing in the block', () => {
  assert.match(block({ mirrorFailed: true }), /PR description behind/);
  assert.doesNotMatch(block({ mirrorFailed: true }), /queue mirrored/);
});

test('with no PR there is no PR line to print', () => {
  const out = block({ pr: null, scope: 'none', queue: [] });
  assert.match(out, /none for this branch/);
  assert.doesNotMatch(out, /github\.com/);
});
