// The diff pane: one file's patch, rendered locally. GitHub refuses to be
// iframed, so the pane draws the raw patch itself and keeps a link out for
// the fancy view.

import { h, btn, ext, api, writeThrough } from './pr.js';

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

/**
 * Pure: the rows -> [{at, text}], one per hunk header, for the outline beside
 * the body. `at` is the row's index, which is what the click scrolls to.
 *
 * The text is what git put after the second @@ -- the enclosing function, a
 * Markdown heading, whatever the funcname rule found -- so for a modified
 * source file this is a table of contents with no parsing at all (#63). A hunk
 * with no context is named by its new-side start line instead. Fewer than two
 * hunks is no outline: one entry names the only place there is to be.
 */
export function outline(rows) {
  const hunks = rows.flatMap(({ text }, at) => {
    const m = text.match(/^@@ -\S+ \+(\d+)[^@]*@@ ?(.*)$/);
    return m ? [{ at, text: m[2] || `line ${m[1]}` }] : [];
  });
  return hunks.length > 1 ? hunks : [];
}

/**
 * Pure: path -> Prism grammar name, or null for a file the pane shows plain.
 * By extension only, never by content: auto-detection runs every grammar over a
 * stranger's file, and this map is also the list of what the vendor map in
 * server.js serves -- core carries markup, css, clike and javascript, and each
 * of the others is one file under /vendor/prism/.
 *
 * The extension is the basename's, after a dot that is not its first character:
 * a dotless `patch` or `sh` at the repo root is a file, not an extension, and a
 * dotfile like `.gitignore` is all name. Both are plain.
 */
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'typescript',
  json: 'json', yml: 'yaml', yaml: 'yaml', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', css: 'css',
  diff: 'diff', patch: 'diff', toml: 'toml',
};
export const language = (path) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? LANG[name.slice(dot + 1).toLowerCase()] ?? null : null;
};

/**
 * Pure: source text -> one array of {cls, text} segments per line, from Prism's
 * token tree rather than its HTML. The segments become <span>s through h(), so
 * the file's text is never parsed as markup -- docs/Security.md. A token that
 * spans lines (a block comment) is split at each newline and keeps its class
 * on every piece; a nested token takes the innermost class. Every line's text
 * joins back to the input exactly, which test/diff.test.js pins.
 *
 * `tokenize` is passed in so the test can hand over the real Prism from Node.
 */
export function highlightLines(text, grammar, tokenize) {
  const lines = [[]];
  const walk = (tok, cls) => {
    if (typeof tok !== 'string') {
      cls = ['tok-' + tok.type, ...[].concat(tok.alias ?? []).map((a) => 'tok-' + a)].join(' ');
      return [].concat(tok.content).forEach((t) => walk(t, cls));
    }
    tok.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1).push({ cls, text: part });
    });
  };
  tokenize(text, grammar).forEach((t) => walk(t, ''));
  return lines;
}

// Prism is a classic script that installs window.Prism, loaded here only when a
// NEW file with a known language opens. `manual` is read off whatever is at
// window.Prism first, so setting it before the import is what stops it from
// walking the page for <code> to highlight.
//
// A failed load is retried on the next open, and the query string is the whole
// of what makes that work: the page's module map caches a module that *failed*
// to load under its specifier too, so a second import of the same URL rejects
// again without going near the network. Dropping our own cache alone leaves
// every later NEW file plain until a reload. `vendor` in server.js matches on
// url.pathname, so the query reaches nothing.
const loaded = {};
let attempt = 0;
const fresh = (url) => (attempt ? `${url}?retry=${attempt}` : url);
async function grammar(lang) {
  if (!loaded.core) {
    globalThis.Prism = { manual: true };
    loaded.core = import(fresh('/vendor/prism.js')).catch((e) => { loaded.core = null; attempt++; throw e; });
  }
  await loaded.core;
  if (!globalThis.Prism.languages[lang]) {
    loaded[lang] ??= import(fresh(`/vendor/prism/${lang}.js`))
      .catch((e) => { loaded[lang] = null; attempt++; throw e; });
    await loaded[lang];
  }
  return globalThis.Prism.languages[lang];
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
  const kind = patch == null ? null : diffKind(patch);
  setTitle(kind);
  // Only a whole added file is highlighted: it is the one body a tokenizer sees
  // from its first line. A modified file's hunks start mid-file and would
  // colour wrongly from inside a comment or string -- #68 has the safe way.
  // Anything that goes wrong here paints the file plain, as before.
  const lang = kind === 'add' && language(f.path);
  let lines = null;
  if (lang) {
    try {
      const src = diffRows(patch).filter((r) => r.cls === 'ctx').map((r) => r.text).join('\n');
      lines = highlightLines(src, await grammar(lang), globalThis.Prism.tokenize);
    } catch (e) {
      console.error('highlight', e);
    }
    if (openPath !== f.path) return;
  }
  let at = 0;
  const seg = ({ cls, text }) => (cls ? h('span', { className: cls }, text) : text);
  const rows = diffRows(patch, from).map(({ cls, text }) => {
    const segs = lines && cls === 'ctx' ? lines[at++] : null;
    return h('div', { className: `dl ${cls}` }, ...(segs?.length ? segs.map(seg) : [text]));
  });
  body.replaceChildren(...rows);
  el('diff-outline').replaceChildren(...outline(diffRows(patch, from)).map(({ at, text }) =>
    btn(text, () => rows[at].scrollIntoView({ block: 'start' }), { title: text })));
}

export function closeDiff() {
  openPath = null;
  el('diff').hidden = true;
  document.querySelector('main').classList.remove('diff-open');
  markSelected(null);
}
