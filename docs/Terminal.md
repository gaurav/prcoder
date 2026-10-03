# The terminal you started it from

The window prcoder was launched in keeps a status block pinned under a scrolling log:

```
prcoder  gaurav/prcoder   initial-implementation → main   2 unpushed · 8 uncommitted
PR #1    A browser workspace around a live Claude Code session
         https://github.com/gaurav/prcoder/pull/1
queue    4 local · 1 done
serving  http://localhost:17455   1 tab
keys     q quit · r refresh · v verbose · o open · t terminal · f folder
```

The block is redrawn in place and the log scrolls above it, so what happened stays in the
scrollback.

## How fresh it is

Everything in the block is what the browser's poll already worked out, so it costs no extra `git`
or `gh` calls. That also means it only moves when the browser polls, and the browser polls only
while its tab is *visible*: switch away and the numbers stop updating, while the socket stays open
and the tab count keeps saying `1 tab`. Once the numbers are more than two minutes old the block
says `checked 7m ago` next to that count, rather than presenting them as current. `r` polls now.

## Keys

- `r` polls now, which moves the block without going back to the browser.
- `v` cycles quiet → verbose → debug. Verbose reports the things that change something you care
  about: an item queued, ticked or moved into an issue, a PR checked out. Debug adds every `git`
  and `gh` subprocess with its timing, the per-poll count of them, route timings, and a line when
  the PR has moved upstream. `-v` or `-vv` (or `PRCODER_VERBOSE=1` or `=2`) starts at a level, which
  is the only way to see startup itself.
- `o` reopens the browser.
- `t` opens a new terminal window in the repo, for whatever is awkward to run through a coding
  agent: several commands in a row, moving between directories, commands piped together, or trying
  out the CLI you are working on. The built-in terminal is Terminal.app on macOS, and elsewhere `t`
  says it has none. `PRCODER_TERMINAL` names your own on any platform, run with the repo's path
  appended: `open -a iTerm`, `kitty --directory`, `wt -d`.
- `f` opens the repo in the file manager, for moving, opening or renaming files, or browsing its
  directories.
- `q` or Ctrl-C quits, asking first when that would cost something.

## Quitting

Quitting kills the PTY, and with it the Claude session in the browser. So when there is something
to lose -- tabs open, unpushed commits, uncommitted files, queue items still on Local and so
only on this machine -- Ctrl-C asks first and says which;
with nothing to lose it quits on one press. A second Ctrl-C at the prompt quits immediately;
nothing here can make prcoder unkillable. The Quit button on the Claude pane, once Claude has
exited, is the same quit and asks the same question in the browser.

## A busy port

If the port this repo usually uses was busy, prcoder takes a free one, and the block says so for
the whole session with the URL prcoder *wanted* -- the one your bookmark or Dock icon points at, or
the one you named with `--port` or `PRCODER_PORT`, which the line tells apart. It asks whoever holds that port
who they are, so the line tells you whether the window you are looking for is another prcoder on
this repo, another worktree, or nothing to do with prcoder at all.
[Ports.md](Ports.md) says how the port is chosen.

## Without a terminal

None of this happens when stdout is not a terminal. Piped or redirected, you get plain lines, with
errors (the busy-port note included) on stderr, which is what a script wants.
