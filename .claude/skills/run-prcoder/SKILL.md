---
name: run-prcoder
description: Launch the prcoder server and verify it (or a change to it) against this repo's real PR. Use when asked to run, start, smoke-test, or demo prcoder, or to confirm a change works in the running app.
---

# Running prcoder

prcoder serves the repo it is started in: it reads the current branch's PR via
`gh` and spawns a real `claude` PTY per websocket connection. Verified working
2026-08-26 on this machine.

## Launch (background, for verification)

```bash
PRCODER_NO_OPEN=1 PRCODER_PORT=7433 node server.js > /tmp/prcoder.log 2>&1 &
sleep 2
```

- `PRCODER_NO_OPEN=1` stops it opening the user's browser.
- `PRCODER_PORT` pins the port; without it the server takes any free port and
  prints the URL on stdout (read the log to find it).
- Run it from the repo root of a branch that has an open PR — most routes
  answer `no pull request for this branch` otherwise. This repo's own PRs are
  fine to test against (CLAUDE.md: never someone else's repo).

## Smoke checks

```bash
curl -s localhost:7433/api/status | head -c 200        # pr, files, queue
curl -s -X POST localhost:7433/api/diff -H 'content-type: application/json' \
  -d '{"path":"files.js"}' | head -c 200               # a real patch, or null
curl -s localhost:7433/ | grep -c '<main>'             # static serving
```

API shape: route table in `server.js` (`routes`), keyed `"METHOD /path"`, JSON
in/out, errors as 500 `{error}`. All handlers are serialised — one slow call
delays the rest, that's expected.

## Client-side changes

```bash
node --check public/app.js public/pr.js public/diff.js public/queue.js
node --test          # bare, never `node --test test/` (Node 26 breaks)
curl -s localhost:7433/app.js | head -3   # the file actually serves
```

Then look at it. `playwright` is a dev dependency and Chromium is installed, so
a client-side change can be seen rather than reasoned about:

```bash
node tools/shot.mjs /tmp/shots   # boots its own server, writes PNGs, kills it
```

Read the PNGs back — a screenshot is the only thing that answers "does this
look right", and three changes shipped on CSS-reading alone before this existed.
`tools/shot.mjs` is a scratch driver, not a test: edit it for whatever you are
looking at, and keep the edits if they are worth having.

Two things it has to do, and any browser script after it:

- **`CLAUDE_BIN=/bin/cat`.** Every page load opens a websocket and spawns
  `CLAUDE_BIN` in a PTY. Without the stub, each run starts a real Claude
  session and leaves it running.
- **No writes you do not undo.** The queue is safe now -- it writes only
  `.prcoder/`, which is gitignored and needs no cleanup. The PR is not: ticking
  a description checkbox edits the description on GitHub, and so does mirroring
  a queue item with ◆. Snapshot the body with `gh pr view <n> --json body -q
  .body` before, and diff after.

For a look with the user's own eyes, leave the server running and hand them the
URL (`http://localhost:7433`), or run `open http://localhost:7433`.

## Teardown and traps

```bash
lsof -ti :7433 | xargs kill
```

(`kill %1` is unreliable across Bash tool calls — jobs don't persist.)

- If every PTY spawn dies with bare `posix_spawnp failed`: the `postinstall`
  chmod in package.json was skipped. `npm install` again; see CLAUDE.md.
- Each browser tab opens its own websocket = its own `claude` process; closing
  the tab kills it.
