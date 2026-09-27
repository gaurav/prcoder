# Firefox on macOS 27, and the workaround that starts it

`tools/browser.mjs` defaults to Firefox, and on macOS 27 Firefox would not start
from 2026-09-16 to 2026-09-26. Everything in here is that one problem: what it
looked like, what it was not, what it turned out to be, and the one command that
re-checks it. Nothing else in prcoder depends on any of it.

The short form: macOS 27 protects `~/Library/Application Support/Firefox` from
whatever process launched Firefox, and Firefox reads that directory even when
`-profile` points somewhere else. `tools/browser.mjs` now gives Firefox app data
of its own under `data/firefox-appdata/` through `MOZ_APP_DATA` and
`MOZ_LOCAL_APP_DATA`, and with that it starts. [What it is](#what-it-is) has
the detail, and #80 is when to take the workaround out again.

## The one command

```
node tools/firefox-runner/probe.mjs
```

Five launches, each run twice -- once as it is and once with `MOZ_APP_DATA`
set. The five are Playwright's own build headless and headed, the Firefox in
`/Applications` over WebDriver BiDi headless and headed, and the bare binary
with no Playwright in the way. It prints `OK` or `FAIL` per line and ends with a
verdict.

The two halves answer different questions:

- **With `MOZ_APP_DATA`:** does the workaround the driver depends on still
  work? These lines all said `OK` on 2026-09-26.
- **Without it:** has the fix upstream reached us? These lines said `FAIL` from
  2026-09-17 on. When the no-env line for Playwright's own build says `OK`, the
  workaround is dead code, and #80 says what to delete.

The bare binary is the line that says whose bug a failure is: it has no
Playwright in the way, so a failure there is Firefox's own. It is also why the
ad-hoc signature on Playwright's build was ruled out rather than suspected --
the Mozilla-signed Firefox in `/Applications` failed the same way.

The run worth doing is the one after a macOS, Firefox or Playwright update. A
`FAIL` for Playwright's build that says `Executable doesn't exist` means the
build is not installed rather than broken: `npx playwright install firefox` brings
it back. (It was uninstalled on 2026-09-19 and reinstalled on 2026-09-26.)

## The other thing in here

`caret-repro.html` is for the bug that made Firefox the default engine in the
first place: a mousedown inside a `draggable` element goes to the drag machinery
rather than the caret, so a click into a `contentEditable` child lands at offset
0. Open it in a real Firefox and click into the middle of both rows.

The point of the second row is that prcoder's fix -- the grip, which switches
`draggable` off while the pointer is over the text -- hides the bug completely.
So the app feeling fine in Firefox is not evidence the browser was fixed, and
the plain row is the only one that answers the question. If both rows put the
caret where you clicked, the bug is gone, and public/CLAUDE.md,
docs/Verifying.md and issue #61 all describe something that no longer exists.

Run on 2026-09-17: the plain row put the caret at 0, the grip row put it where
it was clicked. The bug is live, the grip is load-bearing, and the run worth
repeating is the one after a Firefox update rather than the next time someone
wonders.

## How it was found

The launch failures, one row per build and version, and the six hypotheses
eliminated on 2026-09-17 are in #61, along with a correction: one of the six,
"TCC grants an agent session lacks", was the cause. It looked ruled out
because a Terminal launch failed too, but Terminal lacks the same grant. That
is worth remembering about any "fails for a human as well" test: it rules out
a difference between the two, not a thing they share.

One line of output still misleads, because the probe prints it on every
no-env `FAIL`. `sandbox_extension_issue_file_to_process ... Operation not
permitted` reads like the cause and is not: it prints for a Firefox that starts
normally, too.

## What it is

Found on 2026-09-26, by searching Mozilla's Bugzilla and Playwright's issues.

macOS 27 added an app-data protection that covers a named list of apps,
Firefox among them, and `~/Library/Application Support/Firefox` in particular.
Apple's [macOS 27 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes#System-Integrity-Protection)
mention it in two sentences under System Integrity Protection;
[Wojciech Reguła's write-up](https://wojciechregula.blog/post/golden-gate-appdata-protection/)
is where the list is. Access is judged against the *responsible process*.
Launched through LaunchServices (the Dock, Finder, `open -a`), that is Firefox,
and it may read its own directory. Launched as a bare binary from a shell, it is
the terminal, and the terminal is denied -- which is every automation tool.

Firefox resolves that directory for `profiles.ini` and `installs.ini` even when
`-profile` names a profile somewhere else. The read fails, the profile service
does not initialise, and Firefox exits with `Could not find profile folder`, or
headed, puts up a "Profile Missing" dialog. Headless there is nothing to show
the dialog on, and that is build 1538's hang. It is also why no `-profile`
path made a difference: the profile was never the thing being read.

It is visible from a shell here, with no Firefox involved:

```
$ ls ~/Library/Application\ Support/Firefox/
ls: /Users/gaurav/Library/Application Support/Firefox/: Operation not permitted
```

### Upstream

- [Bugzilla 2060476](https://bugzilla.mozilla.org/show_bug.cgi?id=2060476),
  "Firefox fails to start on macOS 27 when launched directly from the command
  line; works when launched via LaunchServices". This is our bug. Its thread is
  where the diagnosis happened. Closed as a duplicate of the next one.
- [Bugzilla 2069536](https://bugzilla.mozilla.org/show_bug.cgi?id=2069536),
  "Allow Firefox to run with -profile without access to ~/Library/Application
  Support/Firefox". **Fixed, target 158.** Landed on mozilla-central
  2026-09-24 ([D326501](https://phabricator.services.mozilla.com/D326501)).
  After it, a launch that passes `-profile` should work without the grant.
  Playwright always passes one.
- [microsoft/playwright#42768](https://github.com/microsoft/playwright/issues/42768),
  open, labelled v1.64. The same diagnosis from Playwright's side, with a
  proposed fix: give the bundled build its own `Name`/`Vendor` in
  `application.ini`, so that it stops sharing the real Firefox's directory. A
  maintainer's reply points at the Mozilla fix above.
- [microsoft/playwright#42082](https://github.com/microsoft/playwright/issues/42082),
  closed not-planned. It is the same failure, blamed on the
  `sandbox_extension_issue_file_to_process` line -- the red herring above,
  which #42768 also calls out.

### Workarounds

- **`MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA`, pointed at a directory we own.**
  Checked here on 2026-09-26 against `/Applications/Firefox.app` 156.0.1. The
  bare binary went from `Could not find profile folder` in 98ms to a written
  screenshot in 712ms. Through Playwright,
  `firefox.launch({ channel: 'moz-firefox', env: { ...process.env, MOZ_APP_DATA,
  MOZ_LOCAL_APP_DATA } })` loaded example.com in 1.2s. Playwright's own build,
  reinstalled the same day, starts with them in about two seconds. This is the
  one that needs no settings change.
- **Grant the terminal access to Firefox's data:** System Settings -> Privacy &
  Security -> Files & Folders -> *the terminal* -> Firefox. Mozilla
  recommends this narrower grant over Full Disk Access. It has to be given to
  every host separately -- Terminal, the editor, a CI agent.
- **`open -a Firefox`**, which runs as its own responsible process. It is no use
  to Playwright, which has to spawn the binary itself.
- **Firefox 158 or later**, once it ships, for anything that passes `-profile`.

`tools/browser.mjs` and `test/browser/suite.js` use the first: every Firefox
launch gets both variables, pointed under `data/firefox-appdata/` by
`firefoxEnv()` in `tools/driver.mjs`, which `probe.mjs` imports too. Nothing in it
checks the macOS version, because the variables are harmless where they are not
needed. Leaving them unconditional is also what keeps #80's removal down to
deleting lines.

## What is left

**Taking the workaround out (#80).** The fix is already upstream, so an
upstream bug closing is not the signal. The signal is a Playwright release
whose bundled Firefox is 158 or later, or one that closes
microsoft/playwright#42768 -- and this repo's `package.json` moving to it. After
that, the no-env half of `probe.mjs` confirms the workaround is dead code.

**The Firefox pass under #61** was run on 2026-09-26 with the workaround in
place; the issue's last two comments have what it covered. The Claude pane's
exit bar, on the branch for #75, passed too, and #61 is closed. The other half
of that issue -- whether the caret bug that made Firefox mandatory is still
live -- is answered above and needs no driver.
[public/CLAUDE.md](../../public/CLAUDE.md) has that bug, and the comment on the
`pointerdown` handler in `public/queue.js` has the fixes to it that do not work.
