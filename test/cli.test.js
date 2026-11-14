import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { openRepoArgs, OPEN_REPO_VARS, REPO_ENV, parseCli, usage, AGENTS, VERSION, portFor, portCandidates, PORT_BASE, PORT_SPAN, statusLines, ago, queueSummary, quitRisks, worktreeLosses, leaveQuestion, ownerColour, OWNER_COLOURS } from '../cli.js';
import { queueChanges } from '../queue.js';
import { plain } from '../term.js';

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
// `choose` is the one positional that is not a pull request; the flags around
// it are parsed as ever, and a second positional is the usual refusal.
test('prcoder choose is a subcommand, not a pull request target', () => {
  assert.equal(parseCli(['42']).choose, false);
  const c = parseCli(['choose', '--port', '4000', '--', '--effort', 'high']);
  assert.equal(c.choose, true);
  assert.equal(c.target, undefined);
  assert.equal(c.port, 4000);
  assert.deepEqual(c.agentArgs, ['--effort', 'high']);
  assert.throws(() => parseCli(['choose', '42']), /unexpected argument 42/);
  assert.ok(usage().includes('choose'));
});

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
  assert.equal(parseCli(['--no-history']).noHistory, true);
  assert.equal(parseCli([]).noHistory, false);
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
  for (const s of ['--port', '--no-open', '--no-history', '--verbose', '--agent', '--help', '--version', '-- ',
    '--queue', 'PRCODER_QUEUE', 'PRCODER_PORT', 'PRCODER_NO_OPEN', 'PRCODER_NO_HISTORY', 'PRCODER_VERBOSE', 'PRCODER_BROWSER', 'PRCODER_AGENT_BIN', ...AGENTS,
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
  nameWithOwner: 'gaurav/prcoder', remotes: { 'gaurav/prcoder': 'origin' }, defaultBranch: 'main', branch: 'initial-implementation',
  sync: 'ahead', ahead: 2, dirtyFiles: ['a.js', 'b.js'],
  pr: { number: 1, title: 'Drag the panes', url: 'https://github.com/gaurav/prcoder/pull/1', baseRefName: 'main' },
  queue: [{ text: 'a', issue: 4 }, { text: 'b', done: true }, { text: 'c', deleted: true },
    { text: 'd' }],
};
const block = (over = {}) =>
  statusLines({ ...STATUS, ...over }, { local: 'http://localhost:1618' }).map(plain).join('\n');

test('the block says where the branch, the PR and the queue stand', () => {
  const out = block();
  // The repository opens the block, and nothing comes before it -- the word
  // `prcoder` in that column was what the eye found first in every window.
  assert.match(out, /^gaurav\/prcoder {3}initial-implementation → main/);
  const [name] = statusLines(STATUS, { local: 'x' })[0];
  assert.deepEqual(name, { text: 'gaurav/prcoder', style: ['bold', ownerColour('gaurav/prcoder')] });
  assert.doesNotMatch(out, /^prcoder/m);
  // The colour goes by the owner, so related repos share one, and is the
  // same in every clone; the four are spread over owners, not all one.
  assert.ok(OWNER_COLOURS.includes(ownerColour('gaurav/prcoder')));
  assert.equal(ownerColour('gaurav/prcoder'), ownerColour('gaurav/ideas'));
  assert.equal(ownerColour('gaurav/prcoder'), 'green');
  assert.ok(new Set(['gaurav', 'NCATSTranslator', 'uc-cdis', 'anthropics', 'nodejs', 'octocat'].map(ownerColour)).size > 1);
  assert.ok(OWNER_COLOURS.includes(ownerColour(undefined)));
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

// A pull request in the parent of a fork, or into another remote's branch, says
// so the way the pane's head does, since the block is read beside it.
test('the block names the repository of a pull request that is not in this one, and the base\'s remote', () => {
  const out = block({
    remotes: { 'gaurav/prcoder': 'origin', 'upstream/prcoder': 'upstream' },
    pr: { ...STATUS.pr, url: 'https://github.com/upstream/prcoder/pull/9', number: 9, headRefName: 'initial-implementation',
      headRepo: 'gaurav/prcoder', headOwner: 'gaurav', isCrossRepository: true },
  });
  assert.match(out, /initial-implementation → upstream:main/);
  assert.match(out, /^PR upstream\/prcoder#9 +Drag the panes/m);
  // And in its own repository, as before.
  assert.match(block(), /^PR #1 +Drag the panes/m);
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
  const out = block({ pr: null, queue: [] });
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

  assert.match(statusLines(STATUS, { local: 'x', tabs: 1, age: 600_000 }).map(plain).join('\n'),
    /1 tab   checked 10m ago/);
  assert.doesNotMatch(statusLines(STATUS, { local: 'x', tabs: 1, age: 0 }).map(plain).join('\n'), /checked/);
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

// It used to start anyway: a server on a port, a pane with no pull request,
// and an agent in a directory with nothing to commit to.
test('prcoder refuses to start outside a git checkout', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-nogit-'));
  try {
    // /usr/bin/false and a timeout, as above: a run that got past the check
    // would be a listening server. Without git's own variables, which a hook
    // exports: a GIT_DIR would answer for the tmpdir (test/git.test.js says more).
    // LC_ALL=C because the line after prcoder's own is git's, in git's language.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    // A path, not the URL's pathname, which keeps a space in the checkout's
    // path as %20 and so names a file that is not there.
    const { fileURLToPath } = await import('node:url');
    const out = await promisify(execFile)('node', [fileURLToPath(new URL('../server.js', import.meta.url)), '--no-open'],
      { cwd: dir, env: { ...env, LC_ALL: 'C', PRCODER_AGENT_BIN: '/usr/bin/false' }, timeout: 15_000 })
      .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    assert.equal(out.code, 2);
    assert.match(out.stderr, /^prcoder: .* is not inside a git checkout\n {2}fatal: not a git repository/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A real server, in a throwaway repo, for the tests below of what it tells
// the tabs as it goes: the browser suite fakes the socket, so these are the one
// place the server's half is checked. `run` gets the server and its `host:port`
// once it answers, and this returns what `run` returned and the exit code.
async function withServer(run, opts) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-quit-'));
  execSync('git init -q', { cwd: dir, env: gitless() });
  let started;
  try {
    started = await serve(dir, opts);
    const result = await run(started.server, started.base, dir);
    return { result, code: (await started.exited)[0] };
  } finally {
    started?.server.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Without git's own variables, as above: under a hook, `git init` would land
// in whatever GIT_DIR names (test/CLAUDE.md).
const gitless = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/**
 * A server started in `cwd`, on a port that was free a moment ago, once it
 * answers: `{ server, base, exited }`. withServer's, and on its own for a test
 * that needs a second one, in another working copy of the same repository.
 */
async function serve(cwd, { agent = '/bin/cat', args = [] } = {}) {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const net = await import('node:net');
  const { fileURLToPath } = await import('node:url');
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const server = spawn('node', [fileURLToPath(new URL('../server.js', import.meta.url)), '--no-open', ...args],
    { cwd, env: { ...gitless(), PRCODER_PORT: String(port), PRCODER_AGENT_BIN: agent }, stdio: 'ignore' });
  const exited = once(server, 'exit');
  const base = `localhost:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await fetch(`http://${base}/api/whoami`).then((r) => r.json()).then((w) => w?.prcoder === true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  // A pinned port that is taken falls back to any free one (bind() in
  // server.js), and a slow start outlasts the loop. Either way this says so,
  // rather than leaving it to an opaque WebSocket error further on.
  if (!up) server.kill();
  assert.ok(up, `no prcoder answered on port ${port} within 5s: taken since the probe, or a slow start`);
  return { server, base, exited };
}

// The pane's worktree line, from the server's side: each working copy of a
// repository lists them all, says which one it is in, and finds the prcoder
// running in another by that one's own running record. Two real servers, one
// in the main working copy and one in a worktree of it.
test('each working copy lists the others, and where the prcoder in each is', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { result } = await withServer(async (server, base, dir) => {
    const git = (args) => execSync(`git -c user.name=t -c user.email=t@prcoder.invalid -c commit.gpgsign=false ${args}`,
      { cwd: dir, env: gitless(), encoding: 'utf8' }).trim();
    git('commit -q --allow-empty -m x');
    const main = git('symbolic-ref --short HEAD');
    git('worktree add -q -b topic wt');
    const list = (at) => fetch(`http://${at}/api/worktrees`).then((r) => r.json());
    const alone = await list(base);
    const other = await serve(path.join(dir, 'wt'));
    try {
      return { alone, fromMain: await list(base), fromWorktree: await list(other.base), main, here: base, other: other.base, top: await fs.realpath(dir) };
    } finally {
      other.server.kill();
      await other.exited;
      server.kill();
    }
  });
  const { top, main } = result;
  const row = { prunable: false, url: null };
  const rows = [
    { ...row, path: top, name: path.basename(top), branch: main, main: true, here: true },
    { ...row, path: path.join(top, 'wt'), name: 'wt', branch: 'topic', main: false, here: false },
  ];
  assert.deepEqual(result.alone, rows, 'no prcoder in the worktree yet');
  assert.deepEqual(result.fromMain, [rows[0], { ...rows[1], url: `http://${result.other}` }]);
  assert.deepEqual(result.fromWorktree, [{ ...rows[0], here: false, url: `http://${result.here}` }, { ...rows[1], here: true }]);
});

// A quit in a worktree, against real servers and real git: the question
// carries what removing the worktree would delete, the forced request says
// remove or keep in one of two words, and a removal leaves the branch. The
// main working copy is asked nothing about worktrees and cannot be removed.
test('a quit in a worktree removes it or keeps it as told, and never the main working copy', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-leave-')));
  const main = path.join(dir, 'main');
  const git = (args, cwd = main) => execSync(`git -c user.name=t -c user.email=t@prcoder.invalid -c commit.gpgsign=false ${args}`,
    { cwd, env: gitless(), encoding: 'utf8' }).trim();
  const exists = (p) => fs.access(p).then(() => true, () => false);
  const quit = (base, body) => fetch(`http://${base}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json());
  try {
    await fs.mkdir(main);
    git('init -q');
    await fs.writeFile(path.join(main, '.gitignore'), 'node_modules\n');
    git('add .gitignore');
    git('commit -q -m x');
    for (const answer of ['keep', 'remove']) {
      const wt = path.join(dir, answer);
      git(`worktree add -q -b topic-${answer} ${answer === 'keep' ? '../keep' : '../remove'}`);
      // With a file in it: git lists no directory that is empty.
      await fs.mkdir(path.join(wt, 'node_modules'));
      await fs.writeFile(path.join(wt, 'node_modules', 'x.js'), '');
      await fs.writeFile(path.join(wt, 'notes.txt'), 'not committed\n');
      const s = await serve(wt, { agent: '/usr/bin/false' });
      try {
        assert.deepEqual(await quit(s.base, {}),
          { risk: [], worktree: { name: answer, path: wt, lose: ['1 untracked file', 'ignored node_modules/'] } });
        assert.deepEqual(await quit(s.base, { force: true, worktree: 'sideways' }), { error: 'worktree: remove or keep' });
        assert.deepEqual(await quit(s.base, { force: true, worktree: answer }), { quit: true });
        assert.equal((await s.exited)[0], 0);
      } finally {
        s.server.kill();
      }
      assert.equal(await exists(wt), answer === 'keep', `${answer}: the worktree's directory`);
      assert.match(git('branch --list'), new RegExp(`topic-${answer}`), 'its branch stays either way');
    }
    assert.deepEqual(git('worktree list --porcelain').match(/^worktree .*$/gm), [`worktree ${main}`, `worktree ${path.join(dir, 'keep')}`]);
    // The main working copy: no worktree in the question, so with nothing at
    // risk there is no question, and a request to remove it is refused.
    const s = await serve(main, { agent: '/usr/bin/false' });
    try {
      assert.deepEqual(await quit(s.base, { force: true, worktree: 'remove' }), { error: 'this working copy is not a worktree prcoder can remove' });
      assert.deepEqual(await quit(s.base, {}), { quit: true });
      await s.exited;
    } finally {
      s.server.kill();
    }
    assert.ok(await exists(path.join(main, '.gitignore')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A start that checks out is refused while another prcoder runs in the same
// working copy -- found by the top level, not the directory, since one in a
// subdirectory moves the same files under the other's agent. Before, `prcoder
// 7` in `sub/` read sub/.prcoder's records, found none, and checked out.
test('a start in a subdirectory is refused while a prcoder runs at the top of the working copy', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { withGh } = await import('./stub-gh.js');
  const pr = { url: 'https://github.com/o/r/pull/7', number: 7, headRefName: 'other', isCrossRepository: false };
  // repoInfo's `repo view` and pullRequestFor's `pr view`; anything else --
  // the checkout this refuses -- fails the test with gh's exit 9.
  const gh = () => `case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"o/r","parent":null}';;
  "pr view") echo '${JSON.stringify(pr)}';;
  *) echo "gh $* was not expected" >&2; exit 9;; esac`;
  // withServer waits for the server to exit, so the run ends by stopping it.
  const { result } = await withGh(gh, () => withServer(async (server, base, dir) => {
    const sub = path.join(dir, 'sub');
    await fs.mkdir(sub);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const out = await promisify(execFile)('node', [fileURLToPath(new URL('../server.js', import.meta.url)), '7', '--no-open'],
      { cwd: sub, env: { ...env, PRCODER_AGENT_BIN: '/usr/bin/false' }, timeout: 15_000 })
      .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    server.kill();
    return out;
  }));
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /^prcoder: #7 is on other, and another prcoder is running in this working copy \(in .*\) \(http:\/\/localhost:\d+\)/);
});

// The pane's Switch is startOnPr, as a start is: held to this clone's
// repositories case-blind (a URL spelled `O/R` where gh says `o/r` used to be
// "not one of this clone's repositories"), and refused over uncommitted work
// before gh is asked to check anything out. In a spawned server, since the
// in-process one in api.test.js would check out this working tree.
test('the pane\'s Switch is a start\'s checkout, held to the repositories case-blind', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { withGh } = await import('./stub-gh.js');
  const pr = { url: 'https://github.com/o/r/pull/7', number: 7, headRefName: 'other', isCrossRepository: false };
  const gh = () => `case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"o/r","parent":null}';;
  "pr view") echo '${JSON.stringify(pr)}';;
  *) echo "gh $* was not expected" >&2; exit 9;; esac`;
  const { result } = await withGh(gh, () => withServer(async (server, base, dir) => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'staged\n');
    execSync('git add a.txt', { cwd: dir, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) });
    const res = await fetch(`http://${base}/api/pr/switch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://github.com/O/R/pull/7' }),
    });
    server.kill();
    return res.json();
  }));
  assert.match(result.error, /^#7 is on other, and 1 uncommitted file on \S+ is in the way; commit or stash it first$/);
});

// A quit tells every tab before it kills anything, with a close code of its
// own, and that code is all a page has to tell prcoder quitting from its agent
// exiting (ws.onclose in public/app.js). So does an exit that skips quit():
// closing the terminal prcoder runs in (SIGHUP). Two tabs' sockets each time.
test('a quit, or a signal, closes every tab\'s socket with QUIT_CODE', async () => {
  const { QUIT_CODE } = await import('../public/ui.js');
  // In an object: resolved with the promise itself, tab() would wait for the
  // close rather than the open, and nothing here closes it.
  const tab = (base) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/pty`);
    const closed = new Promise((r) => { ws.onclose = (e) => r([e.code, e.reason]); });
    ws.onopen = () => resolve({ closed });
    ws.onerror = reject;
  });
  // The two tabs' close codes, after `end` is done to a server with both open.
  const tabsAfter = (end) => async (server, base) => {
    const tabs = [(await tab(base)).closed, (await tab(base)).closed];
    await end(server, base);
    return Promise.all(tabs);
  };
  const told = [[QUIT_CODE, 'prcoder quit'], [QUIT_CODE, 'prcoder quit']];

  assert.deepEqual(await withServer(tabsAfter(async (_, base) => {
    const r = await fetch(`http://${base}/api/quit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}',
    });
    assert.deepEqual(await r.json(), { quit: true });
  })), { result: told, code: 0 });
  assert.deepEqual(await withServer(tabsAfter((server) => server.kill('SIGHUP'))), { result: told, code: 130 });
});

// The close frame queues behind whatever the socket has not yet written, so a
// server that exits as soon as it has sent it loses it under a burst of the
// agent's output, and the page sees a bare 1006 and offers a Start that
// reaches nothing. Here the agent floods the terminal while the tab reads
// nothing, so megabytes are queued when the quit comes; the tab reads on a
// moment later, and the last frame must still be QUIT_CODE. Until 2026-11-10 quit()
// exited once stdout had drained, and this tab got no close frame at all.
// A raw socket, not a WebSocket: that reads as fast as it can, and the backlog
// is the point.
test('a quit\'s close frame reaches a tab that is behind on the agent\'s output', async () => {
  const fs = await import('node:fs/promises');
  const net = await import('node:net');
  const os = await import('node:os');
  const path = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { QUIT_CODE } = await import('../public/ui.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-flood-'));
  const flood = path.join(stubDir, 'agent');
  await fs.writeFile(flood, '#!/bin/sh\nhead -c 16000000 /dev/zero | tr \'\\000\' x\nexec sleep 600\n', { mode: 0o755 });
  try {
    const { result } = await withServer(async (_, base) => {
      const [host, port] = base.split(':');
      const sock = net.connect(Number(port), host);
      // One listener for the whole run: a 'data' event with nobody listening
      // is lost.
      const chunks = [];
      sock.on('data', (b) => chunks.push(b));
      const ended = new Promise((r) => sock.on('close', r));
      sock.write(`GET /pty HTTP/1.1\r\nHost: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      for (let i = 0; i < 100 && !Buffer.concat(chunks).includes('\r\n\r\n'); i++) await sleep(20);
      sock.pause();
      await sleep(1500);   // the flood, queueing in the server
      const r = await fetch(`http://${base}/api/quit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}',
      });
      assert.deepEqual(await r.json(), { quit: true });
      // A tab can be slow to read -- busy, or in the background -- and the
      // server has to wait for it. Half a second is well past the moment the
      // old quit() was gone, and well inside the 2s it now waits at most.
      await sleep(500);
      sock.resume();
      await ended;
      // The server's frames, unmasked, after the handshake's reply.
      const all = Buffer.concat(chunks);
      let at = all.indexOf('\r\n\r\n') + 4;
      let read = 0;
      let close = null;
      while (at + 2 <= all.length) {
        const op = all[at] & 0x0f;
        let len = all[at + 1] & 0x7f;
        let head = 2;
        if (len === 126) { len = all.readUInt16BE(at + 2); head = 4; }
        else if (len === 127) { len = Number(all.readBigUInt64BE(at + 2)); head = 10; }
        if (at + head + len > all.length) break;   // cut off mid-frame
        if (op === 8) close = all.readUInt16BE(at + head);
        else read += len;
        at += head + len;
      }
      return { close, behind: read > 4_000_000 };
    }, { agent: flood });
    assert.deepEqual(result, { close: QUIT_CODE, behind: true });
  } finally {
    await fs.rm(stubDir, { recursive: true, force: true });
  }
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

// A quit in a worktree can remove it, and git removes ignored files and
// prcoder's own queue without a word, so the question names each kind of
// thing that would go. Completed and deleted queue items are not counted:
// what is on Local is what is still to do.
test('the quit question in a worktree says what removing it would delete', () => {
  assert.deepEqual(worktreeLosses({}), []);
  const queue = [{ text: 'a' }, { text: 'b' }, { text: 'done', done: true }];
  assert.deepEqual(worktreeLosses({ changed: 1, untracked: 2, ignored: ['.env', 'node_modules/'], queue }),
    ['1 uncommitted change', '2 untracked files', 'ignored .env, node_modules/', '2 queue items']);
  assert.deepEqual(worktreeLosses({ ignored: ['.env', 'a/', 'b/', 'c/', 'd/'] }), ['ignored .env, a/, b/ and 2 more']);
  assert.equal(leaveQuestion(['1 unpushed commit'], { name: 'topic', lose: ['1 untracked file', '1 queue item'] }),
    'quit, and [r]emove worktree topic or [k]eep it? [N]  1 unpushed commit; removing it deletes 1 untracked file, 1 queue item ');
  // The keys are inside the first of an 80-column line, whatever follows.
  assert.equal(leaveQuestion([], { name: 'topic', lose: [] }), 'quit, and [r]emove worktree topic or [k]eep it? [N]  it has nothing git lacks ');
});
