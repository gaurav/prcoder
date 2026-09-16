import { TASK, fences, hideComments, summary } from './tasks.js';

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
 * A line over the panes: the app's one notification surface.
 *
 * `sticky` is for a notice that stays true until you act on it, rather than one
 * that reports something already finished -- it waits to be clicked instead of
 * timing out. Every toast is click-to-dismiss; only a sticky one says so, with
 * the ✕ its CSS adds.
 */
let toastTimer;
export function toast(msg, bad = false, sticky = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `${bad ? 'bad' : ''} ${sticky ? 'sticky' : ''}`.trim();
  el.hidden = false;
  // One slot, so a later toast replaces whatever is up -- including a sticky
  // one, which is the other way it goes away.
  el.onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : 4000);
}

/**
 * A checkbox that writes through to GitHub. The browser has already flipped it
 * by the time we hear about it, so a failure puts it back rather than
 * repainting -- the poll would take up to a minute to disagree. `settle` runs
 * either way, against whatever the box ended up saying.
 */
export function writeThrough(box, run, settle = () => {}) {
  // Assigned, not added: the diff pane's box is static markup and openDiff
  // rewires it on every file, where a listener per open would stack up.
  box.onchange = async () => {
    box.disabled = true;
    try { await run(box.checked); } catch { box.checked = !box.checked; }
    box.disabled = false;
    settle(box.checked);
  };
}

/** The light itself, for the two pane headers that survive a poll. */
function paintLight(id, state) {
  const light = document.getElementById(id);
  light.hidden = !state;
  if (!state) return;
  light.className = state.className;
  light.textContent = state.text;
}

const GROUPS = [
  ['tests', 'Tests'],
  ['code', 'Code'],
  ['docs', 'Config & docs'],
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
export function renderHeader(status, prs, { onSwitch, onCommit }) {
  const sel = document.getElementById('pr-switch');
  const commit = document.getElementById('pr-commit');

  // Rebuilt only when the set of PRs changes, so the open list survives a poll.
  // gh pr list is open PRs only, so a merged or closed one has no option of its
  // own — without this the select falls to selectedIndex -1 and renders blank
  // while the pane below it is showing that very PR.
  const shown = status.pr && !prs.some((p) => p.number === status.pr.number)
    ? [{ number: status.pr.number, title: status.pr.title, isDraft: false }, ...prs]
    : prs;

  const keys = shown.map((p) => p.number).join(',');
  if (sel.dataset.keys !== keys) {
    sel.dataset.keys = keys;
    sel.replaceChildren(
      h('option', { value: '' }, shown.length ? 'no pull request' : 'no open pull requests'),
      ...shown.map((p) => h('option', { value: String(p.number) },
        `#${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title}`)),
    );
    sel.onchange = () => sel.value && onSwitch(Number(sel.value));
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

  paintLight('pr-sync', headerSync(status));
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
 * Pure: the status -> the queue pane's light. Named states rather than a
 * boolean, because "nothing to mirror" and "GitHub has it" are both fine and
 * only one of them is worth a dot.
 *
 * `mirrorFailed` is the state this exists for. The store took the change and
 * GitHub did not, so prcoder has stopped trusting the description it can see --
 * and until now the only sign of that was a line on the server's stderr.
 */
export function queueSync(status) {
  if (status.error) return { className: 'light unknown', text: 'unavailable' };
  if (status.mirrorFailed) return { className: 'light bad', text: 'not saved to the PR' };
  if (!status.queue?.some((i) => i.inPr && !i.deleted)) return null;
  if (status.scope !== 'current') return { className: 'light unknown', text: 'not mirroring' };
  return { className: 'light ok', text: 'in the PR' };
}

/** The queue pane's header, like the PR pane's, survives polls. */
export const renderQueueSync = (status) => paintLight('queue-sync', queueSync(status));

/** The pane with no PR to show: why, and the one thing worth doing about it. */
export function renderNoPr(status, { onCreate }) {
  const host = document.getElementById('pr-body');
  // The head is a whole pull request's worth of identity -- title, badges,
  // tabs -- and nothing else clears it, so without this the last PR's heading
  // sits above "No pull request for main yet."
  document.getElementById('pr-head').replaceChildren();
  tab = 'detail';
  shownFor = null;
  const onDefault = status.branch === status.defaultBranch;

  const why = status.detached ? 'HEAD is detached — no branch to open a pull request for.'
    : onDefault ? `You are on ${status.branch}. Make a branch to start a pull request.`
    : `No pull request for ${status.branch} yet.`;

  // Comparing a branch with itself opens an empty diff, so on main there is
  // nothing to offer — the fix is a branch, not a button.
  const can = !status.detached && !onDefault;
  const create = h('button', { className: 'pr-create', disabled: !can }, 'Create a pull request');
  if (can) create.onclick = () => onCreate(create);

  // The same way out of the window the head carries, which is the one thing
  // this pane can still offer: there is no pull request, but the repository and
  // its lists are where you would go to find out why. Left-aligned, unlike the
  // head's: that one is a line in a block of pull request facts and has to be
  // told apart from them, where this sits alone between a sentence and a button.
  const out = noPrLinks(status);

  host.replaceChildren(...kids([
    h('p', { className: 'empty' }, why),
    out.length ? linkRow(out, 'meta') : null,
    status.sync === 'unpushed' && can
      ? h('p', { className: 'pr-note' }, 'This branch is not on GitHub yet; it will be pushed first.')
      : null,
    create,
  ]));
}

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
const scrolled = { detail: 0, files: 0, checks: 0 };
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
  repo: pr.url.replace(/\/pull\/\d+$/, ''),
  ref: pr.isCrossRepository ? pr.baseRefName : pr.headRefName,
});

/** `owner/repo`, from a repository URL on any host. */
const repoName = (repoUrl) => repoUrl.replace(/^https?:\/\/[^/]+\//, '');

/**
 * The head's way out of the pane: this pull request on GitHub, then the repo it
 * is in and the three lists people leave for -- issues, pull requests,
 * milestones.
 *
 * Built from the PR's own URL rather than from the `nameWithOwner` the status
 * carries, which says nothing about the host. That keeps these links right for
 * a GitHub Enterprise host, and points a fork's pull request at the repository
 * it was opened *against*, which is where its issues are. The rest of prcoder
 * does not run against an Enterprise host yet -- `parsePrUrl`, the `gh api`
 * calls and two hard-coded github.com URLs all assume it (#53) -- so this is
 * the part not to undo, not proof that the whole works.
 *
 * The arrow is on the first link only. That is the one that means "what you are
 * looking at, on GitHub"; the rest read as a menu, and five arrows in a row
 * read as decoration.
 */
export const headLinks = (pr) => {
  const { repo } = linkBase(pr);
  return [{ text: `PR #${pr.number} ↗`, href: pr.url }, ...repoLinks(repo)];
};

/** The repository and the three lists: the tail of the head's row, and the
 *  whole of the one in the pane with no pull request to head. */
const repoLinks = (repo) => [
  { text: repoName(repo), href: repo },
  ...['issues', 'pulls', 'milestones'].map((p) => ({ text: p, href: `${repo}/${p}` })),
];

/**
 * The same way out, for the pane that has no pull request to build it from.
 *
 * The host is hard-coded here where the head's is not, because there is no PR
 * URL to read one off -- `nameWithOwner` is all `gh repo view` was asked for.
 * That makes this the third of the github.com assumptions #53 is about, not a
 * new kind of one; the head's is still the part not to undo.
 *
 * The arrow lands on the repository for the same reason it lands on the PR
 * above: it is the "what you are looking at, on GitHub" link, and here that is
 * the repository itself.
 */
export const noPrLinks = ({ nameWithOwner }) => {
  if (!nameWithOwner) return [];
  const [self, ...rest] = repoLinks(`https://github.com/${nameWithOwner}`);
  return [{ ...self, text: `${self.text} ↗` }, ...rest];
};

/**
 * One row of links, dot-separated.
 *
 * The dots are their own elements rather than an `a::before`, which is what
 * they were: a pseudo-element lives inside the link's box, so the separator was
 * underlined with it and a click on the gap followed the link to its right.
 * `pointer-events: none` does not help -- the point is still over the <a>
 * itself once the pseudo-element declines it.
 */
const linkRow = (list, className) => h('div', { className },
  ...list.map((l, i) => [
    i ? h('span', { className: 'sep' }, '·') : null,
    ext(l.href, l.text),
  ]));

/**
 * The pull request pane, in two roots.
 *
 * #pr-head is the identity -- which pull request, on what branch, passing or
 * not -- and does not scroll. #pr-body is one of two views of it: the argument
 * (Detail) or the work (Files). They are tabs rather than one column because
 * they are two different things to be doing, they each want the whole pane, and
 * an agent-written description is long enough to bury a file list entirely.
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
    openSections.clear();
    autoOpen = true;
  }
  // A poll can take the tab out from under the reader: checks that have been
  // deleted from the workflow, or a force-push that has not queued any yet,
  // leave nothing for the Checks tab to show and no tab to leave it by.
  if (tab === 'checks' && !pr.checks.list.length) tab = 'detail';
  renderPrHead(pr, handlers);
  renderPrTab(pr, handlers);
}

function renderPrHead(pr, handlers) {
  const switchTo = (name) => {
    tab = name;
    renderPrHead(pr, handlers);
    renderPrTab(pr, handlers);
  };
  const tabBtn = (name, label, extra = '') =>
    btn(label, () => switchTo(name), { className: `tab${extra}${tab === name ? ' on' : ''}` });

  document.getElementById('pr-head').replaceChildren(...kids([
    h('h2', { className: 'pr-title' }, pr.title),
    pr.note ? h('p', { className: 'pr-note' }, pr.note) : null,
    h('div', { className: 'meta' },
      badge(pr.isDraft ? 'draft' : pr.state.toLowerCase(), pr.isDraft ? 'draft' : pr.state.toLowerCase()),
      h('span', {}, `${pr.headRefName} → ${pr.baseRefName}`),
      h('span', { className: 'add' }, `+${pr.additions}`),
      h('span', { className: 'del' }, `−${pr.deletions}`),
    ),
    linkRow(headLinks(pr), 'meta pr-links'),
    h('div', { className: 'tabs' },
      tabBtn('detail', tabLabel('Detail', taskCount(pr.body))),
      tabBtn('files', tabLabel('Files', viewedCount(pr.files))),
      pr.checks.list.length
        ? tabBtn('checks', tabLabel('Checks', checkCount(pr.checks)), ` dot ${worst(pr.checks)}`)
        : null),
  ]));
}

/**
 * The count each tab carries is what it can tell you while you are on the other
 * one: how many description checkboxes are still open, how many files are still
 * unviewed. Three states, because a fraction that has run out says the wrong
 * thing -- `Detail (10/10)` reads as a proportion you would want to be larger,
 * when what it means is that there is nothing left to do.
 *
 *   Detail          nothing to count
 *   Detail (3/10)   seven outstanding, done over total as the file groups read
 *   Detail ✓        there were things, and they are all done
 */
export const tabLabel = (name, { done, total }) => {
  if (!total) return name;
  return done === total ? `${name} ✓` : `${name} (${done}/${total})`;
};

export const taskCount = (body) => {
  const tasks = blocks(body).filter((b) => b.kind === 'task');
  return { done: tasks.filter((b) => b.done).length, total: tasks.length };
};

export const viewedCount = (files = []) =>
  ({ done: files.filter((f) => f.viewed).length, total: files.length });

/**
 * The checks as the same done-over-total the other two tabs carry, so a run in
 * progress reads as `Checks (1/3)` and a green one as `Checks ✓`.
 *
 * A failure is not "done": it is counted in the total and not in the done, so
 * the fraction stays short of the total for as long as something is red. The
 * colour beside it is what tells those two apart -- a pending 1/3 and a failed
 * 1/3 are the same fraction.
 */
export const checkCount = ({ passed, failed, pending }) =>
  ({ done: passed, total: passed + failed + pending });

/**
 * The one state a row of checks is worth reporting as. Red beats yellow beats
 * green: a single failure is the thing to know about, whatever else passed.
 */
export const worst = ({ failed, pending }) => (failed ? 'fail' : pending ? 'pend' : 'pass');

function renderPrTab(pr, handlers) {
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

  host.replaceChildren(...kids(tab === 'checks' ? [
    ...pr.checks.list.map((c) => h('div', { className: 'check' },
      h('span', { className: `dot ${c.state}` }),
      // A check GitHub gave no URL for is rare and not worth a dead link, so it
      // stays plain text rather than becoming an <a> to nowhere.
      c.url ? ext(c.url, c.name) : h('span', {}, c.name))),
  ] : tab === 'files' ? [
    ...GROUPS.map(([key, label]) => fileGroup(label, pr.groups[key], handlers)),
    h('div', { className: 'meta' },
      ext(`${pr.url}#issuecomment`, `${pr.counts.comments} comments · ${pr.counts.reviews} reviews ↗`)),
  ] : [
    issueRow(pr.issues, true, 'Closes:'),
    h('div', { className: 'body md' }, ...description(pr.body, handlers.onTask)),
    issueRow(pr.issues, false, 'Mentions:'),
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
 * One row of issue chips. The row label says which kind, so the chips stay bare
 * numbers.
 *
 * The two kinds mean different things and are placed differently because of it.
 * `Closes:` is a handful of issues this pull request answers, and it belongs
 * above the description as part of what the pull request *is*. `Mentions:` is
 * every bare `#N` linkedIssues() could find in the body, which on a description
 * that discusses its own backlog is dozens -- six rows of chips between the
 * title and the first sentence, which is the burial this pane is being fixed
 * for. It goes underneath.
 */
function issueRow(list, closes, label) {
  const kind = list.filter((i) => i.closes === closes);
  if (!kind.length) return null;
  return h('div', { className: 'issues' },
    h('span', { className: 'issues-label' }, label),
    ...kind.map((i) => ext(i.url, `#${i.number}`, { title: i.title ?? '' })));
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
  const { done, total } = viewedCount(files);
  return fold({
    className: 'group', dataset: { group: label }, title: label, count: `${done}/${total}`,
    open: !closedGroups.has(label),
    onToggle: (open) => { if (open) closedGroups.delete(label); else closedGroups.add(label); },
  }, [...byDir(files)].map(([dir, list]) => dirGroup(label, dir, list, handlers)));
}

/**
 * The files of one group, split by the directory they are in.
 *
 * A Map because the order is the answer: `gh` returns the files sorted by path,
 * so one pass leaves the directories in that order and the files inside them in
 * it too. Files at the top of the repository have no directory to be named
 * after, and `(root)` is the one label that cannot collide with a real one --
 * a directory's key here always ends in `/`.
 */
const byDir = (files) => {
  const dirs = new Map();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut === -1 ? '(root)' : f.path.slice(0, cut + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  return dirs;
};

/**
 * One directory inside a group, folded like the group itself.
 *
 * The fold state is keyed by group *and* directory: `public/` under Code and
 * `public/` under Tests are two different folds, and a single key would close
 * both. Both keys live in the one `closedGroups` set -- a group's label never
 * ends in `/`, so the two kinds cannot collide.
 */
function dirGroup(group, dir, files, handlers) {
  const key = `${group}/${dir}`;
  const { done, total } = viewedCount(files);
  return fold({
    className: 'dir', dataset: { dir }, title: dir, count: `${done}/${total}`,
    open: !closedGroups.has(key),
    onToggle: (open) => { if (open) closedGroups.delete(key); else closedGroups.add(key); },
  }, files.map((f) => fileRow(f, handlers, dir)));
}

/**
 * A <details> fold with a heading and an optional count, the shape both the file
 * groups and the description's sections take. `onToggle` fires for a click and
 * for the initial `open`, so it has to be idempotent.
 */
function fold({ className, dataset, title, count, open, onToggle }, children) {
  const d = h('details', { className: `fold ${className}`, open, dataset },
    h('summary', {}, h('h3', {}, title), count ? h('span', { className: 'count' }, count) : null),
    h('div', { className: 'sec-body' }, ...children));
  d.addEventListener('toggle', () => onToggle(d.open));
  return d;
}

function fileRow(f, { onViewed, onOpen, selected }, dir = '(root)') {
  const box = h('input', { type: 'checkbox', checked: f.viewed, title: 'mark viewed on GitHub' });
  writeThrough(box, (v) => onViewed(f.path, v), (v) => row.classList.toggle('viewed', v));
  // The path goes inside a <bdi>. Its container is `direction: rtl` so that a
  // long path is cut at the *head* and the filename survives -- but that also
  // makes a leading `.` a neutral character at the start of an RTL run, which
  // the bidi algorithm moves to the visual end: `.gitignore` rendered as
  // `gitignore.` and `.github/workflows/test.yml` as `github/...test.yml.`.
  // A bdi isolates the path and resolves it by its own first strong character,
  // which for any real path is a Latin letter, so it lays out left to right
  // inside a box that still overflows from the left. Checked in both engines
  // on 2026-09-09; `unicode-bidi: plaintext` on the link fixes the order too,
  // but moves the cut to the tail, which is the thing the rtl was for.
  // The name the fold above it does not already say. `title` stays the whole
  // path: the row is what you point at when you want to know where a file is,
  // and the directory heading may have scrolled off the top of a long group.
  const shown = dir === '(root)' ? f.path : f.path.slice(dir.length);
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
      h('span', { className: 'add' }, `+${f.additions}`), ' ',
      h('span', { className: 'del' }, `−${f.deletions}`)),
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
 * what happens when they do not, and test/queue.test.js pins it).
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
 * top level -- prcoder's own mirrored block writes `## TODO`, and a description
 * someone typed may well start at `#`. Anything deeper stays a plain heading
 * inside the section it belongs to.
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
  const tasks = s.nodes.filter((b) => b.kind === 'task');
  return fold({
    className: 'md-section', dataset: { key: s.key }, title: s.title,
    // So a fold never hides work without saying so.
    count: tasks.length ? `${tasks.filter((b) => b.done).length}/${tasks.length}` : null,
    open: openSections.has(s.key),
    onToggle: (open) => { if (open) openSections.add(s.key); else openSections.delete(s.key); },
  }, s.nodes.map((b) => blockNode(b, onTask)));
}

/**
 * The description: the lead as it is, everything after the first heading folded.
 *
 * Collapsed by default, and the open set is deliberately not persisted -- a
 * description you finished reading yesterday reopening itself today is how the
 * pane becomes what this was written to fix.
 */
function description(body, onTask) {
  const { lead, sections } = sectionize(blocks(body));
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

/**
 * The three pieces of raw HTML a PR description actually contains, dealt with
 * before anything is escaped. Everything else stays escaped and shows as text:
 * this is an allowlist of three, not the beginning of an HTML renderer.
 *
 * Comments go because GitHub hides them and prcoder's own block markers are
 * comments -- without this the pane shows a literal marker above the list it
 * delimits.
 *
 * `<details>` is unwrapped rather than reproduced. It used to be because the
 * pane merely scrolled and a collapsed half was usually history; now it is the
 * better reason: the pane folds its own sections, so an author's fold and
 * prcoder's are the same idea twice. Unwrapping it and promoting its summary to
 * a heading feeds it into that machinery instead of nesting inside it.
 *
 * One consequence, live in this repo: a <details> in a description shows up in
 * the pane as its summary promoted to a level-4 heading, which is deeper than
 * the level sections fold at -- so it renders *inside* whichever fold precedes
 * it rather than as one of its own. That is the intended trade (the alternative
 * is two kinds of fold competing), but it is why a collapsed block in this
 * repo's own pull request description reads differently here and on github.com.
 *
 * Every substitution here must leave the body's *lines* where they are.
 * blocks() runs on the output and taskLines() runs on the raw body, and the two
 * counts of checklist lines have to match -- so anything added here that could
 * delete or merge a line containing a `- [ ]` breaks the tick, silently.
 */
export const withoutHtml = (text) => hideComments(text ?? '')
  .replace(/<\/?details[^>]*>/g, '')
  // The heading is one line, and the summary's other lines stay behind it empty.
  .replace(summary(), (s, t) =>
    `#### ${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}${'\n'.repeat(s.split('\n').length - 1)}`);

/** A checkbox in the description, ticked through to GitHub. */
function taskRow({ done, text, index }, onTask) {
  const box = h('input', { type: 'checkbox', checked: done, title: 'tick this on GitHub' });
  const row = h('label', { className: `task${done ? ' done' : ''}` },
    box, h('span', { innerHTML: inline(text) }));
  writeThrough(box, (v) => onTask({ index, done: v, text }),
    (v) => row.classList.toggle('done', v));
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
    // start a word. Same match as linkedIssues() in github.js, which is what
    // puts the same numbers in the Mentions row.
    .replace(/(^|[\s(])#(\d+)\b/g, (m, pre, n) =>
      (where ? `${pre}${a(`${where.repo}/issues/${n}`, `#${n}`)}` : m))
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
  return where ? `${where.repo}/blob/${where.ref}/${href.replace(/^\.?\//, '')}` : null;
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
