# Worktrees: several prcoders on one repository

One prcoder is one working copy: its coding agent runs in that directory, the pull request pane
shows the branch checked out there, and its queue, port and running record are kept in that
directory's `.prcoder/`. To work on two branches of a repository at once, give each a working copy
of its own and run a prcoder in each. A git worktree is the cheap way to get one: a second
directory of files on another branch, sharing the repository's commits, branches and remotes with
the first.

```
git worktree add ../myrepo-topic topic
cd ../myrepo-topic && prcoder
```

Nothing more is needed. prcoder takes everything from the directory it is started in, so one
started in a worktree is that worktree's: its own port and browser tab, its own queue, and a pane
on its own branch's pull request. git refuses to check one branch out in two working copies, so
two prcoders cannot be on the same branch by accident.

This is not what `prcoder -- --worktree <name>` does. That passes `--worktree` to the coding
agent, which moves itself into a worktree of its own making after prcoder has started; prcoder
stays in the directory it was started in, and the pane goes on showing that directory's branch.

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
