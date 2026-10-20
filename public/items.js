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

/**
 * How far `iso` is from now, in a word or two: `3 days ago`, or `in 2 months`
 * for one still to come. Under a minute is `just now`; nothing, or a date
 * that is not one, is ''. `now` is a parameter so a test can hold it still.
 */
// Largest first, so the first that fits is the unit.
const UNITS = [['year', 365 * 86400], ['month', 30 * 86400], ['day', 86400], ['hour', 3600], ['minute', 60]];
export function when(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - now) / 1000);
  const found = UNITS.find(([, size]) => Math.abs(s) >= size);
  if (!found) return 'just now';
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(Math.trunc(s / found[1]), found[0]);
}

/** when() for a time that has passed: a clock a little behind GitHub's says `just now`, not `in 2 minutes`. */
export const age = (iso, now = Date.now()) => when(iso, Math.max(now, Date.parse(iso ?? '') || now));

/** A milestone's due date as its line says it, `due 3 days ago`, with the date on hover. */
export const dueLabel = (dueOn, now = Date.now()) => ({ textContent: `due ${when(dueOn, now)}`, title: `due ${dueOn.slice(0, 10)}` });

// The size chip's bands, on lines changed (additions and deletions together):
// each name holds up to, not including, its count. Wider at the small end than
// GitHub's size labels (XS under 10, S under 30, M under 100), which put most
// pull requests worth a review at M or above (2026-10-20).
const SIZES = [['XS', 50], ['S', 100], ['M', 200], ['L', 500], ['XL', 1000]];

/** A pull request's size as a chip, `XS` to `XXL`, from its lines changed. */
export const sizeChip = (lines) => SIZES.find(([, under]) => (lines ?? 0) < under)?.[0] ?? 'XXL';

// A pull request opened within this long is `new`. One not updated for months
// is not dimmed: an old one with conflicts is often the quickest to finish,
// since the coding agent can fix them (2026-10-20).
export const NEW_FOR = 7 * 86400_000;
export const isNew = (p, now = Date.now()) => now - Date.parse(p.createdAt ?? '') < NEW_FOR;

/**
 * The Pull requests tab's orders, each a comparator over pullRow's fields; the
 * ISO dates compare as they read. `smallest` is the default, since the next
 * one to take on is usually the one that is nearly done.
 */
export const PULL_SORTS = {
  smallest: { label: 'smallest first', by: (a, b) => a.lines - b.lines },
  largest: { label: 'largest first', by: (a, b) => b.lines - a.lines },
  newest: { label: 'newest first', by: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') },
  oldest: { label: 'oldest first', by: (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') },
  updated: { label: 'recently updated', by: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') },
  stale: { label: 'least recently updated', by: (a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') },
};

/** The pull requests in the order `how` names, ties in the order they came (by number, as a second key); an order not named is `smallest`. */
export const sortPulls = (list, how) => [...list].sort((a, b) => (PULL_SORTS[how] ?? PULL_SORTS.smallest).by(a, b) || a.number - b.number);

/** Whether the Pull requests tab's search matches a pull request: case-blind, over `#N`, the title, the author, the head branch, the labels and the body. */
export const pullMatches = (p, query) => {
  const q = (query ?? '').trim().toLowerCase();
  return !q || [`#${p.number}`, p.title ?? '', p.author ?? '', p.headRefName ?? '', ...(p.labels ?? []), p.body ?? ''].join('\n').toLowerCase().includes(q);
};
