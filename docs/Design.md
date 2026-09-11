# Why prcoder looks like this

What the panes do is in [the README](../README.md). This file is the *why*: the argument for
building it at all, the three guards that shape the queue, what the localhost server is exposed to,
and what it deliberately does not do. Where a decision is a property of one function, the docstring
at that function argues it in full and this file only says which one to read.

## Why it exists

The working loop has moved out of the IDE and into agent → PR-review → agent, and nothing existing
fits that loop. Claude Code Desktop, Conductor and Nimbalyst are session managers: N agents in N
worktrees. PR-Agent and CodeRabbit review *for* you, which is the opposite end of the problem.
Agent HQ is a cloud fleet dashboard. None of them treats the pull request as the workspace.

prcoder is a prototype for finding out whether a PR-shaped workspace beats a chat-shaped one. It is
deliberately cheap to throw away.

## Three guards, because the obvious version loses work

The queue lives in `.prcoder/queue.json` and the PR description is a *projection* of it, never the
other way round. Two guards keep that one-directional, and each closes a path where an item
disappears with nobody noticing. Each is a few lines; each is argued at its own function.

**Mirror only the checked-out branch's PR** — `ours()` in [`server.js`](../server.js).
`syncFromPrBlock` tombstones any mirrored item missing from the description's block, which is only
safe when the queue and the description came from the same branch. `prcoder <pr-url>` pins a PR that
is not the checkout's, and without this gate prcoder merges your items against a stranger's block,
burying all of them, *and* writes your queue into their description. It fails closed: a missed merge
is recovered by the next poll, where a wrong one is not.

**Don't trust a description we failed to write** — the `mirrorFailed` latch in `writeQueue`. When
`setBody` fails, the store already has the change and GitHub is behind; treating that stale body as
evidence on the next poll buries the item that failed to go out. The latch suspends the *merge* and
only the merge, because the only thing that can clear it is a successful write — a latch that also
stopped writing would be one nothing could open. Neither side of that write falls back to a body it
failed to read: a read that did not happen says nothing about what the description holds now.

There was a third — a per-branch queue, and a guard refusing a write from a branch the tab had
left. It is gone, and [#48](https://github.com/gaurav/prcoder/issues/48) holds what replaced it and
why: scoping the list to the checkout hid items rather than organising them. Moving to an unrelated
branch mid-task took the list away, and merging a branch put its unfinished items out of reach for
good. One list for the repo is the behaviour to beat.

## What a localhost server is exposed to

Listening on loopback is not the boundary it looks like. A page on the web cannot read localhost's
answers, but it can send a request that takes effect on the way out — switching branches, rewriting
the PR description, filing an issue — and WebSockets are not subject to the same-origin policy at
all, so that page could open `/pty`, get a `claude` PTY in this repo, read what it printed and type
at it, approvals included.

Every route and the socket refuse an `Origin` that is not the server's own. A request that states
none is allowed through: a browser always states one on an upgrade or a `fetch`, so nothing with an
origin to give is being waved past, while `curl`, the drivers and prcoder's own busy-port probe keep
working. `sameOrigin` in [`server.js`](../server.js) carries the rest, including why it compares
against `Host` rather than a computed URL.

## What it deliberately does not do

Review comment threads (counts and a link only), syntax highlighting in the diff pane,
multi-session and worktree management, and any agent-writable queue API. No auto-pull, and no
attempt to detect whether Claude is idle — that would mean parsing the terminal.

**The description renderer is an allowlist and stays one.** It handles headings, fences, inline
code, emphasis, links, checklists, lists and quoted sections; everything it does not know — tables,
nested lists, images, strikethrough, reference-style links, horizontal rules — stays escaped and
shows as its own source. Quotes were the one construct added rather than deferred, and the reason is
the test for the next one: `>` was the last block-level marker that arrived as its own punctuation
down the left margin, which reads as the renderer being broken rather than as a construct it does
not do. What was added is one block, not a grammar — a quote's content is one prose paragraph, so a
bullet, a heading or a nested `> >` inside one shows as its own text, and GitHub's `> [!NOTE]`
alerts are not alerts here. Everything past that is
[#41](https://github.com/gaurav/prcoder/issues/41)'s decision to take; one more paper cut is an
argument for settling it rather than for continuing.

**The queue is machine-local**, which is the trade for not writing your files. Mirroring an item
into the PR description is how you carry it to another machine, and separate worktrees keep separate
queues. There is no conflict detection between two tabs racing on one repo — last write wins on the
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
