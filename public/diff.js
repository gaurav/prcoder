// The diff pane: one file's patch, rendered locally. GitHub refuses to be
// iframed, so the pane draws the raw patch itself and keeps a link out for
// the fancy view.

import { h, btn, ext, api, writeThrough, pref, setPref } from './pr.js';

// Lives outside the render because the 60s poll rebuilds #pr-body from
// scratch; #diff itself is never repainted by the poll (queue.js does the
// same isolation trick).
let openPath = null;

export const selectedPath = () => openPath;

// Whether the open file is one the @ button may name: false while none is open,
// and for a deleted file, which leaves nothing in the working tree to attach.
let mentionable = false;

/**
 * Pure: `path`, which is from the repo root, as seen from `dir`, the repo-root
 * path of the directory the agent runs in (`git rev-parse --show-prefix`, so
 * '' at the root and 'public/' below it). prcoder can be started anywhere in
 * the repo, and the agent's PTY starts where prcoder did.
 */
export function fromDir(dir, path) {
  const up = dir.split('/').filter(Boolean);
  const down = path.split('/');
  while (up.length && down.length > 1 && up[0] === down[0]) { up.shift(); down.shift(); }
  return '../'.repeat(up.length) + down.join('/');
}

/**
 * Pure: what the @ button types for `path`, as the agent in `dir` names it
 * (fromDir), or null for a path it cannot be typed as.
 *
 * Spaced on both sides. The agent reads `@` as a mention only at the start of
 * a word, so the leading space keeps a click straight after one from making
 * `word@path`; the trailing one closes the @-autocomplete menu that typing `@`
 * opens, so Enter then sends the prompt instead of picking a suggestion. A
 * path with a space in it is quoted, `@"a b"`, which is the form Claude Code's
 * prompt parser takes for one (read from its bundle, 2.1.293; still so in
 * 2.1.295). That form has no escape for a `"`, and a control character -- a
 * newline or a tab, both legal in a git path -- would be typed as a keystroke,
 * so a path with either gets no mention at all, until the parser can quote one
 * (#124).
 */
export function mention(path, dir = '') {
  const rel = fromDir(dir, path);
  if (/["\x00-\x1f\x7f]/.test(rel)) return null;
  return ` @${rel.includes(' ') ? `"${rel}"` : rel} `;
}

/** What the @ button types for the open file, from the agent's `dir`, or null when there is none to name. */
export const openMention = (dir) => (mentionable ? mention(openPath, dir) : null);

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
 * stranger's file, and this map -- through `grammars` below -- is also the list
 * of what the vendor map in server.js serves: core carries markup, css, clike
 * and javascript, and each of the others is one file under /vendor/prism/.
 *
 * The extension is the basename's, after a dot that is not its first character:
 * a dotless `patch` or `sh` at the repo root is a file, not an extension, and a
 * dotfile like `.gitignore` is all name. Both are plain.
 */
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  json: 'json', yml: 'yaml', yaml: 'yaml', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', css: 'css',
  diff: 'diff', patch: 'diff', toml: 'toml',
};

// What core already carries, and what a grammar needs loaded before it. Prism's
// components.json is the source for both: `tsx` is the one grammar here that
// extends others rather than clike, and loading it alone leaves it a no-op.
const CORE = new Set(['markup', 'css', 'clike', 'javascript']);
const NEEDS = { tsx: ['jsx', 'typescript'] };

/**
 * Every grammar file the page can ask for, which is what server.js has to
 * serve. Derived rather than written twice: a language added to the map above
 * without its file in the vendor map is a plain file and a console line, and
 * test/api.test.js fetches this list to say so first.
 */
export const grammars = [...new Set(Object.values(LANG).flatMap((l) => [...(NEEDS[l] ?? []), l]))]
  .filter((l) => !CORE.has(l)).sort();
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
const load = (key, url) => (loaded[key] ??= import(fresh(url))
  .catch((e) => { loaded[key] = null; attempt++; throw e; }));
async function one(lang) {
  if (globalThis.Prism.languages[lang]) return;
  await load(lang, `/vendor/prism/${lang}.js`);
}
async function grammar(lang) {
  if (!loaded.core) globalThis.Prism = { manual: true };
  await load('core', '/vendor/prism.js');
  // Prerequisites first and in order: prism-tsx builds on the jsx and
  // typescript grammars, and defines nothing at all if they are not there yet.
  for (const dep of NEEDS[lang] ?? []) await one(dep);
  await one(lang);
  return globalThis.Prism.languages[lang];
}

const el = (id) => document.getElementById(id);

// Hiding the outline is a preference about the pane, not about one file, so it
// is browser-wide and outlives a reload. Like Wrap's below, the choice lives
// here and storage only seeds it, so a refused write still holds from one file
// to the next.
const OUTLINE_KEY = 'prcoder:outline';
let outlineHidden;
const outlineOff = () => (outlineHidden ??= pref(OUTLINE_KEY) === 'off');
function showOutline(on) {
  outlineHidden = !on;
  el('diff').classList.toggle('outline-off', !on);
  setPref(OUTLINE_KEY, on ? 'on' : 'off');
  // The clicked control has just vanished; keep focus on the one that undoes it.
  el(on ? 'diff-outline-hide' : 'diff-outline-show').focus();
}

// Wrapping long lines is the same kind of preference: about the pane, not one
// file, remembered browser-wide. It is a class on the pane and a CSS rule on
// the rows (style.css), not anything written into the rows, so a line-number
// gutter (#8) or a rendered view can be added beside it without touching how a
// line folds. Off for every file until pressed, Markdown and plain text
// included: a setting that turned itself on by extension would read as the
// pane changing its mind, and the owner's repos wrap their Markdown anyway.
//
// The choice lives here, and storage only seeds it: setPref's refused write
// holds for the session only if nothing reads storage back, and a toggle that
// re-read it would be stuck on in Safari's private mode.
const WRAP_KEY = 'prcoder:wrap';
let wrap;
const wrapOn = () => (wrap ??= pref(WRAP_KEY) === 'on');
/**
 * Paint the stored choice: the class the rows fold under, and the button's
 * pressed state. Only the state: the title stays index.html's "wrap long
 * lines", since one that flipped to "unwrap" while pressed read out as
 * "pressed, unwrap long lines", the state twice and in opposite words.
 */
function paintWrap(on) {
  el('diff').classList.toggle('wrap', on);
  el('diff-wrap').setAttribute('aria-pressed', String(on));
}
function setWrap(on) {
  wrap = on;
  paintWrap(on);
  setPref(WRAP_KEY, on ? 'on' : 'off');
}
/** The keyboard's way to the Wrap button. Nothing to flip while no file is open. */
export function toggleWrap() {
  if (!el('diff').hidden) setWrap(!wrapOn());
}

/** Ticking this here ticks the same checkbox on github.com; the file rows use it too. */
export const setViewed = (path, viewed) => api('/api/pr/viewed', { path, viewed });

function setMentionable(on) {
  mentionable = on;
  el('diff-mention').hidden = !on;
}

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

/** `onViewed` is what the viewed box calls: app.js's, which repaints the file rows too. */
export async function openDiff(f, onViewed = setViewed) {
  openPath = f.path;
  // A <bdi>, for the reason spelled out at fileRow in pr.js: this element is
  // `direction: rtl` so a long path is cut at the head, and that alone would
  // move a leading dot to the other end.
  el('diff-path').replaceChildren(h('bdi', {}, f.path));
  el('diff-path').title = f.path;
  // Hidden until /api/diff says whether the file was deleted (below), so a
  // click or Alt+M during the load cannot name a file that is gone.
  setMentionable(false);
  el('diff-mention').title = `type @${f.path} into the coding agent's prompt (Alt+M)`;
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

  // The same write the row checkboxes make, through the same handler, so the
  // row, its group's pie and the tab count follow it.
  const box = el('diff-viewed');
  box.checked = f.viewed;
  writeThrough(box, (v) => onViewed(f.path, v));

  el('diff-close').onclick = closeDiff;
  el('diff').classList.toggle('outline-off', outlineOff());
  el('diff-outline-hide').onclick = () => showOutline(false);
  el('diff-outline-show').onclick = () => showOutline(true);
  paintWrap(wrapOn());
  el('diff-wrap').onclick = () => setWrap(!wrapOn());

  const body = el('diff-body');
  body.replaceChildren(h('div', { className: 'empty' }, 'Loading…'));
  // Emptied here, with the body: a file with no patch returns before the
  // outline is rebuilt, and kept the last file's hunks to jump to.
  el('diff-outline').replaceChildren();
  setTitle(null);
  let patch, from, deleted;
  try {
    ({ patch, from, deleted } = await api('/api/diff', { path: f.path }));
  } catch (e) {
    patch = undefined;
    console.error('diff', e);
  }
  // Two quick clicks can resolve out of order; only the current file may paint.
  if (openPath !== f.path) return;
  // Before the no-patch return: a deleted binary has no patch to say so, only
  // GitHub's `deleted`. A file past its 300-file cap has neither, and the
  // patch's own kind is the check left.
  const kind = patch == null ? null : diffKind(patch);
  setMentionable(!deleted && kind !== 'del' && mention(f.path) != null);

  if (patch == null && !from) {
    body.replaceChildren(h('p', { className: 'empty' },
      'No diff to show for this file (binary, too large, or not in this clone) — ',
      ext(f.url, 'view it on GitHub')));
    return;
  }
  setTitle(kind);
  // Only a whole added file is highlighted: it is the one body a tokenizer sees
  // from its first line. A modified file's hunks start mid-file and would
  // colour wrongly from inside a comment or string -- #68 has the safe way.
  // Anything that goes wrong here paints the file plain, as before.
  const lang = kind === 'add' && language(f.path);
  // Built once: the highlight source, the rows and the outline all read it, and
  // the outline's indices have to be the rows'. A rename's `from` row is a hunk
  // row, so the ctx filter below leaves it out of the source.
  const parsed = diffRows(patch, from);
  let lines = null;
  if (lang) {
    try {
      const src = parsed.filter((r) => r.cls === 'ctx').map((r) => r.text).join('\n');
      lines = highlightLines(src, await grammar(lang), globalThis.Prism.tokenize);
    } catch (e) {
      console.error('highlight', e);
    }
    if (openPath !== f.path) return;
  }
  let at = 0;
  const seg = ({ cls, text }) => (cls ? h('span', { className: cls }, text) : text);
  const rows = parsed.map(({ cls, text }) => {
    const segs = lines && cls === 'ctx' ? lines[at++] : null;
    return h('div', { className: `dl ${cls}` }, ...(segs?.length ? segs.map(seg) : [text]));
  });
  body.replaceChildren(...rows);
  el('diff-outline').replaceChildren(...outline(parsed).map(({ at, text }) =>
    btn(text, () => rows[at].scrollIntoView({ block: 'start' }), { title: text })));
}

export function closeDiff() {
  openPath = null;
  mentionable = false;
  el('diff').hidden = true;
  document.querySelector('main').classList.remove('diff-open');
  markSelected(null);
}
