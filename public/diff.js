// The diff pane: one file's patch, rendered locally. GitHub refuses to be
// iframed, so the pane draws the raw patch itself and keeps a link out for
// the fancy view.

import { h, ext, api, writeThrough } from './pr.js';

// Lives outside the render because the 60s poll rebuilds #pr-body from
// scratch; #diff itself is never repainted by the poll (queue.js does the
// same isolation trick).
let openPath = null;

export const selectedPath = () => openPath;

/**
 * Pure: whether the patch is a whole file rather than a change to one. GitHub's
 * `patch` for a file the PR adds is one hunk from nothing, `@@ -0,0 +1,N @@`,
 * and for a file it removes one hunk to nothing, `@@ -1,N +0,0 @@` (checked
 * against gaurav/ideas#13, 2026-09-18). Read off the patch rather than the
 * REST `status` field so the server keeps sending the patch alone.
 */
export function diffKind(patch) {
  const head = patch.slice(0, patch.indexOf('\n') + 1 || undefined);
  return /^@@ -0,0 /.test(head) ? 'add' : / \+0,0 @@/.test(head) ? 'del' : null;
}

/**
 * Pure: patch text -> [{cls, text}]. GitHub's `patch` starts at the first @@.
 *
 * A whole file is shown plain: every line of an added file is `+`, so the
 * green says nothing and the `+` column is only in the way of reading it. The
 * pane's title carries the fact instead (NEW / DELETED, see openDiff). The
 * `\ No newline at end of file` note keeps the hunk colour so it reads as one.
 *
 * `from` is the old path of a renamed file. It becomes a first row in the hunk
 * colour, and for a rename with no other change it is the whole body -- the
 * patch is null then, which is not the binary case the caller handles.
 */
export function diffRows(patch, from) {
  const head = from ? [{ cls: 'hunk', text: `renamed from ${from}` }] : [];
  if (patch == null) return head;
  const lines = patch.split('\n');
  if (diffKind(patch)) {
    return lines.slice(1).map((text) => text.startsWith('\\')
      ? { cls: 'hunk', text } : { cls: 'ctx', text: text.slice(1) });
  }
  return head.concat(lines.map((text) => ({
    cls: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del'
      : text.startsWith('@@') ? 'hunk' : 'ctx',
    text,
  })));
}

const el = (id) => document.getElementById(id);

/** Ticking this here ticks the same checkbox on github.com; the file rows use it too. */
export const setViewed = (path, viewed) => api('/api/pr/viewed', { path, viewed });

/** Highlight the open file's row, or none. */
const markSelected = (path) => {
  for (const r of document.querySelectorAll('.file')) r.classList.toggle('sel', r.dataset.path === path);
};

/**
 * The title says what the body no longer has to (see diffRows): NEW and DELETED
 * in the colours the file rows use for +/-, DIFF for a change to a file that
 * stays. Reset to DIFF while loading, so a file with no patch does not keep the
 * last one's word.
 */
function setTitle(kind) {
  const title = el('diff').querySelector('h1');
  title.textContent = kind === 'add' ? 'New' : kind === 'del' ? 'Deleted' : 'Diff';
  title.className = kind ?? '';
}

export async function openDiff(f) {
  openPath = f.path;
  // A <bdi>, for the reason spelled out at fileRow in pr.js: this element is
  // `direction: rtl` so a long path is cut at the head, and that alone would
  // move a leading dot to the other end.
  el('diff-path').replaceChildren(h('bdi', {}, f.path));
  el('diff-path').title = f.path;
  // Four ways to read the same file on GitHub, and the pane is a fifth: the
  // patch is what changed, and the other three are what a patch cannot say --
  // what the file became (a Markdown one rendered rather than as source), who
  // last touched the lines around a hunk, and what else has landed in it.
  //
  // The three that are built from the head commit hide together when a payload
  // has none -- a link to `/blob/undefined/` is one that looks fine and 404s --
  // and the diff link stays, because it is built from the PR alone.
  el('diff-file').href = f.blob ?? '';
  el('diff-blame').href = f.blame ?? '';
  el('diff-history').href = f.history ?? '';
  el('diff-gh').href = f.url;
  el('diff-out').hidden = !f.blob;
  el('diff').hidden = false;
  document.querySelector('main').classList.add('diff-open');
  markSelected(f.path);

  // Same GraphQL round-trip the row checkboxes use; on success mirror the
  // row so the two boxes never disagree without a repaint.
  const box = el('diff-viewed');
  box.checked = f.viewed;
  writeThrough(box, (v) => setViewed(f.path, v), (v) => {
    const row = document.querySelector(`.file[data-path="${CSS.escape(f.path)}"]`);
    row?.classList.toggle('viewed', v);
    const rowBox = row?.querySelector('input[type=checkbox]');
    if (rowBox) rowBox.checked = v;
  });

  el('diff-close').onclick = closeDiff;

  const body = el('diff-body');
  body.replaceChildren(h('div', { className: 'empty' }, 'Loading…'));
  setTitle(null);
  let patch, from;
  try {
    ({ patch, from } = await api('/api/diff', { path: f.path }));
  } catch (e) {
    patch = undefined;
    console.error('diff', e);
  }
  // Two quick clicks can resolve out of order; only the current file may paint.
  if (openPath !== f.path) return;

  if (patch == null && !from) {
    body.replaceChildren(h('p', { className: 'empty' },
      'No local diff for this file (binary, too large, or unavailable) — ',
      ext(f.url, 'view it on GitHub')));
    return;
  }
  setTitle(patch == null ? null : diffKind(patch));
  body.replaceChildren(...diffRows(patch, from).map(({ cls, text }) =>
    h('div', { className: `dl ${cls}` }, text)));
}

export function closeDiff() {
  openPath = null;
  el('diff').hidden = true;
  document.querySelector('main').classList.remove('diff-open');
  markSelected(null);
}
