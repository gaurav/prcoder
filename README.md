# prcoder

A PR-focused shell around Claude Code. Run it in a repo, get four panes in your
browser: the pull request you're working on, the diff of whichever file you
clicked, a live Claude Code session, and a task queue that stays out of your
files.

```sh
npm install
npm link                   # once, to run it from any repo; edits here go live

prcoder                    # the PR for the current branch
prcoder 123                # a specific PR
prcoder <pr-url>           # any PR, anywhere
prcoder --model opus       # ...with flags for the Claude session
```

It prints the URL to open, and opens it for you unless `PRCODER_NO_OPEN` is
set. The port is per-repo and stays the same across runs -- see *A URL that
stays put* below.

## What you get

- **Pull request** -- the pull request for the checked-out branch: its description, with checkboxes
  that write back to GitHub, and its changed files, with GitHub's own "viewed" checkbox. A
  switcher checks out another pull request, and a light says whether the branch needs a push or
  a pull.
- **Diff** -- the file you clicked, as GitHub shows it, with links out to GitHub for comments,
  blame and history.
- **Claude Code** -- the real `claude` in a PTY: Escape, slash commands and permission prompts all
  work as they do in a terminal.
- **Queue** -- your own TODO list for this working copy, kept in `.prcoder/` rather than in any
  file you own. An item can be typed into Claude or filed as a GitHub issue.

prcoder follows the branch. It works out the pull request for whatever is checked out, and does
it again every 60 seconds, so a `git checkout` in another terminal -- or by Claude in the middle
pane -- is picked up on its own. Nothing is remembered between polls; every fact comes back from
`git` and `gh`.

[docs/Panes.md](docs/Panes.md) has each pane in detail: layout, ordering, grouping, and what
every control does.

## Arguments

The first argument, if it isn't a flag, is prcoder's: the PR to open. Everything
from the first flag onward is handed to `claude` untouched, so
`prcoder 123 --effort high --model opus` opens PR 123 with that session. There is
no list of Claude's flags here to fall out of date, and nothing to arbitrate when
Claude gains a flag prcoder also wants.

prcoder's own settings are environment variables — `PRCODER_PORT`, `PRCODER_NO_OPEN`,
`PRCODER_VERBOSE`, `CLAUDE_BIN` — which cannot collide with a flag at all.

The first run in a repo picks a port -- seeded from a hash of the path, and
stepped along if that one is busy -- and records it in `.prcoder/port.json`.
Every run after that reads the file, so a repo gets the same URL forever: one
you can bookmark, add to the Dock or point an IDE pane at (see *Finding it
again*), and one that survives renaming the directory. Different repos, and
different worktrees, get different ports, so several sessions run at once. A
busy port falls back to a free one with a note on stderr.

Ports come from 10240-14335 because browsers refuse a list of well-known ones
outright -- Firefox answers *"This address is restricted"*, with nothing on
screen to connect it to prcoder. The list is the
[WHATWG fetch standard's](https://fetch.spec.whatwg.org/#port-blocking) and
10080 is its highest entry, so nothing derived here can land on one. Edit
`port.json` to pin a port permanently (avoid that list), or set `PRCODER_PORT`
to pin one for a single run; `PRCODER_NO_OPEN=1` to be left with just the URL
on stdout, or `PRCODER_OPEN` to a command of your own that gets the URL
appended.

## Scratch space

`data/` is gitignored and is where throwaway output goes -- driver screenshots,
a snapshot of a PR body taken before a write, anything you want next to the code
without committing it. Nothing reads it; it exists so that neither you nor an
agent working in this repo has to reach for `/tmp`.

## Where the queue lives

`.prcoder/queue.json`, in a directory that ignores itself -- it holds a
`.gitignore` of one line, `*`, so nothing is added to your own and nothing
shows up in `git status`. **prcoder does not write anything you own unless you
ask it to.** The only other file there is `port.json`, which is one line and
the port this working copy listens on.

```json
{
  "version": 1,
  "items": [
    { "text": "Add retry to the fetch path",
      "done": false, "doneAt": null, "issue": null, "deleted": false }
  ]
}
```

One list for the repo, whatever is checked out. Items were scoped to the branch
you added them on for a while; that hid them rather than organising them --
moving to an unrelated branch mid-task took the list away, and merging a branch
put its unfinished items out of reach for good. An older file's `branch` fields
are dropped on the next write and those items come back.

The queue is machine-local, which is the trade for not writing your files:
nothing carries it to another machine, and an item that has to outlive this one
can be filed as an issue. Separate worktrees keep separate queues, since each
has its own `.prcoder/`. An earlier prcoder mirrored items into a
`<!-- prcoder:todo -->` block in the PR description; that file's `inPr` and `pr`
fields are dropped on the next write, those items stay in the queue as ordinary
ones, and an old description's block is an ordinary checklist now.

The file is safe for something else to edit -- prcoder writes it through a temp
file and a rename, and re-reads it on every poll -- but the server is the
better way in while prcoder is running: `GET /api/queue`, then `PUT /api/queue`
with `{items}`. [docs/Design.md](docs/Design.md#what-prcoder-writes) has the
rest.

## The terminal you started it from

The window prcoder was launched in is not finished once it has printed a URL.
It keeps a status block pinned under a scrolling log:

```
prcoder  gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    19 active · 1 done · 1 issue
serving  http://localhost:17455   1 tab   q quit · r refresh · v verbose · o open
```

All of it is what the browser's poll worked out anyway, so it costs no extra
`git` or `gh` calls. That also means it only moves when the browser does — and
the browser polls only while its tab is *visible*, so switching away stops the
clock while the socket stays open and the tab count keeps saying `1 tab`. Once
the numbers are more than two minutes old the block says `checked 7m ago` next
to that count, rather than presenting them as current. The block is redrawn in
place and the log scrolls above it, so what happened stays in the scrollback.

**Keys.** `r` polls now, which is the way to move the block without going back
to the browser. `v` cycles quiet → verbose → debug. Verbose narrates the things
that change something you care about — an item queued, ticked, filed as an
issue, a PR checked out. Debug adds every `git` and
`gh` subprocess with its timing, the per-poll count of them, route timings, and
a line when the PR has moved upstream. `PRCODER_VERBOSE=1` or `=2` starts at a
level, which is the only way to see startup itself. `o` reopens the browser.

**Quitting.** Ctrl-C asks first, because quitting kills the PTY and with it the
Claude session in the browser. It says what that costs — tabs open, unpushed
commits, uncommitted files. A second
Ctrl-C at the prompt goes immediately; nothing here can make prcoder unkillable.

None of this happens when stdout is not a terminal. Piped or redirected, you
get plain lines and errors on stderr, which is what a script wants.

If the port was busy, the block keeps saying so for the whole session, with the
URL prcoder *wanted* — the one your bookmark and Dock icon point at, or the one
you named in `PRCODER_PORT`, which the line tells apart. It asks
whoever holds it who they are, so the line tells you whether the window you are
looking for is another prcoder on this repo, another worktree, or nothing to do
with prcoder at all.

## Requirements

Node 22.18 or later in the 22 line, or 24.2 or later. `server.js` starts only
under `import.meta.main`, which older versions do not have: there it is
undefined, and prcoder exits at once having done nothing and said nothing. CI
runs 26.

The [`gh` CLI](https://cli.github.com/), authenticated. All GitHub access goes
through it, so there is no token to configure.

`npm install` brings Playwright for `tools/browser.mjs`; the engines themselves
are a separate download -- `npx playwright install firefox chromium`. The driver
prefers Firefox and falls back to Chromium, because Firefox is what catches
anything to do with selection, focus or dragging, which Chromium is happy to
render correctly and Firefox is not. `PRCODER_BROWSER=chromium|firefox` forces
one. On macOS 27 the driver gives Firefox an app-data directory of its own,
because the system's protection of the real one keeps a Firefox launched from a
terminal from starting at all (`MOZ_APP_DATA`, until #80); [tools/firefox-runner](tools/firefox-runner/README.md)
is what is known about it.

## Finding it again

One prcoder per repo, each a browser tab, soon lost among the pull requests and
diffs you opened while working. Cheapest first:

**In the tabs.** The favicon is a green *PR* square -- blue while that tab's
Claude is working, so a turn you walked away from says whether it is still
going -- and every title ends in `· prcoder`, so in Firefox typing `% prcoder`
in the address bar lists every instance and nothing from github.com. Amber is
free on purpose, held for a third state prcoder cannot see yet: Claude stopped
to ask you something.

**A window per repo.** `PRCODER_OPEN` replaces the platform opener with your
own command, URL appended. Firefox hands the arguments to the running copy, so

```sh
export PRCODER_OPEN='/Applications/Firefox.app/Contents/MacOS/firefox -new-window'
```

gives each prcoder its own window, listed by title in the Window menu and
Mission Control.

**A Dock icon per repo.** This works because the port is fixed: a repo records
its port in `.prcoder/port.json` on the first run and listens on it every run
after (`prcoder` prints it). In Safari, open that URL and choose *File → Add to Dock*. The app
it makes keeps the page title as its window title, so it reads `owner/repo#N ·
…` in Cmd-Tab. From then on start prcoder with `PRCODER_NO_OPEN=1` and click
the icon. The one time the port moves is when a second prcoder is already
running in the same repo; that one says so on stderr and takes a free port.

**Inside IntelliJ.** A stable URL is all an embedded browser needs. There is no
built-in tool window for one, but a JCEF browser plugin such as
[intellij-webbrowser](https://github.com/dervism/intellij-webbrowser) will show
it in a pane. Untested; the terminal's key handling inside JCEF is where to
expect trouble.

There is no single instance with a repo switcher. The server is one repo per
process all the way down, and the Claude session dies with its tab, so a
switcher would mean keeping sessions alive out of view -- the multi-session
management listed below, deliberately not built yet.

## Not here

Syntax-highlighted diffs of modified files, review threads, multi-session management. [docs/Design.md](docs/Design.md) has the full list and the reasoning behind
it, along with why prcoder exists at all; [docs/Security.md](docs/Security.md) has what a
localhost server is exposed to.

`npm test` covers the parts worth pinning down: the queue store, file grouping, GitHub's diff
anchors, every queue ↔ PR-description transition, and the routes that answer without `gh`. What
cannot be unit-tested is driven in a real browser and a real PTY —
[docs/Verifying.md](docs/Verifying.md).
