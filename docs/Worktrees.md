# Worktrees: several prcoders on one repository

One prcoder is one working copy: its coding agent runs in that directory, the pull request pane
shows the branch checked out there, and its queue, port and running record are kept in that
directory's `.prcoder/`. To work on two branches of a repository at once, give each a working copy
of its own and run a prcoder in each. A git worktree is the cheap way to get one: a second
directory of files on another branch, sharing the repository's commits, branches and remotes with
the first.

```
prcoder --worktree topic      # a branch
prcoder --worktree 123        # a pull request, by number or URL
```

Either starts a prcoder in a worktree on what was named, and leaves the working copy you ran it in
exactly as it was: its branch, its uncommitted work, and any prcoder already running there. The
new one has its own port and browser tab, its own queue, and a pane on its own branch's pull
request. git refuses to check one branch out in two working copies, so two prcoders cannot be on
the same branch by accident.

A worktree made by hand is the same thing to prcoder, wherever it is:

```
git worktree add ../myrepo-topic topic
cd ../myrepo-topic && prcoder
```

`prcoder -- --worktree <name>` is not. That passes `--worktree` to the coding agent, which moves
itself into a worktree of its own making after prcoder has started; prcoder stays in the directory
it was started in, and the pane goes on showing that directory's branch. The flag is still passed
on, since what follows `--` is the agent's, and prcoder says at startup which of the two it was.

## What `--worktree` does

**If the branch is already checked out somewhere**, it starts there: in the worktree that has it,
or in the main working copy. For a pull request that means a working copy on its branch -- found
by the branch's name for one of this repository's, and by the branch's config for a fork's, which
is how `gh pr checkout` marks one.

**Otherwise it makes a worktree**, under `~/.prcoder/worktrees/<repository>-<hash>/<name>`, or
under `PRCODER_WORKTREES` in place of `~/.prcoder/worktrees`. The repository's part is its main
working copy's directory name and a hash of its path, so two clones of one name stay apart. The
name is the branch's with anything but letters, digits, dots, dashes and underscores turned into
dashes (`feature/x` is `feature-x`), or `pr-<n>` for a fork's pull request. Outside the repository
on purpose: inside it, an agent started in the worktree would read the instruction files of every
directory above it, the main working copy's among them, and anything walking the main working
copy without reading `.gitignore` would find a second copy of the code. A directory already at
that path which is not the worktree wanted is left alone, and prcoder stops and says so.

**A branch** is checked out as this clone has it. One only origin has is fetched and tracked. One
nobody has is made from origin's default branch, fetched first, tracking nothing; when origin
cannot be reached, from what this clone last saw of it, and the line prcoder prints says which.
It is not made from the commit you are standing on: a second session is usually for other work,
and a branch quietly built on whatever happened to be checked out is found out at the pull
request. For a branch stacked on another, make it first (`git branch child parent`); then it is
one this clone has.

**A pull request** is checked out in its worktree the way `prcoder <pr>` checks one out, with the
same refusals: gh's checkout, and for one whose branch is gone from GitHub, the pull request's
head ([README](../README.md#arguments-and-settings)). A worktree made for a checkout that then
fails is left where it is, and the next run finds it and tries again.

A new worktree has only what git has. Nothing ignored comes with it -- no `node_modules`, no
`.env`, no build output -- so a project that needs installing needs it again there.

## The worktree line

When the repository has more than one working copy, the pull request pane's head has a worktree
line under the milestone's ([Panes.md](Panes.md#the-head)): which working copy this prcoder is in,
and a list of them all, each with its branch and whether a prcoder is running there.

Picking another does not move this prcoder. It cannot: the coding agent was started in this
directory and stays there, and the queue, the port and the layout stored against it are this
working copy's. A prcoder that changed directory would have to end its agent's session and
become, in every way that shows, a different prcoder. So a pick says where the other one is:

- one with a prcoder running gets a notice with its address. It is a link and not opened for you,
  because each browser tab on a prcoder is a coding agent session of its own, and a tab on that
  one is very likely open already. A page cannot bring another tab forward, so finding it is
  yours; the tab's title names the pull request.
- one with none gets the command that starts it.
- one whose directory was deleted without `git worktree remove` is still listed, since git still
  holds its branch as checked out; `git worktree prune` forgets it.

The list is read when the page loads, when the tab is come back to, and as the line is reached,
not on every poll: the server asks each other working copy's prcoder who it is, from the running
record in that working copy's `.prcoder/running/`.

## Quitting in a worktree

A worktree is easy to make and easy to forget, and git will not check its branch out anywhere
else while it exists. So a quit in one -- `q` in the terminal, or Quit in the page -- offers to
remove it, with three answers: remove it and quit, keep it and quit, or do not quit.

Removing is `git worktree remove`, and the question says first what that would delete that git
does not have:

- **uncommitted changes and untracked files.** git refuses to remove a worktree over these, so
  choosing to remove passes `--force`, and they are deleted.
- **ignored files.** git deletes these without a word, forced or not: `node_modules`, an `.env`,
  build output. Up to three are named.
- **the queue.** `.prcoder/` is in the worktree and ignored, so `.prcoder/queue.json` goes with it;
  the items still on Local are counted. A queue kept elsewhere with `--queue` stays.

Commits are never among them. A worktree's branch stays when the worktree goes, with every commit
on it, pushed or not, and can be checked out again anywhere.

One case is not asked about. A worktree that `--worktree` made, with nothing in it that git lacks
and nothing else at stake in the quit, is removed as prcoder goes, and the terminal and the page
say so: the directory is one this command made and can make again in a second. prcoder knows its
own by `.prcoder/worktree.json`, written as it makes one. A worktree made by hand is always asked
about, however clean.

Otherwise nothing is removed without that answer. A quit by a signal -- the terminal closed, a `kill` -- asks
nothing and removes nothing, and neither does a second Ctrl-C at the question. The offer is not
made in the repository's main working copy, in a worktree another prcoder is also running in, or
in one that has been locked with `git worktree lock`. If git refuses the removal after all, its
words are printed with the command that would do it, and the worktree is left as it was.
