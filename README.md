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
`CLAUDE_BIN` — which cannot collide with a flag at all.

By default prcoder takes whatever port the OS has free and opens your browser on
it, so several sessions can run at once and none of them needs a number you have
to remember. Set `PRCODER_PORT` to pin one anyway, or `PRCODER_NO_OPEN=1` to be
left with just the URL on stdout.

Each tab names itself `owner/repo#N · pull request title` -- the branch and
`(no PR)` when there isn't one -- and re-names itself as the branch moves, so a
row of prcoder tabs stays readable at tab width.

## The panes

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
and stays flipped, as far as the browser will remember it. (prcoder takes a
random port unless you pin `PRCODER_PORT`, and the browser files that memory
under the port, so across sessions it is a convenience rather than a promise.)

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

## Requirements

The [`gh` CLI](https://cli.github.com/), authenticated. All GitHub access goes
through it, so there is no token to configure.

## Not here

Syntax-highlighted diffs, review threads, multi-session management. This is a prototype for
finding out whether a PR-shaped workspace beats a chat-shaped one; it's meant to
be cheap to rewrite.

`npm test` covers the parts worth pinning down: the queue store, file grouping, GitHub's diff
anchors, and every queue ↔ PR-description transition.
