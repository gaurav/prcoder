// The diff pane: one file's patch, rendered locally. GitHub refuses to be
// iframed, so the pane draws the raw patch itself and keeps a link out for
// the fancy view.

import { h, api, writeThrough } from './pr.js';

// Lives outside the render because the 60s poll rebuilds #pr-body from
// scratch; #diff itself is never repainted by the poll (queue.js does the
// same isolation trick).
let openPath = null;

export const selectedPath = () => openPath;

/** Pure: patch text -> [{cls, text}]. GitHub's `patch` starts at the first @@. */
export function diffRows(patch) {
  return patch.split('\n').map((text) => ({
    cls: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del'
      : text.startsWith('@@') ? 'hunk' : 'ctx',
    text,
  }));
}

const el = (id) => document.getElementById(id);

export async function openDiff(f, { onViewed }) {
  openPath = f.path;
  el('diff-path').textContent = f.path;
  el('diff-path').title = f.path;
  el('diff-gh').href = f.url;
  el('diff').hidden = false;
  document.querySelector('main').classList.add('diff-open');
  for (const r of document.querySelectorAll('.file.sel')) r.classList.remove('sel');
  document.querySelector(`.file[data-path="${CSS.escape(f.path)}"]`)?.classList.add('sel');

  // Same GraphQL round-trip the row checkboxes use; on success mirror the
  // row so the two boxes never disagree without a repaint.
  const box = el('diff-viewed');
  box.checked = f.viewed;
  writeThrough(box, (v) => onViewed(f.path, v), (v) => {
    const row = document.querySelector(`.file[data-path="${CSS.escape(f.path)}"]`);
    row?.classList.toggle('viewed', v);
    const rowBox = row?.querySelector('input[type=checkbox]');
    if (rowBox) rowBox.checked = v;
  });

  el('diff-close').onclick = closeDiff;

  const body = el('diff-body');
  body.replaceChildren(h('div', { className: 'empty' }, 'Loading…'));
  let patch;
  try {
    ({ patch } = await api('/api/diff', { path: f.path }));
  } catch (e) {
    patch = undefined;
    console.error('diff', e);
  }
  // Two quick clicks can resolve out of order; only the current file may paint.
  if (openPath !== f.path) return;

  if (patch == null) {
    body.replaceChildren(h('p', { className: 'empty' },
      'No local diff for this file (binary, too large, or unavailable) — ',
      h('a', { href: f.url, target: '_blank', rel: 'noopener' }, 'view it on GitHub ↗')));
    return;
  }
  body.replaceChildren(...diffRows(patch).map(({ cls, text }) =>
    h('div', { className: `dl ${cls}` }, text)));
}

export function closeDiff() {
  openPath = null;
  el('diff').hidden = true;
  document.querySelector('main').classList.remove('diff-open');
  for (const r of document.querySelectorAll('.file.sel')) r.classList.remove('sel');
}
