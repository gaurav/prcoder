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
 * sort as they read. "No milestone" is the caller's, and comes first: those
 * are the untriaged, which could belong at any level.
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

/**
 * A milestone's due date as its line says it, `due 3 days ago`, with the date
 * in full on hover (`Tuesday, October 27, 2026`) and a class saying how near
 * it is: `overdue`, `soon`, or neither. GitHub's dueOn is a date sent as the
 * start of that day (`T07:00:00Z` for a date set in California), so it is
 * compared as a date with today's on this clock: due today is `due today` and
 * soon, and overdue only once the day is over -- compared as a time, a
 * milestone was overdue for most of its own day. The distance is in whole
 * days for the same reason: when() on the time said `due in 19 hours` of
 * tomorrow's, and `5 hours ago` of yesterday's.
 */
export function dueLabel(dueOn, now = Date.now()) {
  const day = dueOn.slice(0, 10);
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // The day as written, in UTC so no time zone moves it to the one before.
  const title = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' }).format(Date.parse(`${day}T00:00:00Z`));
  if (day === today) return { className: 'due soon', textContent: 'due today', title };
  const near = day < today ? ' overdue' : Date.parse(dueOn) - now < DUE_SOON ? ' soon' : '';
  return { className: `due${near}`, textContent: `due ${inDays((Date.parse(day) - Date.parse(today)) / 86400_000)}`, title };
}

/**
 * A whole number of days from today as words: `tomorrow`, `in 3 days`, `2
 * months ago`; months from 30 days, years from 365. Only days say `tomorrow`
 * and `yesterday`: `auto` would make 40 days `next month`, which reads as the
 * calendar's.
 */
function inDays(days) {
  if (Math.abs(days) < 30) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(days, 'day');
  const [n, unit] = Math.abs(days) >= 365 ? [Math.trunc(days / 365), 'year'] : [Math.trunc(days / 30), 'month'];
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(n, unit);
}

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
// A milestone due within this long is `soon`, its due date yellow, and one past
// it is overdue, a red badge: the two to look at for rescheduling.
export const DUE_SOON = 7 * 86400_000;

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

/**
 * Whether the Pull requests tab's search matches a pull request: case-blind,
 * over `#N`, the title, the author, the head and base branches, the labels,
 * the body, the issues it closes by `#N` and title, and `word`, the state the
 * row shows -- so a base branch finds the stack on it, an issue finds the pull
 * requests for it whether or not the body names it, and `stacked` or
 * `conflicts` finds those. `word` is the merge word unless the caller knows
 * better: the row says `stacked (N)` for a `ready` built on others (pullWord
 * in queue.js), which needs the stack and so is the caller's to say.
 */
export const pullMatches = (p, query, word = p.merge) => {
  const q = (query ?? '').trim().toLowerCase();
  return !q || [`#${p.number}`, p.title ?? '', p.author ?? '', p.headRefName ?? '', p.baseRefName ?? '', ...(p.labels ?? []), p.body ?? '', word ?? '',
    ...(p.closes ?? []).flatMap((i) => [`#${i.number}`, i.title ?? ''])].join('\n').toLowerCase().includes(q);
};

// The History tab: what was sent to the coding agent, by day and by session.
// Pure, so the grouping and the labels are checked without a DOM, and `now`
// is a parameter so a test can hold it still. Every date here is the local
// one: "Yesterday" is the calendar's, not twenty-four hours.

/** The local calendar day `ms` falls on, as a Date at its midnight. */
const localDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** The local day as `YYYY-MM-DD`, a key that sorts as it reads. */
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * A day's heading: `Today`, `Yesterday`, the weekday's name within the last
 * week, and `Sat, Oct 31` before that, with the year once it is not this one.
 * Rounded to whole days from midnight to midnight, so a clock change does
 * not make yesterday two days ago. A day still to come (a clock put back) is
 * written as a date.
 */
export function dayLabel(ms, now = Date.now()) {
  const day = localDay(ms);
  const today = localDay(now);
  const days = Math.round((today - day) / 86400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('en', { weekday: 'long' }).format(day);
  const year = day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' };
  return new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', ...year }).format(day);
}

/** The time of day, `21:14`, on a 24-hour clock whatever the locale. */
export const timeLabel = (ms) =>
  new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

/**
 * The prompts by day, newest day first, and within a day by session, each
 * session's prompts newest first, as `[{ key, label, sessions: [{ id, rows }] }]`.
 * A session's order within a day is its newest prompt's, and one that ran
 * past midnight is under both days. A prompt with no session (`id` null) is
 * grouped under none.
 */
export function byDay(prompts, now = Date.now()) {
  const days = new Map();
  for (const p of [...prompts].sort((a, b) => b.at - a.at)) {
    const key = dayKey(p.at);
    if (!days.has(key)) days.set(key, { key, label: dayLabel(p.at, now), sessions: new Map() });
    const sessions = days.get(key).sessions;
    const id = p.session ?? '';
    if (!sessions.has(id)) sessions.set(id, { id: p.session ?? null, rows: [] });
    sessions.get(id).rows.push(p);
  }
  return [...days.values()].map((d) => ({ ...d, sessions: [...d.sessions.values()] }));
}

/**
 * The slash command a prompt starts with, `/code-review`, or null: what the
 * tab marks, since "did I review this yet" is answered by seeing one. A path
 * typed on its own, `/tmp`, is marked too, which costs nothing.
 */
export const commandOf = (text) => /^\/[A-Za-z][\w:-]*/.exec(String(text ?? '').trimStart())?.[0] ?? null;

/** Whether the History tab's search matches a prompt: case-blind, over its text. */
export const historyMatches = (p, query) => {
  const q = (query ?? '').trim().toLowerCase();
  return !q || String(p.text ?? '').toLowerCase().includes(q);
};
