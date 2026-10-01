# Ports, and finding prcoder again

Every repo gets its own prcoder, on its own port, in its own browser tab. This file covers how that
port is chosen and how to keep several prcoders apart.

## A port per repo

The first run in a repo picks a port -- seeded from a hash of the path, and stepped along if that
one is busy -- and records it in `.prcoder/port.json`. Every run after that reads the file, so a
repo keeps the same URL: one you can bookmark, add to the Dock or open in an IDE pane (below), and
one that survives renaming the directory. Different repos, and different worktrees, get different
ports, so several prcoders can run at once.

If that port is busy when prcoder starts -- most often because a second prcoder is already running
in the same repo -- it takes a free one for this run and says so, both on stderr and in the status
block ([Terminal.md](Terminal.md)). Pane sizes and other layout choices are stored per port, so a
run on a different port opens with the default layout ([Panes.md](Panes.md#layout)).

Ports come from 10240-14335 because browsers refuse a list of well-known ones outright -- Firefox
answers *"This address is restricted"*, with nothing on screen to connect it to prcoder. The list
is the [WHATWG fetch standard's](https://fetch.spec.whatwg.org/#port-blocking), and 10080 is its
highest entry, so nothing derived here can land on one.

To choose a port yourself, edit `port.json` to change it for good (avoiding that list), or set
`--port` (or `PRCODER_PORT`) for a single run.

## Finding it again

One prcoder per repo, each a browser tab, is soon lost among the pull requests and diffs you
opened while working. Cheapest first:

**In the tabs.** The favicon is a green *PR* square -- blue while that tab's Claude is working, so
a turn you walked away from says whether it is still going -- and every title ends in
`· prcoder`, so in Firefox typing `% prcoder` in the address bar lists every instance and nothing
from github.com. Amber is kept free on purpose, for a third state prcoder cannot see yet: Claude
stopped to ask you something (#51).

**Tab unloaders.** A tab discarded by Firefox under memory pressure, or by an extension such as
[Auto Tab Discard](https://addons.mozilla.org/en-US/firefox/addon/auto-tab-discard/), closes its
socket, and the Claude session goes with it (Terminal.md). A page has no standard way to ask not
to be discarded -- the only signals that extension reads off a page are playing audio and
half-typed form input, and faking either is a hack -- so tell the extension instead: add
`localhost` to Auto Tab Discard's exceptions (right-click its toolbar button, or its options
page). It matches on hostname alone, so that one entry covers every prcoder whatever its port.
A tab brought back after a discard says so in a toast that links here.

**A window per repo.** `PRCODER_OPEN` replaces the platform opener with your own command, with the
URL appended. Firefox hands the arguments to the running copy, so

```sh
export PRCODER_OPEN='/Applications/Firefox.app/Contents/MacOS/firefox -new-window'
```

gives each prcoder its own window, listed by title in the Window menu and Mission Control.

**A Dock icon per repo.** In Safari, open the URL `prcoder` prints and choose *File → Add to Dock*.
The app it makes keeps the page title as its window title, so it reads `owner/repo#N · …` in
Cmd-Tab. From then on, start prcoder with `PRCODER_NO_OPEN=1` and click the icon. This works only
because the port stays put.

**Inside IntelliJ.** A stable URL is all an embedded browser needs. There is no built-in tool
window for one, but a JCEF browser plugin such as
[intellij-webbrowser](https://github.com/dervism/intellij-webbrowser) will show it in a pane.
Untested; the terminal's key handling inside JCEF is where to expect trouble.

There is no single instance with a repo switcher. The server is one repo per process all the way
down, and the Claude session dies with its tab, so a switcher would mean keeping sessions alive
out of view -- the multi-session management [Design.md](Design.md) lists as deliberately not built.
