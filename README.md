# prcoder

A PR-focused shell around Claude Code. Run it in a repo, get three panes in your
browser: the pull request you're working on, a live Claude Code session, and a
task queue that survives moving between machines.

```sh
npm install
node server.js            # the PR for the current branch
node server.js 123        # a specific PR
node server.js <pr-url>   # any PR, anywhere
```

Then open <http://localhost:7420>.

## The panes

**Pull request** — title, description, checks, linked issues, and every changed
file grouped as *Tests* / *Code* / *Config & docs*, tests first, because tests
are the fastest way to see what functionality actually changed. The checkbox on
each file is GitHub's own "viewed" checkbox: tick it here and it's ticked on
github.com. Clicking a file opens GitHub's diff viewer at that file — the diff
itself stays on GitHub, which already does it better.

**Claude Code** — the real `claude` binary in a PTY, so Escape still interrupts,
slash commands still work, permission prompts still appear, and typing while
Claude is mid-turn queues the message the way it always has. Links Claude prints
are clickable.

**Queue** — throw an item in, drag to reorder, tick it off. Each item can be
sent to Claude, mirrored into the PR description, or turned into a GitHub issue.
An item that is in the PR description *and* becomes an issue has its PR line
replaced by a link to the issue.

## Where the queue lives

`FUTURE.md` in the repo root, as a plain markdown checklist. Commit it to carry
ideas between PRs, or gitignore it for scratch notes — that decision is yours
and needs no configuration.

```markdown
## Queue

- [ ] Add retry to the fetch path
- [ ] @pr Docs for the new flag
- [ ] @pr @issue#42 Refactor the parser
- [x] Fix the flaky worktree test
```

`@pr` mirrors the item into a `<!-- prcoder:todo -->` block in the PR
description. Edits you make to that block on github.com — ticking a box, adding
a line from your phone, deleting one — are folded back in on refresh. Any other
section of `FUTURE.md` is left untouched.

## Requirements

The [`gh` CLI](https://cli.github.com/), authenticated. All GitHub access goes
through it, so there is no token to configure.

## Not here

Inline diffs, review threads, multi-session management. This is a prototype for
finding out whether a PR-shaped workspace beats a chat-shaped one; it's meant to
be cheap to rewrite.

`npm test` covers the parts worth pinning down: file grouping, GitHub's diff
anchors, and every `FUTURE.md` ↔ PR-description transition.
