// One milestone's work, in the order to do it in: what the PR pane's milestone
// viewer and the queue's milestone lines share. The rules first, which run
// under node as well as in the page (pr.js imports this, and the server
// imports pr.js -- see CLAUDE.md here), and the drawing under them. Nothing
// here touches the DOM at module scope.

import { h, mark, fraction } from './ui.js';
import { dueLabel, sizeChip } from './items.js';

// How priority and effort are written on an issue or a pull request, as
// LABELS.md in gaurav/milestones has it (read 2026-11-15, at d46781d): two
// labels, `Priority: High` and `Effort: M`. That file is the standard and
// prcoder one reader of it -- nothing here is the milestones board's code.
// `options` is each kind's order, the most pressing and the largest first,
// which is the order a milestone is worked in: by priority, then by effort.
// `prefix` is every label prefix that has carried the kind, and `values` what
// each spelling found under one means, the older ones included: `Priority:
// Critical` is Urgent, `Size: M` is M, and an effort of High, Medium or Low is
// L, M or S. A value the table does not know is no value: the label is left
// to be shown as any other, not guessed at.
export const LABEL_KINDS = {
  priority: {
    field: 'Priority', prefix: /^priority\s*:\s*(.+)$/i, none: 'No priority',
    options: ['Urgent', 'High', 'Medium', 'Low'],
    values: { critical: 'Urgent', urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' },
  },
  effort: {
    field: 'Effort', prefix: /^(?:size|effort)\s*:\s*(.+)$/i, none: 'No effort',
    options: ['XL', 'L', 'M', 'S', 'XS'],
    values: { xs: 'XS', s: 'S', small: 'S', low: 'S', m: 'M', medium: 'M', l: 'L', large: 'L', high: 'L', xl: 'XL' },
  },
};

/** What one label says about `kind`, as one of its options, or null for a label that is not about it. */
const optionOf = (kind, name) => {
  const said = LABEL_KINDS[kind].prefix.exec(String(name ?? '').trim())?.[1];
  return said ? LABEL_KINDS[kind].values[said.trim().toLowerCase()] ?? null : null;
};

/**
 * The priority or the effort a row's labels give it: `{ value, label, old }`,
 * or null when no label says. The label written the standard way stands over
 * any other, as LABELS.md has it; `old` is true for a value read from an
 * older spelling, which the viewer shows as such rather than as settled.
 */
export function labelValue(kind, labels = []) {
  const { field } = LABEL_KINDS[kind];
  const read = labels.map((label) => ({ label, value: optionOf(kind, label) })).filter((l) => l.value);
  const standard = read.find((l) => l.label.trim().toLowerCase() === `${field}: ${l.value}`.toLowerCase());
  const found = standard ?? read[0];
  return found ? { ...found, old: !standard } : null;
}

/** Whether a label is one the headings already say: a priority or an effort the table knows. */
export const isValueLabel = (name) => Object.keys(LABEL_KINDS).some((kind) => optionOf(kind, name));

/**
 * A pull request's effort guessed from its size, for one with none recorded:
 * the size chip's bands (sizeChip in items.js, which the milestones board
 * took from here so the two agree on what an M is), with XXL read as XL. Only
 * ever shown, as `~M`, and never used to place a row: a guess is not a
 * decision.
 */
export const effortGuess = (lines) => {
  const size = sizeChip(lines);
  return size === 'XXL' ? 'XL' : size;
};

/**
 * A milestone's rows in the order to work them, cut into the groups that
 * share a priority and an effort: `[{ key, parts, items }]`. Priority first,
 * then effort, each in its table's order, with the rows nobody has judged
 * after the judged ones of their group -- no label is not `Low` -- and the
 * most recently updated first within a group, the number settling a tie.
 *
 * `parts` is the heading, priority then effort: `{ text, level }`, where
 * `level` is the value's place in its scale from 1 (Urgent, XL) and 0 is
 * unset, which the page colours by. `items` is each row with what was read
 * for it: `{ row, priority, effort }`, labelValue's answers.
 */
export function sections(rows) {
  const kinds = Object.keys(LABEL_KINDS);
  const place = (kind, read) => (read ? LABEL_KINDS[kind].options.indexOf(read.value) : Number.MAX_SAFE_INTEGER);
  const items = rows.map((row) => {
    const read = Object.fromEntries(kinds.map((kind) => [kind, labelValue(kind, row.labels)]));
    return { row, ...read, at: kinds.map((kind) => place(kind, read[kind])) };
  });
  items.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]
    || String(b.row.updatedAt ?? '').localeCompare(String(a.row.updatedAt ?? '')) || a.row.number - b.row.number);
  const out = [];
  for (const { at, ...item } of items) {
    const key = kinds.map((kind) => item[kind]?.value ?? '').join('/');
    if (out.at(-1)?.key !== key) {
      out.push({
        key,
        parts: kinds.map((kind) => (item[kind]
          ? { text: item[kind].value, level: LABEL_KINDS[kind].options.indexOf(item[kind].value) + 1 }
          : { text: LABEL_KINDS[kind].none, level: 0 })),
        items: [],
      });
    }
    out.at(-1).items.push(item);
  }
  return out;
}

/**
 * Which milestone the viewer shows, as a number or null for what is on none.
 * What was picked for this pull request, while it is the one on screen; or
 * the pull request's own; or, for one on no milestone, the last one looked at
 * in this page, since a pull request that will never have a milestone is
 * still somewhere to look for the next thing from; or none.
 */
export const viewingFor = (pr, picked, last) => (picked !== undefined ? picked : pr?.milestone?.number ?? last ?? null);

/**
 * How the pull request on screen stands to the milestone being looked at
 * (`viewing`, a number or null for none): `{ dot, text, due, move }`. `dot` is
 * `on` where it is on that one, `other` where it is on another, `none` where
 * it is on none; `due` is the other milestone's date, for the line to say
 * beside it; and `move` is the button that would put it where the viewer is
 * looking -- its words, or null where it is already there.
 */
export function standing(pr, viewing) {
  const own = pr.milestone ?? null;
  const n = `#${pr.number}`;
  if (!own) return { dot: 'none', text: `${n} is on no milestone`, due: null, move: viewing == null ? null : 'Add it here' };
  if (own.number === viewing) return { dot: 'on', text: `${n} is on this milestone`, due: null, move: null };
  return { dot: 'other', text: `${n} is on ${own.title}`, due: own.dueOn ?? null, move: viewing == null ? `Take it off ${own.title}` : 'Move it here' };
}

// Which kinds the viewer lists, as the preference stores it: `pulls`,
// `issues` or `pulls issues`. Pull requests alone until someone asks for the
// issues, since a pull request is work already under way and the one to
// switch to.
export const KINDS_KEY = 'prcoder:milestone-kinds';
export const kindsFrom = (stored) => {
  const words = String(stored ?? '').split(/\s+/);
  const kinds = { pulls: words.includes('pulls'), issues: words.includes('issues') };
  return kinds.pulls || kinds.issues ? kinds : { pulls: true, issues: false };
};
export const kindsText = (kinds) => ['pulls', 'issues'].filter((k) => kinds[k]).join(' ');
/** `kinds` with `which` flipped; turning the last one off turns the other on, so the list is never of nothing. */
export const flipKind = (kinds, which) => {
  const next = { ...kinds, [which]: !kinds[which] };
  if (next.pulls || next.issues) return next;
  return which === 'pulls' ? { pulls: false, issues: true } : { pulls: true, issues: false };
};

/** `noun`, a plural, as one of them when `n` is 1: `issue`, `pull request`. */
export const several = (n, noun) => (n === 1 ? noun.replace(/s$/, '') : noun);

/**
 * A milestone's counts (`counts` from milestoneRow in github.js) as its pie
 * draws them, or null when there is nothing to draw: no counts -- a pulls.json
 * older than them -- counts that are not whole numbers, as in one damaged, or
 * a milestone that has never held anything. The pie is the whole milestone,
 * pull requests and issues together, so it is the same wherever it is drawn.
 * Done is what merged or closed; a pull request closed without merging is in
 * neither figure, since it is not done and not still to do (the owner's call,
 * 2026-10-24).
 */
export function tally(counts) {
  const { open, merged, closed } = counts?.pulls ?? {};
  const { open: issues, closed: shut } = counts?.issues ?? {};
  if (![open, merged, closed, issues, shut].every((n) => Number.isInteger(n) && n >= 0)) return null;
  const total = open + merged + issues + shut;
  return total ? { pulls: { open, merged, closed }, issues: { open: issues, closed: shut }, done: merged + shut, total } : null;
}

/** A tally as the pie's tooltip and name say it: `5 of 15 done: 2 pull requests merged, 3 issues closed`. */
export const tallyLabel = (t) => `${t.done} of ${t.total} done: ${t.pulls.merged} ${several(t.pulls.merged, 'pull requests')} merged, `
  + `${t.issues.closed} ${several(t.issues.closed, 'issues')} closed`;

/**
 * A milestone's pie, as the button that opens its breakdown. The figure is
 * its tooltip, as a mark's is, and its name, with what a press does.
 */
export function pieButton(m, t) {
  const label = tallyLabel(t);
  const b = h('button', { type: 'button', className: 'breakdown', title: label }, mark(fraction(t)));
  b.setAttribute('aria-label', `${label}; show the breakdown`);
  b.setAttribute('aria-haspopup', 'dialog');
  // A press while it is open for this pie closes it. The popover's light
  // dismiss has already hidden it by the click, on pointerdown, so that is
  // read there; a key press has no pointerdown and finds it still open.
  let wasOpen = false;
  b.onpointerdown = () => { wasOpen = popFor === b && pop.matches(':popover-open'); };
  b.onclick = () => {
    if (wasOpen || (popFor === b && pop.matches(':popover-open'))) { wasOpen = false; pop.hidePopover(); return; }
    showBreakdown(m, t, b);
  };
  return b;
}

/** The one breakdown popover, made on first use, and the pie it was opened from. */
let pop = null;
let popFor = null;

/**
 * Every figure the line draws a part of, as a table under the pie: pull
 * requests open, merged and closed without merging, and issues open and
 * closed, then the pie's figure, saying what it leaves out. A popover rather
 * than a longer line or a tooltip: the line is already as long as a narrow
 * pane allows, and a tooltip is one line of words, where this is a table to
 * read across. `auto`, so Escape and a click anywhere else close it. One on
 * <body> for every line, anchored by CSS to the pie it was opened from, which
 * alone carries the anchor's name (`.milestone-pop` in style.css); Firefox 153
 * and Chromium 151 both anchor (checked 2026-10-24). A button inside a
 * <summary> takes its own click and keys, so a press does not fold the group
 * (checked in both, the same day).
 */
function showBreakdown(m, t, at) {
  if (!pop) {
    pop = document.body.appendChild(h('div', { className: 'milestone-pop', popover: 'auto' }));
    pop.setAttribute('role', 'dialog');
  }
  const cells = (row, ...ns) => h('tr', {}, h('th', { scope: 'row' }, row), ...ns.map((n) => h('td', {}, n)));
  const { open, merged, closed } = t.pulls;
  pop.setAttribute('aria-label', `${m.title}: what it holds`);
  pop.replaceChildren(
    h('p', { className: 'head' }, m.title, m.dueOn ? ` · due ${dueLabel(m.dueOn).title}` : ''),
    h('table', {},
      h('thead', {}, h('tr', {}, h('td'), ...['open', 'merged', 'closed'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, cells('pull requests', String(open), String(merged), String(closed)),
        cells('issues', String(t.issues.open), '–', String(t.issues.closed)))),
    h('p', {}, `${t.done} of ${t.total} done`
      + (closed ? `, leaving out the ${closed} ${several(closed, 'pull requests')} closed without merging` : '')));
  popFor?.style.removeProperty('anchor-name');
  popFor = at;
  at.style.setProperty('anchor-name', '--milestone-pie');
  pop.showPopover();
}

/**
 * Close the breakdown when a repaint -- a poll, a search, a new listing -- has
 * taken away the pie it hangs from, which would leave it anchored to nothing.
 * Whatever redraws a pie calls this after it.
 */
export function staleBreakdown() {
  if (popFor && !popFor.isConnected && pop.matches(':popover-open')) pop.hidePopover();
}
