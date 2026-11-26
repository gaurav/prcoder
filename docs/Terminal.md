# The terminal you started it from

The window prcoder was launched in keeps a status block pinned under a scrolling log:

```
gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    4 local · 1 done
serving  http://localhost:17455   1 tab
keys     q quit · r refresh · v verbose
open     o prcoder · g github · t terminal · f folder
```

The block is redrawn in place and the log scrolls above it, so what happened stays in the
scrollback.

The repository's name opens the block, bold and in colour, and nothing comes before it: with
several of these windows open, one per repo, the one you want is the one whose name you can see
from across the room, and the word `prcoder` in that column was what the eye found first in every
window. The colour goes by the repository's owner, so every repo of one organization is the same
colour and a related repo's window looks like this one's; there are four, each legible on a light
and a dark background, so two organizations can share one. It is off when stdout is not a
terminal, with `NO_COLOR` set, or where `TERM` says the terminal has none. The window's title is set to the same name, `gaurav/prcoder ·
prcoder`, so the Window menu and Mission Control list each window by its repo; it stays until
your shell sets a title of its own, which most do at the next prompt.

## How fresh it is

Everything in the block is what the browser's poll already worked out, so it costs no extra `git`
or `gh` calls. That also means it only moves when the browser polls, and the browser polls only
while its tab is *visible*: switch away and the numbers stop updating, while the socket stays open
and the tab count keeps saying `1 tab`. Once the numbers are more than two minutes old the block
says `checked 7m ago` next to that count, rather than presenting them as current. `r` polls now.

## Keys

- `r` polls now, which moves the block without going back to the browser. It also searches for the
  branch's pull requests afresh, rather than asking only about the ones it already knows
  ([Panes.md](Panes.md)), so one opened on github.com a moment ago shows.
- `v` cycles quiet → verbose → debug. Verbose reports the things that change something you care
  about: an item queued, ticked or moved into an issue, a PR checked out. Debug adds every `git`
  and `gh` subprocess with its timing, the per-poll count of them, route timings, and a line when
  the PR has moved upstream. `-v` or `-vv` (or `PRCODER_VERBOSE=1` or `=2`) starts at a level, which
  is the only way to see startup itself.
- `o` reopens prcoder in the browser.
- `g` opens the pull request on GitHub, in the same browser (`PRCODER_BROWSER` applies), searching
  for it afresh as `r` does. With no
  pull request it opens the compare page that Create would, but only for a branch that has been
  pushed, since for any other the page shows nothing; it never pushes. On the default branch or a
  detached HEAD there is nothing to compare, so it opens the repo.
- `t` opens a new terminal window in the repo, for whatever is awkward to run through a coding
  agent: several commands in a row, moving between directories, commands piped together, or trying
  out the CLI you are working on. The built-in terminal is Terminal.app on macOS, and elsewhere `t`
  says it has none. `PRCODER_TERMINAL` names your own on any platform, run with the repo's path
  appended: `open -a iTerm`, `kitty --directory`, `wt -d`.
- `f` opens the repo in the file manager, for moving, opening or renaming files, or browsing its
  directories. `PRCODER_FILE_MANAGER` replaces the platform's opener the same way:
  `open -a ForkLift`, `nautilus`.
- `q` or Ctrl-C quits, asking first when that would cost something.

## Quitting

Quitting kills the PTY, and with it the Claude session in the browser. So when there is something
to lose -- tabs open, unpushed commits, uncommitted files -- Ctrl-C asks first and says which;
with nothing to lose it quits on one press. A second Ctrl-C at the prompt quits immediately;
nothing here can make prcoder unkillable. The Quit button on the Claude pane, once Claude has
exited, is the same quit and asks the same question in the browser. However prcoder was quit,
every tab it was serving then says it is no longer running ([Panes.md](Panes.md#claude-code)).

The queue is not asked about, because quitting leaves it in `.prcoder/queue.json` (or the file
`--queue` named). Instead, every item still on Local is printed first, under the name of that file, with its issue's link where it has one, so the list is in
the scrollback after prcoder has gone: to copy something into an issue, or to see what to start it
again for. Declining and asking again doesn't print the same list twice; it prints again only once the
queue has changed.

In a git worktree the question has a third answer, since quitting is the moment to take the
worktree away as well: `r` removes it and quits, `k` quits and keeps it, and anything else is no.
It is asked on every quit there, with or without anything else to lose, and says what removing the
worktree would delete that git does not have. The answers come first on the line, because the
block clips a line to the terminal's width. [Worktrees.md](Worktrees.md#quitting-in-a-worktree)
has what is and is not deleted.

## A busy port

If the port this repo usually uses was busy, prcoder takes a free one, and the block says so for
the whole session with the URL prcoder *wanted* -- the one your bookmark or Dock icon points at, or
the one you named with `--port` or `PRCODER_PORT`, which the line tells apart. It asks whoever holds that port
who they are, so the line tells you whether the window you are looking for is another prcoder on
this repo, another worktree, or nothing to do with prcoder at all.
[Ports.md](Ports.md) says how the port is chosen.

## Choosing a pull request

`prcoder choose` is for when the next pull request is not the one on the branch you are on. It
prints the repository's open pull requests and asks which to start on, before the port is taken
or a browser opens:

```
Open pull requests in gaurav/prcoder, by stack, most recently updated first, read just now:

  #159      XXL  ready        2 days ago   Add a PRs tab to the queue: every open pull…
›   #163    L    stacked (1)  2 days ago   Let a description's checklist text be selected without…
  #173      XS   ready        15 days ago  Colour a new Snakefile, .smk or .snakefile in the diff…
  #87       XS   ready        1 month ago  [fixture] A modified, a deleted and a .tsx file on fixture/diff-views-base
PR number [163, the deepest], or q:
```

The order is the PRs tab's *by stack* ([Panes.md](Panes.md)): each pull request
followed by the ones built on it, a step further in, with roots and siblings most recently
updated first. The columns are the tab's facts that a pick turns on -- the size in the tab's
bands and colours, green for `XS` to red for `XXL`; the state in the tab's words, `stacked (N)`
for one that is ready once the N under it merge; and how long since it last moved -- and then
the title. A root on a branch that is not the default says what it is built on after its title,
`on fixture-base › main`, asking git what is under a bare branch as the tab does, and the state
counts those steps. `›` marks the pull request on the checked-out branch. Enter takes the deepest one, since that is usually where the
last session was; the most recently updated of them when several are as deep, and the most
recently updated root when nothing is stacked. `q` or end of input starts nothing.

A pick on another branch is checked out, as the tab's Switch checks one out, and prcoder starts
on it, as `prcoder <n>` does. With uncommitted changes nothing can be checked out, since the pane
only ever shows the checked-out branch's pull request: prcoder says how many files are in the way
above the question, Enter offers the branch's own pull request instead of the deepest (or nothing,
when none listed is the branch's), and a pick of another branch's pull request is answered with
that and asked again -- a fork's too, once gh has said it is not the one checked out here. So is a
pick refused because another prcoder is running, or starting, in the same working copy. Each
answer is held to the working copy as it is when it is typed, not when the list was printed. A
pick on the branch you are on is simply started -- a fork's pull request too, when the branch is
the one gh checked it out to, and a `pr-<n>` made for a merged pull request's deleted branch,
which Enter offers over uncommitted changes as it does a branch of the head's own name. A local copy of the branch with
commits the pull request lacks is checked out but not fast-forwarded: the line gives gh's words
(`Not possible to fast-forward`), prcoder starts on it, and the sync light reads `diverged`, for
you or the agent to merge or rebase. Any other failure after the switch, such as a pull that timed
out or a dropped connection, is reported the same way, in gh's words, and prcoder starts on the
branch it switched to.

The list is the tab's listing, read from GitHub unless `.prcoder/pulls.json` is under a minute
old, and written there, so the tab opens from the same read. `prcoder choose` takes the other
flags as ever, and the agent's after `--`.

## Without a terminal

None of this happens when stdout is not a terminal. Piped or redirected, you get plain lines, with
errors (the busy-port note included) on stderr, which is what a script wants.
