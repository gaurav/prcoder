# How this repo checks itself

`npm test` is `node --test "test/**/*.test.js"`, and every part of that is load-bearing:

- **Not `node --test test/`.** On Node 26 a directory argument is resolved as a module and dies
  with `Cannot find module`.
- **Not bare `node --test`,** which walks the *whole* working directory, so a scratch checkout under
  `data/` became a second copy of the suite: 386 tests, and one failure on the vendored-xterm path
  check because the clone had no `node_modules` (2026-09-18). Node 26 has no
  `--test-exclude-glob` to exclude it; the flag is gone, and `node --help` lists no replacement.
- **Quoted,** because the glob has to reach node unexpanded. `sh` has no `**`, so unquoted it
  collapses to whatever one directory it matches; that run reported 1 test and passed.
- **Double quotes,** for the same reason the `postinstall` script is Node: single quotes are not
  quotes to cmd.exe.

[test/CLAUDE.md](../test/CLAUDE.md) has what discovery picks up and why that keeps the drivers in
`tools/`.

The suite covers everything that can be checked without a browser or a tty, and one thing that
needs a browser: `test/browser/suite.js` opens the real page from a server started in-process, with
the API routes and the `/pty` socket answered by Playwright from a fixture, so it needs no `gh`, no
`claude` and no PTY. It runs once per engine, from `chromium.test.js` and `firefox.test.js`, and
skips with a note when Playwright or that engine is missing; CI installs both. Its blind spot is the
fixture, which is shaped by hand from what `/api/status` answers today, so a field the server
renames and the client follows still passes. A stub `gh` ([#54](https://github.com/gaurav/prcoder/issues/54))
is what closes that.

## Reading the CSS is not verification

Three UI changes shipped in this repo "verified" by reading the stylesheet, and none of them worked.
Every screenshot taken since has found something reading the CSS had not, from HTML comments
rendering as literal text to `_for_` showing its underscores.

So anything whose correctness is a fact about what a browser or a terminal actually does gets
driven, not reasoned about. The [run-prcoder skill](../.claude/skills/run-prcoder/SKILL.md) is the
short form of this file for an agent about to run the drivers, and a change to how a driver is
launched or what it stubs belongs there too.

## The drivers

Each driver's header says what it does and why; this is what each one reaches, and what it
cannot. They share `tools/driver.mjs`, which refuses a port that is already held and stubs
`PRCODER_AGENT_BIN` ([tools/CLAUDE.md](../tools/CLAUDE.md)). **The UI's controls hit the live PR**, so a
stray click edits a description on GitHub: undo what you write, or stay read-only.

**`node tools/browser.mjs [label]`** drives the UI in a real browser and writes PNGs to
`data/shots/<label>/` (`tools/shots.mjs` says how labels are kept and pruned). It prints what it
measures, with a comment at each check saying which regression the check catches.

- **Firefox by default**, because a Firefox-only caret bug survived every Chromium screenshot
  ([public/CLAUDE.md](../public/CLAUDE.md)). `PRCODER_BROWSER=chromium` forces the other, and
  running both is worth the second minute. On macOS 27, Firefox starts only with the app-data
  workaround every launch takes from `firefoxEnv()` (#80);
  [tools/firefox-runner](../tools/firefox-runner/README.md) has the cause and the re-check, and
  [#61](https://github.com/gaurav/prcoder/issues/61) records the Firefox pass owed while it did
  not start.
- **Written against this repo's PR #1**: its sections, file groups and issue chips. The server
  follows the branch, so a run from a feature branch fails on the section count; `PRCODER_PR=1`
  pins it. Leave it unset on `initial-implementation`, since that run is the only one that covers
  branch-following.
- **What it cannot reach.** Every file in PR #1 is one the pull request adds, so the diff pane's
  DIFF and DELETED views, the hunk outline and a `.tsx` file are `tools/diff-views.mjs`'s, below.
  The queue pane is driven against a queue of its own, `data/browser-queue.json` through
  `--queue`, seeded with an item in every tab, so a run never writes the queue of the working copy
  it runs in.
- **It reports only a `pageerror`.** A Content-Security-Policy that blocks something is a console
  message, so it shows only as whichever later check needed what did not load
  ([#62](https://github.com/gaurav/prcoder/issues/62)). Add a `page.on('console')` for a run that
  changes the header.

**`node tools/diff-views.mjs`** drives the diff pane against
[#87](https://github.com/gaurav/prcoder/pull/87), a draft fixture that is never merged: a file
modified in two places (the DIFF view, the outline's rows, its gutter, its ✕ and *Outline*), a
deleted one, an added `.tsx` file highlighted by the grammar built on jsx and typescript, and two
renames, one untouched and one with a line changed. Its base is an orphan branch, so the fixture
stays those files whatever happens to `main`, and the driver refuses to start if the fixture has
been closed. Run it for any change to what the diff pane draws.

**`node tools/no-pr.mjs`** drives the pane with **no** pull request, which `browser.mjs` cannot
reach from a branch that has one. It clones the remote into `data/main-clone` and runs this
tree's `server.js` there, so a row's checkout lands in the clone rather than your working copy. It
prints every row and the stack nested under each root, and drives the first row only: its `#N`
link, a dirty tree disabling its Switch but not the link, and its Switch checking the PR out. A
fault in a later row shows only in the printed list.

**`node tools/cli.mjs`** drives the terminal half in a real PTY, because the status block, the keys
and the quit prompt all switch off when stdout is not a tty, which is what every other driver's
server gets.

**`node tools/firefox-runner/probe.mjs`** is not a driver and boots no server. It asks only whether
anything on this machine can start Firefox, with and without the workaround, and is worth running
after a macOS, Firefox or Playwright update; [its README](../tools/firefox-runner/README.md) says
how to read it.

## Figures worth re-measuring

- **A poll costs seven subprocess calls**, clean tree or dirty, with or without a pull request.
  `PRCODER_VERBOSE=2` prints the count on every poll, so a change that adds a call shows up.
- **The description's prose is 568px wide in Firefox and 567px in Chromium**, in an 864px pane
  (on `23b192f`). `browser.mjs` prints it every run; a line-length cap is not something the
  stylesheet can be read for.

## What else is checked, and where

Each unit test file says at its top what it pins. Two run the server itself:
`test/api.test.js` over real HTTP in-process, including the `Origin` and `Host` refusals
([Security.md](Security.md)), and `test/queue-local.test.js` in a scratch directory with `gh` and
`git` stubbed to fail, asserting that the routes which only read or rewrite the queue never reach
either. Filing an item with ◎ is the one queue route that does, on purpose, and is not driven.
`test/api.test.js` is also the one test that opens a real `/pty`: with settings `sessionArgs`
refuses, so the claim is that it closes with 1008 before the spawn. The exit bar's Restart and Quit
are `test/browser/suite.js`'s, against a mock socket that closes the way an exiting agent does.

Some things were checked against the real thing rather than a stub, and the evidence sits next to
the code:

- GitHub's diff-anchor scheme: pinned, with the date, in `test/files.test.js`.
- `git ls-remote`'s branch argument is a pattern, not a ref name: `remoteBranchHead` in `git.js`.
- git's exit codes, which differ per command: `answer` in `git.js`.
- The exit bar's settings reaching the agent's argv: `sessionArgs` in `server.js`.
- A patch rebuilt from local git when GitHub sends none: `localPatch` in `git.js`, and the
  comparison against GitHub's own patches in commit 7d3df58.
- Which CSS keeps a dotfile's leading dot in place: `fileRow` in `public/pr.js`.
- Which CSS keeps a repository's name when its owner will not fit: the `.pr-repo` chip in
  `public/style.css`, and its test in `test/browser/suite.js`.
