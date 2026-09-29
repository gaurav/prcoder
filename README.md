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
prcoder -- --model opus    # ...with flags for the Claude session, after --
prcoder --help             # prcoder's own flags
```

It prints the URL to open, and opens it for you unless `--no-open` (or `PRCODER_NO_OPEN`) is set.
Each repo keeps the same port, and so the same URL, across runs.

It needs Node 22.18 or later in the 22 line, or 24.2 or later -- on older versions it exits at once
without a word, because it starts only under `import.meta.main` -- and the
[`gh` CLI](https://cli.github.com/), authenticated. All GitHub access goes through `gh`, so there
is no token to configure.

## What you get

- **Pull request** -- the pull request for the checked-out branch: its description, with checkboxes
  that write back to GitHub, its changed files, with GitHub's own "viewed" checkbox, its CI checks,
  and the pull requests stacked on it. A switcher checks out another pull request, and a light says whether the
  branch needs a push or a pull.
- **Diff** -- the file you clicked, as GitHub shows it, with links out to GitHub for comments,
  blame and history.
- **Claude Code** -- the real `claude` in a PTY: Escape, slash commands and permission prompts all
  work as they do in a terminal. When it exits, the pane offers to start it again or quit prcoder.
- **Queue** -- your own TODO list for this working copy, kept in `.prcoder/` rather than in any
  file you own. An item can be typed into Claude or moved into a GitHub issue, and with a pull
  request on screen two more tabs read its description's checklist and the issues it mentions.

prcoder follows the branch. It works out the pull request for whatever is checked out, and does
it again every 60 seconds, so a `git checkout` in another terminal -- or by Claude in the middle
pane -- is picked up on its own. Nothing is remembered between polls; every fact comes back from
`git` and `gh`.

[docs/Panes.md](docs/Panes.md) has each pane in detail: layout, ordering, grouping, and what
every control does.

## Arguments and settings

The first argument, if it isn't a flag, is prcoder's: the PR to open. Everything after `--` is
handed to `claude` untouched, so `prcoder 123 -- --effort high --model opus` opens PR 123 with that
session. Before `--` a flag is prcoder's, and one it does not know is an error that says where it
goes, rather than a guess at which of the two it was for. `prcoder --help` lists the flags.

Most settings are a flag with an environment variable of the same meaning; the flag wins when both
are given.

| Flag | Variable | What it does |
| --- | --- | --- |
| `--port <n>` | `PRCODER_PORT` | Use this port for one run, instead of the repo's own ([docs/Ports.md](docs/Ports.md)). |
| `--no-open` | `PRCODER_NO_OPEN` | Don't open a browser; just print the URL. |
| `--queue <file>` | `PRCODER_QUEUE` | Keep the queue in this file instead of `.prcoder/queue.json`; said at startup. |
| `-v`, `-vv` | `PRCODER_VERBOSE` | Start the log at verbose (`1`) or debug (`2`) rather than quiet. |
| `--agent <name>` | | The coding agent; only `claude` today. |
| | `PRCODER_OPEN` | Open the URL with this command instead of the platform's opener; the URL is appended. |
| | `PRCODER_AGENT_BIN` | Run this instead of `claude`. |

## What it writes

**prcoder does not write anything you own unless you click something that says it will.** Its
own state lives in `.prcoder/`, a directory that ignores itself (it holds a one-line `.gitignore`
of `*`), so nothing shows up in `git status`: `queue.json` is the queue, and `port.json` is this
working copy's port.

On GitHub, it writes only when you click: ticking a description checkbox flips that one line of
the description, ticking a file marks it viewed, ◎ moves a queue item into a new issue, and creating
a pull request pushes the branch and opens GitHub's compare page.

The queue is one list per working copy, whatever branch is checked out, and it stays on this
machine. `queue.json` is safe for something else to edit, but while prcoder is running the server
is the better way in: `GET /api/queue`, then `PUT /api/queue` with `{items}`.
Quitting with items still on Local says how many, since nothing but this machine has them.
[docs/Design.md](docs/Design.md#the-queue-is-yours) has the reasons for all of this.

## The terminal you started it from

The window prcoder was launched in keeps a status block pinned under a scrolling log: the branch
and its sync state, the pull request, the queue's counts, and the URL.

```
prcoder  gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    4 local · 1 done
serving  http://localhost:17455   1 tab   q quit · r refresh · v verbose · o open
```

`r` refreshes it, `v` cycles how much the log says, `o` reopens the browser, and `q` or Ctrl-C
quits, asking first if that would lose anything. [docs/Terminal.md](docs/Terminal.md) has how
fresh the block is, what each verbosity level adds, and what a busy port looks like.

## More

- [docs/Panes.md](docs/Panes.md) -- each pane in detail, and why it is laid out the way it is.
- [docs/Terminal.md](docs/Terminal.md) -- the status block, its keys, and quitting.
- [docs/Ports.md](docs/Ports.md) -- how a repo's port is chosen, and finding a prcoder again: tabs,
  a window or a Dock icon per repo, an IDE pane.
- [docs/Design.md](docs/Design.md) -- why prcoder exists, and what it deliberately does not do.
- [docs/Security.md](docs/Security.md) -- what a localhost server is exposed to, and the checks
  that close it.
- [docs/Verifying.md](docs/Verifying.md) -- for working on prcoder: the tests, the browser and
  terminal drivers, and the Playwright browsers they need.
