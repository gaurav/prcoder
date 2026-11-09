// The page's building blocks: elements, buttons, links, the API call, the
// console, the toast, stored preferences, and the mark and fold every counted
// thing in the PR pane is drawn with. Every pane builds from these, so they
// live here rather than in any one pane's file.
//
// The server loads this through pr.js (cli.js) and diff.js (server.js), so
// nothing here may touch the DOM at module scope (public/CLAUDE.md).

// Skips absent sections; DOM append() would render them as the text "null".
export const kids = (list) => list.flat().filter((k) => k != null);

/**
 * Small helper: build an element and append children.
 *
 * `dataset` is pulled out and merged rather than assigned, because it is a
 * readonly accessor -- Object.assign would drop it on the floor without
 * complaining, and the caller gets an element with no data attributes and no
 * error to explain why. Two call sites used to work around that by hand.
 */
export function h(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...kids(children));
  return node;
}

/** A button with its handler, the one shape every pane's chrome is built from. */
export const btn = (label, fn, props = {}) => {
  const b = h('button', props, label);
  b.onclick = fn;
  return b;
};

/** A link out of the app, which is every link it has. */
export const ext = (href, text, props = {}) => h('a', { href, target: '_blank', rel: 'noopener', ...props }, text);

/**
 * JSON in, JSON out, an error thrown either way it can fail -- a bad status or
 * an `error` in the payload. No body means no body at all, not `{}`: fetch
 * refuses to send one on a GET, and handleApi already reads a missing one as
 * undefined.
 */
export const api = async (url, body, method = 'POST') => {
  const res = await fetch(url, body === undefined ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
  return data;
};

/**
 * A line in the browser console, for the paths whose failures leave nothing on
 * screen -- switching pull requests after a merge was one. Off unless the
 * `prcoder:debug` preference is `on` (`localStorage['prcoder:debug'] = 'on'`
 * in the console, then reload), so a line nobody reads costs nothing to build;
 * an argument that is a function is called only when the line is written, for
 * one that takes work to put together. Debug level, so it shows only with the
 * console's Verbose/Debug filter on.
 */
let debugging;
export const debug = (...args) => {
  if (!(debugging ??= pref('prcoder:debug') === 'on')) return;
  console.debug('[prcoder]', ...args.map((a) => (typeof a === 'function' ? a() : a)));
};

/**
 * A line over the panes, for something that has already happened: it goes on
 * its own, after four seconds, or eight for an error, and on a click before
 * that, which the ✕ its CSS adds says. One slot, so a later toast replaces
 * whatever is up.
 *
 * A notice that waits for you is not a toast: see notice(). The two shared
 * this slot until 2026-11-09, with a `sticky` flag, and a waiting notice was
 * then replaced by the next toast (#22), sat over the queue's last rows (#23)
 * and could not be up beside another (#180).
 */
let toastTimer;
export function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  // textContent, never innerHTML: msg is often a server error.
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  el.onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : 4000);
}

/**
 * A line in the list over the right-hand panes, for something that stays true
 * until you have dealt with it. It stays until it is dismissed, and any number
 * can be up at once.
 *
 * The box on the left and the ✕ on the right both take the line away. #180
 * asks whether "done, noted" and "go away" are two things; nothing here yet
 * does anything different for one than the other, so they are one.
 *
 * `link` is `{ href, text }` for a link out; the message itself is
 * textContent, since it is often something a server said. `kind` names what
 * the notice is about: a second one of a kind replaces the first, so a repeat
 * (two switches, two reloads) is one line, and dismissNotice(kind) is how the
 * page takes one down itself. No button for an action yet -- the first notice
 * that needs one adds it.
 */
export function notice(msg, { bad = false, link = null, kind = null } = {}) {
  if (kind) dismissNotice(kind);
  const line = h('li', { className: bad ? 'bad' : '', dataset: kind ? { kind } : {} });
  const gone = () => line.remove();
  const box = h('input', { type: 'checkbox', title: 'noted — dismiss this notice', ariaLabel: 'noted — dismiss this notice' });
  box.onchange = gone;
  line.append(box,
    h('span', { className: 'text' }, msg, link ? ' ' : null, link ? ext(link.href, link.text) : null),
    btn('✕', gone, { title: 'dismiss this notice', ariaLabel: 'dismiss this notice' }));
  document.getElementById('notices').append(line);
  return line;
}
export const dismissNotice = (kind) => {
  for (const line of document.querySelectorAll('#notices > li')) if (line.dataset.kind === kind) line.remove();
};

/**
 * localStorage, best effort. A browser can refuse the store outright -- Safari's
 * private mode throws on write -- and a remembered preference must never take a
 * pane down with it: a refused read is nothing stored, a refused write holds for
 * this session only. Every stored preference goes through these two.
 */
export const pref = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
export const setPref = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* this session only */ }
};

/**
 * A row's ways out, at its end and on hover: every row of the queue pane
 * builds its cluster from this, in one order -- ▶ (type into the coding
 * agent), ↓ (copy into Local), ⧉ (copy to the clipboard), then whatever is
 * the row's own (◎, ✕, ↩) -- so a button means one thing wherever it sits. A
 * row leaves out what it lacks; h() drops the nulls.
 */
export const actions = (...buttons) => h('span', { className: 'actions' }, ...buttons);

/** One of a pane's tabs; `on` is the one showing, and `extra` is any class besides. */
export const tabBtn = (label, on, onClick, extra = '', props = {}) =>
  btn(label, onClick, { ...props, className: ['tab', extra, on ? 'on' : ''].filter(Boolean).join(' ') });

/**
 * A checkbox that writes through to GitHub. The browser has already flipped it
 * by the time we hear about it, so a failure puts it back. A success is `run`'s
 * to show: app.js updates the status the panes are drawn from and repaints, so
 * every count, pie and row that shows the same fact changes with it.
 */
export function writeThrough(box, run) {
  // Assigned, not added: the diff pane's box is static markup and openDiff
  // rewires it on every file, where a listener per open would stack up.
  box.onchange = async () => {
    box.disabled = true;
    try { await run(box.checked); } catch { box.checked = !box.checked; }
    box.disabled = false;
  };
}

/** Whether a tab's count has run out, which is what fills its mark. Never for nothing to count. */
export const tabDone = ({ done, total }) => total > 0 && done === total;

/** `done` of `total` as the pie mark() draws: how far, and whether it is finished. */
export const fraction = ({ done, total }) => ({ p: total ? done / total : 0, full: tabDone({ done, total }) });

/**
 * The pane's one status mark: a pie filled to `p`, from 0 to 1, that becomes a
 * green disc with a ✓ once `full` -- nothing left. For a check, `state` can
 * also be `pend`, the pie with a yellow ring, or `fail`, a red disc with a ✕,
 * which beats the other two. Every tab with a count, every check row and every
 * fold draws this and nothing else, so a shape means one thing all over the
 * pane; the stylesheet's `.mark` sizes it for where it sits.
 *
 * A pie rather than `3/5`: a fraction in small dim type beside a dim title had
 * to be read and worked out, and a finished one looked like any other. A pie is
 * one size at any count and says "how far" at a glance, and full is a disc.
 * What it gives up is the exact figure -- one of twelve left looks nearly done
 * -- so that is its name and its tooltip, and the tab label keeps the numbers.
 * Not a dot per item, which is exact but grows with the count: a 35-file group
 * would be a row of dots.
 *
 * With a `label` it is an image of that name. Without one it is hidden from a
 * screen reader, for a mark whose words are already beside it: a tab's own
 * name, a check row's `pending`.
 */
export function mark({ p = 0, full = false, state, label }) {
  const look = state === 'fail' ? 'fail' : full ? 'full' : state === 'pend' ? 'pend' : '';
  const el = h('span', { className: `mark ${look}`.trim() });
  if (label) {
    el.title = label;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);   // a shape is no name, as with the glyph buttons
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  el.style.setProperty('--p', String(p));
  return el;
}

/**
 * A fold's `open` and `onToggle`, remembered in `set` -- which holds the keys
 * that are `holds`: the file groups record what was closed (they open by
 * default), the description's sections what was opened (they do not).
 */
export const kept = (set, key, holds) => ({
  open: set.has(key) === (holds === 'open'),
  onToggle: (open) => { if (open === (holds === 'open')) set.add(key); else set.delete(key); },
});

/**
 * A <details> fold with a heading and an optional progress pie, the shape both
 * the file groups and the description's sections take. `onToggle` fires for a
 * click and for the initial `open`, so it has to be idempotent.
 */
export function fold({ className, dataset, title, progress, open, onToggle }, children) {
  const d = h('details', { className: `fold ${className}`, open, dataset },
    h('summary', {}, h('h3', {}, title), progress ? mark(progress) : null),
    h('div', { className: 'sec-body' }, ...children));
  d.addEventListener('toggle', () => onToggle(d.open));
  return d;
}
