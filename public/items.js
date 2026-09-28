// What a queue item is, as predicates. Shared by the pane that draws the tabs
// and the server that counts them into the status block and the quit prompt.
//
// It lives under public/ for the same reason tasks.js does: the browser can
// only import what the static route serves, and the server can import anything.
// A *task* in this codebase is a checklist line in a PR description (tasks.js);
// an *item* is a row of the queue, which is this.
//
// The queue is yours, so these tabs are states of your own list and nothing
// else. Work carried to the PR description or an issue is not a flag here: it
// has left the queue (moveOut in server.js), which is what drains Local, and a
// session that ended tidily leaves it empty.

import { refs, resolveRef } from './tasks.js';

/**
 * Exclusive: every item is on exactly one tab, a tombstone shadowing everything
 * else, so the counts sum to the list. They could not while an item could be
 * both done and mirrored into a description (#43); a move is not a state, so
 * nothing is both any more.
 */
export const TABS = {
  local: (i) => !i.deleted && !i.done,
  done: (i) => !i.deleted && !!i.done,
  deleted: (i) => !!i.deleted,
};

/** How many items are in each tab, for a caller that wants several at once. */
export const counts = (items = []) =>
  Object.fromEntries(Object.entries(TABS).map(([name, f]) => [name, items.filter(f).length]));

/** What the row's tag says: `#91` in this repo, `cli/cli#123` in another. */
export const refLabel = (i) => (i.repo ? `${i.repo}#${i.issue}` : `#${i.issue}`);

/**
 * What ▶ types for an item: its text, and the link to the issue or pull
 * request it is about, unless the text already refers to that one -- an item
 * whose text is the title says nothing about which issue it came from, and
 * `Fix #93` already does. `home` is the repo prcoder is in, as `owner/name`,
 * which a bare `#93` or a `name#93` in the text is read against; unknown, only
 * a reference that names its owner and repo can count.
 */
export function forClaude(i, home) {
  if (!i.issue || !i.issueUrl) return i.text;
  const target = (i.repo ?? home ?? '').toLowerCase();
  const named = refs(i.text).some((r) => {
    if (r.number !== i.issue) return false;
    if (!home) return !!(r.owner && r.name) && `${r.owner}/${r.name}`.toLowerCase() === target;
    return (resolveRef(r, home).repo ?? home).toLowerCase() === target;
  });
  return named ? i.text : `${i.text} (${i.issueUrl})`;
}
