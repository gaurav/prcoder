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

## Arguments and settings

The first argument, if it isn't a flag, is prcoder's: the PR to open. Everything from the first
flag onward is handed to `claude` untouched, so `prcoder 123 --effort high --model opus` opens
PR 123 with that session. prcoder has no flags of its own, so its settings are environment
variables:

| Variable | What it does |
| --- | --- |
| `PRCODER_PORT` | Use this port for one run, instead of the repo's own ([docs/Ports.md](docs/Ports.md)). |
| `PRCODER_NO_OPEN` | Don't open a browser; just print the URL. |
| `PRCODER_OPEN` | Open the URL with this command instead of the platform's opener; the URL is appended. |
| `PRCODER_VERBOSE` | Start the log at `1` (verbose) or `2` (debug) rather than quiet. |
| `CLAUDE_BIN` | Run this instead of `claude`. |

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

The window prcoder was launched in keeps a status block pinned under a scrolling log: the branch
and its sync state, the pull request, the queue's counts, and the URL.

```
prcoder  gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    19 active · 1 done · 1 issue
serving  http://localhost:17455   1 tab   q quit · r refresh · v verbose · o open
```

`r` refreshes it, `v` cycles how much the log says, `o` reopens the browser, and `q` or Ctrl-C
quits, asking first if that would lose anything. [docs/Terminal.md](docs/Terminal.md) has how
fresh the block is, what each verbosity level adds, and what a busy port looks like.

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

## Not here

Syntax-highlighted diffs of modified files, review threads, multi-session management. [docs/Design.md](docs/Design.md) has the full list and the reasoning behind
it, along with why prcoder exists at all; [docs/Security.md](docs/Security.md) has what a
localhost server is exposed to.

`npm test` covers the parts worth pinning down: the queue store, file grouping, GitHub's diff
anchors, every queue ↔ PR-description transition, and the routes that answer without `gh`. What
cannot be unit-tested is driven in a real browser and a real PTY —
[docs/Verifying.md](docs/Verifying.md).
