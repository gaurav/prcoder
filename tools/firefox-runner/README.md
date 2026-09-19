# Firefox, and why it is not running

`tools/browser.mjs` defaults to Firefox, and on this machine Firefox does not
start. Everything in here is that one problem: what it looks like, what it is
not, and the one command that re-checks it. Nothing else in prcoder depends on
any of it -- if you are working in Chromium, `PRCODER_BROWSER=chromium` and you
are done.

## The one command

```
node tools/firefox-runner/probe.mjs
```

Five launches in about two minutes: Playwright's own build headless and headed,
the Firefox in `/Applications` over WebDriver BiDi headless and headed, and the
bare binary with no Playwright in the way. It prints `OK` or `FAIL` per line and
says at the end whether anything worked.

Every line has said `FAIL` since 2026-09-17. The run worth doing is the one
after a macOS or Firefox update; if a line comes back `OK`, #61 is unblocked and
`tools/browser.mjs` should be pointed at whatever that line launched.

## The other thing in here

`caret-repro.html` is for the bug that made Firefox the default engine in the
first place: a mousedown inside a `draggable` element goes to the drag machinery
rather than the caret, so a click into a `contentEditable` child lands at offset
0. Open it in a real Firefox and click into the middle of both rows.

The point of the second row is that prcoder's fix -- the grip, which switches
`draggable` off while the pointer is over the text -- hides the bug completely.
So the app feeling fine in Firefox is not evidence the browser was fixed, and
the plain row is the only one that answers the question. If both rows put the
caret where you clicked, the bug is gone, and CLAUDE.md, docs/Verifying.md and
#61 all describe something that no longer exists.

Run on 2026-09-17: the plain row put the caret at 0, the grip row put it where
it was clicked. The bug is live, the grip is load-bearing, and the run worth
repeating is the one after a Firefox update rather than the next time someone
wonders.

## What fails

| What | How |
| --- | --- |
| Playwright build 1471 (Firefox 134) | `Can't find profile directory` |
| Playwright build 1538 (Firefox 153, currently pinned) | hangs until the caller's timeout |
| Playwright build 1543 (Firefox 155, Playwright 1.63.0) | exits 1, `Could not find profile folder` |
| `/Applications/Firefox.app` 155.0.1, Mozilla-signed | exits 1, `Could not find profile folder` |

Build 1538 hanging rather than exiting is why a default `node tools/browser.mjs`
run sat for Playwright's full three-minute timeout and read as a hung server.
`existsSync(firefox.executablePath())` is true throughout, so that check cannot
tell installed from working; the driver now gives an unforced Firefox 45 seconds
and falls back to Chromium, printing an `engine:` line when it does.

## What it is not

Each of these looked likely enough to cost an hour on 2026-09-17, and each is
eliminated. Don't re-run them.

- **Playwright's build being `adhoc, linker-signed`.** The Mozilla-signed
  Firefox in `/Applications` fails headless the same way, from a bare shell with
  no Playwright anywhere near it. That is the single most useful result here: it
  moves the bug from Playwright to Firefox.
- **The profile directory.** Fails for a `-profile` path that exists, for one
  inside the repo, and for no `-profile` at all.
- **A different Firefox version.** Ten months older fails the same way as
  current. Each attempt is a ~100MB download.
- **TCC grants an agent session lacks.** All of it fails from a Terminal window
  too, run by hand.
- **The Claude Code shell sandbox.** Identical with it on and off, so
  `dangerouslyDisableSandbox` buys nothing and a hung launch is not evidence of
  it.
- **Playwright being unable to drive a stock build.** It can:
  `channel: 'moz-firefox'` drives one over WebDriver BiDi and is supported by
  the pinned 1.62.1. It finds and launches `/Applications/Firefox.app`, then
  fails headless and headed like the rest.

Two things that mislead while reading the output.
`sandbox_extension_issue_file_to_process` is not the smoking gun it reads as --
it prints for the signed Firefox too. And Playwright 1.50's installer is broken
here in its own right: it reports downloading 83MB and leaves an 852K stub,
where `curl` and `unzip` on the same URL give a correct tree.

## What is actually left

Firefox on macOS 27 (27.0 / 26A428) cannot resolve a profile when it is
launched as a bare binary, which is how every automation tool starts it. That is
Mozilla's to fix, or a build newer than 155. Nothing in this repo moves it.

#61 carries the pass that is owed when it does: the pane work driven in Firefox.
The other half of that issue -- whether the caret bug that made Firefox
mandatory is still live -- is answered above and needs no driver.
[CLAUDE.md](../../CLAUDE.md) has that bug and the three fixes to it that do not
work.
