# Why prcoder looks like this

What the panes do is in [Panes.md](Panes.md). This file is the *why*: the argument for
building it at all, what shapes the queue, and what it deliberately does not do. What the server is
exposed to, and the checks that close it, is in [Security.md](Security.md). Where a
decision is a property of one function, the docstring at that function argues it in full and this
file only says which one to read.

## Why it exists

The working loop has moved out of the IDE and into agent → PR-review → agent, and nothing existing
fits that loop. Claude Code Desktop, Conductor and Nimbalyst are session managers: N agents in N
worktrees. PR-Agent and CodeRabbit review *for* you, which is the opposite end of the problem.
Agent HQ is a cloud fleet dashboard. None of them treats the pull request as the workspace.

## The queue is yours

The queue is your own TODO list for this working copy, kept in one file and nowhere else:
`.prcoder/queue.json`, unless `--queue` names another. It started as something bigger — one list that *was* every place work lives, two-way mirrored
into a block in the PR description, with guards to stop that sync burying items — and in use it
worked best as the smaller thing. That redesign, decided 2026-09-14, is [#27](https://github.com/gaurav/prcoder/pull/27). The mirror
is parked in [#82](https://github.com/gaurav/prcoder/pull/82), a draft kept for reference, and a
description that still carries its block holds an ordinary checklist now.

**prcoder does not edit a pull request's title or description**, and keeps no list anywhere but
that file. The one exception is a checkbox you tick, in the PR pane or on the queue's PR tab: that
flips its one line (`toggleTask` in [`public/tasks.js`](../public/tasks.js)), re-reading the body first and
refusing if the line has changed under it, and never falling back to a cached copy (`editBody`) — a
read that did not happen says nothing about what the description holds now. An earlier version of
this branch also had ◇, which appended an item to the description as a checkbox; it came out under
the same rule, and is small enough to rebuild from `203dd93` if it is ever wanted.

**Moving an item out is one-way, and only into an issue.** ◎ files it as an issue: written there
first and taken off the list after (`moveOut` in [`server.js`](../server.js)). That order is the
one whose failure is recoverable: a filing that did not land leaves the item where it was, and a
store write that fails after one that did leaves it in both places and says so, rather than in
neither. Nothing reads a description back into the queue, so there is no merge to get wrong.

**Something else may edit the queue file.** Every write is a temp file and a rename, so a
reader never sees half a file, and every poll re-reads it, so an outside edit shows up within a
minute. Last write wins over the whole list, as it does between two tabs (below). For an agent the
safer route is the server — `GET /api/queue`, then `PUT /api/queue` with `{items}` — because that
goes through the same coercion the page's writes do; whether Claude should get a channel of its own
into prcoder is [#21](https://github.com/gaurav/prcoder/issues/21)'s question.

**What else reaches GitHub, and only on a click:** ◎ files an item as a new issue, a file's checkbox
marks it viewed, and creating a pull request pushes the branch and opens GitHub's compare page. None
of them writes a description.

**Each permanent source is a tab, read straight from it.** PR is the description's checklist, and
Issues is the issues the description mentions without closing; pulling from either copies the item
into Local and leaves the source alone, since a checkbox is the PR's record and an issue is the
project's. Issues is deliberately that narrow for now: an upcoming milestone to focus on, search, and
showing an issue in the pane are a design still to be settled. Quitting with items still on Local
offering to file them as issues is a follow-up of its own. FUTURE.md is not a source and
will not be one (retired 2026-09-26): its items were all either done or already issues, and a
tracked file of TODOs is a third place for work to live where the queue and issues cover it.

The queue was scoped per branch once, with a guard refusing a write from a branch the tab had left.
That is gone too, and [#48](https://github.com/gaurav/prcoder/issues/48) holds why: scoping the list
to the checkout hid items rather than organising them. Moving to an unrelated branch mid-task took
the list away, and merging a branch put its unfinished items out of reach for good.

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

**The queue is machine-local**, which is the trade for not writing your files. Filing an item as an
issue is how you carry it to another machine, and separate worktrees keep separate queues. There is no conflict detection between two tabs racing on one repo — last write wins on the
whole list. A write-side guard was written and cut: it misses the case that actually
happens (two tabs on one server, where the mtime matches because the same process wrote it), and
merging on conflict needs item identity, which text is not. The upgrade, if a lost item is ever
actually observed, is an id per item and a union by id.

**prcoder's flags end at `--`.** Everything before it is prcoder's and parsed strictly (`parseCli`
in [`cli.js`](../cli.js)); everything after it goes to the agent verbatim. So there is no list of
Claude's flags to keep in step, and an agent flag written before `--` is an error that says where it
goes, not a session started with the wrong pull request. `--port`, `--no-open`, `--queue` and `-v`
each have an environment variable of the same meaning, which the flag overrides; `--agent` has none
yet, and `PRCODER_OPEN` and `PRCODER_AGENT_BIN` have no flag.
`PRCODER_AGENT_BIN` is a path to run, not a name, which is why it is not `PRCODER_AGENT`: that
would read as `--agent`'s variable, and is the name `--agent` needs if it ever gets one. It was
`CLAUDE_BIN`, and prcoder refuses to start while only the old name is set, since ignoring it would
spawn the real `claude` in place of whatever stub it named.

The other side of that line, prcoder adding nothing of its own to `claude`'s arguments, is what
keeps one gap open.
[#21](https://github.com/gaurav/prcoder/issues/21): prcoder can put nothing into the Claude session
that is not a typed user turn, so it cannot give the session standing instructions about the
workspace it sits in, cannot tell it the branch moved underneath it, and cannot receive the
statusLine JSON contract that would answer
[#13](https://github.com/gaurav/prcoder/issues/13) (Claude's context-window usage in the status
block). Every mechanism that would close it — a `--settings` JSON carrying a hook, an MCP server,
`--append-system-prompt` — means prcoder passing flags of its own to `claude`. So it is a decision
to take rather than a patch to write.
