// What a queue item is, as predicates. Shared by the pane that draws the tabs
// and the server that counts them into the status block and the quit prompt.
//
// It lives under public/ for the same reason tasks.js does: the browser can
// only import what the static route serves, and the server can import anything.
// A *task* in this codebase is a checklist line in a PR description (tasks.js);
// an *item* is a row of the queue, which is this.
//
// Carrying an item out to the PR or to an issue is a flag on disk, not a move.
// It is these filters, and nothing in the store, that take a promoted item out
// of Local -- so Local drains as work is carried out of it, and a session that
// ended tidily leaves it empty.

/**
 * ponytail: an item that is both done and mirrored satisfies two of these, so
 * tab counts do not sum to the length of the list. It genuinely is both, and
 * hiding it from either tab would be the lie. Making them sum needs an
 * exclusive `stage` field, which costs the bare-#N rule for an item that is
 * mirrored *and* filed, leaves restore with no stage to restore to, and changes
 * what existing fields mean -- the one thing store.js says to bump VERSION for.
 * See issue #20.
 */
export const TABS = {
  local: (i) => !i.deleted && !i.done && !i.inPr && !i.issue,
  pr: (i) => !i.deleted && i.inPr,
  issues: (i) => !i.deleted && !!i.issue,
  done: (i) => !i.deleted && i.done,
  deleted: (i) => i.deleted,
};

/** How many items are in each tab, for a caller that wants several at once. */
export const counts = (items = []) =>
  Object.fromEntries(Object.entries(TABS).map(([name, f]) => [name, items.filter(f).length]));
