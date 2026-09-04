# prcoder

A PR-focused shell around Claude Code. Run it in a repo, get three panes in your
browser: the pull request you're working on, a live Claude Code session, and a
task queue that stays out of your files.

```sh
npm install
npm link                   # once, to run it from any repo; edits here go live

prcoder                    # the PR for the current branch
prcoder 123                # a specific PR
prcoder <pr-url>           # any PR, anywhere
prcoder --model opus       # ...with flags for the Claude session
```

Then open <http://localhost:1618>.

## Where the repo is

prcoder follows the branch. It resolves the pull request for whatever is
checked out, and re-derives that every 60 seconds, so a `git checkout` in
another terminal -- or by Claude in the middle pane -- is picked up on its own.
Nothing is remembered between polls; every fact comes back from `git` and `gh`.

The switcher in the PR pane header lists open pull requests and runs
`gh pr checkout` to move between them. Uncommitted work hides it behind a
Commit button, because the checkout would fail anyway. On a branch with no pull
request the pane says so, disables the editing controls, and offers to create
one -- pushing the branch first if GitHub has not seen it.

Next to it, a light for the one thing prcoder cannot fix for you: whether the
branch and the remote agree. It reads `unpushed`, `N unpushed`, `pull needed`
or `diverged`, and it needs no `git fetch` -- GitHub's view of the branch head
comes back with the pull request metadata. That does mean it is only as fresh
as the last poll.

## Arguments

The first argument, if it isn't a flag, is prcoder's: the PR to open. Everything
from the first flag onward is handed to `claude` untouched, so
`prcoder 123 --effort high --model opus` opens PR 123 with that session. There is
no list of Claude's flags here to fall out of date, and nothing to arbitrate when
Claude gains a flag prcoder also wants.

prcoder's own settings are environment variables — `PRCODER_PORT`, `PRCODER_NO_OPEN`,
`PRCODER_VERBOSE`, `CLAUDE_BIN` — which cannot collide with a flag at all.

The port is derived from the repo's path, so a repo gets the same URL every
run -- one you can bookmark, add to the Dock or point an IDE pane at (see
*Finding it again*). Different repos, and different worktrees, get different
ports, so several sessions run at once. A busy port falls back to a free one
with a note on stderr. Set `PRCODER_PORT` to pin one instead, `PRCODER_NO_OPEN=1`
to be left with just the URL on stdout, or `PRCODER_OPEN` to a command of your
own that gets the URL appended.

Each tab names itself `owner/repo#N · pull request title` -- the branch and
`(no PR)` when there isn't one -- and re-names itself as the branch moves, so a
row of prcoder tabs stays readable at tab width.

## The panes

Every line between the panes is a splitter: drag it to resize, double-click it
to drop back to the default. The sizes are remembered per browser, so the
layout you settle on is the one the next `prcoder` opens with.

**Pull request** — title, description, checks, linked issues, and every changed
file grouped as *Tests* / *Code* / *Config & docs*, tests first, because tests
are the fastest way to see what functionality actually changed. The checkbox on
each file is GitHub's own "viewed" checkbox: tick it here and it's ticked on
github.com. Checklists in the description are real checkboxes too, and they
write straight back to the description -- ticking one inside prcoder's own TODO
block ticks the queue item it came from. Clicking a file opens its diff in the
**Diff** pane; cmd/ctrl-clicking opens GitHub's diff viewer at that file
instead.

**Diff** — the selected file's patch, rendered plainly above the terminal so
select → read → tick viewed → ask Claude never leaves the window. It shows the
same hunks GitHub does (fetched once per push and cached), refreshes itself when
the branch head moves, and links out to GitHub for anything the plain rendering
can't do — syntax highlighting, comments, binary and oversized files.

**Claude Code** — the real `claude` binary in a PTY, so Escape still interrupts,
slash commands still work, permission prompts still appear, and typing while
Claude is mid-turn queues the message the way it always has. Links Claude prints
are clickable.

**Queue** — throw an item in, drag to reorder, tick it off. Each item can be
sent to Claude, mirrored into the PR description, or turned into a GitHub issue.
An item that is in the PR description *and* becomes an issue has its PR line
replaced by a link to the issue.

New items go to the bottom, so typing them in builds a list in the order you
mean to work through it. The arrow next to the input flips that to the top for
the other way of using a queue -- the thing you must not forget to do next --
and stays flipped.

## Where the queue lives

`.prcoder/queue.json`, in a directory that ignores itself -- it holds a
`.gitignore` of one line, `*`, so nothing is added to your own and nothing
shows up in `git status`. **prcoder does not write anything you own unless you
ask it to.**

```json
{
  "version": 1,
  "items": [
    { "text": "Add retry to the fetch path", "branch": "add-retries",
      "done": false, "inPr": false, "issue": null, "deleted": false }
  ]
}
```

Items are tagged with the branch you added them on and the pane shows the
branch you have checked out, so switching PRs swaps the list and nothing from
one lands in another. Items for a branch you have deleted stay in the file:
out of view, but not gone.

The queue is machine-local, which is the trade for not writing your files.
The way to carry an item elsewhere is the ◆ button, which mirrors it into a
`<!-- prcoder:todo -->` block in the PR description. Edits you make to that
block on github.com — ticking a box, adding a line from your phone, deleting
one — are folded back in on refresh. prcoder only mirrors into the pull request
for the branch you have checked out: a PR you are merely looking at is never
written to. Separate worktrees keep separate queues, since each has its own
`.prcoder/`.

If you have a `FUTURE.md` from an earlier version, its `## Queue` section is
imported once, on the first run, and the file is never read or written again.

Next to the pane's title is the queue's own light: whether the items you have
mirrored are actually on GitHub. It reads `in the PR` when they are, and
`not saved to the PR` when a write failed — prcoder keeps the change locally
and stops trusting the description it can see until a write succeeds, so the
light is how you know to stay open a moment longer.

## The terminal you started it from

The window prcoder was launched in is not finished once it has printed a URL.
It keeps a status block pinned under a scrolling log:

```
prcoder  gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    19 active · 1 done · 10 in the PR · 1 issue   queue mirrored
serving  http://localhost:7455   1 tab   q quit · r refresh · v verbose · o open
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
that change something you care about — an item queued, ticked, mirrored into
the description, filed as an issue, a PR checked out. Debug adds every `git` and
`gh` subprocess with its timing, the per-poll count of them, route timings, and
a line when the PR has moved upstream. `PRCODER_VERBOSE=1` or `=2` starts at a
level, which is the only way to see startup itself. `o` reopens the browser.

**Quitting.** Ctrl-C asks first, because quitting kills the PTY and with it the
Claude session in the browser. It says what that costs — tabs open, unpushed
commits, uncommitted files, and a queue change GitHub never received. A second
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

The [`gh` CLI](https://cli.github.com/), authenticated. All GitHub access goes
through it, so there is no token to configure.

## Finding it again

One prcoder per repo, each a browser tab, soon lost among the pull requests and
diffs you opened while working. Cheapest first:

**In the tabs.** The favicon is a green *PR* square, and every title ends in
`· prcoder`, so in Firefox typing `% prcoder` in the address bar lists every
instance and nothing from github.com.

**A window per repo.** `PRCODER_OPEN` replaces the platform opener with your
own command, URL appended. Firefox hands the arguments to the running copy, so

```sh
export PRCODER_OPEN='/Applications/Firefox.app/Contents/MacOS/firefox -new-window'
```

gives each prcoder its own window, listed by title in the Window menu and
Mission Control.

**A Dock icon per repo.** This works because the port is fixed: it is a hash
of the repo's path, so a repo listens on the same port every run (`prcoder`
prints it). In Safari, open that URL and choose *File → Add to Dock*. The app
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

Syntax-highlighted diffs, review threads, multi-session management. This is a prototype for
finding out whether a PR-shaped workspace beats a chat-shaped one; it's meant to
be cheap to rewrite.

`npm test` covers the parts worth pinning down: the queue store, file grouping, GitHub's diff
anchors, and every queue ↔ PR-description transition.
