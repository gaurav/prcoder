// A picker of our own, in place of a native <select> whose `change` acts at
// once: a button that shows the current value and opens a list with a search
// field over it. Nothing is picked but by Enter on the highlighted row or a
// click on a row, in the open list. A closed <select> changes on a bare arrow
// (Linux and Windows) or a letter (everywhere), and where a change is a
// checkout or a write to GitHub that is a key on its way somewhere else doing
// it (#188). Here the closed button only opens, and arrows, letters and the
// wheel only move through an open list.
//
// The list is a `popover="auto"` on <body>, anchored by CSS to the button, as
// the queue's milestone breakdown is (showBreakdown in queue.js). So it is not
// in the pane that draws its button, and a redraw of that pane -- the poll's,
// every few seconds -- neither shuts it nor takes the focus from its search
// field: each redraw calls picker() again, which hands back a button for the
// same picker and brings the open list's rows up to date in place. The native
// selects needed the page to guess when a dropdown was open, by the focus, and
// to draw around it (the switcher's held options, `replaceKeeping` in ui.js);
// both went with them.
//
// pr.js imports this, so the server loads it too: no DOM at module scope
// (public/CLAUDE.md).

import { h } from './ui.js';

/** Case-blind: whether every word of `query` is somewhere in `text`. */
export const wordsIn = (text, query) => {
  const hay = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/**
 * The filter a picker uses unless it is given its own: with nothing typed the
 * rows as they are, groups and indents and all; with a query the ones whose
 * text (or `search`, where a row has more to be found by) has every word of
 * it, flat, since a match's parent may not be one.
 */
export const matchRows = (rows, query) => (query.trim()
  ? rows.filter((r) => wordsIn(r.search ?? r.text, query)).map((r) => ({ ...r, depth: 0, group: undefined }))
  : rows);

/**
 * Where the highlight goes from `from` by `step` over `rows`, skipping the
 * disabled, and stopping at the ends: a list that wrapped put the highlight on
 * the first row for one press too many of ↓ held down. -1 when no row can be
 * picked. `from` -1 starts before the first, or after the last.
 */
export const stepRow = (rows, from, step) => {
  const start = from < 0 ? (step > 0 ? -1 : rows.length) : from;
  for (let i = start + step; i >= 0 && i < rows.length; i += step) if (!rows[i].disabled) return i;
  return from >= 0 && rows[from] && !rows[from].disabled ? from : -1;
};

// Every picker on the page, by id: what outlives the buttons a redraw makes.
const pickers = new Map();

const isOpen = (p) => p.pop.matches(':popover-open');

/** The rows the open list shows for what is typed, and the highlight kept on its row. */
function draw(p) {
  const { opts } = p;
  const query = p.input.value;
  p.shown = (opts.filter ?? matchRows)(opts.rows, query);
  const keyed = p.shown.findIndex((r) => r.key === p.at);
  // The row it was on, while that is still listed and can be picked; else the
  // current value's with nothing typed, and the first that can be picked.
  const current = query.trim() ? -1 : p.shown.findIndex((r) => r.key === opts.current && !r.disabled);
  const i = keyed >= 0 && !p.shown[keyed].disabled ? keyed : current >= 0 ? current : stepRow(p.shown, -1, 1);
  p.at = p.shown[i]?.key ?? null;
  const row = (r, n) => {
    const el = h('div', { id: `${p.list.id}-${n}`, className: `picker-row${r.cls ? ` ${r.cls}` : ''}`, dataset: { key: r.key } },
      h('span', { className: 'picker-text' }, `${r.depth ? '└ ' : ''}${r.text}`),
      r.detail ? h('span', { className: `picker-detail${r.detail.cls ? ` ${r.detail.cls}` : ''}`, ...(r.detail.title ? { title: r.detail.title } : {}) }, r.detail.text) : null);
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(r.key === p.at));
    if (r.disabled) el.setAttribute('aria-disabled', 'true');
    if (r.key === opts.current) el.setAttribute('aria-current', 'true');
    if (r.title) el.title = r.title;
    if (r.depth) {
      el.dataset.depth = r.depth;
      el.style.paddingLeft = `${8 + 14 * r.depth}px`;
    }
    return el;
  };
  // Rows of one group, in a run, sit under its label; the rest are the list's own.
  const out = [];
  let group = null;
  p.shown.forEach((r, n) => {
    if (r.group && group?.name !== r.group) {
      group = { name: r.group, el: h('div', { className: 'picker-group' }, h('div', { className: 'picker-group-label' }, r.group)) };
      group.el.setAttribute('role', 'group');
      group.el.setAttribute('aria-label', r.group);
      group.el.firstChild.setAttribute('aria-hidden', 'true');
      out.push(group.el);
    } else if (!r.group) group = null;
    (group ? group.el : { append: (el) => out.push(el) }).append(row(r, n));
  });
  p.list.replaceChildren(...(out.length ? out : [h('div', { className: 'picker-none' }, (query.trim() ? opts.none : opts.empty) ?? 'nothing matches')]));
  mark(p);
}

/** Say which row is highlighted, to the eye and to a screen reader, and keep it in view. */
function mark(p) {
  let on = null;
  p.list.querySelectorAll('[role=option]').forEach((el) => {
    const is = el.dataset.key === p.at;
    el.setAttribute('aria-selected', String(is));
    if (is) on = el;
  });
  if (on) p.input.setAttribute('aria-activedescendant', on.id);
  else p.input.removeAttribute('aria-activedescendant');
  on?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Shut the list. With `focus`, for a pick or an Escape, the focus goes back
 * to where it was when the list opened -- the terminal, when a shortcut
 * opened it from there, so the next key is the agent's again -- or to the
 * button as it is now, which a redraw may have made since.
 */
function close(p, focus = false) {
  if (isOpen(p)) p.pop.hidePopover();
  if (!focus) return;
  const back = p.back?.isConnected && p.back !== document.body && !p.back.matches?.('[data-picker]') ? p.back : p.button;
  if (back?.isConnected) back.focus();
}

function pick(p, key) {
  const row = p.shown.find((r) => r.key === key);
  if (!row || row.disabled) return;
  const { onPick, current } = p.opts;
  close(p, true);
  // The one it is on already is no pick: the list was opened and left as it was.
  if (row.key !== current) onPick?.(row);
}

function open(p) {
  if (isOpen(p) || p.button.disabled) return;
  p.input.value = '';
  p.at = null;
  p.back = document.activeElement;
  draw(p);
  p.pop.showPopover();
  p.input.focus();
  p.opts.onOpen?.();
}

function make(id) {
  const list = h('div', { id: `picker-${id}-list`, className: 'picker-list' });
  list.setAttribute('role', 'listbox');
  const input = h('input', { type: 'search', className: 'picker-search', autocomplete: 'off', spellcheck: false });
  Object.entries({ role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': list.id })
    .forEach(([k, v]) => input.setAttribute(k, v));
  const pop = h('div', { className: 'picker-pop', dataset: { picker: id } }, input, list);
  pop.setAttribute('popover', 'auto');
  const p = { id, pop, input, list, button: null, opts: { rows: [] }, shown: [], at: null };
  pop.style.setProperty('position-anchor', `--picker-${id}`);
  input.oninput = () => {
    // What is typed chooses again from the top; the row it was on may be gone.
    p.at = null;
    draw(p);
  };
  input.onkeydown = (e) => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    const at = p.shown.findIndex((r) => r.key === p.at);
    let to = null;
    if (move) to = stepRow(p.shown, at, move);
    // Home and End are the text's while there is some: the caret's ends.
    else if (e.key === 'Home' && !input.value) to = stepRow(p.shown, -1, 1);
    else if (e.key === 'End' && !input.value) to = stepRow(p.shown, -1, -1);
    else if (e.key === 'PageDown' || e.key === 'PageUp') {
      to = at;
      for (let n = 0; n < 8; n++) to = stepRow(p.shown, to, e.key === 'PageDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Not a key held down from before the list opened, nor one that is part
      // of composing a character.
      if (!e.repeat && !e.isComposing && p.at != null) pick(p, p.at);
      return;
    } else if (e.key === 'Escape') {
      // The search field's own Escape clears it; this one leaves, as a menu's does.
      e.preventDefault();
      close(p, true);
      return;
    } else if (e.key === 'Tab') {
      // On from the button, as if the list had not been open.
      close(p, true);
      return;
    } else return;
    e.preventDefault();
    if (to >= 0) p.at = p.shown[to].key;
    mark(p);
  };
  // A press, not a click, so a drag begun on a row and let go off it picks
  // nothing; and never the focus off the search field.
  list.onpointerdown = (e) => e.preventDefault();
  list.onclick = (e) => {
    const el = e.target.closest?.('[role=option]');
    if (el) pick(p, el.dataset.key);
  };
  // beforetoggle, which comes as the list opens or shuts, however it does --
  // the light dismiss included. `toggle` comes a task later, and for that long
  // the button said a shut list was open.
  pop.addEventListener('beforetoggle', (e) => {
    p.button?.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open') p.opts.onClose?.();
  });
  document.body.append(pop);
  pickers.set(id, p);
  return p;
}

/**
 * The button of picker `id`, showing `text`, for the caller to put on the
 * page -- or `button`, one already there, made into it. Called on every
 * redraw: the picker itself is kept by `id`, so its open list stays open, and
 * is brought up to `rows` where it is.
 *
 *   rows     `[{ key, text, depth, group, disabled, title, cls, detail, search }]`.
 *            `key` is a string, and what `current` and a pick go by. `detail`
 *            is `{ text, cls, title }`, said after the text; `search` is
 *            what a row is found by when that is more than its text.
 *   current  the key of the value the button shows, marked in the list.
 *   scope    what the picker is about -- the pull request, say. A redraw with
 *            another shuts an open list, since a pick there would be about
 *            something no longer on screen.
 *   filter   `(rows, query) => rows`, in place of matchRows: its own ranking,
 *            or a row made from the query.
 *   onPick   `(row)`, on Enter or a click in the open list, and then only for
 *            a row that is not `current` and not disabled.
 *   onOpen, onClose   as the list opens and shuts.
 *   label    the control's name, for a screen reader; `placeholder` the
 *            search field's; `empty` and `none` what the list says with no
 *            rows at all and with none matching.
 */
export function picker(id, { button = null, text, title = null, label, cls = '', disabled = false, scope = '', dataset = {}, placeholder = 'search', ...opts }) {
  const p = pickers.get(id) ?? make(id);
  const b = button ?? h('button', { type: 'button' });
  b.className = `picker${cls ? ` ${cls}` : ''}`;
  const caret = h('span', { className: 'caret' }, '▾');
  caret.setAttribute('aria-hidden', 'true');
  b.replaceChildren(h('span', { className: 'picker-value' }, text), caret);
  b.title = title ?? '';
  b.disabled = disabled;
  b.setAttribute('aria-haspopup', 'listbox');
  b.setAttribute('aria-label', `${label}: ${text}`);
  [...Object.keys(b.dataset)].forEach((k) => delete b.dataset[k]);
  Object.assign(b.dataset, dataset, { picker: id });
  b.style.setProperty('anchor-name', `--picker-${id}`);
  // The light dismiss shuts the list on the press, before the click that
  // would then open it again: a click on the button of an open list closes it.
  let wasOpen = false;
  b.onpointerdown = () => { wasOpen = isOpen(p); };
  b.onclick = () => {
    if (wasOpen) { wasOpen = false; return; }
    open(p);
  };
  // ↓ and ↑ open it, as they do a select; no other key does anything here.
  b.onkeydown = (e) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    open(p);
  };
  const moved = p.scope !== undefined && p.scope !== scope;
  if (p.button && p.button !== b) {
    p.button.style.removeProperty('anchor-name');
    // A redraw replaces the button, and with it the focus a pick or an Escape
    // had just handed back: the new one takes it, once it is on the page.
    if (document.activeElement === p.button) {
      queueMicrotask(() => { if (b.isConnected && (document.activeElement === document.body || !document.activeElement)) b.focus(); });
    }
  }
  Object.assign(p, { button: b, scope, opts });
  p.input.placeholder = placeholder;
  p.input.setAttribute('aria-label', label);
  p.list.setAttribute('aria-label', label);
  b.setAttribute('aria-expanded', String(isOpen(p)));
  if (isOpen(p)) {
    if (moved || disabled) close(p);
    else draw(p);
  }
  return b;
}

/** Open picker `id` with the caret in its search field, for a shortcut. False when it cannot. */
export function openPicker(id) {
  const p = pickers.get(id);
  if (!p?.button?.isConnected || p.button.disabled || p.button.hidden) return false;
  open(p);
  return isOpen(p);
}

/**
 * Shut any open list whose button a redraw has taken off the page or hidden,
 * which would leave it anchored to nothing: the milestone line's, when the
 * pane turns to a branch with no pull request.
 */
export function closeOrphans() {
  pickers.forEach((p) => {
    if (isOpen(p) && (!p.button?.isConnected || p.button.hidden)) close(p);
  });
}
