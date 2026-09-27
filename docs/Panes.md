# The panes, in detail

This is how the window behaves today. Layout and ordering are still being tuned, so this file
changes more often than the [README](../README.md), which says only what each pane is for. Each
rule keeps its reason beside it, so a change can see what it is trading away.
[Design.md](Design.md) has the decisions that are not expected to move.

## Layout

Every line between the panes is a splitter, and so is the diff outline's left edge: drag it to
resize, double-click it to go back to the default. Sizes are remembered per repo and per browser, so
the next `prcoder` in that repo opens with the layout you settled on. They live in the browser's
`localStorage`, which is kept per origin, and the origin includes the port from
`.prcoder/port.json`. So each repo, each worktree, and each browser or profile has a layout of its
own. A repo whose port changes (`port.json` deleted, its port busy at startup, or a port named
with `--port` or `PRCODER_PORT`) opens with the default layout, and gets the old one back once it
is on the old port again.

The terminal folds to its header line with a click anywhere on that line; the ▼ before its title
says so, and is the keyboard's way in. The diff (or the queue, with no diff open) takes the room,
and another click unfolds it. Folding never touches the session, which keeps running folded. While
a turn runs, the folded header says `● working` beside its title, from the same signal as the
tab's blue icon. Whether the terminal is folded, whether the outline is shown, and which way the
queue adds are remembered the same way as the sizes.

Each tab names itself `owner/repo#N · pull request title` (the branch and `(no PR)` when there
isn't one), and renames itself as the branch moves, so a row of prcoder tabs stays readable at
tab width.

## Pull request

### The head

Which pull request you are in stays at the top, in the order it is used: the title; then the way
out of the window, with this pull request on GitHub drawn as a button beside plain links to the
repository's issues, pulls and milestones, and the repository they are all in at the end of that
row; then the state and the branch it targets.

The repository comes last in its row because it is the only thing there whose length has no
bound. A short one fits beside the four links; a long one drops whole onto the next line, so the
four stay where they are either way. On a line of its own it truncates rather than wraps: a long
owner is clipped and the repository's own name kept, since that is the half that says which
checkout you are in. It is drawn as a chip rather than a fifth link: the links are places to go,
and the chip is the one thing in the head that answers which checkout this is.

### Moving between pull requests

The switcher in the head lists open pull requests, each followed by the ones stacked on its branch
and indented under it, and runs `gh pr checkout` to move between them. Uncommitted work hides it
behind a Commit button, because the checkout would fail anyway.

On a branch with no pull request the pane keeps the pull request head's shape, with the branch as
its title and a line under it saying why there is no pull request. The way out of the window is in
the same row: the issues, pulls and milestones, and the repository at the end of it. The head
does not scroll, so those are on screen however long the list below it runs. Where the pull
request's button would be, **Create PR** opens GitHub's compare page, pushing the branch first if
GitHub has not seen it; on the default branch or a detached HEAD there is nothing to create, and
the button is left out. The editing controls are disabled.

It also lists the open pull requests that merge *into* the branch you are on, which on `main` is
the question that branch is interesting for, with each one's stack nested under it. A row's `#N`
opens that pull request on GitHub, so you can compare a few in other tabs; its **Switch** checks it
out, the same way the switcher does. Uncommitted work disables Switch for the same reason it hides
the switcher, and leaves the links alone.

### The sync light

Next to the switcher is a light for the one thing prcoder cannot fix for you: whether the branch
and the remote agree. It reads `unpushed`, `N unpushed`, `pull needed` or `diverged`, and needs no
`git fetch`: GitHub's view of the branch head comes back with the pull request metadata. On a
branch with no pull request it uses git's own record of origin's head from the last push or fetch,
the one `git status` reads, so a push from another machine shows only after a fetch. Either way it
is only as fresh as the last poll.

### Detail, Files, Checks and Stack

Below the head are the tabs. Reading the argument, working the files and watching CI are three
different things and each wants the whole pane; the last, *Stack*, is the pull requests built on
this one's branch, laid out like the list above. Each tab carries the count the others cannot show
you -- how many description boxes are still unticked, how many files are still unviewed, how many
checks have gone green, how many pull requests are stacked on this one -- so none hides from you
while you are in another. A count that has run out keeps its numbers, `Files (11/11)`, so it
still says how many, and ends in a green circle with a ✓ in it to say none are left. The Checks
tab also carries a mark in front while it is not done: a yellow ring while something is still
running, and a red ✕ as soon as anything fails, which is the part a fraction alone can't tell you.
When everything passes it gets the green circle like any other tab. It is a shape as well as a colour so that it survives
colour blindness, and the tab's name, read by a screen reader and shown on hover, says the same in
words: `Checks (1/3): 1 failed, 1 pending`.

The list of open pull requests is fetched when the page loads, when you open the switcher, and
after a checkout, not on every poll, so the Stack count can be a few minutes old. Opening the tab
fetches the list again, so a pull request stacked from the terminal shows up there, and one that
merged drops out. A fetch that fails keeps the list it had, and until the first one lands the tab,
and the list of pull requests into a branch, say there is no list yet rather than that it is empty.

*Detail* is the description. It opens as the lead paragraph and then one folded line per section,
so a long description is an outline you scan rather than a wall you scroll; a section that contains
checklist items says how many are still open, and its pie fills as they are ticked. The prose is
set in serif at a reading size and capped to a comfortable line length, because it is the one thing
in the window that is read rather than operated. Checklists in it are real checkboxes and write
straight back to the description. It ends with the issues the description points at, one line
each with its title: the ones this pull request closes, then the ones it only mentions. A bare
`#41` in the prose is a link but says nothing about what it is, and the titles are the point of
the list. What the renderer does and does not draw is in [Design.md](Design.md).

*Files* is every changed file grouped as *Config & docs* / *Tests* / *Code*, in that order. Inside
each group the files read like a tree: the files at the top of the repository come first, and
below them the rest are folded by the directory they are in, a directory ahead of what is inside
it and sibling directories alphabetical. The files in each list are ordered by lines changed,
additions plus deletions, the largest first. A row inside a fold shows only the part of its path the directory
above it does not, so a path is read once per directory rather than once per file. Both levels
fold and remember what you closed. Each fold's pie fills green as its files are viewed (hover it
for the figure). The checkbox on each file is GitHub's own "viewed" checkbox: tick it here and
it's ticked on github.com. Clicking a file opens its diff in the **Diff** pane; cmd/ctrl-clicking
opens GitHub's diff viewer at that file instead.

*Checks* is CI, one row per check, led by the same mark and ending in `pending` or `failed` for a
check that has not passed. Each links to its run -- or is plain text, when GitHub gave no
link or one that is not `http(s)` ([Security.md](Security.md#the-pull-request-description)). The
tab is there only when the pull request has any, and a poll that empties the list moves you back
to *Detail* rather than leaving you on a tab that is no longer drawn.

## Diff

The selected file's patch, drawn above the terminal, so select → read → tick viewed → ask Claude
never leaves the window. It shows the same hunks GitHub does (fetched once per push and cached),
or, for a file GitHub sent no patch for, the same change as local git sees it: GitHub stops
sending patches partway through a large pull request, and git in this clone can usually still
make them. It refreshes itself when the branch head moves.

A file the pull request adds or deletes is shown as its own text under a green **NEW** or red
**DELETED** title rather than as a wall of `+` or `-`, since a patch that is all one sign has
nothing to contrast. A **NEW** file is syntax-highlighted when its extension names a language
prcoder ships a grammar for; it is the one view where a tokenizer sees a whole file rather than a
hunk that starts in the middle of one. A renamed file says where it came from on its first line,
and a rename with no other change says only that.

A diff with more than one hunk gets an outline down its right edge, one row per hunk, named by the
context git puts after the `@@` (the enclosing function, a heading); a click scrolls to it. Its ✕
hides it for every file until *Outline* in the header brings it back.

Four links go out to GitHub, for anything the plain rendering can't do -- comments, binary and
oversized files, highlighting of a changed file. *Diff* comes first because it is what the pane
itself shows: this file's patch in GitHub's viewer. The other three are the whole file as this
pull request leaves it: *File* for what it became (the parts a hunk doesn't show, and Markdown
rendered rather than as source), *Blame* for who last touched the lines around a hunk, and
*History* for what else has landed in it. Those three are pinned to the head commit, so they keep
showing what you were looking at after the next push.

## Claude Code

The real `claude` binary in a PTY, so Escape still interrupts, slash commands still work,
permission prompts still appear, and typing while Claude is mid-turn queues the message the way it
always has. Links Claude prints are clickable. The tab's favicon is blue while Claude is working
and green when it is idle, read from the timing of the PTY's output (Design.md says why only the
timing).

## Queue

Your own TODO list for this working copy, stored in `.prcoder/queue.json`. Add an item, drag it by
its grip (or focus the grip and use ↑ ↓) to reorder, tick it off. ▶ types an item into the session
and ticks it off in the same click; ◎ files it as a new GitHub issue and takes it off the queue, so
the issue is where it lives from then on.

New items go to the bottom, so typing them in builds a list in the order you mean to work through
it. The arrow next to the input flips that to the top, for the other way of using a queue -- the
thing you must not forget to do next -- and stays flipped.

**Local** is the working list, and it drains as you move and finish things, so a session you
finished tidily ends with it empty. Only Local is yours to reorder. **Completed** is what you ticked
off and what you sent, most recently finished first, with a delete-all for clearing it out;
unticking one puts it back on Local, which is the way back if Claude did not do it or the tick was
a slip. **Deleted** holds tombstones, the latest on top, until you empty it, and hides when it holds
nothing. Every item is on exactly one of those.

With a pull request on screen, two more tabs read GitHub rather than your queue. **PR** is the
description's own checklist, ticked through to GitHub like the boxes in the PR pane; **Issues** is
the issues the description mentions without closing, the most recently updated on GitHub
first. A mention that is not an open issue -- a closed one, or a pull request -- is dimmed and
says which. ↓ on either copies the item into Local
and leaves it where it was.
