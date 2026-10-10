import { TASK, fences, withoutHtml, mention, repoUrl, urlPath } from './tasks.js';

// Re-exported for the tests, which read the pane's view of a body through here.
export { withoutHtml };

// Skips absent sections; DOM append() would render them as the text "null".
const kids = (list) => list.flat().filter((k) => k != null);

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

/** The PR pane's sync light, in the part of the header that survives a poll. */
function paintLight(state) {
  const light = document.getElementById('pr-sync');
  light.hidden = !state;
  if (!state) return;
  light.className = state.className;
  light.textContent = state.text;
}

// The Files tab's top-level order: config and docs, then tests, then code.
const GROUPS = [
  ['docs', 'Config & docs'],
  ['tests', 'Tests'],
  ['code', 'Code'],
];

/**
 * The browser tab title. A row of tabs shows only the first few characters, so
 * the short URL — the one string that identifies this session against every
 * other prcoder tab, and against github.com's own tabs — comes first, and the
 * PR title is trimmed to whatever is left of a tab's width.
 *
 * The repository comes from the PR's own URL, not from the checkout: a PR from
 * a fork, or one opened with `prcoder <url>`, lives somewhere else entirely.
 *
 * `· prcoder` goes last, past what a tab shows, for the places that search
 * titles instead — Firefox's `%` tab search, the Window menu — so one string
 * finds every instance among the github.com tabs named the same way.
 */
const TITLE_MAX = 72;

export function pageTitle(status) {
  // A failed poll keeps the last good title (paint() is not reached), so this
  // is only the very first load, where there is nothing to name the tab with.
  if (!status || status.error) return 'prcoder';

  if (status.pr) {
    const repo = repoName(linkBase(status.pr).repo);
    return `${clamp(`${repo}#${status.pr.number}`, status.pr.title)} · prcoder`;
  }

  const where = status.detached ? 'detached HEAD' : status.branch;
  return `${clamp(status.nameWithOwner ?? 'prcoder', where ? `${where} (no PR)` : 'no PR')} · prcoder`;
}

/** `head · tail`, with the tail cut to fit. The head is never truncated. */
function clamp(head, tail) {
  if (!tail) return head;
  const room = TITLE_MAX - head.length - 3;
  if (room < 8) return head;
  return `${head} · ${tail.length > room ? `${tail.slice(0, room - 1).trimEnd()}…` : tail}`;
}

/**
 * The header is the one part of this pane that is never blown away, so the
 * switcher and the light live there — a poll landing mid-click would otherwise
 * close an open dropdown.
 */
export function renderHeader(status, prs, handlers) {
  const { onSwitch, onCommit } = handlers;
  const sel = document.getElementById('pr-switch');
  const commit = document.getElementById('pr-commit');

  // Rebuilt only when the set of PRs changes, so the open list survives a poll.
  //
  // Stacked PRs sit under the one they build on. An <option> cannot nest and an
  // <optgroup> cannot be chosen, so the indent is in the label, in non-breaking
  // spaces because a plain leading one is collapsed.
  //
  // `prs` is null until app.js has a list, and the placeholder says so rather
  // than "no open pull requests" -- the pane below says there is no list yet,
  // and the two sat one above the other disagreeing. The `?` in the keys
  // rebuilds the options when a list lands, even an empty one.
  const shown = switcherRows(prs ?? [], status.pr);

  const keys = (prs ? '' : '?') + shown.map(({ pr, depth }) => `${pr.number}:${depth}`).join(',');
  // Nor while it has focus, the one sign a page gets that its dropdown may be
  // open: a list landing then replaced the options under the open dropdown,
  // which closed it or moved the pick. It is rebuilt as it loses focus, from
  // the status painted last -- each call here replaces the one before.
  const stale = sel.dataset.keys !== keys;
  const open = document.activeElement === sel;
  sel.onblur = stale && open ? () => renderHeader(status, prs, handlers) : null;
  if (stale && open) debug('switcher options held while it has focus:', keys);
  else if (stale) {
    debug('switcher options rebuilt:', sel.dataset.keys ?? '(none)', '->', keys);
    sel.dataset.keys = keys;
    sel.replaceChildren(
      h('option', { value: '' }, shown.length ? 'no pull request' : prs ? 'no open pull requests' : 'no list of pull requests yet'),
      ...shown.map(({ pr: p, depth }) => h('option', { value: String(p.number) },
        `${depth ? `${'\u00a0\u00a0'.repeat(depth)}└\u00a0` : ''}#${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title}`)),
    );
    sel.onchange = () => {
      debug('switcher picked', sel.value || '(none)');
      if (sel.value) onSwitch(Number(sel.value));
    };
  }
  // Always re-assert: a failed switch has to snap back to the real branch.
  sel.value = status.pr ? String(status.pr.number) : '';

  // Uncommitted work would make `gh pr checkout` fail, so offer the fix instead
  // of the switch. Claude is right there in the next pane.
  const blocked = status.dirtyFiles.length > 0;
  sel.hidden = blocked || status.scope === 'other-repo';
  commit.hidden = !blocked;
  commit.onclick = () => onCommit(status.dirtyFiles);
  commit.textContent = `Commit ${status.dirtyFiles.length} file${status.dirtyFiles.length === 1 ? '' : 's'}…`;

  paintLight(headerSync(status));
}

// `ahead` is not in the table because it counts.
const SYNC = { behind: 'pull needed', diverged: 'diverged', unpushed: 'not pushed' };

/** The sync light's words, shared with the terminal's status block in server.js. */
export const syncPhrase = (s) => (s.sync === 'ahead' ? `${s.ahead} unpushed` : SYNC[s.sync] ?? null);

/** Pure: the status -> the PR pane's light, or null for nothing worth saying. */
function headerSync(status) {
  if (status.error) return { className: 'light unknown', text: 'unavailable' };
  if (status.scope === 'other-repo') return { className: 'light', text: 'another repo' };
  if (status.scope === 'other-branch') return { className: 'light', text: 'not checked out' };
  const out = syncPhrase(status);
  if (out) return { className: 'light warn', text: out };
  if (status.detached) return { className: 'light', text: 'detached HEAD' };
  return null;
}

/**
 * The open pull requests that merge *into* this branch.
 *
 * Filtered from the list the switcher already fetches rather than asked for:
 * `gh pr list` carries `baseRefName` for free, where a `--base` query of its own
 * would be another call in the one state that already makes an extra one (#19).
 * A detached HEAD is no branch to merge into, not every pull request.
 */
export const prsInto = (prs, branch) =>
  (branch ? prs.filter((p) => p.baseRefName === branch) : []);

/**
 * The same, with every pull request stacked on each one nested under it:
 * `[{ pr, kids }]`, where a kid's base is its parent's head.
 *
 * Still the one list, so a stack costs no call of its own. `seen` is there
 * because two open pull requests can name each other's branches as their bases,
 * and GitHub doesn't stop them.
 */
export function prTree(prs, branch, seen = new Set()) {
  // A fork's head branch lives in the fork, so nothing here can be based on it,
  // whatever it is called -- and it is very often called `main`.
  return prsInto(prs, branch).filter((p) => !seen.has(p.number) && seen.add(p.number))
    .map((pr) => ({ pr, kids: pr.isCrossRepository ? [] : prTree(prs, pr.headRefName, seen) }));
}

/**
 * Every open pull request in switcher order, `[{ pr, depth }]`: each one
 * followed by the ones stacked on it.
 *
 * The roots are the ones whose base is no other open PR's head, grouped by
 * that base. A cycle of bases has no root at all, so whatever the walk didn't
 * reach goes on the end, unnested. Otherwise it would drop out of the switcher.
 */
export function stackOrder(prs) {
  const heads = new Set(prs.filter((p) => !p.isCrossRepository).map((p) => p.headRefName));
  const bases = new Set(prs.map((p) => p.baseRefName).filter((b) => !heads.has(b)));
  const seen = new Set();
  const walk = (nodes, depth) => nodes.flatMap(({ pr, kids }) => [{ pr, depth }, ...walk(kids, depth + 1)]);
  return [
    ...[...bases].flatMap((b) => walk(prTree(prs, b, seen), 0)),
    ...prs.filter((p) => !seen.has(p.number)).map((pr) => ({ pr, depth: 0 })),
  ];
}

/**
 * The switcher's options, `[{ pr, depth }]`: stackOrder over the open pull
 * requests, and the one on screen.
 *
 * gh pr list is open PRs only, so a merged or closed one has no option of its
 * own -- without one the select falls to selectedIndex -1 and renders blank
 * while the pane below it is showing that very PR. It goes into the list the
 * tree is built from rather than in front of the finished order: pinned there,
 * the open PRs based on its branch were roots of their own in the switcher
 * while its Stack tab showed them under it. First in that list, so it still
 * leads its group.
 */
export function switcherRows(prs, current) {
  const missing = current && !prs.some((p) => p.number === current.number);
  if (!missing) return stackOrder(prs);
  const { number, title, headRefName, baseRefName, isCrossRepository } = current;
  return stackOrder([{ number, title, isDraft: false, headRefName, baseRefName, isCrossRepository }, ...prs]);
}

/**
 * What `here` is built on, bottom first: `{ nodes, into, ask }` (#93). `here` is
 * `{ pr }` in a pull request's pane and `{ branch }` in the branch-only one;
 * `nodes` are the pull requests and bare branches under it, `into` the branch
 * the bottom one merges into -- the default branch, or null when the walk ran
 * out -- and `ask` the branch whose base only git can say, and has not yet.
 *
 * A pull request's base comes from the list, as prTree reads it the other way
 * up, so most of a stack costs nothing. A branch with no open pull request --
 * one that merged, or never had one -- has no base on GitHub, and `below` is
 * git's answers for such branches (branchesBelow in git.js, asked for
 * through app.js).
 * `seen` again, because two pull requests can be each other's bases going
 * down as well as up.
 */
export function stackUnder(here, prs, below = [], defaultBranch) {
  const none = { nodes: [], into: null, ask: null };
  if (!prs || !defaultBranch) return none;
  const gitNext = (b) => {
    for (const r of below) {
      const git = [r.branch, ...r.names];
      const i = git.indexOf(b);
      if (i >= 0) return git[i + 1] ?? (r.toDefault ? defaultBranch : null);
    }
    return undefined;
  };
  const start = here.pr ? here.pr.headRefName : here.branch;
  if (!start || (!here.pr && start === defaultBranch)) return none;
  const seen = new Set([start]);
  const nodes = [];
  let b = here.pr ? here.pr.baseRefName : gitNext(start);
  let ask = b === undefined ? start : null;
  // ponytail: a fixed cap, past any stack a person keeps by hand.
  while (b && b !== defaultBranch && !seen.has(b) && nodes.length < 20) {
    seen.add(b);
    // A fork's head is in the fork: nothing here is based on it.
    const pr = prs.find((p) => !p.isCrossRepository && p.headRefName === b);
    nodes.push(pr ? { pr } : { branch: b });
    const next = pr ? pr.baseRefName : gitNext(b);
    if (next === undefined) ask = b;
    b = next;
  }
  return { nodes: nodes.reverse(), into: b === defaultBranch ? b : null, ask };
}

/**
 * The whole stack `here` is in, as nested `[{ pr } | { branch }, kids]`: from
 * the bottom of stackUnder's chain up to `here`, marked, with what is built on
 * it under it as before. Each node on the way also carries the other pull
 * requests built on it, since the list has them for nothing. Null with no
 * chain, which is the pane as it was -- except for a branch git says was cut
 * straight from the default branch: the branch-only pane says what any branch
 * is built on, so that one is a tree of itself, `from main`.
 */
export function stackTree(here, prs, under) {
  if (!under.nodes.length && !(here.branch && under.into)) return null;
  const chain = [...under.nodes, here];
  const seen = new Set(chain.filter((n) => n.pr).map((n) => n.pr.number));
  const build = (i) => {
    const n = chain[i];
    const up = i + 1 < chain.length ? [build(i + 1)] : [];
    const others = n.pr?.isCrossRepository ? [] : prTree(prs, n.pr ? n.pr.headRefName : n.branch, seen);
    return { ...n, here: i === chain.length - 1, kids: [...up, ...others] };
  };
  return [build(0)];
}

/**
 * The line over a stackTree: whose stack it is, and where it bottoms out.
 * Parts, as named() takes them.
 */
export const stackTitle = (who, under) => [
  'The stack ', ...who, ' is in',
  ...(under.into ? [', from ', { branch: under.into }, '.']
    : under.ask ? ['. What ', { branch: under.ask }, ' is built on is not known yet.']
    : ['. Nothing was found below ', { branch: headOf(under.nodes[0]) }, '.']),
];

const headOf = (n) => (n.pr ? n.pr.headRefName : n.branch);

/**
 * The pane with no PR to show. The head is the pull request head's shape with
 * the branch in place of the pull request -- which branch, why there is no PR,
 * and the same way out of the window -- and the body is what merges into here.
 *
 * The way out used to be in the body, under that list, which put it below the
 * fold on `main` with a dozen PRs open: the one branch where issues and
 * milestones are how you choose what to work on next. The head does not
 * scroll, so it is always there.
 */
export function renderNoPr(status, prs, { onCreate, onSwitch, onBelow, below = [], creating = false }) {
  const host = document.getElementById('pr-body');
  tab = 'detail';
  shownFor = null;
  const onDefault = status.branch === status.defaultBranch;

  // Comparing a branch with itself opens an empty diff, so on main there is
  // nothing to offer — the fix is a branch, not a button.
  const can = !status.detached && !onDefault;
  const why = status.detached ? 'No branch to open a pull request for.'
    : onDefault ? 'Default branch. Make a branch to start a pull request.'
    : status.sync === 'unpushed' ? `No pull request for ${status.branch} yet. It is not on GitHub, so Create PR pushes it first.`
    : `No pull request for ${status.branch} yet.`;

  // Create PR takes the pull request's own place in the row, as the one filled
  // button: in both views it is the way to this branch's pull request on
  // GitHub, one that exists and one that is a compare page away. Where no pull
  // request can be made it is left out rather than disabled, since the note
  // already says why. Disabled while a click is still pushing (see createPr in
  // app.js), since this pane is redrawn on every poll.
  const create = can ? [{ text: 'Create PR', className: 'primary', onClick: onCreate, disabled: creating }] : [];

  // The same rows as a pull request's head, down to the class names, through
  // the same HEAD_ORDER. The title is `pr-branch-name` and not `pr-title`
  // because the drivers and the browser suite wait on `.pr-title` to mean a
  // pull request has loaded.
  const out = noPrLinks(status);
  paintHead({
    title: h('h2', { className: 'pr-branch-name' }, status.detached ? 'Detached HEAD' : status.branch),
    note: h('p', { className: 'pr-note' }, why),
    links: create.length || out.links.length ? linkRow([...create, ...out.links], 'meta pr-ways pr-links', out.repo) : null,
  });

  // What the branch is built on only git can say, so it is asked for here --
  // app.js asks once per list, which is the schedule this pane already reads.
  const under = stackUnder({ branch: status.branch }, prs, below, status.defaultBranch);
  if (under.ask) onBelow?.(under.ask);
  const opts = { blocked: status.dirtyFiles.length > 0, onSwitch };
  const tree = stackTree({ branch: status.branch }, prs, under);
  host.replaceChildren(...kids([
    tree
      ? h('div', { className: 'pr-into' },
        h('span', { className: 'pr-into-label' }, ...named(stackTitle(['branch ', { branch: status.branch }], under))),
        stackList(tree, opts))
      : intoRow(status, prs ?? [], opts)
        ?? (status.detached ? null : h('p', { className: 'empty' }, ...named(intoEmpty(status.branch, prs)))),
  ]));
}

/**
 * Said, as the Stack tab says it, when nothing merges into the branch -- or when
 * prcoder has no list to tell (`prs` is null until app.js has one).
 */
const NO_LIST = ['No list of open pull requests yet.'];

/** What the branch-only pane says with no rows. Parts, as named() takes them. */
export const intoEmpty = (branch, prs) => (prs ? ['No pull requests into branch ', { branch }, '.'] : NO_LIST);

/**
 * The pull requests into this branch, each a row you can read or check out.
 *
 * This is the branch-only pane's reason to exist: on `main` there is nothing to
 * create and nothing to read, and what you actually want to know is which pull
 * requests land here.
 *
 * Reading and moving are two controls because they are two different things.
 * The row used to be one button that ran `gh pr checkout`, so a cmd-click to
 * compare a few pull requests in other tabs moved the working copy instead. The
 * `#N` is a real link now, and Switch goes through the same checkout the header's
 * switcher does.
 *
 * On a dirty tree only Switch is disabled, because that checkout would fail.
 * The header has already swapped the switcher for a Commit button, and the link
 * still works: you don't need a clean tree to read a pull request.
 */
function intoRow(status, prs, opts) {
  const tree = prTree(prs, status.branch);
  if (!tree.length) return null;
  return h('div', { className: 'pr-into' },
    h('span', { className: 'pr-into-label' }, ...named(['Pull requests into branch ', { branch: status.branch }])),
    stackList(tree, opts));
}

/**
 * A sentence that names a branch, as parts: plain strings, and `{ branch }`
 * for the name. Parts rather than a string so the name can be set in the code
 * face -- `main` or `queue-tabs` in running text otherwise reads as a word of
 * the sentence -- and rather than elements so tests can read them in Node,
 * where there is no document to build one in.
 */
const named = (parts) => parts.map((p) => (typeof p === 'string' ? p : h('code', { className: 'branch' }, p.branch)));

/**
 * What a Stack tab's pull requests are built on. The head above already says
 * both, but the tab is read on its own, and "built on pr-stack" left you to
 * remember which pull request pr-stack was.
 *
 * Not a link. The PR's page is the title's link a few lines up, and GitHub's
 * page for a branch shows its files and commits, not what is built on it.
 */
export const stackBase = (pr) => [`PR #${pr.number} (branch `, { branch: pr.headRefName }, ')'];

/**
 * A prTree or stackTree as nested lists. Each pull request's stack sits under
 * it, so the size of a stack is how far its indent runs.
 */
const stackList = (nodes, opts) => h('ul', {},
  ...nodes.map((n) => (n.pr ? prRow : bareRow)(n, opts, n.kids.length ? stackList(n.kids, opts) : null)));

/** The row you are on, for a screen reader: bold is only the mark you see. */
const current = (here) => (here ? { ariaCurrent: 'true' } : {});

/**
 * One open pull request: the link to it, what it is called, and the checkout.
 * The one you are looking at is marked instead of offering to go there: the
 * switcher in the head is the way to check it out.
 */
const prRow = ({ pr: p, here }, { blocked, onSwitch }, kids) => h('li', current(here),
  h('div', { className: here ? 'pr-row here' : 'pr-row' },
    ext(p.url, `#${p.number}`, { className: 'pr-num' }),
    p.isDraft ? badge('draft', 'draft') : null,
    h('span', { className: 'pr-row-title', title: p.title }, p.title),
    here ? null : btn('Switch', () => onSwitch(p.number), {
      className: 'pr-go', disabled: blocked,
      title: blocked ? 'Commit or stash your changes first' : `Check out #${p.number} here`,
    })),
  kids);

/**
 * A branch in a stack with no open pull request: the one you are on in the
 * branch-only pane, or one a stack is built on that has merged or never had
 * one. Nothing to link to or check out -- Switch is `gh pr checkout`.
 */
const bareRow = ({ branch, here }, _opts, kids) => h('li', current(here),
  h('div', { className: here ? 'pr-row pr-bare here' : 'pr-row pr-bare' },
    h('code', { className: 'branch' }, branch),
    h('span', { className: 'pr-row-title' }, here ? 'this branch' : 'no open pull request')),
  kids);

/**
 * Which half of the pane is showing, where each half was scrolled to, and which
 * pull request that was all decided about.
 *
 * It lives out here because renderPr runs on every 60s poll and replaces both
 * roots wholesale, so anything the reader chose about the *view* is gone the
 * moment it does. diff.js and queue.js keep their state in module scope for the
 * same reason.
 *
 * Not localStorage. The tab is a per-pull-request fact, and a browser-wide one
 * would carry a decision about a description you have finished reading onto a
 * description you have not opened yet.
 */
let tab = 'detail';
let shownFor = null;
const scrolled = { detail: 0, files: 0, checks: 0, stack: 0 };
const openSections = new Set();
// Whether the single-section description below is still allowed to open itself.
let autoOpen = true;
// Groups record which are *closed*, the inverse of sections, because their
// default is open -- so a group nobody has touched needs no entry, and a group
// that appears for the first time arrives open rather than missing.
const closedGroups = new Set();

// What a relative link and a bare #N in the description are written against.
// Set by renderPr rather than threaded through description(), blockNode(),
// sectionNode() and taskRow(), none of which has any other use for it; inline()
// takes it as an argument so it can still be tested without a pull request.
let links = null;

/**
 * The two things `[README](README.md)` and `#28` need to become links: the
 * repository they are relative to, and the ref a path in it should be read at.
 *
 * The head branch, because a description points at the files the pull request
 * adds as often as at ones that were already there -- except from a fork, where
 * the head branch is in a repository this URL is not. GitHub leaves these hrefs
 * relative and lets the browser resolve them against the page, which on a pull
 * request page is `/owner/repo/pull/` and a 404; prcoder is not on that page,
 * so it has to resolve them itself and may as well resolve them usefully.
 */
const linkBase = (pr) => ({
  repo: repoUrl(pr.url),
  ref: pr.isCrossRepository ? pr.baseRefName : pr.headRefName,
});

/** `owner/repo`, from a repository URL on any host. */
const repoName = (repoUrl) => repoUrl.replace(/^https?:\/\/[^/]+\//, '');

/**
 * The head's way out of the pane, in two parts: the links -- this pull request
 * on GitHub and the three lists people leave for -- and the repository they are
 * all in, which ends the same row.
 *
 * At the end, and nowhere else in it. The repository is the only part of the
 * row whose width has no bound: `heal-data-stewards/heal-vlmd-AI-pipeline` is a
 * real one, and at 12px it is most of the pane at its 375px default. It used
 * to sit between `PR #62` and `issues`, where it wrapped the row and moved
 * `issues`/`pulls`/`milestones` from one repository to the next; the four links
 * you aim at are the four that are always the same length, and they stay
 * findable only while nothing ahead of them varies. It then had a line of its
 * own under the state for a while, which cost the head a line even for a slug
 * as short as `gaurav/prcoder`. Last in the row, a short slug shares the line
 * and a long one wraps whole onto the next and clips only there (see .pr-repo
 * in the stylesheet), so neither case moves the four.
 *
 * Built from the PR's own URL rather than from the `nameWithOwner` the status
 * carries, which says nothing about the host. That keeps these links right for
 * a GitHub Enterprise host, and points a fork's pull request at the repository
 * it was opened *against*, which is where its issues are. The rest of prcoder
 * does not run against an Enterprise host yet -- `parsePrUrl`, the `gh api`
 * calls and two hard-coded github.com URLs all assume it (#53) -- so this is
 * the part not to undo, not proof that the whole works.
 *
 * No ↗ on any of them. Every link out of prcoder opens a new tab, so marking
 * one (it used to be the first of each row) only raised the question of what
 * the unmarked ones did.
 *
 * The pull request is the one marked `primary`, and drawn as a button: of
 * everything in the head it is the link actually clicked, and it used to look
 * exactly like `milestones`. The number on it is not what earns it the button
 * -- it is kept because it is short and is how the PR gets named out loud.
 */
export const headLinks = (pr) => {
  const { repo } = linkBase(pr);
  return {
    links: [{ text: `PR #${pr.number}`, href: pr.url, className: 'primary' }, ...listLinks(repo)],
    repo: repoCrumb(repo),
  };
};

/** The three lists people leave for. */
const listLinks = (repo) =>
  ['issues', 'pulls', 'milestones'].map((p) => ({ text: p, href: `${repo}/${p}` }));

/**
 * The repository itself, as a chip rather than a fifth link, split at the
 * first slash so it can be truncated on purpose.
 *
 * `rest` carries the slash. The owner is the half that gives way when the slug
 * will not fit -- it is the same all day, where the name is what tells you
 * which checkout you are looking at -- and `heal-data-…heal-vlmd-AI-pipeline`
 * would be the result of clipping a span that ended with the separator.
 *
 * A slug with no slash at all should not reach here, but if one does it is all
 * name and no owner, which clips the way any other unsplittable name does.
 */
const repoCrumb = (repo) => {
  const slug = repoName(repo);
  const cut = slug.indexOf('/');
  return cut < 0
    ? { href: repo, slug, owner: '', rest: slug }
    : { href: repo, slug, owner: slug.slice(0, cut), rest: slug.slice(cut) };
};

/**
 * The same way out, for the pane that has no pull request to build it from.
 *
 * The host is hard-coded here where the head's is not, because there is no PR
 * URL to read one off -- `nameWithOwner` is all `gh repo view` was asked for.
 * That makes this the third of the github.com assumptions #53 is about, not a
 * new kind of one; the head's is still the part not to undo.
 *
 * Same shape as headLinks minus the pull request, and rendered by the same
 * linkRow -- before this the two panes laid the same links out differently.
 */
export const noPrLinks = ({ nameWithOwner }) => {
  if (!nameWithOwner) return { links: [], repo: null };
  const repo = `https://github.com/${nameWithOwner}`;
  return { links: listLinks(repo), repo: repoCrumb(repo) };
};

/**
 * One row of links, dot-separated.
 *
 * The dots are their own elements rather than an `a::before`, which is what
 * they were: a pseudo-element lives inside the link's box, so the separator was
 * underlined with it and a click on the gap followed the link to its right.
 * `pointer-events: none` does not help -- the point is still over the <a>
 * itself once the pseudo-element declines it.
 *
 * No dot beside a link with a class of its own (the pull request's button):
 * its box already separates it, and a dot hanging off a pill reads as debris.
 *
 * An entry with `onClick` in place of `href` is a button, handed itself so it
 * can disable itself while it works: Create PR, which pushes before it opens
 * anything.
 *
 * The repository chip, when there is one, goes last and without a dot either:
 * the chip's border separates it the way the button's fill does.
 */
const linkRow = (list, className, crumb) => h('div', { className },
  ...list.map((l, i) => [
    i && !l.className && !list[i - 1].className ? h('span', { className: 'sep' }, '·') : null,
    l.onClick
      ? btn(l.text, (e) => l.onClick(e.currentTarget), { className: l.className, disabled: !!l.disabled })
      : ext(l.href, l.text, l.className ? { className: l.className } : {}),
  ]),
  crumb ? repoChip(crumb) : null);

/**
 * The repository, at the end of that row.
 *
 * One link in two spans, because the CSS shrinks them differently: the owner
 * ellipsises and the name is held whole. `title` is the slug uncut, which is
 * the only way back to an owner the pane has clipped.
 */
const repoChip = (crumb) => ext(crumb.href, [
  crumb.owner ? h('span', { className: 'owner' }, crumb.owner) : null,
  h('span', { className: 'name' }, crumb.rest),
], { title: crumb.slug, className: 'pr-repo' });

/**
 * The pull request pane, in two roots.
 *
 * #pr-head is the identity -- which pull request, on what branch, passing or
 * not -- and does not scroll. #pr-body is one of four views of it: the argument
 * (Detail), the work (Files), CI (Checks, drawn only when there are checks) and
 * the stack it is in (Stack). They are tabs rather than one column
 * because they are different things to be doing, they each want the whole
 * pane, and an agent-written description is long enough to bury a file list
 * entirely. docs/Panes.md has what each shows.
 */
export function renderPr(pr, handlers) {
  links = linkBase(pr);
  // A different pull request is a different set of sections and a different
  // amount of scroll; none of the old numbers mean anything against it.
  if (shownFor !== pr.number) {
    shownFor = pr.number;
    scrolled.detail = 0;
    scrolled.files = 0;
    scrolled.checks = 0;
    scrolled.stack = 0;
    openSections.clear();
    autoOpen = true;
  }
  // A poll can take the tab out from under the reader: checks that have been
  // deleted from the workflow, or a force-push that has not queued any yet,
  // leave nothing for the Checks tab to show and no tab to leave it by.
  if (tab === 'checks' && !pr.checks.list.length) tab = 'detail';
  // Parsed once for both: the Detail tab's count and the description itself.
  const parsed = blocks(pr.body);
  renderPrHead(pr, parsed, handlers);
  renderPrTab(pr, parsed, handlers);
}

function renderPrHead(pr, parsed, handlers) {
  const switchTo = (name) => {
    tab = name;
    // The Stack tab says what is and is not built on this branch, and the list
    // it says it from is fetched only now and then (see loadPrs in app.js).
    // Opening it asks for a fresh one, which repaints the pane when it lands.
    if (name === 'stack') handlers.onStackOpen?.();
    renderPrHead(pr, parsed, handlers);
    renderPrTab(pr, parsed, handlers);
  };
  const paneTab = (name, label, extra, props) => tabBtn(label, tab === name, () => switchTo(name), extra, props);
  const ways = headLinks(pr);
  const state = pr.isDraft ? 'draft' : pr.state.toLowerCase();
  // The base is often another pull request's branch, and which one is the
  // thing you want next to it. From the list, so it costs nothing.
  const under = handlers.prs?.find((p) => !p.isCrossRepository && p.headRefName === pr.baseRefName);

  const files = filesProgress(pr.files);
  const tasks = taskCount(parsed);
  const checks = checkCount(pr.checks);
  // A tab's accessible name and its tooltip, which say the same thing.
  const said = (name) => ({ ariaLabel: name, title: name });

  // Each row stands alone -- no row's spacing depends on which one is above it
  // -- so the order is HEAD_ORDER and nothing else.
  const rows = {
    title: h('h2', { className: 'pr-title' }, pr.title),
    note: pr.note ? h('p', { className: 'pr-note' }, pr.note) : null,
    // `pr-links` carries no style of its own -- it is the hook tools/browser.mjs
    // measures the row by, so it is not dead CSS to clean up.
    links: linkRow(ways.links, 'meta pr-ways pr-links', ways.repo),
    state: h('div', { className: 'meta pr-state' },
      badge(state, state),
      h('span', {}, `${pr.headRefName} → ${pr.baseRefName}`, under ? ' (' : null,
        under ? ext(under.url, `#${under.number}`) : null, under ? ')' : null),
      h('span', { className: 'add' }, `+${pr.additions}`),
      h('span', { className: 'del' }, `−${pr.deletions}`),
    ),
    // Each tab that counts work left leads with its mark (tabLabel says why in
    // front). The mark is hidden from a screen reader, so whatever it says that
    // the label does not goes in the button's name -- filesName, checksName.
    tabs: h('div', { className: 'tabs' },
      paneTab('detail', [tasks.total ? mark(fraction(tasks)) : null,
        tabLabel('Detail', tasks)]),
      paneTab('files', [files.count.total ? mark({ p: files.p, full: files.full }) : null,
        tabLabel('Files', files.count)], '', said(filesName(files))),
      pr.checks.list.length
        ? paneTab('checks', [mark({ ...fraction(checks), state: worst(pr.checks) }),
          tabLabel('Checks', checks)], '', said(checksName(pr.checks)))
        : null,
      paneTab('stack', stackLabel(stackOn(pr, handlers.prs), stackUnder({ pr }, handlers.prs, handlers.below, handlers.defaultBranch).nodes))),
  };
  paintHead(rows);
}

/**
 * The head, top to bottom, in the order it is read: what this is, the way to
 * it on GitHub with the lists beside it and the repository they are in,
 * whether it is open, and what it changes. Rearranging the head is reordering
 * this.
 *
 * Both views of the pane draw their head through it. The one with no pull
 * request has no state or tabs, and those rows fall out.
 */
const HEAD_ORDER = ['title', 'note', 'links', 'state', 'tabs'];

const paintHead = (rows) =>
  document.getElementById('pr-head').replaceChildren(...kids(HEAD_ORDER.map((k) => rows[k])));

/**
 * The count each tab carries is what it can tell you while you are on the other
 * one: how many description checkboxes are still open, how many files are still
 * unviewed.
 *
 *   Detail          nothing to count
 *   Detail (3/10)   seven outstanding, done over total as the file groups read
 *   Detail (10/10)  there were things, and they are all done -- and tabDone
 *
 * The count stays on when it runs out. It used to become a bare `Detail ✓`, on
 * the grounds that `(10/10)` alone reads as a proportion you would want to be
 * larger; but `(11/11)` is what says all eleven files were viewed rather than
 * that some rule decided it was finished, and the ✓, a 12px glyph in the tab's
 * dim grey, was too faint to notice (2026-09-27). So the count says how many,
 * and the tab's mark (mark()) turns into a green ✓ circle to say none are left.
 *
 * The mark goes in front of the name, on every tab. For a while Files and
 * Detail carried theirs after the count and Checks carried its own in front,
 * so one tab moved its mark across the label when it went green, and the eye
 * had two places to look (2026-10-06). In front it sits beside the word it is
 * about rather than the parenthesis, at a place that does not move with the
 * count's width, and it is where a check row's mark already was.
 */
export const tabLabel = (name, { done, total }) => (total ? `${name} (${done}/${total})` : name);

/** Whether a tab's count has run out, which is what fills its mark. Never for nothing to count. */
export const tabDone = ({ done, total }) => total > 0 && done === total;

/** Over blocks() rather than the body, so a caller that has parsed it once reuses that. */
export const taskCount = (list) => {
  const tasks = list.filter((b) => b.kind === 'task');
  return { done: tasks.filter((b) => b.done).length, total: tasks.length };
};

/**
 * The open pull requests built on this one's branch, from the switcher's list.
 * None for a fork: its head branch is in another repository, so a base here
 * with the same name -- a fork's `main`, often -- is not it.
 *
 * This one starts out seen. prTree's own `seen` only stops a cycle of bases
 * recursing forever; it would still reach round the loop back to this pull
 * request and list it under its own Stack tab, with a Switch to where you are.
 */
export const stackOn = (pr, prs) => (!prs || pr.isCrossRepository ? []
  : prTree(prs, pr.headRefName, new Set([pr.number])));

/**
 * What the Stack tab says when it has no rows, which is four different facts:
 * nothing is built on this branch, nothing *can* be (a fork's branch), prcoder
 * does not look (a pull request in another repository), or it has no list to
 * look in yet (`prs` is null until app.js has one). The last two both arrive as
 * a null list, which is why `otherRepo` is its own argument -- see paint() in
 * app.js. Parts, as named() takes them.
 */
export const stackEmpty = (pr, prs, otherRepo = false) => (otherRepo
  ? ['Stacks are listed only for pull requests in this repository.']
  : !prs ? NO_LIST
  : pr.isCrossRepository
    ? ['Nothing here can be built on ', ...stackBase(pr), ': the branch is in a fork.']
    : ['Nothing is stacked on ', ...stackBase(pr), '.']);

const stackSize = (nodes) => nodes.reduce((n, k) => n + 1 + stackSize(k.kids), 0);

/**
 * `Stack (↓1 ↑2)`: the pull requests under this one, and every one built on it.
 * A part that is nothing is left out, and a stack of one is plain `Stack`.
 * Bare branches under it are drawn and not counted -- there is nothing to
 * switch to -- and neither are the other stacks on the ones under it.
 */
export const stackLabel = (above, under = []) => {
  const down = under.filter((n) => n.pr).length;
  const up = stackSize(above);
  const parts = [down && `↓${down}`, up && `↑${up}`].filter(Boolean);
  return parts.length ? `Stack (${parts.join(' ')})` : 'Stack';
};

export const viewedCount = (files = []) =>
  ({ done: files.filter((f) => f.viewed).length, total: files.length });

const lines = (f) => (f.additions ?? 0) + (f.deletions ?? 0);

/** viewedCount by changed lines, additions plus deletions, rather than by files. */
export const viewedLines = (files = []) => ({
  done: files.filter((f) => f.viewed).reduce((n, f) => n + lines(f), 0),
  total: files.reduce((n, f) => n + lines(f), 0),
});

/**
 * The pie for a list of files: how much of the reviewing is left, which the
 * tab's `(14/17)` cannot say -- fourteen of seventeen with the last three the
 * biggest is a pie still mostly empty. So it fills by changed lines viewed, and
 * by files only where there are no lines to weigh (renames, mode changes,
 * binaries). Full is every file viewed, not every line: an unviewed rename
 * weighs nothing, and must not let a pie read as finished.
 */
export const filesProgress = (files = []) => {
  const count = viewedCount(files);
  const weight = viewedLines(files);
  // The part the count cannot say, written once for this label and filesName.
  const lines = weight.total ? `${weight.done} of ${weight.total} changed lines viewed` : null;
  return {
    p: fraction(weight.total ? weight : count).p,
    full: tabDone(count),
    label: `${count.done} of ${count.total} files` + (lines ? `, ${lines}` : ' viewed'),
    count,
    lines,
  };
};

/**
 * The Files tab's accessible name and tooltip: its label, then what its pie
 * says that the label does not -- `Files (2/5): 40 of 120 changed lines
 * viewed`. The pie was its own tooltip once, a 12px target; on the button the
 * whole tab is. Plain label once every file is viewed, or when there are no
 * lines to weigh, since the pie then says nothing the count does not. Takes
 * filesProgress, so the tab walks its files once and says what the pie says.
 */
export const filesName = ({ count, lines, full }) => {
  const label = tabLabel('Files', count);
  return lines && !full ? `${label}: ${lines}` : label;
};

/**
 * The checks as the same done-over-total the other two tabs carry, so a run in
 * progress reads as `Checks (1/3)` and a green one as `Checks (3/3)` with the
 * done circle, and the mark in front fills by the same fraction.
 *
 * A failure is not "done": it is counted in the total and not in the done, so
 * the fraction stays short of the total for as long as something is red. That
 * leaves a pending 1/3 and a failed 1/3 as the same fraction: the mark in
 * front tells them apart on screen -- a yellow ring round the pie, or a red ✕
 * in place of it -- and checksName in words.
 */
export const checkCount = ({ passed, failed, pending }) =>
  ({ done: passed, total: passed + failed + pending });

/**
 * The Checks tab's accessible name and tooltip: its label, then what the mark
 * in front of it means -- `Checks (1/3): 1 failed, 1 pending`. The mark is shape and
 * colour, which a screen reader does not get, and the fraction alone cannot say
 * whether what is missing failed or is still running.
 *
 * Not the visible label. `Checks (1/3, 1 failed)` on the tab itself was tried
 * (2026-09-27) and at the pane's 375px default it wrapped every tab's label
 * onto two lines, which is the head growing back the height this pane has been
 * giving up. The name starts with the label as written, so speech input that
 * says what is on screen still finds the button.
 */
export const checksName = (checks) => {
  const label = tabLabel('Checks', checkCount(checks));
  const words = [checks.failed && `${checks.failed} failed`, checks.pending && `${checks.pending} pending`];
  return words.some(Boolean) ? `${label}: ${words.filter(Boolean).join(', ')}` : label;
};

/**
 * The word a check row carries beside its mark. A pass carries none: it is the
 * state you stop reading at. A screen reader still needs one, since the mark is
 * otherwise hidden from it, so a passed row's mark is named instead -- an image
 * called `passed` -- and the ✓ is what a sighted reader gets for the word.
 */
const CHECK_WORD = { pend: 'pending', fail: 'failed' };

/**
 * The one state a row of checks is worth reporting as. Red beats yellow beats
 * green: a single failure is the thing to know about, whatever else passed.
 */
export const worst = ({ failed, pending }) => (failed ? 'fail' : pending ? 'pend' : 'pass');

function renderPrTab(pr, parsed, handlers) {
  const host = document.getElementById('pr-body');
  // Recorded as it happens rather than read before the replace: a tab switch
  // sets `tab` to the tab being switched *to* before it re-renders, so reading
  // scrollTop here filed the outgoing tab's offset under the incoming one and
  // restored it four lines later. The listener only ever fires while the DOM
  // and `tab` agree, and reassigning the one handler every render is
  // idempotent -- there is never a second one to remove.
  host.onscroll = () => { scrolled[tab] = host.scrollTop; };
  // A <summary> is a keyboard control, and a poll landing a second after you
  // tabbed onto one would otherwise drop focus on the floor. queue.js decided
  // not to freeze a whole pane over focus and that still holds -- this restores
  // it instead.
  const focused = document.activeElement?.closest?.('.md-section')?.dataset.key;

  const stack = tab === 'stack' ? stackOn(pr, handlers.prs) : null;
  // Only an open tab asks git: most pull requests are on the default branch,
  // and the ones that aren't mostly sit on another PR, which the list has.
  const under = stack && stackUnder({ pr }, handlers.prs, handlers.below, handlers.defaultBranch);
  if (under?.ask) handlers.onBelow?.(under.ask);
  const tree = under && stackTree({ pr }, handlers.prs, under);
  host.replaceChildren(...kids(stack ? [
    tree
      ? h('div', { className: 'pr-into' },
        h('span', { className: 'pr-into-label' }, ...named(stackTitle(stackBase(pr), under))),
        stackList(tree, handlers))
      : stack.length
      ? h('div', { className: 'pr-into' },
        h('span', { className: 'pr-into-label' }, ...named(['Pull requests built on ', ...stackBase(pr)])),
        stackList(stack, handlers))
      : h('p', { className: 'empty' }, ...named(stackEmpty(pr, handlers.prs, handlers.otherRepo))),
  ] : tab === 'checks' ? [
    ...pr.checks.list.map((c) => h('div', { className: 'check' },
      mark({ full: c.state === 'pass', state: c.state, label: CHECK_WORD[c.state] ? undefined : 'passed' }),
      // A check GitHub gave no URL for is rare and not worth a dead link, so it
      // stays plain text rather than becoming an <a> to nowhere.
      c.url ? ext(c.url, c.name, { className: 'check-name' }) : h('span', { className: 'check-name' }, c.name),
      CHECK_WORD[c.state] ? h('span', { className: 'check-state' }, CHECK_WORD[c.state]) : null)),
  ] : tab === 'files' ? [
    ...GROUPS.map(([key, label]) => fileGroup(label, pr.files.filter((f) => f.group === key), handlers)),
    h('div', { className: 'meta' },
      ext(`${pr.url}#issuecomment`, `${pr.counts.comments} comments · ${pr.counts.reviews} reviews`)),
  ] : [
    h('div', { className: 'body md' }, ...description(parsed, handlers.onTask)),
    issueRow(pr.issues, true, 'Closes'),
    issueRow(pr.issues, false, 'Mentions'),
  ]));

  // Assigning forces layout, so this lands against the new content rather than
  // the old. Nothing reflows underneath it afterwards -- the description's
  // serif stack is all system faces, deliberately, because a webfont arriving
  // late would move every line under a scroll position already restored.
  host.scrollTop = scrolled[tab];
  if (focused) host.querySelector(`.md-section[data-key="${CSS.escape(focused)}"] > summary`)?.focus();
}

const badge = (text, kind) => h('span', { className: `badge ${kind}` }, text);

/**
 * One list of issues, labelled with what this pull request does about them.
 *
 * Both lists sit below the description, `Closes:` first. The closing ones were
 * above it, from before a description reliably said which issues it closed:
 * they are now named in the abstract's own prose -- and inline() links every
 * `#N` in it -- so a row of the same numbers a line above that sentence was
 * saying it twice, in the one place the pane is trying to keep clear.
 *
 * A line per issue, titled, rather than a wrapped row of bare-number chips:
 * `#41` says nothing about what it is, and a description that discusses its own
 * backlog carries a dozen of them. The title is what makes the list readable,
 * and it is also what makes a chip the wrong shape -- a pill does not hold a
 * sentence. A number with no title left is still a link.
 *
 * The number and the title are separate spans inside the one link so the
 * stylesheet can treat them apart: thirteen rows that were one colour and one
 * weight end to end gave the eye nowhere to land, and a wrapped title came back
 * to the margin under the `#` and read as a fourteenth. The row is still the
 * whole link -- the split is for the grid and the colour, not the click. The
 * space between them is what keeps `textContent` reading `#27 Make the …`, which
 * is how tools/browser.mjs finds a row; the grid never renders it.
 */
function issueRow(list, closes, label) {
  const kind = list.filter((i) => i.closes === closes);
  if (!kind.length) return null;
  return h('div', { className: 'issues' },
    h('span', { className: 'issues-label' }, label),
    ...kind.map((i) => ext(i.url, [
      h('span', { className: 'num' }, `#${i.number}`),
      ...(i.title ? [' ', h('span', { className: 'ttl' }, i.title)] : []),
    ])));
}

/**
 * One group of changed files, folded.
 *
 * Open by default, which is the opposite of a description's sections and for
 * the opposite reason: this tab is the working surface, and a file list you
 * have to open is a file list in the way. The fold is here so a group you have
 * finished with can be got out of the way -- thirty-five files across three
 * groups is a smaller version of the problem the tabs were for.
 */
function fileGroup(label, files, handlers) {
  if (!files?.length) return null;
  const { root, dirs } = byDir(files);
  return fold({
    className: 'group', dataset: { group: label }, title: label, progress: filesProgress(files),
    ...kept(closedGroups, label, 'closed'),
  }, [
    ...root.map((f) => fileRow(f, handlers)),
    ...dirs.map(([dir, list]) => dirGroup(label, dir, list, handlers)),
  ]);
}

/**
 * Two paths, ordered the way a tree is: a directory ahead of what is inside it,
 * siblings alphabetical. The folds are ordered by this; the files inside one are
 * ordered by bySize, and fall back to this only on a tie.
 *
 * Segment by segment, and it has to be -- comparing the whole strings is the
 * obvious version and it splits a directory from its children. `alpha-x/` and
 * `alpha/beta/` first differ at `-` (45) against `/` (47), so a string compare
 * puts `alpha-x/` *between* `alpha/` and `alpha/beta/`. Segment 0 is `alpha`
 * against `alpha-x` here, which cannot go wrong that way.
 *
 * Running out of segments is the answer for a prefix: `alpha/` and
 * `alpha/beta/` agree on segment 0, and the trailing `/` every directory key
 * carries leaves `alpha/` with an empty final segment, which sorts below any
 * real name. The length return is what catches a key without the slash.
 */
export const byPath = (a, b) => {
  const A = a.split('/'), B = b.split('/');
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  return A.length - B.length;
};

/**
 * Two files, the one with more changed lines first -- additions plus deletions,
 * so a file rewritten line for line counts both halves -- and by path on a tie.
 * The largest change in a directory is usually the one to read first.
 */
export const bySize = (x, y) =>
  lines(y) - lines(x) || byPath(x.path, y.path);

/**
 * The files of one group, split into the ones at the top of the repository and
 * one entry per directory below it.
 *
 * The order is this pane's own, not `gh`'s. It used to be inherited -- `gh`
 * returns the files sorted by path, so one pass left the directories in
 * whatever order their *first* file happened to fall in, which is not an order
 * over the directories at all: a group here drew `.claude/skills/run-prcoder/`,
 * `.github/workflows/`, the root, `docs/`, with the repo's own README buried in
 * the middle. The Map is an accumulator now: `byPath` orders the directories,
 * which keeps a parent ahead of its children, and `bySize` the files in each.
 *
 * Root files come back separately because they are not a fold. They have no
 * directory to be named after and nothing to strip off their rows, so they draw
 * as the group's first rows and each group reads like a tree.
 */
export const byDir = (files) => {
  const root = [], dirs = new Map();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    if (cut === -1) { root.push(f); continue; }
    const dir = f.path.slice(0, cut + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  for (const list of dirs.values()) list.sort(bySize);
  return { root: root.sort(bySize), dirs: [...dirs].sort(([a], [b]) => byPath(a, b)) };
};

/**
 * One directory inside a group, folded like the group itself.
 *
 * The fold state is keyed by group *and* directory: `public/` under Code and
 * `public/` under Tests are two different folds, and a single key would close
 * both. Both keys live in the one `closedGroups` set -- a group's label never
 * ends in `/` and a directory's key always does, so the two kinds cannot
 * collide.
 */
function dirGroup(group, dir, files, handlers) {
  const key = `${group}/${dir}`;
  return fold({
    className: 'dir', dataset: { dir }, title: dir, progress: filesProgress(files),
    ...kept(closedGroups, key, 'closed'),
  }, files.map((f) => fileRow(f, handlers, dir)));
}

/**
 * The +/− counts for one file, as [class, text] pairs. A side that changed
 * nothing is left out rather than shown as a zero: `+101` reads as an addition
 * at a glance where `+101 −0` does not. A file with neither (a rename, a mode
 * change) gets no counts at all. The header's totals above keep both sides on
 * purpose -- `+400 −0` there says the shape of the whole PR at a glance.
 */
export const nums = ({ additions, deletions }) => [
  additions ? ['add', `+${additions}`] : null,
  deletions ? ['del', `−${deletions}`] : null,
].filter(Boolean);

/** `done` of `total` as the pie mark() draws: how far, and whether it is finished. */
const fraction = ({ done, total }) => ({ p: total ? done / total : 0, full: tabDone({ done, total }) });

/** fraction, with the figure as the mark's name -- for a fold, where no label beside it says it. */
const counted = (count, what) => ({ ...fraction(count), label: `${count.done} of ${count.total} ${what}` });

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
function mark({ p = 0, full = false, state, label }) {
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
const kept = (set, key, holds) => ({
  open: set.has(key) === (holds === 'open'),
  onToggle: (open) => { if (open === (holds === 'open')) set.add(key); else set.delete(key); },
});

/**
 * A <details> fold with a heading and an optional progress pie, the shape both
 * the file groups and the description's sections take. `onToggle` fires for a
 * click and for the initial `open`, so it has to be idempotent.
 */
function fold({ className, dataset, title, progress, open, onToggle }, children) {
  const d = h('details', { className: `fold ${className}`, open, dataset },
    h('summary', {}, h('h3', {}, title), progress ? mark(progress) : null),
    h('div', { className: 'sec-body' }, ...children));
  d.addEventListener('toggle', () => onToggle(d.open));
  return d;
}

function fileRow(f, { onViewed, onOpen, selected }, dir = '') {
  const box = h('input', { type: 'checkbox', checked: f.viewed, title: 'mark viewed on GitHub' });
  writeThrough(box, (v) => onViewed(f.path, v));
  // The path goes inside a <bdi>. Its container is `direction: rtl` so that a
  // long path is cut at the *head* and the filename survives -- but that also
  // makes a leading `.` a neutral character at the start of an RTL run, which
  // the bidi algorithm moves to the visual end: `.gitignore` rendered as
  // `gitignore.` and `.github/workflows/test.yml` as `github/...test.yml.`.
  // A bdi isolates the path and resolves it by its own first strong character,
  // which for any real path is a Latin letter, so it lays out left to right
  // inside a box that still overflows from the left. Checked in both engines
  // on 2026-09-09; `unicode-bidi: plaintext` on the link fixes the order too,
  // but moves the cut to the tail, which is the thing the rtl was for. An LRM
  // prefix and an LRI…PDI wrap both work, and both put invisible characters
  // into text people copy.
  // The name the fold above it does not already say. `title` stays the whole
  // path: the row is what you point at when you want to know where a file is,
  // and the directory heading may have scrolled off the top of a long group.
  // A root row has no fold above it and passes no `dir`, which slices nothing.
  const shown = f.path.slice(dir.length);
  const link = ext(f.url, h('bdi', {}, shown), { className: 'path', title: f.path });
  link.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) return;   // GitHub stays one modifier away
    e.preventDefault();
    onOpen(f);
  });
  const row = h('div', {
    className: `file${f.viewed ? ' viewed' : ''}${f.path === selected ? ' sel' : ''}`,
    dataset: { path: f.path },
  },
    box,
    link,
    h('span', { className: 'nums' },
      ...nums(f).map(([cls, text], i) => [i ? ' ' : null, h('span', { className: cls }, text)])),
  );
  return row;
}

/**
 * A PR description as blocks, in body order: `code`, `p`, `heading`, `task`,
 * `list` and `quote`. No DOM -- blockNode() below turns one of these into an element, and
 * sectionize() regroups them into folds. Splitting it this way is what lets the
 * whole renderer be tested without a browser.
 *
 * `index` counts every checklist line as it goes, because a tick is sent as a
 * *position* in that list and taskLines() in tasks.js recounts it the same way
 * on the server -- the two walks have to agree line for line (tasks.js says
 * what happens when they do not, and test/tasks.test.js pins it).
 *
 * The numbering happens here, once, before anything downstream groups or hides
 * anything. So sectionize() may regroup these blocks and the pane may fold them
 * without renumbering a thing. Anything that wants to change *which lines
 * count* belongs in tasks.js, where both sides read it.
 */
export function blocks(text) {
  const out = [];
  let index = 0;

  for (const chunk of fences(withoutHtml(text))) {
    // A fence is not markdown, so nothing inside it is a heading, a task or a
    // list -- which is why this repo's own description can show a `## Queue`
    // sample without growing a fold, and a `- [ ]` sample without growing a
    // checkbox the server would refuse.
    if (chunk.code !== undefined) {
      out.push({ kind: 'code', code: chunk.code });
      continue;
    }
    for (const para of chunk.text.split(/\n{2,}/).filter(Boolean)) {
      let prose = [];
      let list = null;
      let quote = null;
      // Prose, a list and a quote are the three things that can be open, never
      // two at once: every branch that opens one closes the others, which is
      // what keeps the output in body order.
      const flush = () => {
        if (prose.length) out.push({ kind: 'p', text: prose.join('\n') });
        if (list) out.push(list);
        if (quote) out.push(quote);
        prose = [];
        list = null;
        quote = null;
      };
      for (const line of para.split('\n')) {
        const task = TASK.exec(line);
        if (task) {
          flush();
          out.push({
            kind: 'task', done: task[1].toLowerCase() === 'x', text: task[2], index: index++,
          });
          continue;
        }
        // A heading is one line, so it is handled here rather than per
        // paragraph: one can open a paragraph that runs straight on into prose.
        const head = HEADING.exec(line);
        if (head) {
          flush();
          out.push({ kind: 'heading', level: head[1].length, text: head[2] });
          continue;
        }

        const quoted = QUOTE.exec(line);
        if (quoted) {
          if (prose.length || list) flush();
          quote ??= { kind: 'quote', text: null };
          quote.text = quote.text === null ? quoted[1] : `${quote.text}\n${quoted[1]}`;
          continue;
        }

        const num = ORDERED.exec(line);
        const bul = num ? null : BULLET.exec(line);
        if (num || bul) {
          // A change of marker starts a new list, the way GitHub renders it.
          if (list && list.ordered !== Boolean(num)) flush();
          // Conditional, unlike the branches above, because flush() would close
          // the very list this line is appending to. Anything else that can be
          // open has to be named here or it comes out after the list instead of
          // before it.
          if (prose.length || quote) flush();
          list ??= { kind: 'list', ordered: Boolean(num), start: num ? Number(num[1]) : 1, items: [] };
          list.items.push(num ? num[2] : bul[1]);
          continue;
        }
        // A plain line under a list item is that item wrapping, not new prose.
        // Descriptions arrive from an editor with no hard wrap, and this repo's
        // own bullets run to four hundred characters.
        if (list) {
          list.items[list.items.length - 1] += `\n${line.trim()}`;
          continue;
        }
        // Lazy continuation: an unmarked line under a quote is still the quote,
        // the way GitHub reads it and the way the list above reads its own. A
        // marked line is not -- every branch over this one flushes first, so a
        // heading or a list after a quote ends it rather than joining it.
        if (quote !== null) {
          quote.text += `\n${line.trim()}`;
          continue;
        }
        prose.push(line);
      }
      flush();
    }
  }
  return out;
}

/**
 * A bullet needs its space, the way a heading does: `-flag` and `--body-file`
 * are prose, and this repo's own description is full of both.
 *
 * Both are matched *after* TASK, which matches `- [ ] x` as well. A checklist
 * line rendered as a bullet is a line that never gets an index, and every tick
 * after it in the body would then address the line above -- so the order of
 * those two tests in blocks() is load-bearing, and test/pr.test.js pins it.
 *
 * One level only. Leading whitespace is allowed but not counted, so an indented
 * sub-bullet becomes a sibling rather than being lost or mis-parsed: at 375px
 * there is nothing to indent into, and a real indent stack would need a notion
 * of a line that tasks.js does not have.
 */
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
/** `1.` and `1)`, the two GitHub renders. The author's start number is kept. */
const ORDERED = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;

/**
 * A quote needs no space after its `>`, unlike a bullet: `>text` is a quote on
 * GitHub, and there is no `>flag` the way there is a `-flag` for it to eat.
 * Exactly one space is eaten if there is one, so an indent inside a quote is
 * the author's and survives.
 *
 * ponytail: a quote's content is one prose paragraph, whatever it contains --
 * a bullet, a heading, a fence or a nested `> >` inside one shows as its own
 * text. Give the quote its own blocks() pass when a description needs it. A
 * checklist line is the one that cannot wait quietly: `> - [ ]` is a checkbox
 * on GitHub and prose here, but TASK in tasks.js does not match it either, so
 * both sides skip it and the tick indices stay in step. Anything that starts
 * counting quoted lines has to change both.
 */
const QUOTE = /^[ \t]*>[ \t]?(.*)$/;

/** One block as an element. The DOM half of blocks(); everything above is pure. */
const blockNode = (b, onTask) => ({
  // textContent, not inline(): the point of a fence is that what is inside it
  // is not markdown.
  code: () => h('pre', {}, h('code', { textContent: b.code })),
  p: () => h('p', { innerHTML: inline(b.text) }),
  // Offset by two: the pane's own <h1> names it and the PR title is the <h2>,
  // so a description's top-level heading sits under both.
  heading: () => h(`h${Math.min(b.level + 2, 6)}`, { innerHTML: inline(b.text) }),
  quote: () => h('blockquote', { innerHTML: inline(b.text) }),
  task: () => taskRow(b, onTask),
  list: () => h(b.ordered ? 'ol' : 'ul', b.start > 1 ? { start: b.start } : {},
    ...b.items.map((t) => h('li', { innerHTML: inline(t) }))),
}[b.kind]());

/**
 * The description as an outline: everything before the first heading, then one
 * section per heading at the *shallowest* level the body actually uses.
 *
 * Deriving that level from the body rather than fixing one here is what lets a
 * description written with `#` and one written with `##` each fold at their own
 * top level -- the mirrored block an earlier prcoder wrote starts `## TODO`, and
 * a description someone typed may well start at `#`. Anything deeper stays a
 * plain heading inside the section it belongs to.
 *
 * Regrouping only. Every block comes out exactly once, in the order it went in,
 * carrying the `index` it went in with -- see blocks() for why that is the whole
 * safety argument for folding at all.
 */
export function sectionize(list) {
  const levels = list.filter((b) => b.kind === 'heading').map((b) => b.level);
  const top = Math.min(...levels);   // Infinity for a body with no headings
  if (!Number.isFinite(top)) return { lead: list, sections: [] };

  const lead = [];
  const sections = [];
  const seen = new Map();
  for (const b of list) {
    if (b.kind === 'heading' && b.level === top) {
      // Keyed by its own text, so the key survives the poll rebuilding this
      // list and survives a section being added above it -- an index would not.
      // A description with two `## Why` gets `Why` and `Why#2`: duplicates are
      // rare, and an ordinal is cheaper than pretending they cannot happen.
      const n = (seen.get(b.text) ?? 0) + 1;
      seen.set(b.text, n);
      sections.push({ title: b.text, key: n === 1 ? b.text : `${b.text}#${n}`, nodes: [] });
    } else (sections.at(-1)?.nodes ?? lead).push(b);
  }
  return { lead, sections };
}

/**
 * One section, collapsed behind its heading.
 *
 * A native <details> rather than a toggle of our own, for one reason above the
 * free keyboard operation and disclosure semantics: a closed <details> keeps its
 * subtree in the DOM. The obvious hand-rolled version builds a section's body
 * when it is first opened, and that is exactly the thing that would break the
 * checklist index -- an unopened section's task lines would never be counted,
 * and every tick after it would address the line above. Native removes the
 * temptation.
 *
 * Not `name=`, which would make these an accordion. The decision was that each
 * section folds, not that only one may be open: closing what someone is reading
 * because they opened the next one is worse than either.
 */
function sectionNode(s, onTask) {
  const count = taskCount(s.nodes);
  return fold({
    className: 'md-section', dataset: { key: s.key }, title: s.title,
    // So a fold never hides work without saying so.
    progress: count.total ? counted(count, 'done') : null,
    ...kept(openSections, s.key, 'open'),
  }, s.nodes.map((b) => blockNode(b, onTask)));
}

/**
 * The description: the lead as it is, everything after the first heading folded.
 *
 * Collapsed by default, and the open set is deliberately not persisted -- a
 * description you finished reading yesterday reopening itself today is how the
 * pane becomes what this was written to fix.
 */
function description(parsed, onTask) {
  const { lead, sections } = sectionize(parsed);
  // A description that is one heading and nothing else would fold to a single
  // line showing nothing at all.
  // Once per pull request, not once per poll. renderPr runs every 60s, and
  // without the flag a reader who collapses that one section watches it reopen
  // a minute later, every minute.
  if (autoOpen && !lead.length && sections.length === 1) openSections.add(sections[0].key);
  autoOpen = false;
  return [
    ...lead.map((b) => blockNode(b, onTask)),
    ...sections.map((sec) => sectionNode(sec, onTask)),
  ];
}

// A heading needs its space: `#hashtag` is prose, and rendering it as a heading
// would swallow the line.
export const HEADING = /^(#{1,6})\s+(.*)$/;

/** A checkbox in the description, ticked through to GitHub. */
function taskRow({ done, text, index }, onTask) {
  const box = h('input', { type: 'checkbox', checked: done, title: 'tick this on GitHub' });
  const row = h('label', { className: `task${done ? ' done' : ''}` },
    box, h('span', { innerHTML: inline(text) }));
  writeThrough(box, (v) => onTask({ index, done: v, text }));
  return row;
}

/**
 * Code spans are lifted out before anything else runs and put back last, so no
 * other rule can reach inside one. Without that `PRCODER_NO_OPEN` italicises
 * its own middle, and a URL in backticks becomes a link inside a <code>.
 *
 * Emphasis comes after bold, so `**x**` is already <strong> by the time the
 * single-asterisk rule looks. The underscore form needs a non-word character
 * either side or it eats snake_case; the asterisk form needs no such guard,
 * because a bare `*` mid-word is vanishingly rare in prose and common only in
 * globs, which live in code spans and are already out of reach.
 */
export const inline = (s, where = links) => {
  const code = [];
  const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  return escape(s)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      const url = target(href, where);
      return url ? a(url, text) : m;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_, pre, url) => pre + a(url, url))
    // After the two link rules, so a `#` inside an href this just built is not
    // a mention: those are preceded by a path character, and a mention has to
    // start a word. mentions() in tasks.js reads the same pattern over the same
    // shown text, which is what puts the same numbers in the Mentions row.
    .replace(mention(), (m, pre, n) =>
      (where ? `${pre}${a(`${escape(where.repo)}/issues/${n}`, `#${n}`)}` : m))
    .replace(/\n/g, '<br>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
};

/**
 * Where a link in a description actually points, or null for one this pane will
 * not open -- which stays as its own source, the way everything else it does
 * not know does.
 *
 * The null is the guard as much as the fallback: this href is interpolated into
 * an `href="..."` and set with innerHTML, so `javascript:` and `data:` targets
 * are a typed turn into the running claude session away (see escape() below).
 * Only http(s) and repository-relative paths get through; a bare `#anchor` is a
 * position on a page prcoder is not, so it is left alone too.
 */
const target = (href, where) => {
  if (/^https?:\/\//.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
  // `href` has been through escape() with the rest of the description, but the
  // ref comes from the pull request: raw, a branch named `a"/style="...` closed
  // the href and added an attribute to the page that holds the /pty socket.
  return where ? `${escape(where.repo)}/blob/${urlPath(where.ref)}/${href.replace(/^\.?\//, '')}` : null;
};

// Quotes as well as angle brackets. inline() interpolates a link's URL into an
// href="..." attribute and blockNode() sets the result with innerHTML, so a `"`
// left raw closes the attribute and whatever follows is parsed as another one --
// including an inline event handler, which innerHTML does fire. The page holding
// this pane is the page holding the /pty socket, so that is a typed turn into
// the running claude session, from a description anyone can write.
const escape = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
