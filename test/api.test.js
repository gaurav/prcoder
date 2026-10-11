// The routes, over real HTTP. Everything that listens in server.js is behind
// `import.meta.main`, so importing it starts nothing and this can listen on a
// free port in-process -- no spawn, no port to pin, no server left running.
// No `claude` either: a PTY is spawned only by a /pty websocket, and nothing
// here opens one.
//
// Only the routes that need no `gh`. `ready()` never runs without the main
// guard, so `pr` and `info` stay null and the handlers that shell out would be
// testing this machine's GitHub auth rather than prcoder. Those are the curls
// in .claude/skills/run-prcoder, run by hand against a real PR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { server, sessionArgs, startedWith, missingVendor, keepPr } from '../server.js';
import { grammars } from '../public/diff.js';

let base;
before(() => new Promise((res) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  res();
})));
// Without this `node --test` never exits.
after(() => new Promise((res) => server.close(res)));

// What a second prcoder asks the holder of its port. Answering from cache is
// the contract: a probe that waited on gh would time out and the busy-port note
// would name the wrong thing.
test('/api/whoami answers from cache, before any poll has run', async () => {
  const res = await fetch(`${base}/api/whoami`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), {
    prcoder: true, repo: process.cwd(), branch: null, nameWithOwner: null,
    started: { model: '', effort: '' },
  });
});

test('a handler that throws is a 500 with the message, not a dead process', async () => {
  const res = await fetch(`${base}/api/diff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'files.js' }),
  });
  assert.equal(res.status, 500);
  // The sentence every route says off a branch with no PR; the skill quotes it.
  assert.deepEqual(await res.json(), { error: 'no pull request for this branch' });
});

test('an unknown route is a 404, and the method is part of the key', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal(await (await fetch(`${base}/api/nope`)).text(), 'no such route');
  // GET /api/queue exists; DELETE is a different key entirely.
  assert.equal((await fetch(`${base}/api/queue`, { method: 'DELETE' })).status, 404);
});

test('static files come from public/, and a miss is a 404', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.match(await res.text(), /<main/);
  assert.equal((await fetch(`${base}/nothing.js`)).status, 404);
});

// The page holds the PTY socket, so it is the one worth a policy: a frame is
// the hole the origin check does not close (docs/Security.md), and script-src
// is what a future escape in the description renderer would run into.
test('the page is served with a CSP that forbids framing and foreign script', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
});

// The vendor map is hand-written paths into node_modules, so it breaks silently
// on an xterm upgrade -- and a 404 here is a blank page with a module error in
// a console prcoder never shows. The server derives *which* grammars from the
// page's own `grammars`, so the two cannot disagree about that; what is still
// worth fetching is whether the file each one names is really there, which a
// prismjs upgrade is what changes.
test('the vendored xterm and Prism files are where the map says', async () => {
  // A derived list that came back empty would pass the loop below without
  // fetching anything, so it is checked for being a list of grammars first.
  assert.ok(grammars.length > 5 && grammars.includes('tsx'), grammars.join(', '));
  for (const p of ['/vendor/xterm.mjs', '/vendor/xterm.css',
                   '/vendor/addon-fit.mjs', '/vendor/addon-web-links.mjs',
                   '/vendor/prism.js', ...grammars.map((l) => `/vendor/prism/${l}.js`)]) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
});

// A page on the web cannot read this server's answers, but every mutating route
// takes effect on the way out -- and the /pty socket is not covered by the
// same-origin policy at all. An origin that is not ours is refused; one that is
// absent is not a browser, which is what keeps curl and the drivers working.
test('a request from another origin is refused before it reaches a handler', async () => {
  const res = await fetch(`${base}/api/diff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
    body: JSON.stringify({ path: 'files.js' }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'cross-origin request refused' });
});

test('our own origin is not refused, and neither is a request without one', async () => {
  const post = (headers) => fetch(`${base}/api/diff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ path: 'files.js' }),
  });
  // 500 is the no-PR error every route gives here: past the guard, into the handler.
  assert.equal((await post({ origin: base })).status, 500);
  assert.equal((await post({})).status, 500);
});

// DNS rebinding: attacker.test resolves to 127.0.0.1 once its page has loaded,
// so Origin and Host agree -- and a same-origin GET sends no Origin at all. The
// Host name is what gives it away. fetch will not set Host, so this goes by hand.
test('a request naming a host that is not loopback is refused, origin or none', async () => {
  const { port } = server.address();
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/whoami', headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  const rebound = `attacker.test:${port}`;
  assert.equal(await get({ host: rebound }), 403);
  assert.equal(await get({ host: rebound, origin: `http://${rebound}` }), 403);
  for (const name of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(await get({ host: `${name}:${port}` }), 200, name);
  }
});

test('a malformed origin is refused rather than parsed into a pass', async () => {
  const res = await fetch(`${base}/api/diff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'not a url' },
    body: JSON.stringify({ path: 'files.js' }),
  });
  assert.equal(res.status, 403);
});

// The payload shape is part of this route's contract, and it has changed twice:
// a bare array, then `{items, branch}`, and now `{items}` again. A client that
// missed a change used to send something the route then indexed into, and the
// TypeError told nobody what to send. None of these reaches a store write, so
// the queue on disk is untouched either way.
test('a queue write of the wrong shape says so, rather than throwing from inside', async () => {
  const put = async (body) => {
    const res = await fetch(`${base}/api/queue`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return [res.status, (await res.json()).error];
  };
  const want = 'the queue must be sent as {items}';
  // Both old wire formats, either of which somebody may still have open.
  assert.deepEqual(await put([]), [500, want]);
  assert.deepEqual(await put([{ text: 'a task' }]), [500, want]);
  assert.deepEqual(await put({ branch: 'work' }), [500, want]);
  assert.deepEqual(await put({ items: 'not an array', branch: 'work' }), [500, want]);
});

// The branch goes into git, so it has to be one origin has (or the one checked
// out). Both refusals come before the gh lookup the walk itself needs.
test('what a branch is built on is asked only of a branch origin has', async () => {
  const ask = async (body) => {
    const res = await fetch(`${base}/api/below`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return [res.status, (await res.json()).error];
  };
  assert.deepEqual(await ask({}), [500, 'no branch']);
  assert.deepEqual(await ask({ branch: 42 }), [500, 'no branch']);
  assert.deepEqual(await ask({ branch: '--upload-pack=x' }), [500, 'origin has no branch --upload-pack=x']);
  assert.deepEqual(await ask({ branch: 'no-such-branch-anywhere' }), [500, 'origin has no branch no-such-branch-anywhere']);
});

// The exit panel's "Start coding agent" sends its settings as the /pty
// query, and they become part of a spawn's argv -- so only names and levels get
// through, and a model that is really a flag is refused rather than handed to
// claude.
test('session settings become claude flags, and nothing else does', () => {
  const args = (q) => sessionArgs(new URLSearchParams(q));
  assert.deepEqual(args(''), []);
  assert.deepEqual(args('model=&effort='), []);
  assert.deepEqual(args('model=opus&effort=high&continue=on'),
    ['--continue', '--model', 'opus', '--effort', 'high']);
  assert.deepEqual(args('model=claude-opus-5-5[1m]'), ['--model', 'claude-opus-5-5[1m]']);
  assert.deepEqual(args('model=claude-sonnet-4-5@20250929'), ['--model', 'claude-sonnet-4-5@20250929']);
  assert.deepEqual(args('model=arn:aws:bedrock:us-east-1:1:application-inference-profile/x'),
    ['--model', 'arn:aws:bedrock:us-east-1:1:application-inference-profile/x']);
  assert.equal(args('model=--dangerously-skip-permissions'), null);
  assert.equal(args('model=opus --verbose'), null);
  assert.equal(args('effort=extreme'), null);
});

// Pinned so that changing it is a decision (2026-10-01): a blank field sends
// nothing, so whatever -- gave stays in the argv. Blanking both fields is not
// a way back to the agent's own default when prcoder's command line named one.
test('blank settings keep the command line\'s model and effort, and chosen ones win', () => {
  const base = ['--model', 'opus', '--effort', 'high'];
  const args = (q) => sessionArgs(new URLSearchParams(q), base);
  assert.deepEqual(args('model=&effort='), base);
  assert.deepEqual(args('model=haiku'), [...base, '--model', 'haiku']);
  assert.equal(args('effort=extreme'), null);
});

// The exit bar is filled with the command line's settings, so an untouched
// restart sends them back -- and the command line takes names the allowlist
// refuses. Sending back what -- gave must start the agent, not close the socket.
test('settings the command line already gave are kept, not checked', () => {
  const base = ['--model', 'my model', '--effort', 'extreme'];
  const args = (q) => sessionArgs(new URLSearchParams(q), base);
  assert.deepEqual(args('model=my+model&effort=extreme'), base);
  assert.deepEqual(args('model=my+model&effort=low'), [...base, '--effort', 'low']);
  assert.equal(args('model=other+model'), null);
});

// What the exit bar is filled with: the last of each, as claude reads them.
test('startedWith reads the model and effort from the agent\'s arguments', () => {
  assert.deepEqual(startedWith([]), { model: '', effort: '' });
  assert.deepEqual(startedWith(['--continue', '--model', 'opus', '--effort=high']),
    { model: 'opus', effort: 'high' });
  assert.deepEqual(startedWith(['--model', 'opus', '--model=haiku']), { model: 'haiku', effort: '' });
  assert.deepEqual(startedWith(['--models', 'x', '--effort']), { model: '', effort: '' });
});

// Refused before the spawn, like a foreign origin: this opens a real /pty and
// would start a `claude` if the guard were after it.
test('a /pty socket with settings that are not allowed is closed unspawned', async () => {
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?model=--help`);
  const [code] = await new Promise((res) => ws.on('close', (...a) => res(a)));
  assert.equal(code, 1008);
});

// What startup warns about. Empty here, because this checkout has been
// installed; and a directory with no node_modules is missing every file,
// Prism's grammars included, so none of the map is skipped.
test('missingVendor names the vendor files that are not installed', () => {
  assert.deepEqual(missingVendor(), []);
  const all = missingVendor(import.meta.dirname);
  assert.ok(all.includes('@xterm/xterm/lib/xterm.mjs'));
  assert.ok(all.includes('prismjs/prism.js'));
  assert.equal(all.length, 5 + grammars.length);
});

// The half of #120's fix that matters: a check finishing leaves updatedAt where
// it was, so a poll that keeps the PR has to take the checks from the cheap call
// or the Checks tab says pending until something else touches the PR.
test('a poll that keeps the PR still takes its checks from prHeads', () => {
  const pr = { number: 1, updatedAt: 'a', checks: { pending: 1 } };
  assert.equal(keepPr(pr, { number: 1, updatedAt: 'a', checks: { passed: 1 } }), true);
  assert.deepEqual(pr.checks, { passed: 1 });
  assert.equal(keepPr(pr, { number: 1, updatedAt: 'b' }), false);
  assert.equal(keepPr(pr, { number: 2, updatedAt: 'a' }), false);
  assert.equal(keepPr(pr, null), false);
  // No PR then or now: nothing to reload.
  assert.equal(keepPr(null, null), true);
});
