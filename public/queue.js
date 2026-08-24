import { h } from './pr.js';

// The client owns the list; every change persists the whole array. Single user,
// single repo — no ids, no diffing.
let items = [];
let tab = 'active';
let deps = {};
// Set while a branch switch is in flight. Every save() writes the whole array,
// so one stray checkbox during the switch would overwrite the other branch's
// FUTURE.md wholesale.
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

export async function initQueue(d) {
  deps = d;
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
          bulk('→ all to PR', () => { items.forEach((i) => { if (!i.done && !i.deleted) i.inPr = true; }); save('/api/queue/push', 'POST'); },
            !hasPr && 'no pull request to push to'),
          bulk('clear done', () => { items.forEach((i) => { if (i.done) i.deleted = true; }); save(); }),
        ]),
    ),
    h('ul', { className: 'items' }, ...shown.map((i) => row(i))),
  );

  document.getElementById('queue-input').placeholder =
    tab === 'done' ? 'Add an item…' : 'Add an item, Enter to save';
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
        hasPr ? (item.inPr ? 'in PR description' : 'add to PR description') : 'no pull request to push to',
        () => { item.inPr = !item.inPr; save('/api/queue/push', 'POST'); },
        !hasPr),
      item.issue ? null : act('◎', 'create an issue', () => save('/api/queue/issue', 'POST', { items, index: idx })),
      item.deleted
        ? act('↩', 'restore', () => { item.deleted = false; save(); })
        // A tombstone, not a splice: the Deleted tab is where it goes.
        : act('✕', 'delete', () => { item.deleted = true; item.inPr = false; save('/api/queue/push', 'POST'); }),
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

export function addItem(text) {
  if (!text.trim()) return;
  items.unshift({ text: text.trim(), done: false, inPr: false, issue: null, deleted: false });
  tab = 'active';
  save();
}
