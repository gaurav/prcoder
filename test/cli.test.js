import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCli, usage, AGENTS, VERSION, portFor, portCandidates, PORT_BASE, PORT_SPAN, statusLines, ago, queueSummary, quitRisks } from '../cli.js';
import { queueChanges } from '../queue.js';

test('the PR target follows a command, everything after -- is the agent\'s', () => {
  const none = parseCli([]);
  assert.equal(none.command, 'open');
  assert.equal(none.target, undefined);
  assert.deepEqual(none.agentArgs, []);
  assert.equal(none.agent, 'claude');
  assert.equal(none.verbose, 0);
  assert.equal(parseCli(['open', '123']).target, '123');
  assert.deepEqual([parseCli(['new', 'main']).command, parseCli(['new', 'main']).target], ['new', 'main']);
  const both = parseCli(['open', '123', '--', '--model', 'opus']);
  assert.equal(both.target, '123');
  assert.deepEqual(both.agentArgs, ['--model', 'opus']);
  assert.deepEqual(parseCli(['open', '42', '--']).agentArgs, []);
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
  assert.throws(() => parseCli(['open', '42', '--effort', 'high']), /after --/);
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
  assert.throws(() => parseCli(['open', '123', '456']), /456/);
});

// The PR used to come first. A branch is a valid target, so a word there that
// is not a command is the old form, and the error says what it is now -- not a
// guess at whether `prcoder open` meant a branch called open.
test('a PR where the command goes is an error that shows the new form', () => {
  assert.throws(() => parseCli(['123']), /unknown command 123; to open a pull request: prcoder open 123/);
  assert.throws(() => parseCli(['constructor']), /unknown command constructor/);
});

// --help is meant to replace reading the README, so every flag and every
// environment variable has to be in it.
test('the help names every flag, env var and agent', () => {
  const text = usage();
  for (const s of ['--port', '--no-open', '--verbose', '--agent', '--help', '--version', '-- ',
    'PRCODER_PORT', 'PRCODER_NO_OPEN', 'PRCODER_VERBOSE', 'PRCODER_OPEN', 'PRCODER_AGENT_BIN', ...AGENTS]) {
    assert.ok(text.includes(s), `help mentions ${s}`);
  }
  assert.equal(VERSION, createRequire(import.meta.url)('../package.json').version);
});

// The URL has to be the same every run for a bookmark, a Dock app or an IDE
// pane to point at it; and two repos on one machine must not share it.
test('the port is a fixed function of the repo path', () => {
  const a = portFor('/Users/x/code/prcoder');
  assert.equal(a, portFor('/Users/x/code/prcoder'));
  assert.ok(a >= PORT_BASE && a < PORT_BASE + PORT_SPAN, `${a} out of range`);
  assert.notEqual(a, portFor('/Users/x/code/other'));
});

// The one that made this range move. Browsers refuse a list of well-known
// ports outright -- Firefox with "This address is restricted" and nothing that
// names prcoder -- and the old 1618-2617 range contained four of them. 10080 is
// the highest entry in the list, so the whole class is gone if nothing derives
// below it. A path is not a bookmark: this has to hold for any of them.
test('no derived port is one a browser refuses to load', () => {
  for (let i = 0; i < 5000; i++) {
    const p = portFor(`/Users/x/code/repo-${i}`);
    assert.ok(p > 10080, `${p} is in the browsers' blocked range`);
  }
});

// A first run walks these until one binds. Wrapping rather than climbing keeps
// every candidate inside the range checked above.
test('the candidates are the whole range, starting at the seed', () => {
  const seed = portFor('/Users/x/code/prcoder');
  const c = portCandidates('/Users/x/code/prcoder');
  assert.equal(c[0], seed);
  assert.equal(c.length, PORT_SPAN);
  assert.equal(new Set(c).size, PORT_SPAN, 'a candidate is offered twice');
  assert.ok(c.every((p) => p >= PORT_BASE && p < PORT_BASE + PORT_SPAN));

  // A pinned port is not a seed to walk from -- it is the whole answer, and
  // listenOnRepoPort never gets here with one set. Below the range it would also
  // start the walk at a negative offset.
  process.env.PRCODER_PORT = '4000';
  try { assert.deepEqual(portCandidates('/Users/x/code/prcoder'), c); }
  finally { delete process.env.PRCODER_PORT; }
});

// The block under the log. Pure, so the wording is checked without a terminal.
const STATUS = {
  nameWithOwner: 'gaurav/prcoder', defaultBranch: 'main', branch: 'initial-implementation',
  sync: 'ahead', ahead: 2, dirtyFiles: ['a.js', 'b.js'], scope: 'current',
  pr: { number: 1, title: 'Drag the panes', url: 'https://github.com/gaurav/prcoder/pull/1', baseRefName: 'main' },
  queue: [{ text: 'a', issue: 4 }, { text: 'b', done: true }, { text: 'c', deleted: true },
    { text: 'd' }],
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
  // The pane's tabs, counted with the pane's own predicates: 'a' links an issue
  // and is still yours to do, 'c' is a tombstone and counts as nothing.
  assert.match(out, /2 local · 1 done/);
});

test('with no PR there is no PR line to print', () => {
  const out = block({ pr: null, scope: 'none', queue: [] });
  assert.match(out, /none for this branch/);
  assert.doesNotMatch(out, /github\.com/);
});

// What the verbose log says happened. Every branch, because the whole value of
// the line is that it names the right change.
test('each way an item can change gets its own line', () => {
  const was = [{ text: 'a' }, { text: 'b', done: true }, { text: 'c' }];
  const one = (now) => queueChanges(was, now);

  assert.deepEqual(one([...was, { text: 'd' }]), ["queued 'd'"]);
  assert.deepEqual(one([{ text: 'a', done: true }, was[1], was[2]]), ["ticked 'a'"]);
  assert.deepEqual(one([was[0], { text: 'b' }, was[2]]), ["unticked 'b'"]);
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

// The label column padded, not cut. Sliced to eight, `PR #10000` printed as
// `PR #1000` -- a wrong number that looks like a right one, in the block the
// terminal stares at all session.
test('a PR number too wide for the label column widens the row, it does not lose a digit', () => {
  assert.match(block({ pr: { ...STATUS.pr, number: 10000 } }), /PR #10000\b/);
  assert.doesNotMatch(block({ pr: { ...STATUS.pr, number: 10000 } }), /PR #1000\s/);
});

// The entry point itself, for the paths that exit before a server starts:
// help and version on stdout with exit 0, a parse error on stderr with exit 2
// and the synopsis under it. Cheap, because none of them get as far as
// term.init() or a port.
test('prcoder --help, --version and a bad flag exit before anything starts', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  // The timeout is for a run that does not exit: one that got past the checks
  // is a listening server, and would otherwise hang the suite rather than fail.
  const runIn = (env, ...args) => promisify(execFile)('node', ['server.js', ...args],
    { cwd: new URL('..', import.meta.url), env, timeout: 15_000 })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const run = (...args) => runIn(process.env, ...args);

  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.equal(help.stdout.trim(), usage());

  const version = await run('-V');
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);

  const bad = await run('open', '42', '--effort', 'high');
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^prcoder: unknown option --effort; flags for the agent go after --/);
  assert.match(bad.stderr, /\nusage: prcoder /);

  const old = await run('42');
  assert.equal(old.code, 2);
  assert.match(old.stderr, /prcoder open 42/);

  // The old name is refused, not ignored: ignored, it would start the real agent.
  // Refused before the server starts, so this exits rather than listening.
  const env = { ...process.env, CLAUDE_BIN: '/bin/cat' };
  delete env.PRCODER_AGENT_BIN;
  const stale = await runIn(env, '--no-open');
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /^prcoder: CLAUDE_BIN is now PRCODER_AGENT_BIN/);
});

// Quitting prints Local rather than asking about it: the queue is on disk, so
// nothing is lost, and the list is what you would want to copy from.
test('quitting lists what is on Local, with links, and nothing when it is empty', () => {
  assert.deepEqual(queueSummary([]), []);
  assert.deepEqual(queueSummary([{ text: 'done', done: true }]), []);
  const lines = queueSummary([
    { text: 'Fix the flaky test', issue: 91, issueUrl: 'https://github.com/o/r/issues/91' },
    { text: 'ticked', done: true }, { text: 'gone', deleted: true }, { text: 'plain' },
  ]);
  assert.equal(lines[0], 'queue    2 items on Local, in .prcoder/queue.json (and 1 completed, 1 deleted):');
  assert.deepEqual(lines.slice(1).map((l) => l.trim()),
    ['Fix the flaky test  https://github.com/o/r/issues/91', 'plain']);
  assert.equal(queueSummary([{ text: 'one' }])[0], 'queue    1 item on Local, in .prcoder/queue.json:');
});

// The y/N is for what quitting costs, and says what `y` does to a session.
test('the quit question names only what quitting costs', () => {
  assert.deepEqual(quitRisks({}), []);
  assert.deepEqual(quitRisks({ tabs: 1, ahead: 2 }), ['1 browser tab — its Claude session ends', '2 unpushed commits']);
  assert.deepEqual(quitRisks({ tabs: 2, dirty: 1 }), ['2 browser tabs — their Claude sessions end', '1 uncommitted file']);
});
