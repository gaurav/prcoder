# prcoder

A local server + browser UI wrapping a real `claude` PTY. See README.md for what
it does and how to run it, `docs/Design.md` for why it works the way it does --
the guards, the non-goals -- `docs/Security.md` for what the server is exposed to
and the checks new work has to keep, and `docs/Verifying.md` for what this repo
checks and how. Keep those three true when you change what they describe.

**The queue is yours, and moves out one way.** It no longer mirrors into the PR
description; "The queue is yours" in `docs/Design.md` says what replaced that and
what is still to come. Don't bring a sync back without reading it.

## Scratch work goes in `data/`

`data/` is gitignored and is where anything temporary belongs -- driver
screenshots, snapshots of a PR body taken before a write, intermediate output.
Not `/tmp`: reads outside this working directory are blocked, so a screenshot
written to `/tmp` is one nobody in this session can look at.

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

**Run tests with bare `node --test`, not `node --test test/`.** On Node 26 a
directory argument is resolved as a module and dies with `Cannot find module`.
Bare discovery treats *everything* under `test/` as a test file, which is why
the drivers live in `tools/` — `browser.mjs` for the UI, `cli.mjs` for the
terminal. Either one under `test/` would run on every `npm test`, spawn a
server and drive a browser or a PTY.

`node:test` is a preference, not a constraint. If it ever gets in the way —
maintainability, a matcher you keep hand-rolling, watch mode, anything — the
owner is fine with swapping in a real test framework (stated 2026-09-05). The
rule above is about the CLI's directory argument, not about staying on the
built-in runner.

## Subprocess errors lie by omission

Two failures this repo depends on are invisible rather than loud, so check the
real behaviour before trusting either.

`execFile` hands stderr to its callback and never puts it on the error object.
`run` in `github.js` attaches it, and every `no pull requests found`-style guard
reads it — without that they match against `undefined` and silently never fire.

git's exit codes are per-command, and a non-zero one is often an answer rather
than a failure. `rev-parse --verify --quiet` exits 1 for a missing object where
`cat-file -e` exits 128; `merge-base --is-ancestor` exits 1 to mean "no" and 128
to mean "bad object". `asks()` in `git.js` treats one specific code as the
answer and rethrows the rest, so pick the command whose codes you can tell apart.

## Raw mode swallows SIGINT

`term.js` puts stdin in raw mode so a keypress can be read, and raw mode turns
ISIG off: Ctrl-C then arrives as byte 3 on stdin and **no SIGINT is delivered
at all**. The keypress handler is the only Ctrl-C there is, so a bug in it is a
process you cannot interrupt. That is why a second Ctrl-C at the confirm prompt
exits unconditionally, and why `kill -TERM` is wired separately -- a signal
with a default action never runs `exit` handlers, so the cursor and the raw
mode would never be restored.

None of it exists without a tty. `process.stdout.isTTY` gates the block and
`process.stdin.isTTY` gates the keys, so a piped run behaves as it always did
-- which is what `tools/browser.mjs` (`stdio: 'ignore'`) is standing proof of.
`tools/cli.mjs` drives the other half, in a real PTY.

## Old descriptions still carry the mirror's block

Descriptions written by an earlier prcoder hold a checklist between prcoder's
own HTML-comment markers. Nothing reads or rewrites that block any more: it is
an ordinary checklist now, ticked like any other from the PR pane, and a line
moved in with ◇ is appended at the end of the body rather than into it. Leave
old blocks alone; hand-editing them is safe.

## The Claude pane is not prcoder's to draw on

`term.write()` in `public/app.js` puts bytes into xterm's buffer without them
ever reaching the PTY, which makes it look like the way to tell the user
something in the middle pane. It is not, for two reasons.

Claude never sees it. The only path to the session is `{type:'input'}` ->
`pty.write` (`server.js`), which is what `sendToClaude` uses. So a notice
written this way that is *addressed* to Claude -- "re-read any open files" was
one, until 2026-09-05 -- is read by nobody. prcoder has no way to put anything
into Claude's context that is not a typed user turn; issue #21 is where the
options are written down.

And Claude Code owns that viewport. With `"tui": "fullscreen"` it is on the
alternate screen, repainting frames over whatever is there; anything prcoder
writes survives until the next one. The exception is `ws.onclose`, which writes
`[claude exited]` precisely because the PTY is dead and nothing will repaint.

Notices for the human go to `toast()`, which sits over the panes and is nothing
to do with the terminal. Pass `sticky` for one that stays true until acted on
rather than reporting something already finished -- it waits for a click instead
of timing out.

## One engine is not "a real browser"

`tools/browser.mjs` ran Chromium only, and a Firefox-only bug survived every
screenshot it ever took: in Firefox a mousedown inside a `draggable` element
goes to the drag machinery rather than to the caret, so clicking into a
`contentEditable` child lands at offset 0 instead of where you clicked. Chromium
places the caret correctly with the same markup, so there was nothing to see.

prcoder is used in Firefox, so `tools/browser.mjs` now defaults to it and falls
back to Chromium only when it is not installed; `PRCODER_BROWSER=chromium|firefox`
forces one. That is Playwright's own patched Firefox, not the one in
/Applications -- Playwright cannot drive a stock build, so the check is
`existsSync(firefox.executablePath())` and the fix for a miss is
`npx playwright install firefox`. Running both is worth the second minute: the
caret bug is invisible in Chromium and fatal in Firefox, and it is the one thing
here that only one engine can tell you about.

The caret check prints `caret: 12 of 34` -- an offset into that row's text, and
the length of it. Both are needed, and reading only the first is how the check
sat half-broken. `.item .text` is `flex: 1`, so its box runs to the end of the
row and the middle of the box is past the end of the sentence; clicking there
sent the caret to the end of the text, and `caret > 0` passed. That is all the
old `65` and `66` in this file ever were -- the length of whatever row came
first, one apart because the two engines round a click past the end
differently. The driver measures the text node and aims inside it now, so the
engines agree and the number means what it says. `0 of n` is the Firefox drag
bug; `n of n` means the click missed the glyphs and the check is not checking
anything.

What the driver waits on encodes an assumption about what the pane shows first.
It waited on `.file` to decide the panes had finished loading, which was true
until the pull request pane grew tabs and opened on the description instead --
after which `.file` does not exist until something clicks Files. The failure is
a 30-second `waitForSelector` timeout that reads as a hung server, not as a
stale selector. It waits on `#pr-head .pr-title` now; if you change which tab
opens by default, check every `waitForSelector` in `tools/browser.mjs` in the
same commit rather than the next one.

Three fixes for that bug do not work, so they are not worth retrying:
`draggable="false"` on the child, `-moz-user-select` on the child, and leaving
it to the browser. All three leave the caret at 0. The row has to stop being
draggable for as long as the pointer is on its text, which is why the queue
rows have a grip.

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
the wrapper, or listen without wrapping.

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
