import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { openRepoArgs, OPEN_REPO_VARS, REPO_ENV, parseCli, usage, AGENTS, VERSION, portFor, portCandidates, PORT_BASE, PORT_SPAN, statusLines, ago, queueSummary, quitRisks } from '../cli.js';
import { queueChanges } from '../queue.js';

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
  assert.equal(parseCli(['--queue', 'data/q.json']).queue, 'data/q.json');
  assert.equal(parseCli([]).queue, undefined);
  assert.equal(parseCli(['-h']).help, true);
  assert.equal(parseCli(['--version']).version, true);
  assert.equal(parseCli(['-V']).version, true);
});

test('bad input is an error that names the problem', () => {
  assert.throws(() => parseCli(['--port']), /argument missing/);
  assert.throws(() => parseCli(['--port', 'abc']), /--port/);
  assert.throws(() => parseCli(['--agent', 'gpt']), /supported: claude/);
  assert.throws(() => parseCli(['123', '456']), /456/);
  assert.throws(() => parseCli(['--queue', '']), /--queue wants a file path/);
});

// --help is meant to replace reading the README, so every flag and every
// environment variable has to be in it.
test('the help names every flag, env var and agent', () => {
  const text = usage();
  for (const s of ['--port', '--no-open', '--verbose', '--agent', '--help', '--version', '-- ',
    '--queue', 'PRCODER_QUEUE', 'PRCODER_PORT', 'PRCODER_NO_OPEN', 'PRCODER_VERBOSE', 'PRCODER_BROWSER', 'PRCODER_AGENT_BIN', ...AGENTS,
    ...Object.values(OPEN_REPO_VARS)]) {
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
  // Every key the terminal answers to is in the legend, or it does not exist.
  assert.match(out, /^keys +q quit · r refresh · v verbose$/m);
  assert.match(out, /^open +o prcoder · g github · t terminal · f folder$/m);
  // ...and on rows that fit an 80-column window, which the serving row did not.
  assert.ok(out.split('\n').every((l) => !/^(keys|open) /.test(l) || l.length < 80));
});

// The table behind t and f. A null is the "not implemented here" message, so
// a platform must be null rather than a guess at a command it does not have.
test('t and f know the platform\'s commands, and say so when they have none', () => {
  assert.deepEqual(openRepoArgs('terminal', 'darwin', '/r'), ['open', '-a', 'Terminal', '/r']);
  assert.deepEqual(openRepoArgs('folder', 'darwin', '/r'), ['open', '/r']);
  assert.deepEqual(openRepoArgs('folder', 'win32', '/r'), ['explorer', '/r']);
  assert.deepEqual(openRepoArgs('folder', 'linux', '/r'), ['xdg-open', '/r']);
  assert.equal(openRepoArgs('folder', 'sunos', '/r'), null, 'not every unix is Linux');
  assert.equal(openRepoArgs('terminal', 'linux', '/r'), null);
  assert.equal(openRepoArgs('terminal', 'win32', '/r'), null);
});

// PRCODER_TERMINAL and PRCODER_FILE_MANAGER run through the shell, so the path
// reaches it as a variable, not as text: a space must not split it, a quote
// must not end it, and on Windows a %NAME% in it must not expand.
test('an override for t or f is run with the repo appended, as a variable the shell expands once', () => {
  assert.equal(openRepoArgs('terminal', 'linux', "/a b/it's", 'kitty --directory'), 'kitty --directory "$PRCODER_REPO"');
  assert.equal(openRepoArgs('terminal', 'win32', 'C:\\a %TEMP%', 'wt -d'), 'wt -d "%PRCODER_REPO%"');
  assert.equal(openRepoArgs('folder', 'sunos', '/r', 'nautilus'), 'nautilus "$PRCODER_REPO"', 'even where f has no built-in');
  assert.deepEqual(OPEN_REPO_VARS, { terminal: 'PRCODER_TERMINAL', folder: 'PRCODER_FILE_MANAGER' });
  assert.equal(REPO_ENV, 'PRCODER_REPO');
});

// What the string above relies on, against the real sh: a path that its own
// quoting would have to get right arrives whole.
test('sh hands an override the repo path whole, whatever is in it', () => {
  const dir = "/a b/it's $HOME `x` \\ %TEMP%";
  const cmd = openRepoArgs('folder', 'linux', dir, `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.argv[1])'`);
  assert.equal(execSync(cmd, { env: { ...process.env, [REPO_ENV]: dir } }).toString(), dir);
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

  const bad = await run('42', '--effort', 'high');
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^prcoder: unknown option --effort; flags for the agent go after --/);
  assert.match(bad.stderr, /\nusage: prcoder /);

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
  assert.equal(queueSummary([{ text: 'one' }], '/work/q.json')[0], 'queue    1 item on Local, in /work/q.json:');
});

// Shift-Enter puts newlines in an item, and an unindented second line would
// read as an item of its own.
test('a multi-line item on Local is indented as one item', () => {
  const [, item] = queueSummary([{ text: 'fix login\nalso check logout', issueUrl: 'https://x/1' }]);
  assert.equal(item, '           fix login\n           also check logout  https://x/1');
});

// The y/N is for what quitting costs, and says what `y` does to a session.
test('the quit question names only what quitting costs', () => {
  assert.deepEqual(quitRisks({}), []);
  assert.deepEqual(quitRisks({ tabs: 1, ahead: 2 }), ['1 browser tab — its Claude session ends', '2 unpushed commits']);
  assert.deepEqual(quitRisks({ tabs: 2, dirty: 1 }), ['2 browser tabs — their Claude sessions end', '1 uncommitted file']);
});
