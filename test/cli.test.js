import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, portFor, statusLines, queueChanges, ago } from '../server.js';

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

// What the verbose log says happened. Every branch, because the whole value of
// the line is that it names the right change.
test('each way an item can change gets its own line', () => {
  const was = [{ text: 'a' }, { text: 'b', done: true }, { text: 'c', inPr: true }];
  const one = (now) => queueChanges(was, now);

  assert.deepEqual(one([...was, { text: 'd' }]), ["queued 'd'"]);
  assert.deepEqual(one([{ text: 'a', done: true }, was[1], was[2]]), ["ticked 'a'"]);
  assert.deepEqual(one([was[0], { text: 'b' }, was[2]]), ["unticked 'b'"]);
  assert.deepEqual(one([was[0], was[1], { text: 'c' }]),
    ["removed 'c' from the PR description"]);
  assert.deepEqual(one([{ text: 'a', deleted: true }, was[1], was[2]]), ["deleted 'a'"]);
  assert.deepEqual(one([was[1], was[2]]), ["dropped 'a'"]);
  assert.deepEqual(one(was), []);
});

// Text is the only identity an item has, so an edit cannot read as an edit --
// and saying so out loud is better than a line that quietly names the wrong item.
test('editing an item reads as a drop and a queue, not an edit', () => {
  assert.deepEqual(queueChanges([{ text: 'old' }], [{ text: 'new' }]),
    ["queued 'new'", "dropped 'old'"]);
});

// A reorder is not a change worth a line; it would fire on every drag.
test('reordering says nothing', () => {
  const items = [{ text: 'a' }, { text: 'b' }];
  assert.deepEqual(queueChanges(items, [items[1], items[0]]), []);
});

// The block is only as true as the last poll, and the browser stops polling the
// moment its tab is hidden — so an age that never appears is a block that lies.
test('the block says how old it is, once that is worth saying', () => {
  assert.equal(ago(0), null);
  assert.equal(ago(119_000), null, 'a 60s poll must not label itself stale');
  assert.equal(ago(180_000), 'checked 3m ago');
  assert.equal(ago(3_600_000), 'checked 1h ago');
  // undefined is what a caller with no timestamp yet passes; it is not "old".
  assert.equal(ago(undefined), null);

  assert.match(statusLines(STATUS, { local: 'x', tabs: 1, age: 600_000 }).join('\n'),
    /1 tab   checked 10m ago/);
  assert.doesNotMatch(statusLines(STATUS, { local: 'x', tabs: 1, age: 0 }).join('\n'), /checked/);
});
