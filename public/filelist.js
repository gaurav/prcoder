// The Files tab: how the changed files are grouped and ordered, how they are
// drawn, how far through them the review is, and the walk the keyboard takes
// through them (Alt+J, Alt+K and Alt+X in app.js). pr.js draws the tab bar and
// asks this file for the tab's contents.
//
// The server loads this through pr.js (cli.js), so nothing here may touch the
// DOM at module scope (public/CLAUDE.md).

import { h, ext, writeThrough, fold, kept, fraction, tabDone } from './ui.js';

// The Files tab's top-level order: config and docs, then tests, then code.
const GROUPS = [
  ['docs', 'Config & docs'],
  ['tests', 'Tests'],
  ['code', 'Code'],
];

// Groups record which are *closed*, the inverse of the description's sections
// (openSections in pr.js), because their default is open -- so a group nobody
// has touched needs no entry, and a group that appears for the first time
// arrives open rather than missing.
const closedGroups = new Set();

export const viewedCount = (files = []) =>
  ({ done: files.filter((f) => f.viewed).length, total: files.length });

const lines = (f) => (f.additions ?? 0) + (f.deletions ?? 0);

/** viewedCount by changed lines, additions plus deletions, rather than by files. */
export const viewedLines = (files = []) => ({
  done: files.filter((f) => f.viewed).reduce((n, f) => n + lines(f), 0),
  total: files.reduce((n, f) => n + lines(f), 0),
});

/**
 * The pie for a list of files: how much of the reviewing is left, which the
 * tab's `(14/17)` cannot say -- fourteen of seventeen with the last three the
 * biggest is a pie still mostly empty. So it fills by changed lines viewed, and
 * by files only where there are no lines to weigh (renames, mode changes,
 * binaries). Full is every file viewed, not every line: an unviewed rename
 * weighs nothing, and must not let a pie read as finished.
 */
export const filesProgress = (files = []) => {
  const count = viewedCount(files);
  const weight = viewedLines(files);
  // The part the count cannot say, written once for this label and filesName.
  const lines = weight.total ? `${weight.done} of ${weight.total} changed lines viewed` : null;
  return {
    p: fraction(weight.total ? weight : count).p,
    full: tabDone(count),
    label: `${count.done} of ${count.total} files` + (lines ? `, ${lines}` : ' viewed'),
    count,
    lines,
  };
};

/**
 * One group of changed files, folded.
 *
 * Open by default, which is the opposite of a description's sections and for
 * the opposite reason: this tab is the working surface, and a file list you
 * have to open is a file list in the way. The fold is here so a group you have
 * finished with can be got out of the way -- thirty-five files across three
 * groups is a smaller version of the problem the tabs were for.
 */
export function fileGroup({ label, files, rows }, handlers) {
  if (!files.length) return null;
  return fold({
    className: 'group', dataset: { group: label }, title: label, progress: filesProgress(files),
    ...kept(closedGroups, label, 'closed'),
  }, rows.map((r) => (r.path ? fileRow(r, handlers) : dirGroup(label, r.dir, r.files, handlers))));
}

/**
 * Two paths, ordered the way a tree is: a directory ahead of what is inside it,
 * siblings alphabetical. The folds are ordered by this; the files inside one are
 * ordered by bySize, and fall back to this only on a tie.
 *
 * Segment by segment, and it has to be -- comparing the whole strings is the
 * obvious version and it splits a directory from its children. `alpha-x/` and
 * `alpha/beta/` first differ at `-` (45) against `/` (47), so a string compare
 * puts `alpha-x/` *between* `alpha/` and `alpha/beta/`. Segment 0 is `alpha`
 * against `alpha-x` here, which cannot go wrong that way.
 *
 * Running out of segments is the answer for a prefix: `alpha/` and
 * `alpha/beta/` agree on segment 0, and the trailing `/` every directory key
 * carries leaves `alpha/` with an empty final segment, which sorts below any
 * real name. The length return is what catches a key without the slash.
 */
export const byPath = (a, b) => {
  const A = a.split('/'), B = b.split('/');
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  return A.length - B.length;
};

/**
 * Two files, the one with more changed lines first -- additions plus deletions,
 * so a file rewritten line for line counts both halves -- and by path on a tie.
 * The largest change in a directory is usually the one to read first.
 */
export const bySize = (x, y) =>
  lines(y) - lines(x) || byPath(x.path, y.path);

/**
 * The files of one group, split into the ones at the top of the repository and
 * one entry per directory below it.
 *
 * The order is this pane's own, not `gh`'s. It used to be inherited -- `gh`
 * returns the files sorted by path, so one pass left the directories in
 * whatever order their *first* file happened to fall in, which is not an order
 * over the directories at all: a group here drew `.claude/skills/run-prcoder/`,
 * `.github/workflows/`, the root, `docs/`, with the repo's own README buried in
 * the middle. The Map is an accumulator now: `byPath` orders the directories,
 * which keeps a parent ahead of its children, and `bySize` the files in each.
 *
 * Root files come back separately because they are not a fold. They have no
 * directory to be named after and nothing to strip off their rows, so they draw
 * as the group's first rows and each group reads like a tree.
 */
export const byDir = (files) => {
  const root = [], dirs = new Map();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    if (cut === -1) { root.push(f); continue; }
    const dir = f.path.slice(0, cut + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  for (const list of dirs.values()) list.sort(bySize);
  return { root: root.sort(bySize), dirs: [...dirs].sort(([a], [b]) => byPath(a, b)) };
};

/**
 * The Files tab's layout, and the one place its order is decided: a group per
 * GROUPS entry, in that order, holding its `files` and the `rows` it draws --
 * the root files, each a row, then one `{ dir, files }` fold per directory, as
 * byDir orders them; a row with a `path` is a file. An empty group is kept, and draws nothing.
 *
 * fileGroup draws it and fileOrder walks it, so the keyboard's "next file" is
 * the row under the one on screen by construction rather than by two functions
 * agreeing: a change to how the tab lays out its rows is made here, for both.
 */
export const fileTree = (files = []) => GROUPS.map(([key, label]) => {
  const mine = files.filter((f) => f.group === key);
  const { root, dirs } = byDir(mine);
  return { key, label, files: mine, rows: [...root, ...dirs.map(([dir, list]) => ({ dir, files: list }))] };
});

/**
 * Every changed file in the order the Files tab draws them (fileTree). The
 * keyboard walks this list -- Alt+J, Alt+K and Alt+X in app.js. Worked out
 * here rather than read off the page, because the Files tab is not always the
 * one showing: the keys work from Detail, Checks and the terminal too.
 */
export const fileOrder = (files = []) => fileTree(files)
  .flatMap((g) => g.rows.flatMap((r) => (r.path ? [r] : r.files)));

/**
 * Opens the folds `path`'s row sits in -- its group, and its directory if it
 * has one -- and brings the row into view, for a file the keyboard opened.
 * A click is on a row already showing, but Alt+J walks into folds the user
 * closed to get them out of the way, and a selection inside one is a selection
 * nobody can see. Into `closedGroups` as well as onto the page, so the Files
 * tab shows the row open when it is drawn next, if it is not the tab showing
 * now. Only the row scrolls: `nearest` leaves the pane alone when the row is
 * already visible.
 */
export function revealFile(files, path) {
  for (const g of fileTree(files)) {
    const r = g.rows.find((x) => x.path === path || x.files?.some((f) => f.path === path));
    if (!r) continue;
    closedGroups.delete(g.label);
    if (!r.path) closedGroups.delete(dirKey(g.label, r.dir));
  }
  const row = document.querySelector(`.file[data-path="${CSS.escape(path)}"]`);
  for (let d = row?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  row?.scrollIntoView({ block: 'nearest' });
}

/**
 * The file `step` rows on from `path` in that order -- +1 the next, -1 the
 * one before -- or null at either end: the keys stop there rather than wrap,
 * so the last file is where the list runs out and not where it starts again.
 * With no file open there is nothing to step from, so a step forward is the
 * first file and a step back the last.
 */
export function fileFrom(files, path, step) {
  const order = fileOrder(files);
  if (!order.length) return null;
  const at = order.findIndex((f) => f.path === path);
  if (at === -1) return step > 0 ? order[0] : order[order.length - 1];
  return order[at + step] ?? null;
}

/**
 * The next file still unviewed after `path`, going round to the top past the
 * end, or null once every file is viewed. `path` itself is never the answer:
 * Alt+X has just marked it, and a tick that failed to land would otherwise
 * open the same file again as its own "next". With no file open, the first
 * unviewed file.
 */
export function nextUnviewed(files, path) {
  const order = fileOrder(files);
  const at = order.findIndex((f) => f.path === path);
  for (let i = 1; i <= order.length; i++) {
    const f = order[(at + i) % order.length];
    if (!f.viewed && f.path !== path) return f;
  }
  return null;
}

/**
 * One directory inside a group, folded like the group itself.
 *
 * The fold state is keyed by group *and* directory: `public/` under Code and
 * `public/` under Tests are two different folds, and a single key would close
 * both. Both keys live in the one `closedGroups` set -- a group's label never
 * ends in `/` and a directory's key always does, so the two kinds cannot
 * collide.
 */
const dirKey = (group, dir) => `${group}/${dir}`;
function dirGroup(group, dir, files, handlers) {
  const key = dirKey(group, dir);
  return fold({
    className: 'dir', dataset: { dir }, title: dir, progress: filesProgress(files),
    ...kept(closedGroups, key, 'closed'),
  }, files.map((f) => fileRow(f, handlers, dir)));
}

/**
 * The +/− counts for one file, as [class, text] pairs. A side that changed
 * nothing is left out rather than shown as a zero: `+101` reads as an addition
 * at a glance where `+101 −0` does not. A file with neither (a rename, a mode
 * change) gets no counts at all. The header's totals above keep both sides on
 * purpose -- `+400 −0` there says the shape of the whole PR at a glance.
 */
export const nums = ({ additions, deletions }) => [
  additions ? ['add', `+${additions}`] : null,
  deletions ? ['del', `−${deletions}`] : null,
].filter(Boolean);

// `selected` is a function, asked as the row is drawn: a tab switch redraws
// the rows with the handlers of the last paint, which can predate the file
// opened since -- by a click, or by Alt+J from another tab.
function fileRow(f, { onViewed, onOpen, selected }, dir = '') {
  const box = h('input', { type: 'checkbox', checked: f.viewed, title: 'mark viewed on GitHub' });
  writeThrough(box, (v) => onViewed(f.path, v));
  // The path goes inside a <bdi>. Its container is `direction: rtl` so that a
  // long path is cut at the *head* and the filename survives -- but that also
  // makes a leading `.` a neutral character at the start of an RTL run, which
  // the bidi algorithm moves to the visual end: `.gitignore` rendered as
  // `gitignore.` and `.github/workflows/test.yml` as `github/...test.yml.`.
  // A bdi isolates the path and resolves it by its own first strong character,
  // which for any real path is a Latin letter, so it lays out left to right
  // inside a box that still overflows from the left. Checked in both engines
  // on 2026-09-09; `unicode-bidi: plaintext` on the link fixes the order too,
  // but moves the cut to the tail, which is the thing the rtl was for. An LRM
  // prefix and an LRI…PDI wrap both work, and both put invisible characters
  // into text people copy.
  // The name the fold above it does not already say. `title` stays the whole
  // path: the row is what you point at when you want to know where a file is,
  // and the directory heading may have scrolled off the top of a long group.
  // A root row has no fold above it and passes no `dir`, which slices nothing.
  const shown = f.path.slice(dir.length);
  const link = ext(f.url, h('bdi', {}, shown), { className: 'path', title: f.path });
  link.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) return;   // GitHub stays one modifier away
    e.preventDefault();
    onOpen(f);
  });
  const row = h('div', {
    className: `file${f.viewed ? ' viewed' : ''}${f.path === selected?.() ? ' sel' : ''}`,
    dataset: { path: f.path },
  },
    box,
    link,
    h('span', { className: 'nums' },
      ...nums(f).map(([cls, text], i) => [i ? ' ' : null, h('span', { className: cls }, text)])),
  );
  return row;
}
