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
import { server } from '../server.js';

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

// The vendor map is hand-written paths into node_modules, so it breaks silently
// on an xterm upgrade -- and a 404 here is a blank page with a module error in
// a console prcoder never shows.
test('the vendored xterm files are where the map says', async () => {
  for (const p of ['/vendor/xterm.mjs', '/vendor/xterm.css',
                   '/vendor/addon-fit.mjs', '/vendor/addon-web-links.mjs']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
});
