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
 * A line over the panes: the app's one notification surface.
 *
 * `sticky` is for a notice that stays true until you act on it, rather than one
 * that reports something already finished -- it waits to be clicked instead of
 * timing out. Every toast is click-to-dismiss, and says so with the ✕ its CSS
 * adds; a sticky one also has a border of its own.
 */
let toastTimer;
export function toast(msg, bad = false, sticky = false, link = null) {
  const el = document.getElementById('toast');
  // textContent, never innerHTML: msg is often a server error. A link is the
  // one thing a message can carry past that, so it is a separate argument.
  el.textContent = msg;
  if (link) {
    el.append(' ', Object.assign(document.createElement('a'),
      { href: link.href, textContent: link.text, target: '_blank', rel: 'noopener' }));
  }
  el.className = `${bad ? 'bad' : ''} ${sticky ? 'sticky' : ''}`.trim();
  el.hidden = false;
  // One slot, so a later toast replaces whatever is up -- including a sticky
  // one, which is the other way it goes away.
  el.onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : 4000);
}

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
