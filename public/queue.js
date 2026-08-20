import { h } from './pr.js';

// The client owns the list; every change persists the whole array. Single user,
// single repo — no ids, no diffing.
let items = [];
let tab = 'active';
let deps = {};

export async function initQueue(d) {
  deps = d;
  items = await fetch('/api/queue').then((r) => r.json());
  render();
}

const save = async (url = '/api/queue', method = 'PUT', body = items) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data?.error) { alert(data.error); return; }
  if (Array.isArray(data)) items = data;
  render();
};

function render() {
  const host = document.getElementById('queue-body');
  const shown = items.filter((i) => (tab === 'done' ? i.done : !i.done));

  host.replaceChildren(
    h('div', { className: 'tabs' },
      tabBtn('active', `Active (${items.filter((i) => !i.done).length})`),
      tabBtn('done', `Completed (${items.filter((i) => i.done).length})`),
      h('span', { className: 'spacer' }),
      bulk('→ all to PR', () => { items.forEach((i) => { if (!i.done) i.inPr = true; }); save('/api/queue/push', 'POST'); }),
      bulk('clear done', () => { items = items.filter((i) => !i.done); save(); }),
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

const bulk = (label, fn) => {
  const b = h('button', { className: 'bulk' }, label);
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
      act(item.inPr ? '◆' : '◇', item.inPr ? 'in PR description' : 'add to PR description', () => {
        item.inPr = !item.inPr;
        save('/api/queue/push', 'POST');
      }),
      item.issue ? null : act('◎', 'create an issue', () => save('/api/queue/issue', 'POST', { items, index: idx })),
      act('✕', 'delete', () => { items.splice(idx, 1); save(); }),
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

const act = (glyph, title, fn) => {
  const b = h('button', { title }, glyph);
  b.onclick = fn;
  return b;
};

export function addItem(text) {
  if (!text.trim()) return;
  items.unshift({ text: text.trim(), done: false, inPr: false, issue: null });
  tab = 'active';
  save();
}
