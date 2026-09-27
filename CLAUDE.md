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
package 'playwright'`. Read `tools/CLAUDE.md` before writing one: it applies
there too, and `tools/driver.mjs` is what to build it on.

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
