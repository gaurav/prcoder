---
name: run-prcoder
description: Launch the prcoder server and verify it (or a change to it) against this repo's real PR. Use when asked to run, start, smoke-test, or demo prcoder, or to confirm a change works in the running app.
---

# Running prcoder

prcoder serves the repo it is started in: it reads the current branch's PR via
`gh` and spawns a real `claude` PTY per websocket connection. Run it from a
branch with an open PR -- most routes answer `no pull request for this branch`
otherwise. Test against this repo's own PRs; another repo only when its owner
has said so (CLAUDE.md).

## Launch

First see whether one is already up: `.prcoder/port.json` records this repo's
port, and `curl -s localhost:<port>/api/whoami` says if it is live. A running
server is the cheapest thing to verify against, and it serves `public/` from
disk, so a reload shows a client change. A second server started in the same
directory moves aside to another port rather than taking the recorded one.

Otherwise:

```bash
mkdir -p data
PRCODER_NO_OPEN=1 PRCODER_PORT=17433 node server.js > data/prcoder.log 2>&1 &
sleep 2
curl -s localhost:17433/api/status | head -c 200   # pr, files, queue
lsof -ti :17433 | xargs kill                       # `kill %1` does not survive a Bash call
```

`/api/status` is the check worth making by hand: it is the one that needs a
live `gh` and a real PR. The rest -- the 404 and 500 shapes, static serving,
`/api/whoami`, the vendored xterm paths -- is `test/api.test.js`, so `npm test`
already covers it.

`PRCODER_NO_OPEN=1` stops it opening the user's browser. Without `PRCODER_PORT`
it takes the recorded port, writing one on the first run, and prints the URL on
stdout. For a look with the user's own eyes, leave it running and hand them that.

API shape: the `routes` table in `server.js`, keyed `"METHOD /path"`, JSON
in/out, errors as 500 `{error}`. Every handler but `/api/whoami` is serialised,
so one slow call delays the rest.

## Verifying a change

```bash
npm test                   # node --test "test/**/*.test.js"; see CLAUDE.md for the quotes.
                           # Includes test/browser.test.js, in Chromium; it skips with a
                           # note when the browser is missing (npx playwright install chromium)
node --check public/*.js   # the client files the tests do not import
```

For the diff pane: under Files, a `.js` or `.md` file opens under **NEW** with
coloured tokens, and a `.txt` (any extension `language` in `public/diff.js`
does not list) opens plain. Prism loads on that first click, so a 404 in the
vendor map shows as a plain file and a `highlight` line in the console, not as
an error anywhere prcoder shows.

Then look at it. `docs/Verifying.md` is the standing account of the three
drivers -- what each reaches, which engine, the stub, the Firefox situation --
and is where a check that outlives the session gets written down. The short
form:

```bash
node tools/browser.mjs highlighting               # the UI, PNGs to data/shots/highlighting/;
                                                  # the label says what you were looking at. Firefox, falling
                                                  # back to Chromium if it will not start
PRCODER_BROWSER=chromium node tools/browser.mjs   # skip that wait, or compare engines
node tools/cli.mjs                                # the terminal half, in a real PTY
node tools/no-pr.mjs                              # the pane with no pull request, in a clone
```

Each boots its own server on a port of its own (the `port` line near the top)
and refuses to start if that port is held, because `server.js` would quietly
move to a free one and the driver would drive whatever is already there. The env they spawn with is
in each driver's `spawn` block -- copy from there, not from here. A Playwright
`Executable doesn't exist` means the browser build this repo's Playwright wants
is not the one installed: `npx playwright install chromium` (or `firefox`).

Read the PNGs back: a screenshot is the only thing that answers "does this look
right", and three changes shipped on CSS-reading alone before the driver
existed. The drivers assert nothing, they print `want …` lines for a human, so
edit them for whatever you are looking at and keep the edits worth having.

Two rules for them, and for any script after them:

- **Stub `claude`.** Every page load opens a websocket and spawns `CLAUDE_BIN`
  in a PTY, one per tab; without a stub each run starts a real session and
  leaves it running. Use `tools/claude-stub.mjs`, which echoes and sends the
  cursor probe a real session sends. `/bin/cat` is enough for the terminal half
  only -- anything that reads the PTY's timing passes against it for the wrong
  reason (CLAUDE.md).
- **No writes you do not undo.** The queue is safe: it writes only `.prcoder/`,
  which is gitignored and needs no cleanup. The PR is not — ticking a
  description checkbox — in the PR pane or the queue's PR tab — edits the
  description on GitHub. Moving a queue item with
  ◇ or ◎ writes to GitHub too, and one-way: putting the queue back does not take
  the line out of the description or close the issue. Snapshot the body with `gh pr view <n> --json body -q
  .body` before, and diff after. Opening and closing a description's sections
  is not a write — the fold is browser state and never reaches GitHub — so the
  driver clicks them freely.

If every PTY spawn dies with a bare `posix_spawnp failed`, the `postinstall`
script was skipped: `npm install` again, and see CLAUDE.md for why.
