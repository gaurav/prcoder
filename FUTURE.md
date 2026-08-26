## Queue

- [ ] Let Claude Code tell prcoder "I've changed the PR, reload it" -- the 60s poll should be the fallback, not the only signal
- [ ] Add a visual sign that the queue is synced -- so I feel safe closing the app without anything being dropped
- [ ] The queue should have ways of entering options in the text itself, e.g. ># to send to GitHub issue >[] to make it an item in the description, etc.
- [ ] The queue should default to adding to the bottom
- [ ] When editing queued text, the text caret doesn't go where you click -- it goes to the start
- [ ] @issue#2 Try moving the panels around: queue at the top (at some point I would like to try putting it on the right, but it might be better wide), PR title and description (or -- if a file/diff is selected -- that) in the middle as an "active" pane, and then Claude at the bottom so it's easy to find.
- [ ] Allow the user to edit the GitHub PR title and description automatically
- [ ] @pr Look at the switcher, sync light and Deleted tab in a real browser -- they were built without a working browser connection, so only the CSS has been read
- [ ] @pr Figure out where there's a `null` before and after the PR description
- [ ] @pr Add browser-level tests for the pane rendering (needs jsdom as a dev dependency)
- [ ] @pr Two browser tabs each spawn their own `claude` PTY and their own 60s poll, doubling gh traffic against one global lock
- [ ] @pr A branch with no PR runs `git ls-remote` every poll to learn whether it is pushed; the PR case gets the same answer free from headRefOid
- [ ] @pr `gh pr checkout` has a 120s timeout and sits behind the global serial lock, so a slow checkout stalls /api/status for the duration -- needs a decision about per-route locking
- [ ] @pr Prefetch patches eagerly in refreshPr if first-click diff latency on big PRs annoys -- there's a ponytail comment at the cache in server.js
- [ ] @pr Add line numbers to the diff pane, parsed from the @@ hunk headers, if hunk navigation proves painful
- [ ] @pr Update issue #2: diff-on-select shipped as a right-column pane, so only the panel-rearrangement half of it is still open
- [ ] @pr Refresh the PR description -- it still says the diff stays on GitHub and lists inline diffs as deliberately excluded, and the pane/line/test counts predate the diff pane
