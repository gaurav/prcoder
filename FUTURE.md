## Queue

- [ ] Let Claude Code tell prcoder "I've changed the PR, reload it" -- the 60s poll should be the fallback, not the only signal
- [ ] Add a visual sign that the queue is synced -- so I feel safe closing the app without anything being dropped
- [ ] The queue should have ways of entering options in the text itself, e.g. ># to send to GitHub issue >[] to make it an item in the description, etc.
- [ ] The queue should default to adding to the bottom
- [ ] When editing queued text, the text caret doesn't go where you click -- it goes to the start
- [ ] @issue#2 Try moving the panels around: queue at the top (at some point I would like to try putting it on the right, but it might be better wide), PR title and description (or -- if a file/diff is selected -- that) in the middle as an "active" pane, and then Claude at the bottom so it's easy to find.
- [ ] Allow the user to edit the GitHub PR title and description automatically
- [ ] @pr Figure out where there's a `null` before and after the PR description
- [ ] @pr Add browser-level tests for the pane rendering (needs jsdom as a dev dependency)
