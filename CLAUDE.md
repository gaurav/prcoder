# prcoder

A local server + browser UI wrapping a real `claude` PTY. See README.md for what
it does and how to run it.

## Two traps

**Don't delete the `postinstall` chmod in package.json.** It looks like dead
setup. npm blocks node-pty's own install script, which is what makes
`prebuilds/*/spawn-helper` executable. Without it every PTY spawn fails with a
bare `posix_spawnp failed` — no mention of permissions, and node-pty still
imports fine, so it reads like a Node ABI problem when it isn't.
`npm install-scripts approve node-pty` does *not* replace it — tested 2026-08-23,
the approved script is `node-gyp rebuild` and the prebuilt helper still lands
non-executable.

**Run tests with bare `node --test`, not `node --test test/`.** On Node 26 a
directory argument is resolved as a module and dies with `Cannot find module`.
Bare discovery treats *everything* under `test/` as a test file, which is why
the drivers live in `tools/` — `shot.mjs` for the browser, `cli.mjs` for the
terminal. Either one under `test/` would run on every `npm test`, spawn a
server and drive a browser or a PTY.

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
-- which is what `tools/shot.mjs` (`stdio: 'ignore'`) is standing proof of.
`tools/cli.mjs` drives the other half, in a real PTY.

## Never write the queue's markers in prose

`splitPrBlock` in `queue.js` finds prcoder's block with `body.indexOf(OPEN)` —
the *first* occurrence. Write `<!-- prcoder:todo -->` literally into a PR
description's prose, as a sentence about how prcoder works, and the next queue
write treats that sentence as the start of the block and replaces everything
from it to the real closing marker. Half the description, gone, on a poll.

This repo describes prcoder in its own PRs, so the trap is live here rather
than theoretical — it was caught in review on 2026-09-01, one edit before
being pushed. Say "prcoder's own HTML-comment markers" instead, and if you must
show the literal string, check that the body still contains exactly one of each
marker before writing it.

## Verifying against GitHub

Prefer checking GitHub's real behaviour over trusting its docs — the diff-anchor
scheme in `files.js` was confirmed by grepping the rendered HTML of a public PR,
and that assertion is pinned in `test/files.test.js` with the date.

Test writes against this repo's own PRs. Never against a repo you don't own.
