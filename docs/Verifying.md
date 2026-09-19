# How this repo checks itself

`npm test` is `node --test "test/**/*.test.js"` — a quoted glob, never `node --test test/`, because
Node 26 resolves a directory argument as a module and dies with `Cannot find module`, and never bare
either, because that walks the whole working directory and runs any scratch checkout under `data/`
as a second suite ([CLAUDE.md](../CLAUDE.md) has the rest, including why the quotes are
load-bearing and why that puts the drivers in `tools/`). That covers everything that can be checked
without a browser or a tty, plus one test that needs a browser: `test/browser.test.js` opens the real
page from the server started in-process, with the API routes and the `/pty` socket answered by
Playwright from a fixture, so it needs no `gh`, no `claude` and no PTY, and asserts the things this
pane has shipped broken -- raw markup as text, headings, checkbox write-back, the issue lists, the
tab count -- and a quoted section, which is in its fixture because neither of this repo's own
descriptions contains a `>` and so no driver run has ever shown one. It skips with a note when Playwright or Chromium is missing; CI installs Chromium so it
runs there. Its blind spot is its fixture, shaped by hand from what `/api/status` answers today, so a
field the server renames and the client follows still passes; the `gh` stub issue is what closes that.
This file is about the rest, and about the rule that produced it.

## Reading the CSS is not verification

Three UI changes shipped in this repo "verified" by reading the stylesheet: the tab title, the pane
width and font sizes, and the description's checkboxes. None of them worked. Every screenshot taken
since has turned up something reading the CSS had not — prcoder's own block markers rendering as
literal text, `##` headings rendering as literal `##`, a stray `</details>` the moment the
description grew one, and `_for_` with its underscores showing because a formatter had rewritten
`*for*` in the body.

So: anything whose correctness is a fact about what a browser or a terminal actually does gets
driven, not reasoned about. Three drivers exist for it: two for the two halves of the window, and
one for the pane the first of them cannot reach. The
[run-prcoder skill](../.claude/skills/run-prcoder/SKILL.md) is the short form of this section for
an agent about to run them; a change here that alters how a driver is launched or what it stubs
belongs there too.

## The drivers

`node tools/browser.mjs` boots its own server and drives the UI in a real browser, writing PNGs to
`data/shots`. Firefox by default, because a Firefox-only bug — a click into a draggable row's text
putting the caret at offset 0 — survived every Chromium screenshot; see [CLAUDE.md](../CLAUDE.md)
for the rest, and for the three fixes to it that do **not** work.
`PRCODER_BROWSER=chromium` forces the other; running both is worth the second minute — when both
run. As of 2026-09-17 Firefox does not start at all on this machine, so a default run waits 45
seconds and falls back to Chromium with an `engine:` line saying so -- `PRCODER_BROWSER=chromium`
skips the wait; [tools/firefox-runner](../tools/firefox-runner/README.md) is why, and is the
one-command re-check.

Its assertions are written against this repo's own PR #1 — that description's sections, file groups
and issue chips — and the server follows whatever branch you are on, so a run from a feature branch
drives a pull request they do not fit and fails on the section count. `PRCODER_PR=1` pins it.

Every file in PR #1 is one it adds, so the driver only ever sees the diff pane's NEW title: the
plain-diff DIFF and the DELETED views are on a path it never takes. They were checked on
2026-09-18 by starting a stubbed prcoder on a pull request with the real mix (`gaurav/ideas#13`,
`CLAUDE_BIN=tools/claude-stub.mjs PRCODER_NO_OPEN=1 PRCODER_PORT=<free>` from that repo) and
screenshotting `#diff` per file from a script in `data/`. Do that again for anything that changes
what the pane draws; a run against this repo alone says nothing about the two states it lacks.

The hunk outline is out of reach for the same reason -- no hunks, so `#diff-outline` is empty and
hides itself, and its gutter with it. Making that gutter draggable was checked on 2026-09-18 from a
script in `data/` against the prcoder already running on this repo: rows injected into the outline,
the line dragged, and the outline's width read back against the cursor's own position, which is what
says the number written is a distance from the right edge rather than a drift. The gutter is hidden
before the injection and shown after, which is the empty case the running app is always in here.

The pane with **no** pull request is out of that driver's reach for the same reason — it follows the
branch it runs on, that branch has PR #1, and `PRCODER_PR` only pins a different one — so
`node tools/no-pr.mjs` is the third driver. It clones the remote into `data/main-clone`, which
arrives on `main`, and runs *this* working tree's `server.js` with the clone as its working
directory: `repo` in there is only `process.cwd()`, and nothing is installed in the clone because
every import resolves from the directory `server.js` is in. It drives the list of pull requests
that merge into the branch, its dimmed state on a dirty tree (a tracked file, since `userDirt` reads
`--untracked-files=no`), and the checkout a row performs — which is the other reason for the clone:
that checkout has to land somewhere that is not your own working copy. The clone is left behind and
reset on the next run; deleting it is safe.

Pinning is also the way to run the whole file and never touch the path every real user is on, so
leave it unset on `initial-implementation`: that run is the only thing that covers branch-following,
and the driver's second line says which of the two you just did.

`node tools/cli.mjs` drives the other half in a real PTY, because none of the terminal UI exists
without a tty: the status block, the keys and the quit prompt all switch off the moment stdout is a
pipe, which is exactly what a scripted `node server.js` gets — and so exactly what the browser
driver proves *nothing* about. It prints escape sequences as `\e`, so a block claiming six rows with
five underneath it is visible rather than a mystery smear.

Both refuse to start if their port (17434, 17455) is already held, because `server.js` quietly falls
back to a free one and a driver would otherwise drive whatever *is* on that port. Both stub
`CLAUDE_BIN`: every page load spawns it in a PTY, and an unstubbed run starts a real Claude session
per screenshot. `tools/cli.mjs` stubs it with `/bin/cat`, which is all the terminal half needs;
`tools/browser.mjs` uses `tools/claude-stub.mjs`, which also sends the probe a real session sends,
because a stub that only echoes cannot fail the icon check. The UI's controls hit the live PR, so a stray click edits a description on GitHub —
undo what you write, or stay read-only.

Chromium has a quieter version of the same trap. Playwright serves a headless run from
`chromium_headless_shell-<build>` and a headed one from `chromium-<build>`, which are two separate
downloads under one `npx playwright install chromium`; this machine has the shell for build 1234
and not the browser. So `PRCODER_BROWSER=chromium` works, and the same run with `headless: false`
fails with `Executable doesn't exist at .../chromium-1234/...`, which reads as a broken Playwright
install rather than as the one missing half it is. `npx playwright install chromium` fixes it.

The browser driver reports a `pageerror` and nothing else, which is the blind spot to know about
when changing the Content-Security-Policy `serveFile` sends ([Security.md](Security.md)). A
directive that blocks a script, a stylesheet or a font is a console message rather than a page
exception, so the driver says nothing, and the only thing that turns red is whichever check needed
the thing that did not load — the icon check covers xterm, the pane figures cover the stylesheet.
That is real coverage, but it is indirect: a directive that nothing exercises can be wrong through a
green run. Add a `page.on('console')` line for the run that changes the header; #62 is making that permanent.

No driver touches the **queue pane** at all. Its row actions, the grip's arrow-key reorder, drag and
drop and the tabs are checked by hand or not at all -- the grip exists because of a Firefox-only
caret bug found that way. [#65](https://github.com/gaurav/prcoder/issues/65) is the fourth driver,
and what it needs first: a queue of its own, which a clone gives for free the way `tools/no-pr.mjs`
already takes one.

`node tools/firefox-runner/probe.mjs` is not a driver and boots no server. It asks a narrower
question — can anything on this machine drive Firefox — by trying Playwright's own build and the
Firefox in `/Applications` over WebDriver BiDi, headless and headed, and then the bare binary with
no Playwright in the way. That last one is what says whose bug a failure is, and it is why the
ad-hoc signature on Playwright's build is ruled out rather than suspected. Every line has said
FAIL since 2026-09-17; the run that matters is the one after a macOS or Firefox update, and
[the directory's README](../tools/firefox-runner/README.md) is what to read before adding a case.

## The measured figures

Numbers that only mean something re-measured. The driver prints all of these on every run, so they
are re-checked rather than quoted:

| What | Firefox | Chromium |
| --- | --- | --- |
| Description prose width, in an 864px pane | 568px | 567px |
| Title line widths at the pane's 375px default width | not re-measured | 251, 257, 318 |

The prose cap and the title's `text-wrap: balance` are both properties no stylesheet can be read
for, and the pane's 375px default width is the only one at which balancing does anything — a real
title runs to three lines there, and a greedy wrap leaves the last holding a word or two. The title figures were
taken by hand for most of this repo's first PR while the description claimed the driver measured
them; it does now.

That last row is the one figure here that is about GitHub's data rather than about this code: it is
the *current* PR title, wrapped, so it moves when the title is rewritten and says nothing about a
regression when it does. It was 285, 263, 236 in both engines under the title this PR carried on
`5f7d6cc`. Re-measured in Chromium on 2026-09-18 (`4879171`); Firefox is the pass #61 owes.

A poll costs **seven subprocess calls**, clean tree and dirty alike. `PRCODER_VERBOSE=2` prints the
count on every poll, so a change that adds a call is visible rather than inferred. The pull requests
into the current branch are filtered out of the list the switcher already holds for that reason: a
`gh pr list --base` of their own would be an eighth call, on the one branch that already makes an
extra one ([#19](https://github.com/gaurav/prcoder/issues/19)). The expensive
path a changed `updatedAt` takes costs one call more than it did: a single `gh api graphql` that
asks for every linked issue's title at once, however many there are.

Every figure here was measured on `5f7d6cc`, in both engines.

## What gets checked, and where

Unit tests cover the queue store, the port derivation, the description renderer, file grouping and
the order the folds come out in, GitHub's diff anchors, the sync verdict, every queue ↔
PR-description transition, the status block's wording, the queue light's states, and the terminal's
own erase bookkeeping — the last because a block that miscounts its rows either eats scrollback or
leaves a smear, and both look like anything but an off-by-one.

Two of them pin a *coupling* rather than a behaviour. The description wins on `done`, so a tick the
description never received is reverted by the next merge — correct, and exactly why the store may
never move without the body moving with it. And a tick is sent as a *position* in the body's list of
checklist lines, so `public/tasks.js` holds that grammar for both sides and a test walks one body
through both walks; two callers of one function can still be handed different bodies.

The routes are tested over real HTTP. `test/api.test.js` listens on port 0 in-process rather than
spawning anything — everything that listens in `server.js` is behind `import.meta.main`, so
importing the module starts nothing, and a PTY comes only from a `/pty` websocket no test opens. It
pins `/api/whoami`'s cache-only contract, the 404 and 500 shapes, static serving, the four
hand-written `vendor` paths into `node_modules` (which break silently on an xterm upgrade and
surface as a blank page), and the origin refusal: an `Origin` that is not ours is a 403 before any
handler runs, one that matches reaches the handler, one that is absent does too, and a malformed one
is refused rather than parsed into a pass. A `Host` that is not a loopback name is refused with or
without an `Origin`, which is the DNS-rebinding case; that test sends its requests with `node:http`,
because `fetch` will not set `Host`. Only the handlers that answer without `gh` — the rest
would be testing this machine's GitHub auth.

Some things can only be checked against the real thing, so they are:

- **GitHub's diff-anchor scheme** (`diff-` + sha256 of the path) was confirmed by grepping the
  rendered HTML of a public PR rather than taken from documentation, and the assertion is pinned so
  it fails loudly if GitHub changes it.
- **`git ls-remote`'s branch argument is a pattern, not a ref name.** Checked against real git in a
  scratch repo, because the belief *was* the bug: with only `refs/heads/feature/topic` on the
  remote, a bare `topic` comes back with its sha. A stub would have pinned the belief.
- **The `git` exit codes the sync verdict depends on**, because a non-zero exit is often an answer
  rather than a failure and git's codes differ per command — see [CLAUDE.md](../CLAUDE.md), which
  records which command returns what and why `asks()` exists.
- **Which CSS stops a dotfile's leading dot migrating to the end of its path**, decided by measuring
  four candidates in both engines rather than by reasoning about the bidi algorithm. The column is
  `direction: rtl` so a long path is cut at the head and keeps its filename; the first guess,
  `unicode-bidi: plaintext`, fixes the character order and moves the cut to the tail, which is the
  thing the rtl was for. An LRM prefix and an `LRI…PDI` wrap both work and both put invisible
  characters into text people copy. `<bdi>` needs no styles of its own and is what shipped. The
  driver measures the dot's position with range rectangles rather than screenshotting it, because at
  13px a misplaced leading dot reads as a full stop and is invisible either way.

And some only on screen. Driven in the browser: the two tabs and the folded description, including a
forced poll to prove a fold survives `renderPr` replacing the whole pane, and each tab's scroll
position crossed to the other tab and back, because the switch is what used to lose it; the
three splitters between the panes dragged to known coordinates and the page reloaded (not the
fourth, inside the diff pane, which no pull request here can show), and moved again from the keyboard —
focus lands, an arrow moves the line by ten and shift-arrow by fifty, `Home` resets, and
`aria-valuenow` reports the position as a percentage of the window and changes when the line moves
(it was a ResizeObserver on the 1px gutter, which a move never resizes); the switcher, both sync-light
states, the Deleted tab (which needed a tombstone put in through the API before it would render at
all), the queue's synced light, the description's checkboxes and the disabled states; and both
toasts, the four-second one watched to fade and the sticky one clicked away; the head's row of links out, whose right
alignment is measured against the head's own content edge with the title's left edge as the control,
because `justify-content` on a row that is also `.meta` is an agreement between two rules that only
the browser settles, and whose separators are hit-tested at their own centres -- they were an
`a::before`, which lives inside the link's box, so each dot was underlined with its link and a press
on one followed the link to its right, and that a separator is now its own element says nothing
about where a click lands; the description's two
repository-relative link kinds, a relative path and a bare `#N`, read back as resolved hrefs off
this repo's own description rather than as the source they used to show; and the tab icon, staying
green while a line is typed at the `tools/claude-stub.mjs` stub -- an echo is output too, and the
icon reporting busy while Claude waits on you is the bug that reading is for -- then going blue on
the Enter that starts the turn, and back to green two seconds later even though the stub's
cursor-position probe, every 200ms throughout, is still arriving. That last one is its own
assertion: it was a `cat` stub that never probed, so the icon stuck busy from the first paint in
every real session and no check could see it. And a queue row dragged by its grip onto
the row above, then a synthetic `drop` carrying only `text/plain` -- a link or a selection -- on the
same row, which must leave the queue exactly as the real drag did. Row drags carried `text/plain`
too, until that drop read as a drag from row `NaN` and moved the first item; run against the old
code the check prints `MOVED`, in both engines. Then the same row moved back from the keyboard: focus
on its grip, Down, and the pair is in its original order with focus still on the row that moved.

Driven in the PTY: the tab count, `r` forcing a poll, the busy-port line finding the other instance
and naming its repo, the quit prompt naming what it costs, a second instance with no tab quitting on
one press with no prompt at all, and no `claude` left running afterwards.

## What the caret assertion actually proves

Narrower than it looks, and worth knowing before trusting it. The assertion is `caret > 0` — that a
click into a queue item's text did not land at position 0, which is what the Firefox drag bug does
([CLAUDE.md](../CLAUDE.md)). That is all it proves.

The offset it prints is not a constant and is not evidence. `.item .text` is `flex: 1`, so its box
runs to the end of the row and the middle of the box is past the end of the sentence — the click
lands after the last glyph and the caret goes to the end of the text. So the number printed is the
length of whichever row happens to come first, which is why it moves when the queue's contents
move. A check that would catch a click landing on the *wrong* character has to aim at the
text node rather than at the box; that is a two-line fix, and it is on the branch stacked on this
one rather than cherry-picked back here.
