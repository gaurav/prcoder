import { h } from './pr.js';

// The client owns the list; every change persists the whole array. Single user,
// single repo — no ids, no diffing.
let items = [];
let tab = 'active';
let deps = {};
// Set while a branch switch is in flight. Every save() writes the whole array,
// and the server stamps it with whatever branch is checked out by the time it
// lands, so one stray checkbox during the switch would file this branch's items
// under the next one. The server refuses a payload carrying a stale branch;
// this stops us sending one in the first place.
let frozen = false;

export const freeze = (on) => { frozen = on; };

/**
 * Replace the list from the server. Skipped while an item is being edited: the
 * text is contentEditable and only saves on blur, so a poll landing mid-typing
 * would throw the edit away.
 */
export function setItems(next, prAvailable) {
  if (document.getElementById('queue-body').contains(document.activeElement)) return;
  items = next;
  hasPr = prAvailable;
  render();
}

// Mirroring into a PR description needs a PR. Creating an issue does not, so
// that control stays live on a branch that has none.
let hasPr = true;

// Which end the input adds to. The queue is two things at once -- a backlog in
// the order you mean to work through it, and somewhere to put the thing you
// must not forget to do next -- so the end is the user's to choose, and the
// arrow on the button says which one is live without being clicked.
//
// The app's only stored preference, and a best-effort one: reading storage
// throws outright where it is disabled, and prcoder takes a random port unless
// PRCODER_PORT is pinned, so the origin -- and the value with it -- usually
// changes between sessions. Losing it costs a click.
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
  items = await fetch('/api/queue').then((r) => r.json());
  render();
}

const save = async (url = '/api/queue', method = 'PUT', body = items) => {
  if (frozen) return;
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data?.error) { alert(data.error); return; }
  if (Array.isArray(data)) items = data;
  render();
};

function render() {
  const host = document.getElementById('queue-body');
  const live = items.filter((i) => !i.deleted);
  // Restoring the last tombstone hides the tab; without this you would be left
  // looking at an empty list with no tab to click back to.
  if (tab === 'deleted' && live.length === items.length) tab = 'active';
  const shown = tab === 'deleted' ? items.filter((i) => i.deleted)
    : live.filter((i) => (tab === 'done' ? i.done : !i.done));

  host.replaceChildren(
    h('div', { className: 'tabs' },
      tabBtn('active', `Active (${live.filter((i) => !i.done).length})`),
      tabBtn('done', `Completed (${live.filter((i) => i.done).length})`),
      ...(items.some((i) => i.deleted) ? [tabBtn('deleted', `Deleted (${items.filter((i) => i.deleted).length})`)] : []),
      h('span', { className: 'spacer' }),
      ...(tab === 'deleted'
        // The only hard delete in the app, and it is behind the tab that shows
        // you what you are about to lose.
        ? [bulk('empty', () => { items = items.filter((i) => !i.deleted); save(); })]
        : [
          bulk('→ all to PR', () => { items.forEach((i) => { if (!i.done && !i.deleted) i.inPr = true; }); save(); },
            !hasPr && 'no pull request on this branch to push to'),
          bulk('clear done', () => { items.forEach((i) => { if (i.done) i.deleted = true; }); save(); }),
        ]),
    ),
    h('ul', { className: 'items' }, ...shown.map((i) => row(i))),
  );

  document.getElementById('queue-input').placeholder =
    tab === 'done' ? 'Add an item…' : 'Add an item, Enter to save';
}

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

const tabBtn = (name, label) => {
  const b = h('button', { className: tab === name ? 'tab on' : 'tab' }, label);
  b.onclick = () => { tab = name; render(); };
  return b;
};

const bulk = (label, fn, disabled = false) => {
  const b = h('button', { className: 'bulk', disabled: !!disabled }, label);
  if (typeof disabled === 'string') b.title = disabled;
  b.onclick = fn;
  return b;
};

function row(item) {
  const idx = items.indexOf(item);

  const box = h('input', { type: 'checkbox', checked: item.done });
  box.onchange = () => { item.done = box.checked; save(); };

  const text = h('span', { className: 'text', contentEditable: 'true', textContent: item.text });
  text.onblur = () => { if (text.textContent.trim() !== item.text) { item.text = text.textContent.trim(); save(); } };
  text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };

  const li = h('li', { className: 'item', draggable: true },
    box,
    text,
    item.issue ? h('a', { className: 'tag issue', href: item.issueUrl ?? '#', target: '_blank', rel: 'noopener' }, `#${item.issue}`) : null,
    h('span', { className: 'actions' },
      act('▶', 'send to Claude', () => deps.sendToClaude(item.text)),
      act(item.inPr ? '◆' : '◇',
        hasPr ? (item.inPr ? 'in PR description' : 'add to PR description')
          : 'no pull request on this branch to push to',
        () => { item.inPr = !item.inPr; save(); },
        !hasPr),
      item.issue ? null : act('◎', 'create an issue', () => save('/api/queue/issue', 'POST', { items, index: idx })),
      item.deleted
        ? act('↩', 'restore', () => { item.deleted = false; save(); })
        // A tombstone, not a splice: the Deleted tab is where it goes.
        : act('✕', 'delete', () => { item.deleted = true; item.inPr = false; save(); }),
    ),
  );

  li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', idx); li.classList.add('dragging'); });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (from === idx) return;
    items.splice(idx, 0, items.splice(from, 1)[0]);
    save();
  });

  return li;
}

const act = (glyph, title, fn, disabled = false) => {
  const b = h('button', { title, disabled }, glyph);
  b.onclick = fn;
  return b;
};

export async function addItem(text) {
  if (!text.trim()) return;
  const item = { text: text.trim(), done: false, inPr: false, issue: null, deleted: false };
  // The end of the whole array, past any done or deleted rows: the Active tab
  // filters without reordering, so it still shows last there, and FUTURE.md
  // reads newest-last.
  if (addTo === 'top') items.unshift(item); else items.push(item);
  tab = 'active';
  await save();
  // Either end can be off-screen in a list taller than the pane, and an item
  // you cannot see reads as a save that did not happen. Not scrollIntoView:
  // save() has already repainted from the server's echo, so the object above no
  // longer exists as a row -- but the end it went to is known, and that is all
  // this needs. It stays out of save() itself, which every checkbox and drag
  // also calls; the viewport should not jump for those.
  const host = document.getElementById('queue-body');
  host.scrollTop = addTo === 'top' ? 0 : host.scrollHeight;
}
