import { h, btn, ext, api, toast, blocks, writeThrough } from './pr.js';
import { TABS } from './items.js';

// The client owns the list; every change persists the whole array. Single user,
// single repo — no ids, no diffing.
let items = [];
let tab = 'local';
let deps = {};
// Set while a branch switch is in flight. The switch ends by replacing the
// whole list from the server, so a click landing in the middle of it writes the
// array as it was before the switch and then watches the response take it back.
// Inert for those few hundred milliseconds is the honest thing to show.
let frozen = false;

// Repaints, because render() is what marks the list inert. The guard in save()
// used to be the only one, by which point the click had already flipped a box
// or pushed an item into the local array -- the write was dropped and the UI
// went on showing it as saved until a poll silently took it back.
export const freeze = (on) => { frozen = on; render(); };

/**
 * Replace the list from the server. Skipped while an item is being edited: the
 * text is contentEditable and only saves on blur, so a poll landing mid-typing
 * would throw the edit away. Skipped while a row is being dragged, too: the
 * repaint replaces the row under the pointer, the drop lands on nothing, and
 * the reorder silently does not happen.
 *
 * Only those two are at risk, so only they hold the list back. Anything else in
 * the pane can keep focus indefinitely -- a clicked tab does, in Chromium -- and
 * freezing on it leaves the queue stale with nothing to unstick it.
 */
export function setItems(next, prAvailable, prOnScreen = null) {
  if (document.activeElement?.closest?.('#queue-body .text[contenteditable]')) return;
  if (document.querySelector('#queue-body .item.dragging')) return;
  items = next;
  hasPr = prAvailable;
  pr = prOnScreen;
  render();
}

// The sources, read straight from where they live rather than kept in the
// queue: the PR on screen, from the poll. Its description's checkboxes are the
// PR tab, and the issues it mentions without closing are the Issues tab -- whose
// titles are fetched when that tab is opened, since nothing else needs them.
let pr = null;
let openIssues = null;

// Moving an item into a PR description needs this branch's own PR on screen.
// Filing an issue does not, so that control stays live on a branch that has none.
let hasPr = true;
const NO_PR = 'no pull request for this branch to move items into';

// Which end the input adds to. The queue is two things at once -- a backlog in
// the order you mean to work through it, and somewhere to put the thing you
// must not forget to do next -- so the end is the user's to choose, and the
// arrow on the button says which one is live without being clicked.
//
// The app's only stored preference, and a best-effort one: reading storage
// throws outright where it is disabled, and the origin is a port -- so a repo
// whose port moves, or one opened through PRCODER_PORT, is a different origin
// and starts again from the default. Losing it costs a click.
const ADD_TO_KEY = 'prcoder:add-to';
let addTo = 'bottom';
const readAddTo = () => {
  try { return localStorage.getItem(ADD_TO_KEY) === 'top' ? 'top' : 'bottom'; } catch { return 'bottom'; }
};

export async function initQueue(d) {
  deps = d;
  // Read here rather than at module scope: initQueue only ever runs in a
  // browser, so the module stays importable by a node test that has no
  // localStorage to touch.
  addTo = readAddTo();
  document.getElementById('queue-where').onclick = () => {
    addTo = addTo === 'bottom' ? 'top' : 'bottom';
    try { localStorage.setItem(ADD_TO_KEY, addTo); } catch { /* honoured for this session anyway */ }
    paintWhere();
  };
  // Before the fetch, so a remembered ↑ is not shown as the markup's ↓ for as
  // long as /api/queue takes to answer.
  paintWhere();
  // api(), not a bare fetch: a 500 answers `{error}` with a 200-shaped body, and
  // assigning that object to `items` made the very next render() throw on
  // items.filter -- a server-side error taking the whole pane down rather than
  // showing itself.
  try {
    items = await api('/api/queue', undefined, 'GET');
  } catch (e) {
    toast(e.message, true);
  }
  render();
}

/** Whether the change reached the server, for the one caller that has to undo. */
const save = async (url = '/api/queue', method = 'PUT', body = { items }) => {
  // The backstop behind inert -- a blur fired *by* the freeze still lands here.
  // Loud, because the local array has already moved and the next poll is about
  // to move it back.
  if (frozen) {
    toast('busy switching branches — that change was not saved', true);
    return false;
  }
  let data;
  try { data = await api(url, body, method); } catch (e) { toast(e.message, true); return false; }
  if (Array.isArray(data)) items = data;
  render();
  return true;
};

const LABELS = { local: 'Local', pr: 'PR', issues: 'Issues', done: 'Completed', deleted: 'Deleted' };

// Local is always there because an *empty* Local is the thing worth seeing --
// it is how a tidy session ends. Completed is always there because it is where
// the delete-all lives. Deleted hides when it holds nothing.
const ALWAYS = ['local', 'done'];

/**
 * Which tabs the strip draws, and which of them is active: your own list's tabs,
 * with the `sources` that are available -- PR and Issues, when there is a PR on
 * screen -- between Local and the rest. Pure, and exported only so it can
 * be checked without a DOM -- render() is the sole caller and decides neither
 * for itself.
 *
 * The tab you were on can empty and vanish from the strip -- restoring the last
 * tombstone does it -- leaving nothing highlighted and a list with no tab to
 * click back to. Local is never left this way: it is in ALWAYS.
 *
 * tools/browser.mjs leans on the hiding rule from the other side: it seeds a
 * deleted item precisely because a tab with nothing in it is not there to be
 * clicked, and a driver that clicks one that is missing hangs for 30s rather
 * than failing.
 */
export function stripFor(list, active, sources = []) {
  const own = Object.keys(TABS).filter((n) => n !== 'local' && (ALWAYS.includes(n) || list.some(TABS[n])));
  const strip = ['local', ...sources, ...own];
  return { strip, tab: strip.includes(active) ? active : 'local' };
}

/** The PR description's checklist, in the order a tick counts it. */
const prTasks = () => (pr ? blocks(pr.body).filter((b) => b.kind === 'task') : []);

/**
 * The issues the description mentions and does not close. The ones it closes
 * are what the PR already answers; a bare `#N` elsewhere is work it points at.
 *
 * ponytail: mentions only. Milestones, search and showing an issue here are a
 * design of their own, and this tab is where they would go.
 */
const mentioned = () => (pr?.issues ?? []).filter((i) => !i.closes);

function render() {
  const host = document.getElementById('queue-body');
  // Native, and it covers what a per-control `disabled` would miss: the
  // contentEditable text, the drag handles, focus.
  host.inert = frozen;
  const { strip, tab: active } = stripFor(items, tab, pr ? ['pr', 'issues'] : []);
  tab = active;
  // A source's count is what it still holds open; the list's own are its tabs.
  const count = (name) => (name === 'pr' ? prTasks().filter((t) => !t.done).length
    : name === 'issues' ? mentioned().length
      : items.filter(TABS[name]).length);
  const label = (n) => `${LABELS[n]} (${count(n)})`;
  const shown = TABS[tab] ? items.filter(TABS[tab]) : [];

  host.replaceChildren(
    h('div', { className: 'tabs' },
      ...strip.map((n) => tabBtn(n, label(n))),
      h('span', { className: 'spacer' }),
      ...bulks(),
    ),
    tab === 'pr' ? prList()
      : tab === 'issues' ? issueList()
        : h('ul', { className: 'items' }, ...shown.map((i, n) => row(i, shown[n - 1], shown[n + 1]))),
  );

  // Adding always lands in Local, so say so where that is not what you are
  // looking at.
  document.getElementById('queue-input').placeholder =
    tab === 'local' ? 'Add an item, Enter to save' : 'Add an item…';
}

/**
 * The bulk actions, which belong to one tab each: you act on the list in front
 * of you. Both destructive ones confirm and say what they are about to take,
 * because a bulk delete has no single row to have thought twice about.
 */
function bulks() {
  const of = (name) => items.filter(TABS[name]);
  const many = (n) => `${n} item${n === 1 ? '' : 's'}`;

  if (tab === 'local') {
    return [bulk('→ all to PR', () => {
      const local = of('local');
      // Confirmed, because it writes to GitHub and empties the tab in one click.
      if (!local.length || !confirm(`Move ${many(local.length)} into the PR description?\n\nThey are added there as checkboxes and leave the queue.`)) return;
      toPr(local);
    }, { disabled: !hasPr, title: hasPr ? 'move every item here into the PR description' : NO_PR })];
  }
  if (tab === 'done') {
    return [bulk('delete all', () => {
      const done = of('done');
      // A tombstone, like the row's own ✕: these land in Deleted, and the
      // confirm says so rather than implying they are gone.
      if (!done.length || !confirm(`Delete ${many(done.length)} from Completed?\n\nThey move to the Deleted tab, where they can be restored.`)) return;
      done.forEach((i) => { i.deleted = true; });
      save();
    })];
  }
  if (tab === 'deleted') {
    // The only hard delete in the app, and it is behind the tab that shows you
    // what you are about to lose.
    return [bulk('delete forever', () => {
      const gone = of('deleted');
      if (!gone.length || !confirm(`Permanently delete ${many(gone.length)}?\n\nThis cannot be undone.`)) return;
      items = items.filter((i) => !i.deleted);
      save();
    })];
  }
  return [];
}

/**
 * Out of the queue and into somewhere permanent. The server writes there first
 * and answers the list without them, so a failure leaves them where they were.
 */
const toPr = (moving) => save('/api/queue/to-pr', 'POST', { items, indices: moving.map((i) => items.indexOf(i)) });

// The button is static markup in the pane header, which render()'s
// replaceChildren never reaches, so only the two things that change addTo have
// to repaint it. The title says both where items go now and what a click does;
// the accent is there because ↑ is the choice you made, not the default.
function paintWhere() {
  const b = document.getElementById('queue-where');
  const title = addTo === 'bottom'
    ? 'new items go to the bottom — click to add to the top'
    : 'new items go to the top — click to add to the bottom';
  b.textContent = addTo === 'bottom' ? '↓' : '↑';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.classList.toggle('top', addTo === 'top');
}

/**
 * Drop `from` where `to` currently sits, in place.
 *
 * The correction is the whole of it: the row is removed first, which shifts
 * every index above it down by one, so an unadjusted `to` puts a downward drag
 * *past* the row it was dropped on while an upward one lands before it -- the
 * same gesture meaning two different things depending on direction. Out here
 * rather than inline in the drop handler because it is the one part of a drag
 * that can be checked without a browser.
 */
export function reorder(list, from, to) {
  const [moved] = list.splice(from, 1);
  list.splice(from < to ? to - 1 : to, 0, moved);
  return list;
}

const tabBtn = (name, label) => btn(label, () => {
  tab = name;
  render();
  if (name === 'issues') loadIssues();
}, { className: tab === name ? 'tab on' : 'tab' });

/** Titles, refetched on every visit to the tab: issues change on GitHub, not here. */
async function loadIssues() {
  try {
    openIssues = new Map((await api('/api/issues', undefined, 'GET')).map((i) => [i.number, i.title]));
  } catch (e) {
    toast(e.message, true);
  }
  if (tab === 'issues') render();
}

/**
 * Copied into your queue, and left where it was: a checkbox in the description
 * is the PR's record and an issue is the project's, so pulling an item is taking
 * it on, not taking it away. Something already on Local is not added twice.
 */
async function pull(text, issue = null) {
  if (items.some((i) => TABS.local(i) && i.text === text)) {
    toast('already in your queue');
    return;
  }
  const item = { text, done: false, issue, deleted: false };
  if (addTo === 'top') items.unshift(item); else items.push(item);
  if (await save()) toast(`added to your queue: ${text}`);
  else items = items.filter((i) => i !== item);
}

/** The PR tab: the description's own checkboxes, ticked through to GitHub. */
function prList() {
  const tasks = prTasks();
  if (!tasks.length) return h('p', { className: 'empty' }, `No checkboxes in PR #${pr.number}'s description.`);
  return h('ul', { className: 'items' }, ...tasks.map((t) => {
    const box = h('input', { type: 'checkbox', checked: t.done, title: 'tick this on GitHub' });
    writeThrough(box, (v) => deps.onTask({ index: t.index, done: v, text: t.text }));
    return h('li', { className: 'item source' },
      box,
      h('span', { className: 'text', textContent: t.text }),
      h('span', { className: 'actions' },
        btn('↓', () => pull(t.text), { title: 'copy into your queue' })));
  }));
}

/**
 * The Issues tab: what the description mentions without closing. A mention that
 * is not among the open issues is a closed one, or a pull request -- a bare `#N`
 * is either on GitHub -- and says so rather than disappearing, since the
 * description still points at it.
 */
function issueList() {
  const list = mentioned();
  if (!list.length) return h('p', { className: 'empty' }, `PR #${pr.number}'s description mentions no issues it does not close.`);
  return h('ul', { className: 'items' }, ...list.map((i) => {
    const title = openIssues?.get(i.number);
    const text = title ?? (openIssues ? 'not an open issue' : '…');
    return h('li', { className: `item source${title || !openIssues ? '' : ' closed'}` },
      ext(i.url, `#${i.number}`, { className: 'tag issue' }),
      h('span', { className: 'text', textContent: text }),
      h('span', { className: 'actions' },
        btn('↓', () => pull(title ?? `#${i.number}`, i.number), { title: 'copy into your queue' })));
  }));
}

/**
 * What a row's drag carries. Its own type, not text/plain: a link or a text
 * selection dropped on a row carries text/plain too, and Number() of that is
 * NaN -- which splice() reads as 0, so the first item moved and was saved.
 */
const ROW = 'application/x-prcoder-row';

const bulk = (label, fn, props = {}) => btn(label, fn, { className: 'bulk', ...props });

function row(item, above, below) {
  const idx = items.indexOf(item);
  // Order is the backlog's meaning, and only Local is a backlog -- Completed and
  // Deleted are filtered views where a drop would splice the item to a position
  // in the full array that nobody on this tab can see.
  const ordered = tab === 'local';

  // The keyboard's way to reorder, which a drag has no equivalent of. Moves
  // past the next row *shown*, not the next in the array: the tab filters, so
  // the array neighbour may be a done or deleted item you cannot see move.
  const grip = h('span', { className: 'grip', title: 'drag, or focus and press ↑ ↓, to reorder', tabIndex: 0 }, '⠿');
  grip.setAttribute('role', 'button');
  grip.setAttribute('aria-label', `reorder “${item.text}”: up or down arrow moves it`);
  grip.onkeydown = async (e) => {
    const past = { ArrowUp: above, ArrowDown: below }[e.key];
    if (!past) return;
    e.preventDefault();
    const at = [...document.querySelectorAll('#queue-body .item .grip')].indexOf(grip);
    // reorder() drops in front of its target, so going down targets the row after.
    reorder(items, idx, items.indexOf(past) + (e.key === 'ArrowDown' ? 1 : 0));
    // save() repaints every row, so focus goes to the grip now in the new place.
    if (await save()) document.querySelectorAll('#queue-body .item .grip')[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };

  const box = h('input', { type: 'checkbox', checked: item.done });
  box.onchange = () => { item.done = box.checked; save(); };

  const text = h('span', { className: 'text', contentEditable: 'true', textContent: item.text });
  text.onblur = () => { if (text.textContent.trim() !== item.text) { item.text = text.textContent.trim(); save(); } };
  text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };

  const li = h('li', { className: 'item', draggable: ordered },
    ordered ? grip : null,
    box,
    text,
    item.issue ? ext(item.issueUrl ?? '#', `#${item.issue}`, { className: 'tag issue' }) : null,
    h('span', { className: 'actions' },
      // Typed, not sent: the turn is left in the prompt for you to edit, which
      // is the whole of what prcoder puts into a session (docs/Design.md).
      // Handing it over is what doing an item looks like here, so it ticks the
      // box the way finishing it would: the row leaves Local for Completed, and
      // the Local tab stays a list of what has not been handed over yet. Not a
      // delete -- Completed is where you go to see what you handed over, and its
      // own checkbox puts an item back if Claude turned out not to do it.
      //
      // Only if it went. `sendToClaude` answers false on a closed socket, and
      // an item ticked off after a refused send is work nobody has done and
      // nothing will remind you of.
      btn('▶', () => {
        if (!deps.sendToClaude(item.text, false)) return toast('Claude is not connected — nothing was typed.', true);
        item.done = true;
        save();
      }, { title: 'type into Claude, and check it off' }),
      // Both are moves, not flags: the item is written there and leaves the queue.
      btn('◇', () => toPr([item]), {
        title: hasPr ? 'move into the PR description' : NO_PR,
        disabled: !hasPr,
      }),
      item.issue ? null : btn('◎', () => save('/api/queue/to-issue', 'POST', { items, index: idx }),
        { title: 'move into a new issue' }),
      item.deleted
        ? btn('↩', () => { item.deleted = false; save(); }, { title: 'restore' })
        // A tombstone, not a splice: the Deleted tab is where it goes.
        : btn('✕', () => { item.deleted = true; save(); }, { title: 'delete' }),
    ),
  );

  // Firefox hands a mousedown inside a draggable element to its drag machinery
  // instead of to the caret, so a click in the middle of an item's text landed
  // at the start of it. Confirmed in Firefox and *not* in Chromium, which is
  // why it survived being looked at. Nothing else fixes it — draggable=false on
  // the span, and -moz-user-select, both leave the caret at 0 — so the row
  // gives up being draggable for exactly as long as the pointer is on its text,
  // and the grip above is the handle that always drags.
  li.addEventListener('pointerdown', (e) => { li.draggable = ordered && !text.contains(e.target); });
  li.addEventListener('dragstart', (e) => { e.dataTransfer.setData(ROW, idx); li.classList.add('dragging'); });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes(ROW)) return;
    const from = Number(e.dataTransfer.getData(ROW));
    if (from === idx) return;
    reorder(items, from, idx);
    save();
  });

  return li;
}

/** True once the server has it, so the caller knows whether to clear the input. */
export async function addItem(text) {
  if (!text.trim()) return false;
  const item = { text: text.trim(), done: false, issue: null, deleted: false };
  // The end of the whole array, past any done or deleted rows: Local filters
  // without reordering, so a new item still shows last there.
  if (addTo === 'top') items.unshift(item); else items.push(item);
  // A brand-new item is local by definition, so this is the tab it is on.
  tab = 'local';
  if (!await save()) {
    // Taken back out. save() has already said what went wrong, and a row left
    // sitting there is one the next poll is about to delete without comment --
    // while the text it came from has gone from the input.
    items = items.filter((i) => i !== item);
    render();
    return false;
  }
  // Either end can be off-screen in a list taller than the pane, and an item
  // you cannot see reads as a save that did not happen. Not scrollIntoView:
  // save() has already repainted from the server's echo, so the object above no
  // longer exists as a row -- but the end it went to is known, and that is all
  // this needs. It stays out of save() itself, which every checkbox and drag
  // also calls; the viewport should not jump for those.
  const host = document.getElementById('queue-body');
  host.scrollTop = addTo === 'top' ? 0 : host.scrollHeight;
  return true;
}
