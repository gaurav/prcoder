---
name: run-prcoder
description: Launch the prcoder server and verify it (or a change to it) against this repo's real PR. Use when asked to run, start, smoke-test, or demo prcoder, or to confirm a change works in the running app.
---

# Running prcoder

prcoder serves the repo it is started in: it reads the current branch's PR via
`gh` and spawns a real `claude` PTY per websocket connection. Run it from a
branch with an open PR — most routes answer `no pull request for this branch`
otherwise. This repo's own PRs are fine to test against (CLAUDE.md: never
someone else's repo).

## Launch

For handing the user a URL, or poking at it by hand:

```bash
PRCODER_NO_OPEN=1 PRCODER_PORT=7433 node server.js > /tmp/prcoder.log 2>&1 &
sleep 2
curl -s localhost:7433/api/status | head -c 200   # pr, files, queue
lsof -ti :7433 | xargs kill                       # `kill %1` does not survive a Bash call
```

`/api/status` is the check worth making by hand, because it is the one that
needs a live `gh` and a real PR. Everything that does not — the 404 and 500
shapes, static serving, `/api/whoami`, the vendored xterm paths — is
`test/api.test.js`, so `node --test` already covers it.

`PRCODER_NO_OPEN=1` stops it opening the user's browser; without `PRCODER_PORT`
it takes the port derived from the repo's path, or any free one, and prints the
URL on stdout. For a look with the user's own eyes, leave it running and hand
them `http://localhost:7433`, or `open` it.

API shape: the `routes` table in `server.js`, keyed `"METHOD /path"`, JSON
in/out, errors as 500 `{error}`. All handlers are serialised — one slow call
delays the rest, that's expected.

## Verifying a change

```bash
node --test                # bare, never `node --test test/` (Node 26 breaks)
node --check public/*.js   # the client files the tests do not import
```

Then look at it. Both drivers boot their own server and kill it after, and they
are where the env stubs are actually written down — copy from
`tools/shot.mjs:35-39`, not from here.

```bash
node tools/shot.mjs /tmp/shots                 # the browser: writes PNGs
PRCODER_BROWSER=firefox node tools/shot.mjs    # the run that counts for selection,
                                               # focus and drag. Separate download:
                                               # npx playwright install firefox
node tools/cli.mjs                             # the other half, in a real PTY: the
                                               # status block, the keys, the quit prompt
```

Read the PNGs back — a screenshot is the only thing that answers "does this look
right", and three changes shipped on CSS-reading alone before this existed. Both
are scratch drivers, not tests: they assert nothing and print `want …` lines for
a human. Edit them for whatever you are looking at, and keep the edits if they
are worth having.

Two rules for them, and for any script after them:

- **`CLAUDE_BIN=/bin/cat`.** Every page load opens a websocket and spawns
  `CLAUDE_BIN` in a PTY — one per tab, killed when the tab closes. Without the
  stub, each run starts a real Claude session and leaves it running.
- **No writes you do not undo.** The queue is safe: it writes only `.prcoder/`,
  which is gitignored and needs no cleanup. The PR is not — ticking a
  description checkbox edits the description on GitHub, and so does mirroring a
  queue item with ◆. Snapshot the body with `gh pr view <n> --json body -q
  .body` before, and diff after.

If every PTY spawn dies with a bare `posix_spawnp failed`, the `postinstall`
chmod was skipped: `npm install` again, and see CLAUDE.md for why.
