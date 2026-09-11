import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCli, usage, AGENTS, VERSION } from '../cli.js';
import { portFor, portCandidates, PORT_BASE, PORT_SPAN, statusLines, queueChanges, ago } from '../server.js';

test('a leading positional is our PR target, everything after -- is the agent\'s', () => {
  const none = parseCli([]);
  assert.equal(none.target, undefined);
  assert.deepEqual(none.agentArgs, []);
  assert.equal(none.agent, 'claude');
  assert.equal(none.verbose, 0);
  assert.equal(parseCli(['123']).target, '123');
  const both = parseCli(['123', '--', '--model', 'opus']);
  assert.equal(both.target, '123');
  assert.deepEqual(both.agentArgs, ['--model', 'opus']);
  assert.deepEqual(parseCli(['42', '--']).agentArgs, []);
  assert.deepEqual(parseCli(['--', '-r']).agentArgs, ['-r']);
  // Only the first -- is ours; a second one is the agent's to interpret.
  assert.deepEqual(parseCli(['--', 'a', '--', 'b']).agentArgs, ['a', '--', 'b']);
});

// The one that matters: a flag's value must not be mistaken for a PR target.
test('flag values are never read as a PR target', () => {
  const agent = parseCli(['--', '--effort', 'high', '--model', 'opus']);
  assert.equal(agent.target, undefined);
  assert.deepEqual(agent.agentArgs, ['--effort', 'high', '--model', 'opus']);
  const ours = parseCli(['--port', '4000', '--agent', 'claude', '--', '--effort', 'high']);
  assert.equal(ours.target, undefined);
  assert.equal(ours.port, 4000);
  assert.deepEqual(ours.agentArgs, ['--effort', 'high']);
  // An agent flag before -- is refused rather than guessed at, and the
  // message says where it goes.
  assert.throws(() => parseCli(['--effort', 'high']), /after --/);
  assert.throws(() => parseCli(['42', '--effort', 'high']), /after --/);
  assert.throws(() => parseCli(['-r']), /after --/);
});

test('prcoder\'s own flags', () => {
  assert.equal(parseCli(['-v']).verbose, 1);
  assert.equal(parseCli(['-vv']).verbose, 2);
  assert.equal(parseCli(['--verbose', '--verbose']).verbose, 2);
  assert.equal(parseCli(['--no-open']).noOpen, true);
  assert.equal(parseCli(['-h']).help, true);
  assert.equal(parseCli(['--version']).version, true);
  assert.equal(parseCli(['-V']).version, true);
});

test('bad input is an error that names the problem', () => {
  assert.throws(() => parseCli(['--port']), /argument missing/);
  assert.throws(() => parseCli(['--port', 'abc']), /--port/);
  assert.throws(() => parseCli(['--agent', 'gpt']), /supported: claude/);
  assert.throws(() => parseCli(['123', '456']), /456/);
});

// --help is meant to replace reading the README, so every flag and every
// environment variable has to be in it.
test('the help names every flag, env var and agent', () => {
  const text = usage();
  for (const s of ['--port', '--no-open', '--verbose', '--agent', '--help', '--version', '-- ',
    'PRCODER_PORT', 'PRCODER_NO_OPEN', 'PRCODER_VERBOSE', 'PRCODER_OPEN', 'CLAUDE_BIN', ...AGENTS]) {
    assert.ok(text.includes(s), `help mentions ${s}`);
  }
  assert.equal(VERSION, createRequire(import.meta.url)('../package.json').version);
});

// The URL has to be the same every run for a bookmark, a Dock app or an IDE
// pane to point at it; and two repos on one machine must not share it.
test('the port is a fixed function of the repo path', () => {
  const a = portFor('/Users/x/code/prcoder', {});
  assert.equal(a, portFor('/Users/x/code/prcoder', {}));
  assert.ok(a >= PORT_BASE && a < PORT_BASE + PORT_SPAN, `${a} out of range`);
  assert.notEqual(a, portFor('/Users/x/code/other', {}));
  assert.equal(portFor('/anything', { PRCODER_PORT: '4000' }), 4000);
});

// The one that made this range move. Browsers refuse a list of well-known
// ports outright -- Firefox with "This address is restricted" and nothing that
// names prcoder -- and the old 1618-2617 range contained four of them. 10080 is
// the highest entry in the list, so the whole class is gone if nothing derives
// below it. A path is not a bookmark: this has to hold for any of them.
test('no derived port is one a browser refuses to load', () => {
  for (let i = 0; i < 5000; i++) {
    const p = portFor(`/Users/x/code/repo-${i}`, {});
    assert.ok(p > 10080, `${p} is in the browsers' blocked range`);
  }
});

// A first run walks these until one binds. Wrapping rather than climbing keeps
// every candidate inside the range checked above.
test('the candidates are the whole range, starting at the seed', () => {
  const seed = portFor('/Users/x/code/prcoder', {});
  const c = portCandidates('/Users/x/code/prcoder');
  assert.equal(c[0], seed);
  assert.equal(c.length, PORT_SPAN);
  assert.equal(new Set(c).size, PORT_SPAN, 'a candidate is offered twice');
  assert.ok(c.every((p) => p >= PORT_BASE && p < PORT_BASE + PORT_SPAN));

  // A pinned port is not a seed to walk from -- it is the whole answer, and
  // resolvePort never gets here with one set. Below the range it would also
  // start the walk at a negative offset.
  process.env.PRCODER_PORT = '4000';
  try { assert.deepEqual(portCandidates('/Users/x/code/prcoder'), c); }
  finally { delete process.env.PRCODER_PORT; }
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

// The entry point itself, for the paths that exit before a server starts:
// help and version on stdout with exit 0, a parse error on stderr with exit 2
// and the synopsis under it. Cheap, because none of them get as far as
// term.init() or a port.
test('prcoder --help, --version and a bad flag exit before anything starts', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = (...args) => promisify(execFile)('node', ['server.js', ...args], { cwd: new URL('..', import.meta.url) })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.equal(help.stdout.trim(), usage());

  const version = await run('-V');
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);

  const bad = await run('42', '--effort', 'high');
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^prcoder: unknown option --effort; flags for the agent go after --/);
  assert.match(bad.stderr, /\nusage: prcoder /);
});
