# prcoder

A local server + browser UI wrapping a real `claude` PTY. See README.md for what
it does and how to run it, `docs/Design.md` for why it works the way it does --
the guards, the non-goals -- `docs/Security.md` for what the server is exposed to
and the checks new work has to keep, and `docs/Verifying.md` for what this repo
checks and how. `.claude/skills/run-prcoder/SKILL.md` is the short form of the
last two for an agent about to run the thing: how to launch, what to stub, what
not to write. Keep all of them true when you change what they describe -- the
skill drifts first, because nothing else links to it.

**The queue is yours, and prcoder writes no description but a box you tick.**
The queue lives only in `.prcoder/queue.json`; it no longer mirrors into the PR
description, and prcoder no longer reads FUTURE.md. "What prcoder writes" in
`docs/Design.md` says why, what the one exception is, and where the source tabs
are going (`queue-tabs`, PR #27). The mirror is parked in PR #82; don't bring a
sync back without reading both.

## Scratch work goes in `data/`

`data/` is gitignored and is where anything temporary belongs -- driver
screenshots, snapshots of a PR body taken before a write, intermediate output.
Not `/tmp`: reads outside this working directory are blocked, so a screenshot
written to `/tmp` is one nobody in this session can look at. A one-off
Playwright script has to live here too -- `import 'playwright'` resolves from
this repo's `node_modules`, and from a scratch directory it is `Cannot find
package 'playwright'`.

## Two traps

**Don't delete the `postinstall` script.** `tools/postinstall.mjs` looks like
dead setup. npm blocks node-pty's own install script, which is what makes
`prebuilds/*/spawn-helper` executable. Without it every PTY spawn fails with a
bare `posix_spawnp failed` — no mention of permissions, and node-pty still
imports fine, so it reads like a Node ABI problem when it isn't.
`npm install-scripts approve node-pty` does *not* replace it — tested 2026-08-23,
the approved script is `node-gyp rebuild` and the prebuilt helper still lands
non-executable. It is Node rather than the `chmod ... || true` it used to be
because cmd.exe has neither command, so the shell version failed `npm install`
outright on Windows.

**`npm test` is `node --test "test/**/*.test.js"`, and the quotes are
load-bearing.** Not `node --test test/`: on Node 26 a directory argument is
resolved as a module and dies with `Cannot find module`. Not bare `node --test`
either, which walks the *whole* working directory — so a scratch checkout under
`data/` became a second copy of the suite, 386 tests and one failure on the
vendored-xterm path check because the clone had no `node_modules` (2026-09-18).
Node 26 has no `--test-exclude-glob` to say it the other way round; the flag is
gone, and `node --help` lists no replacement.

The glob has to reach node unexpanded. `sh` has no `**`, so unquoted it collapses
to whatever one directory it matches — that run reported 1 test and passed. The
quotes are double for the same reason the postinstall script is Node: single
quotes are not quotes to cmd.exe.

Discovery takes every `*.test.js` under `test/`, at any depth; anything else
there runs only when a test file imports it, which is how `test/browser/suite.js`
runs once per engine and never bare. The drivers still live in `tools/` —
`browser.mjs` for the UI, `cli.mjs` for the terminal, `no-pr.mjs` for the pane
the first one cannot reach — so none of them is one rename from running on every
`npm test`, spawning a server and driving a browser or a PTY.

`node:test` is a preference, not a constraint. If it ever gets in the way —
maintainability, a matcher you keep hand-rolling, watch mode, anything — the
owner is fine with swapping in a real test framework (stated 2026-09-05). The
rule above is about the CLI's directory argument, not about staying on the
built-in runner.

## Subprocess errors are quieter than they look

A gh or git failure here is usually quiet, not loud: stderr missing from the
error, a full stdout behind a non-zero exit, or an exit code that means "no"
rather than "broke". Read the docstrings on `run` in `github.js` and `answer`
in `git.js` before adding a call, and check what the real tool does.

## Old descriptions still carry the mirror's block

Descriptions written by an earlier prcoder hold a checklist between prcoder's
own HTML-comment markers. Nothing reads or rewrites that block any more: it is
an ordinary checklist now, ticked like any other from the PR pane. Leave old
blocks alone; hand-editing them is safe.

## Driving Firefox

prcoder is used in Firefox, so `tools/browser.mjs` now defaults to it and falls
back to Chromium only when it is not installed; `PRCODER_BROWSER=chromium|firefox`
forces one. That is Playwright's own patched Firefox, not the one in
/Applications -- the default path needs the Juggler patch only that build has,
so the check is `existsSync(firefox.executablePath())` and the fix for a miss is
`npx playwright install firefox`. (A stock install is drivable over WebDriver
BiDi with `channel: 'moz-firefox'`; `tools/firefox-runner/` has what came of
trying it.) Running both is worth the second minute: the
caret bug is invisible in Chromium and fatal in Firefox, and it is the one thing
here that only one engine can tell you about. `test/browser/` runs its suite in
both for the same reason: a header-height test written against Chromium failed
in Firefox (2026-09-26).

Installed is not the same as working, and the check cannot tell them apart.
From 2026-09-16 to 2026-09-26 Firefox did not start at all on this machine,
while `existsSync(firefox.executablePath())` was true throughout. The cause
was macOS 27 denying a terminal-launched Firefox its own `~/Library/Application
Support/Firefox`, which Firefox reads even when `-profile` points elsewhere.
Every Firefox launch in `tools/` and `test/` now sets `MOZ_APP_DATA` and
`MOZ_LOCAL_APP_DATA` under `data/firefox-appdata/`, and with them it starts in
about two seconds. A launch that leaves them out hangs until the timeout, with
nothing in the output to say why -- so a new driver that launches Firefox
passes `firefoxEnv()` from `tools/driver.mjs`, which is also where the port
check, the stubbed server environment and the kill-on-exit every driver needs
live. The workaround is temporary, and #80 is when it comes out
(Firefox 158 fixes this upstream). The 45-second timeout and the fall-back to
Chromium stay until then, in case the workaround stops working;
`tools/firefox-runner/` is the whole story, and `probe.mjs` there is the
re-check. The Firefox pass #61 owed was run on 2026-09-26, the exit bar on #75's branch
included, and #61 is closed; docs/Verifying.md has what it covered.

## Running `tools/browser.mjs`

A run takes minutes, which reads as a hung server: `node tools/browser.mjs |
tail` shows nothing at all until the very end -- `tail` buffers the whole
stream -- and the way to watch a run is to redirect to a file.

Don't read the offset the driver prints as evidence. The assertion is `caret > 0`
and nothing finer: `.item .text` is `flex: 1`, so the middle of its box is past
the end of the sentence and the click sends the caret to the end of the text.
The number is therefore the length of whichever row comes first, and it moves
when the queue does -- it has been 65, 66 and 51 at different times, all of them
passing and none of them meaning anything. docs/Verifying.md has the rest.

What the driver waits on and clicks encodes assumptions about what the pane
shows first. It waited on `.file` to decide the panes had finished loading,
which was true until the pull request pane grew tabs and opened on the
description instead -- after which `.file` does not exist until something
clicks Files. Later it opened "the first file" expecting a highlighted `.js`,
which held until Config & docs became the first group and the first row was
`.gitignore`. Both failed as a 30-second timeout that reads as a hung server,
not as a stale selector. So a change to what the panes show first -- the
default tab, the order of the file groups -- is a run of the driver in the same
commit, not the next one.

## A stub that only echoes is not a session

`CLAUDE_BIN=/bin/cat` was the drivers' stand-in for `claude` because an echo is
the same burst of output a turn is made of. It is not the same *session*. A real
one asks the terminal where the cursor is (`ESC [ ? 6 n`) every ~200ms forever,
and xterm answers every one -- so the PTY is never quiet, and the tab icon's "2
seconds of quiet means idle" never fired in a real browser. cat never asks, so
the driver's icon check passed for as long as the bug existed.

It is a request/response loop, which is why a bare PTY test misses it too: with
nothing answering, Claude asks once and gives up. `tools/claude-stub.mjs` echoes
*and* probes. It needs raw mode and has to swallow the `ESC [ ? ... R` answers
rather than echo them -- a stub that prints its own answers back is output, which
is the state the check is trying to tell apart.

Anything else that reads the PTY's timing has the same blind spot: drive it
against the stub that probes, not against cat.

## Don't wrap `window.WebSocket` in a Playwright init script

`send` in `public/app.js` tests `ws.readyState !== WebSocket.OPEN`. A wrapper
function does not carry the statics, so `WebSocket.OPEN` becomes `undefined`,
every send returns false, and the page silently stops talking to the PTY --
no error, no closed socket. Three runs of a driver investigating an
always-busy tab icon came back green because the instrumentation had switched
off the traffic causing it. Copy `CONNECTING`/`OPEN`/`CLOSING`/`CLOSED` onto
the wrapper, or listen without wrapping. To keep the page from opening a PTY at
all, `page.routeWebSocket('**/pty', () => {})` mocks the socket without touching
the constructor -- `test/browser/suite.js` runs the whole page that way.

Same shape in reverse: a `MutationObserver` in `addInitScript` has no
`document.head` to observe yet, and the throw takes the rest of the init script
with it. Install observers after `goto`.

## Verifying against GitHub

Prefer checking GitHub's real behaviour over trusting its docs — the diff-anchor
scheme in `files.js` was confirmed by grepping the rendered HTML of a public PR,
and that assertion is pinned in `test/files.test.js` with the date.

Test writes against this repo's own PRs. Never against a repo you don't own.

## Green is not evidence that a rebuilt history is intact

Splitting work into a commit per finding means rebuilding files by hand, and
both `npm test` and the drivers run against the *working tree* — so they stay
green while a commit is missing half of what its message claims. It happened
here: the server half of one change was staged out of its own commit and
nothing went red.

The only check that sees it is `git diff <the tree you drove> HEAD` coming back
empty. Take that diff before trusting a reassembled series, not the test run.
