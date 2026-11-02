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

/**
 * The day a milestone is due, `2026-10-20`, out of GitHub's dueOn: a date sent
 * as midnight wherever it was set, with no word of where. Real ones read
 * 2026-11-02 (nodejs/node, rust-lang/rust, flutter/flutter) have `T00` from
 * UTC, `T04` to `T08` from the Americas, and `T13` and `T21` from east of
 * Greenwich, where it is already the next day. So the UTC date is a day early
 * for those, and this rounds: an hour from `T11` on is a zone ahead of UTC, and
 * so the next day. That reads UTC-10 to UTC+13 right, and is a day out only for
 * the zones past them, Samoa's and Kiribati's.
 */
const DUE_ROUND = 13 * 3600_000;
export const dueDay = (dueOn) => new Date(Date.parse(dueOn) + DUE_ROUND).toISOString().slice(0, 10);

/**
 * A milestone's due date as its line says it, `due 3 days ago`, with the date
 * on hover and a class saying how near it is: `overdue`, `soon`, or neither.
 * Its day (dueDay) is compared with today's on this clock, and all of it is
 * counted in whole days: due today is `due today` and soon, and overdue only
 * once the day is over. With a time in any of it, a milestone was overdue for
 * most of its own day, or `due 3 hours ago` and not overdue the evening before.
 */
export function dueLabel(dueOn, now = Date.now()) {
  const day = dueDay(dueOn);
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const title = `due ${day}`;
  if (day === today) return { className: 'due soon', textContent: 'due today', title };
  const due = `${day}T00:00:00Z`;
  const from = Date.parse(`${today}T00:00:00Z`);
  const near = day < today ? ' overdue' : Date.parse(due) - from < DUE_SOON ? ' soon' : '';
  return { className: `due${near}`, textContent: `due ${when(due, from)}`, title };
}

// A milestone due within this long is `soon`, its due date yellow, and one past
// it is overdue, a red badge: the two to look at for rescheduling.
export const DUE_SOON = 7 * 86400_000;
