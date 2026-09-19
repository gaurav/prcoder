# What a session inside prcoder needs to know

prcoder runs a real `claude` session in the middle pane of a browser workspace, in the repo it was
started in. This file is what that session needs in order to use the queue sitting beside it,
written to be read by the agent rather than about it.

**Nothing delivers this yet.** prcoder passes the session no arguments of its own (`server.js`, the
spawn), and there is no channel into its context that is not a typed user turn -- #21 is where the
mechanisms are weighed and #72 is this text's own issue. Until one lands, this is a document to
paste in or point at. It is written so that whatever wins -- `--append-system-prompt`, a
`SessionStart` hook, a set of MCP tool descriptions -- can take it close to verbatim.

## Where you are

Three panes around you: the pull request on the left (title, description, files, diffs), you in the
middle, a queue underneath. A human is reading that pull request while you work, and the panes poll
GitHub every 60 seconds.

The queue is their list of what still has to happen. An item can be local, mirrored into the pull
request description as a checkbox, or filed as a GitHub issue. One control reaches you: **▶ types
an item's text into your prompt without sending it, and marks that item done in the same click**
(`public/queue.js`). So an item arriving as a turn is already ticked before you start. Don't tick
it again -- and if you did not finish it, untick it, because nothing else will.

## `.prcoder/`, and why not to edit it

- **`port.json`** -- the port this repo's server is on. How you find it.
- **`queue.json`** -- the queue itself: a `version` and an `items` array.

Read them freely. Do not write them. A running prcoder rewrites `queue.json` *and* the description's
marker block from its own memory on every poll of a visible tab, so an edit to either is reverted,
usually within a minute, with no error anywhere. The server is the only writer that sticks.

## The API

Loopback only, and it refuses a request from a foreign `Origin`; a request that sends no `Origin` at
all -- `curl`, or a fetch from your own tooling -- is allowed through (`docs/Security.md`).

```bash
PORT=$(node -p 'require("./.prcoder/port.json").port')

curl -s localhost:$PORT/api/whoami    # {prcoder, repo, branch, nameWithOwner} -- is it live, and whose
curl -s localhost:$PORT/api/status    # the pull request, its files, the queue, the sync state
curl -s localhost:$PORT/api/queue     # the items alone
```

`whoami` answers instantly by design: it skips the lock every other route waits on, so it is the
cheap way to ask whether a server is there before doing anything else. `status` is a whole poll's
worth of answer -- the pull request, the changed files with their viewed flags, the queue, whether
the branch is pushed -- and it is almost always cheaper than making the same `gh` calls yourself.

A write is the whole list back:

```bash
curl -s localhost:$PORT/api/queue > items.json
# edit items.json
curl -s -X PUT localhost:$PORT/api/queue -H 'content-type: application/json' \
  -d "{\"items\": $(cat items.json)}"
```

The store and the pull request description are updated together, which is the other reason to come
through here: a write of your own leaves them disagreeing.

## Six rules for a write

1. **Send the whole array, as `{items}`.** There is no partial update and there are no item ids, so
   the last write wins outright (#44).
2. **Re-read immediately before you write.** A copy from earlier in your session goes stale without
   saying so -- the human is clicking in the pane the whole time you work. Re-read, change the
   items you mean to, write that back.
3. **An item's text is its identity.** The description's block is matched back to items by issue
   number where there is one and by exact text otherwise, so editing the text of a mirrored item
   buries it and adds a second one in its place. Change anything but the text.
4. **`done` is the only field the description owns.** Ticking a box is safe from either end.
   Everything else is the store's.
5. **Deleting is a tombstone:** `deleted: true` together with `inPr: false`, which is what the
   pane's ✕ writes. Don't splice the array -- the Deleted tab is how a human gets it back.
6. **Some fields are derived on the way out.** `issueUrl` is computed from `issue` per request;
   write the number, not the URL.

## Filing an issue

`POST /api/queue/issue` with `{items, index}` files `items[index].text` as an issue in this
repository and records the number back on the item. It does not look for an existing one first, and
on 2026-09-19 that filed two issues that duplicated two written up a fortnight earlier. Search the
open issues before you use it; if one already covers the item, set the item's `issue` field to that
number with a plain `PUT` instead.

## Using the queue in your own work

- **Tick what you finished**, in the same turn you finish it. You are the only one who knows.
- **Untick what you were handed and did not finish** -- ▶ ticked it optimistically.
- **Add what you found.** A new item is `{text, done: false, inPr: false, issue: null, deleted: false}`
  appended to the array. This is the right home for the follow-up work you would otherwise bury in a
  comment nobody reads.
- **Leave scope to the human.** Ticking your own work off is yours. Deleting someone else's item,
  rewriting text, filing issues -- ask first.
