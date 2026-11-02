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

/**
 * What the row's tag says: `#91` in this repo, `cli/cli#123` in another, and
 * `PR ` ahead of either for a pull request -- a bare `#91` is either on GitHub,
 * and `PR #N` is what the PR pane's head already calls one. An issue, and an
 * item whose kind is not known, stays a bare number.
 */
export const refLabel = (i) => `${i.kind === 'pull' ? 'PR ' : ''}${i.repo ? `${i.repo}#${i.issue}` : `#${i.issue}`}`;

/**
 * The class that draws a reference as what it is, beside refLabel: tinted for
 * a pull request, outlined for an issue -- the queue's tag and the PR pane's
 * `#N` both. An unknown kind is drawn as an issue, as every tag was before the
 * two were told apart.
 */
export const refClass = (kind) => (kind === 'pull' ? 'pull' : 'issue');

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
  const named = refs(i.text, home).some((r) => {
    if (r.number !== i.issue) return false;
    if (!home) return !!(r.owner && r.name) && `${r.owner}/${r.name}`.toLowerCase() === target;
    return (resolveRef(r, home).repo ?? home).toLowerCase() === target;
  });
  return named ? i.text : `${i.text} (${i.issueUrl})`;
}

// The standing buckets, after every release or deadline milestone and in
// decreasing urgency, as MILESTONES.md in gaurav/milestones has them (read
// 2026-10-15). `Critical` is the one bucket ahead of the releases. Matched
// case-blind: another repository may spell them a little differently.
const BUCKETS = ['needed soon', 'needed later', 'not urgent', 'upstream'];

/**
 * Open milestones in the order the Issues tab groups by: Critical; releases
 * and deadlines, the ones with a due date first and soonest first, then the
 * undated by name; then the buckets, Needed soon to Upstream. The ISO dates
 * sort as they read. "No milestone" is the caller's, last.
 */
export function rankMilestones(list) {
  const rank = ({ title, dueOn }) => {
    const name = (title ?? '').trim().toLowerCase();
    if (name === 'critical') return [0, ''];
    const i = BUCKETS.indexOf(name);
    if (i >= 0) return [3 + i, ''];
    return dueOn ? [1, dueOn] : [2, name];
  };
  return [...list].sort((a, b) => {
    const [x, p] = rank(a);
    const [y, q] = rank(b);
    return x - y || p.localeCompare(q);
  });
}

// What issueMatches searches, lowercased once per issue rather than once per
// keystroke: a listing is up to 500 issues with their bodies. Keyed on the
// object, which a new listing replaces, so an edited issue is read afresh.
const haystacks = new WeakMap();

/** Whether the Issues tab's search matches an issue: case-blind, over `#N`, the title, the labels and the body. */
export const issueMatches = (i, query) => {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  let hay = haystacks.get(i);
  if (hay == null) {
    hay = [`#${i.number}`, i.title ?? '', ...(i.labels ?? []), i.body ?? ''].join('\n').toLowerCase();
    haystacks.set(i, hay);
  }
  return hay.includes(q);
};
