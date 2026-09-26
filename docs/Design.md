# Why prcoder looks like this

What the panes do is in [the README](../README.md). This file is the *why*: the argument for
building it at all, what it writes and where, and what it deliberately does not do. What
the server is exposed to, and the checks that close it, is in [Security.md](Security.md). Where a
decision is a property of one function, the docstring at that function argues it in full and this
file only says which one to read.

## Why it exists

The working loop has moved out of the IDE and into agent → PR-review → agent, and nothing existing
fits that loop. Claude Code Desktop, Conductor and Nimbalyst are session managers: N agents in N
worktrees. PR-Agent and CodeRabbit review *for* you, which is the opposite end of the problem.
Agent HQ is a cloud fleet dashboard. None of them treats the pull request as the workspace.

## What prcoder writes

prcoder does not edit a pull request's title or description, and it keeps no list anywhere but
`.prcoder/`. The one exception is a checkbox you tick in the PR pane: that flips its one line in the
description (`toggleTask` in [`queue.js`](../queue.js)), re-reading the body first and refusing if
the line has changed under it. Nothing else is written into a description, by the server or the page.

- **The queue is yours**, stored in `.prcoder/queue.json` and nowhere else. It is one list for the
  repo, not scoped to the checked-out branch: a per-branch queue was built and reverted, because
  switching branches mid-task took the list away and merging a branch put its unfinished items out
  of reach for good ([#48](https://github.com/gaurav/prcoder/issues/48)). Its tabs are states of
  that list — Active, Completed, Deleted — and nothing else.
- **No other list is read into it, and it is written nowhere else.** An earlier prcoder mirrored
  items two ways into a `<!-- prcoder:todo -->` block in the PR description, with two guards and a
  per-PR latch to stop the sync burying items, and imported FUTURE.md once. Both are gone. The
  mirror is kept in a draft PR of its own for reference, since it was the one thing that carried
  items between machines; an old description's block is an ordinary checklist now. FUTURE.md is not
  a source and will not be one (retired 2026-09-26): its items were all either done or already
  issues.
- **Something else may edit `.prcoder/queue.json`.** Every write is a temp file and a rename, so a
  reader never sees half a file, and every poll re-reads it, so an outside edit shows up within a
  minute. Last write wins over the whole list, as it does between two tabs (below). For an agent the
  safer route is the server — `GET /api/queue`, then `PUT /api/queue` with `{items}` — because that
  goes through the same coercion the page's writes do; whether Claude should get a channel of its
  own into prcoder is [#21](https://github.com/gaurav/prcoder/issues/21)'s question.
- **What else reaches GitHub, and only on a click:** ◎ files an item as a new issue, a file's
  checkbox marks it viewed, and creating a pull request pushes the branch and opens GitHub's compare
  page. None of them writes a description.
- **Where it is going.** [#27](https://github.com/gaurav/prcoder/pull/27) adds tabs read straight
  from other sources — the description's checklist, the issues it mentions, later a search over
  issues — where pulling an item copies it into your list and leaves the source alone.

## What it deliberately does not do

Review comment threads (counts and a link only), syntax highlighting of a modified file's diff (a
file the PR adds is highlighted, because a whole file is what a tokenizer can read from its first
line and a hunk is not; [#68](https://github.com/gaurav/prcoder/issues/68) has the safe way for the
rest), multi-session and worktree management, and a queue API made for an agent (#21 decides that). No auto-pull, and nothing
parses the terminal. The tab icon does read whether Claude is working, but from the *timing* of the
PTY's output rather than its content — blue while frames are arriving, green two seconds after they
stop — and that is the whole of prcoder's idea of what the session is doing.

One sequence is taken out of that stream before the timing is read, and it is the exception that
shows where the line is. Claude asks the terminal where the cursor is (`ESC [ ? 6 n`) five times a
second for as long as the session is up, and xterm answers every one, so the PTY is never quiet and
the icon sat busy from the first paint until the tab closed. A frame that is nothing but that probe
is skipped. It is still not reading the TUI: it is a question addressed to the terminal, which the
terminal answers by itself, and nothing Claude drew is looked at. Anything that *is* drawn stays
off limits — which is why the third state, "stopped to ask you something", is issue #51 and not a
match against the prompt box.

**The description renderer is an allowlist and stays one.** It handles headings, fences, inline
code, emphasis, links — including the two kinds that mean nothing without a repository behind them,
a relative path and a bare `#N` — checklists, lists and quoted sections; everything it does not know — tables,
nested lists, images, strikethrough, reference-style links, horizontal rules — stays escaped and
shows as its own source. Quotes were the one construct added rather than deferred, and the reason is
the test for the next one: `>` was the last block-level marker that arrived as its own punctuation
down the left margin, which reads as the renderer being broken rather than as a construct it does
not do. What was added is one block, not a grammar — a quote's content is one prose paragraph, so a
bullet, a heading or a nested `> >` inside one shows as its own text, and GitHub's `> [!NOTE]`
alerts are not alerts here. Everything past that is
[#41](https://github.com/gaurav/prcoder/issues/41)'s decision to take; one more paper cut is an
argument for settling it rather than for continuing. It is a security boundary as well as a scope
one — [Security.md](Security.md) says why.

**The queue is machine-local**, which is the trade for not writing your files. Nothing carries it to
another machine; an item that has to outlive this one can be filed as an issue with ◎. Separate
worktrees keep separate queues. There is no conflict detection between two tabs racing on one repo — last write wins on the
whole list. A write-side guard was written and cut: it misses the case that actually
happens (two tabs on one server, where the mtime matches because the same process wrote it), and
merging on conflict needs item identity, which text is not. The upgrade, if a lost item is ever
actually observed, is an id per item and a union by id.

**prcoder has no flags of its own.** The argv is cut at the first flag and everything from there is
handed to `claude` verbatim, which is why prcoder's settings are environment variables and its
verbosity is a keypress; `prcoder --help` is still Claude's help.
[#12](https://github.com/gaurav/prcoder/issues/12) is the replacement.

That policy is also what keeps one gap open.
[#21](https://github.com/gaurav/prcoder/issues/21): prcoder can put nothing into the Claude session
that is not a typed user turn, so it cannot give the session standing instructions about the
workspace it sits in, cannot tell it the branch moved underneath it, and cannot receive the
statusLine JSON contract that would answer
[#13](https://github.com/gaurav/prcoder/issues/13) (Claude's context-window usage in the status
block). Every mechanism that would close it — a `--settings` JSON carrying a hook, an MCP server,
`--append-system-prompt` — means prcoder passing flags of its own to `claude`. So it is a decision
to take rather than a patch to write.
