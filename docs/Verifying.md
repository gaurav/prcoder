# How this repo checks itself

`npm test` is `node --test` — bare, never `node --test test/`, for the reason in
[CLAUDE.md](../CLAUDE.md). That covers everything that can be checked without a browser or a tty.
This file is about the rest, and about the rule that produced it.

## Reading the CSS is not verification

Three UI changes shipped in this repo "verified" by reading the stylesheet: the tab title, the pane
width and font sizes, and the description's checkboxes. None of them worked. Every screenshot taken
since has turned up something reading the CSS had not — prcoder's own block markers rendering as
literal text, `##` headings rendering as literal `##`, a stray `</details>` the moment the
description grew one, and `_for_` with its underscores showing because a formatter had rewritten
`*for*` in the body.

So: anything whose correctness is a fact about what a browser or a terminal actually does gets
driven, not reasoned about. The two drivers exist for the two halves.

## The two drivers

`node tools/browser.mjs` boots its own server and drives the UI in a real browser, writing PNGs to
`data/shots`. Firefox by default — see [CLAUDE.md](../CLAUDE.md) for why one engine is not "a real
browser", and for the three fixes to the Firefox caret bug that do **not** work.
`PRCODER_BROWSER=chromium` forces the other; running both is worth the second minute.

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

## The measured figures

Numbers that only mean something re-measured. The driver prints all of these on every run, so they
are re-checked rather than quoted:

| What | Firefox | Chromium |
| --- | --- | --- |
| Description prose width, in an 864px pane | 568px | 567px |
| Title line widths at the pane's 375px floor | 285, 263, 236 | 285, 263, 236 |

The prose cap and the title's `text-wrap: balance` are both properties no stylesheet can be read
for, and the 375px floor is the only width at which balancing does anything — a real title runs to
three lines there, and a greedy wrap leaves the last holding a word or two. The title figures were
taken by hand for most of this repo's first PR while the description claimed the driver measured
them; it does now.

A poll costs **seven subprocess calls**, clean tree and dirty alike. `PRCODER_VERBOSE=2` prints the
count on every poll, so a change that adds a call is visible rather than inferred.

Every figure here was measured on `5f7d6cc`, in both engines.

## What gets checked, and where

Unit tests cover the queue store, the port derivation, the description renderer, file grouping,
GitHub's diff anchors, the sync verdict, every queue ↔ PR-description transition, the status block's
wording, the queue light's states, and the terminal's own erase bookkeeping — the last because a
block that miscounts its rows either eats scrollback or leaves a smear, and both look like anything
but an off-by-one.

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
is refused rather than parsed into a pass. Only the handlers that answer without `gh` — the rest
would be testing this machine's GitHub auth.

Some things can only be checked against the real thing, so they are:

- **GitHub's diff-anchor scheme** (`diff-` + sha256 of the path) was confirmed by grepping the
  rendered HTML of a public PR rather than taken from documentation, and the assertion is pinned so
  it fails loudly if GitHub changes it.
- **`git ls-remote`'s branch argument is a pattern, not a ref name.** Checked against real git in a
  scratch repo, because the belief *was* the bug: with only `refs/heads/feature/topic` on the
  remote, a bare `topic` comes back with its sha. A stub would have pinned the belief.
- **The `git` exit codes the sync verdict depends on** — see [CLAUDE.md](../CLAUDE.md), which
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
position crossed to the other tab and back, because the switch is what used to lose it; quoted sections, spliced
into the `/api/status` response because neither of this repo's own descriptions contains a `>`; the
splitters dragged to known coordinates and the page reloaded, and moved again from the keyboard —
focus lands, an arrow moves the line by ten and shift-arrow by fifty, `Home` resets, and
`aria-valuenow` reports the position as a percentage of the window; the switcher, both sync-light
states, the Deleted tab (which needed a tombstone put in through the API before it would render at
all), the queue's synced light, the description's checkboxes and the disabled states; and both
toasts, the four-second one watched to fade and the sticky one clicked away; the head's row of links out, whose right
alignment is measured against the head's own content edge with the title's left edge as the control,
because `justify-content` on a row that is also `.meta` is an agreement between two rules that only
the browser settles; the description's two
repository-relative link kinds, a relative path and a bare `#N`, read back as resolved hrefs off
this repo's own description rather than as the source they used to show; and the tab icon going
blue while the PTY prints and back to green two seconds after it stops, typed at the
`tools/claude-stub.mjs` stub, whose echo is the same burst of output a Claude turn is made of and
whose cursor-position probe, every 200ms throughout, is what a real session sends between turns. The
green half is the assertion: it was a `cat` stub that never probed, so the icon stuck busy from the
first paint in every real session and no check could see it.

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
