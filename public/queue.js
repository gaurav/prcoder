import { h, btn, ext, api, toast, pref, setPref, tabBtn, writeThrough, fold, kept } from './ui.js';
import { TABS, refLabel, forClaude, rankMilestones, issueMatches } from './items.js';
import { refs, resolveRef, blocks } from './tasks.js';
import { blockNode } from './pr.js';

// The client owns the list; every change persists the whole array. Single user,
// single repo — no ids, no diffing.
let items = [];
// The list as the server last had it. Every caller changes `items` in place and
// then saves, so a failed save has to put this back: left alone, the change
// stayed on screen as if saved, and the next save that did succeed sent the
// whole array -- persisting the change the toast had just said was not.
let confirmed = [];
const settle = (list) => { items = list; confirmed = structuredClone(list); };
let tab = 'local';
let deps = {};
// Saves the server has not answered yet. A status that arrives meanwhile was
// read before the write -- the server runs them in order behind one lock -- so
// its list is the one the change was made to, and painting it would take the
// change back until the save's own answer put it back again.
let saving = 0;

/**
 * Replace the list, and the PR its source tabs read, from the server. Skipped
 * while a save is in flight (above); while an item is being edited, because the
 * text is contentEditable and only saves on blur, so a poll landing mid-typing
 * would throw the edit away; and while a row is being dragged, because the
 * repaint replaces the row under the pointer, the drop lands on nothing, and
 * the reorder silently does not happen.
 *
 * Only those put the list at risk, so only they hold it back. Anything else in
 * the pane can keep focus indefinitely -- a clicked tab does, in Chromium -- and
 * freezing on it leaves the queue stale with nothing to unstick it.
 */
export function setItems(next, prOnScreen = null) {
  // The Issues tab's search box is the other place a repaint lands under a
  // caret: its text is kept and put back, but the caret and a composition
  // mid-word are not. Safe to hold on by the same argument as the text above
  // -- focus leaves it with the next click anywhere else -- where a tab is not.
  if (saving || document.activeElement?.closest?.('#queue-body .text[contenteditable], #queue-search')) return;
  if (document.querySelector('#queue-body .item.dragging')) return;
  // What the PR and Issues tabs draw from: a tick on github.com changes the
  // PR tab without changing the list, so it has to count as news too.
  const source = (p) => (p ? JSON.stringify([p.number, p.body, p.issues]) : '');
  const samePr = source(prOnScreen) === source(pr);
  pr = prOnScreen;
  // Most polls bring the list already on screen, and a rebuild for nothing
  // costs every row and listener. `items` is kept, not swapped for the equal
  // copy: the rows on screen hold its objects, and a tick on a row whose item
  // was no longer in `items` saved the list without the tick.
  if (samePr && JSON.stringify(next) === JSON.stringify(items)) {
    confirmed = structuredClone(next);
    return;
  }
  settle(next);
  render();
}

// The sources, read straight from where they live rather than kept in the
// queue: the PR on screen, from the poll, whose description's checkboxes are
// the PR tab; and the repository's open issues, fetched when the Issues tab is
// opened, since nothing else needs them. `listing` is /api/issues' answer --
// milestones, issues, and the mentions the description makes without closing,
// which `mentions` indexes by number as it always did; `listed` indexes the
// listing's issues the same way.
let pr = null;
let listing = null;
let mentions = null;
let listed = new Map();
// The Issues tab's own state, kept across the repaint every poll causes and
// not across a reload, like the file groups' folds: the search, which groups
// are closed, which rows are open, and which groups a listing has had, so a
// new one can be given its starting state (seedGroups).
let query = '';
const closedGroups = new Set();
const expanded = new Set();
const seen = new Set();

// Which end the input adds to. The queue is two things at once -- a backlog in
// the order you mean to work through it, and somewhere to put the thing you
// must not forget to do next -- so the end is the user's to choose, and the
// arrow on the button says which one is live without being clicked.
//
// Stored like the pane sizes, the terminal fold and the diff's outline and
// Wrap, and best-effort like all of them: reading storage throws outright
// where it is disabled, and the origin is a port -- so a repo whose port
// moves, or one opened through PRCODER_PORT, is a different origin and starts
// again from the default. Losing it costs a click.
const ADD_TO_KEY = 'prcoder:add-to';
let addTo = 'bottom';
const readAddTo = () => (pref(ADD_TO_KEY) === 'top' ? 'top' : 'bottom');

export async function initQueue(d) {
  deps = d;
  // Read here rather than at module scope: initQueue only ever runs in a
  // browser, so the module stays importable by a node test that has no
  // localStorage to touch.
  addTo = readAddTo();
  document.getElementById('queue-where').onclick = () => {
    addTo = addTo === 'bottom' ? 'top' : 'bottom';
    setPref(ADD_TO_KEY, addTo);
    paintWhere();
  };
  // Before the fetch, so a remembered ↑ is not shown as the markup's ↓ for as
  // long as /api/queue takes to answer.
  paintWhere();
  // api(), not a bare fetch: a 500 answers `{error}` with a 200-shaped body, and
  // assigning that object to `items` made the very next render() throw on
  // items.filter -- a server-side error taking the whole pane down rather than
  // showing itself.
  try {
    settle(await api('/api/queue', undefined, 'GET'));
  } catch (e) {
    toast(e.message, true);
  }
  render();
}

/**
 * Whether the change reached the server. When it did not, the list goes back to
 * what the server last confirmed, and the toast says why.
 */
const save = async (url = '/api/queue', method = 'PUT', body = { items }) => {
  const undo = (message) => {
    toast(message, true);
    items = structuredClone(confirmed);
    render();
    return false;
  };
  let data;
  saving++;
  try { data = await api(url, body, method); } catch (e) { return undo(e.message); } finally { saving--; }
  settle(Array.isArray(data) ? data : items);
  render();
  return true;
};

const LABELS = { local: 'Local', pr: 'PR', issues: 'Issues', done: 'Completed', deleted: 'Deleted' };

// Local is always there because an *empty* Local is the thing worth seeing --
// it is how a tidy session ends. Completed is always there because it is where
// the delete-all lives. Deleted hides when it holds nothing.
const ALWAYS = ['local', 'done'];

/**
 * Which tabs the strip draws, and which of them is active: your own list's tabs,
 * with the `sources` that are available -- PR and Issues, when there is a PR on
 * screen -- between Local and the rest. Pure, and exported only so it can
 * be checked without a DOM -- render() is the sole caller and decides neither
 * for itself.
 *
 * The tab you were on can empty and vanish from the strip -- restoring the last
 * tombstone does it -- leaving nothing highlighted and a list with no tab to
 * click back to. Local is never left this way: it is in ALWAYS.
 *
 * tools/browser.mjs leans on the hiding rule from the other side: it seeds a
 * deleted item precisely because a tab with nothing in it is not there to be
 * clicked, and a driver that clicks one that is missing hangs for 30s rather
 * than failing.
 */
export function stripFor(list, active, sources = []) {
  const own = Object.keys(TABS).filter((n) => n !== 'local' && (ALWAYS.includes(n) || list.some(TABS[n])));
  const strip = ['local', ...sources, ...own];
  return { strip, tab: strip.includes(active) ? active : 'local' };
}

/** The PR description's checklist, in the order a tick counts it. */
const prTasks = () => (pr ? blocks(pr.body).filter((b) => b.kind === 'task') : []);

/**
 * The issues the description mentions and does not close. The ones it closes
 * are what the PR already answers; a bare `#N` elsewhere is work it points at.
 * The Issues tab's first group, ahead of the repository's own.
 */
const mentioned = () => (pr?.issues ?? []).filter((i) => !i.closes);

/** The Issues tab's count: the repository's open issues, the matches while searching, `…` before the first listing. */
const issueCount = () => (!listing ? '…' : query.trim() ? matching().length : listing.total);

/** The listed issues the search lets through. */
const matching = () => (listing?.issues ?? []).filter((i) => issueMatches(i, query));

function render() {
  const host = document.getElementById('queue-body');
  // Issues is always there -- a repository has issues whatever is checked out
  // -- and PR only with a pull request on screen.
  const { strip, tab: active } = stripFor(items, tab, pr ? ['pr', 'issues'] : ['issues']);
  tab = active;
  // A source's count is what it still holds open; the list's own are its tabs.
  const count = (name) => (name === 'pr' ? prTasks().filter((t) => !t.done).length
    : name === 'issues' ? issueCount()
      : items.filter(TABS[name]).length);
  const label = (n) => `${LABELS[n]} (${count(n)})`;
  const shown = TABS[tab] ? items.filter(TABS[tab]) : [];
  // Most recent first on Completed and Deleted, so the item you just ticked or
  // deleted by mistake is on top to be taken back. The store stamps the times;
  // one it has not stamped yet (from before the field existed) goes last, and
  // the sort is stable, so ties keep the queue's own order.
  const at = { done: 'doneAt', deleted: 'deletedAt' }[tab];
  if (at) shown.sort((a, b) => (b[at] ?? -Infinity) - (a[at] ?? -Infinity));

  host.replaceChildren(
    h('div', { className: 'tabs' },
      ...strip.map((n) => queueTab(n, label(n))),
      h('span', { className: 'spacer' }),
      ...bulks(),
    ),
    tab === 'pr' ? prList()
      : tab === 'issues' ? issueList()
        : h('ul', { className: 'items' }, ...shown.map((i, n) => row(i, shown[n - 1], shown[n + 1]))),
  );
}

/**
 * The bulk actions, which belong to one tab each: you act on the list in front
 * of you. Both destructive ones confirm and say what they are about to take,
 * because a bulk delete has no single row to have thought twice about.
 */
function bulks() {
  const of = (name) => items.filter(TABS[name]);
  const many = (n) => `${n} item${n === 1 ? '' : 's'}`;

  if (tab === 'done') {
    return [bulk('delete all', () => {
      const done = of('done');
      // A tombstone, like the row's own ✕: these land in Deleted, and the
      // confirm says so rather than implying they are gone.
      if (!done.length || !confirm(`Delete ${many(done.length)} from Completed?\n\nThey move to the Deleted tab, where they can be restored.`)) return;
      done.forEach((i) => { i.deleted = true; });
      save();
    })];
  }
  if (tab === 'deleted') {
    // The only hard delete in the app, and it is behind the tab that shows you
    // what you are about to lose.
    return [bulk('delete forever', () => {
      const gone = of('deleted');
      if (!gone.length || !confirm(`Permanently delete ${many(gone.length)}?\n\nThis cannot be undone.`)) return;
      items = items.filter((i) => !i.deleted);
      save();
    })];
  }
  return [];
}

// The button is static markup in the pane header, which render()'s
// replaceChildren never reaches, so only the two things that change addTo have
// to repaint it. The title says both where items go now and what a click does;
// the accent is there because ↑ is the choice you made, not the default.
function paintWhere() {
  const b = document.getElementById('queue-where');
  const title = addTo === 'bottom'
    ? 'new items go to the bottom — click to add to the top'
    : 'new items go to the top — click to add to the bottom';
  b.textContent = addTo === 'bottom' ? '↓' : '↑';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.classList.toggle('top', addTo === 'top');
}

/**
 * Drop `from` where `to` currently sits, in place.
 *
 * The correction is the whole of it: the row is removed first, which shifts
 * every index above it down by one, so an unadjusted `to` puts a downward drag
 * *past* the row it was dropped on while an upward one lands before it -- the
 * same gesture meaning two different things depending on direction. Out here
 * rather than inline in the drop handler because it is the one part of a drag
 * that can be checked without a browser.
 */
export function reorder(list, from, to) {
  const [moved] = list.splice(from, 1);
  list.splice(from < to ? to - 1 : to, 0, moved);
  return list;
}

const queueTab = (name, label) => tabBtn(label, tab === name, () => {
  tab = name;
  render();
  if (name === 'issues') loadIssues();
}, '', { dataset: { tab: name } });

/**
 * A new item always lands on Local, so when you are looking at another tab the
 * Local tab flashes to say where it went -- rather than taking you there, which
 * is what adding used to do, and which threw away whatever you were reading.
 * After the save, because save() repaints the strip and a class set before it
 * would be on a button that no longer exists.
 */
function flashLocal() {
  if (tab !== 'local') document.querySelector('#queue-body .tab[data-tab="local"]')?.classList.add('flash');
}

/**
 * The repository's issues and milestones, and the mentions' titles and states,
 * refetched on every visit to the tab: issues change on GitHub, not here. The
 * listing on screen stays until the new one lands, and stays if it does not.
 * It lands in the groups alone when the tab is drawn: the search box is up
 * before the listing is, and a render() would take it out from under a
 * query being typed.
 */
async function loadIssues() {
  try {
    const got = await api('/api/issues', undefined, 'GET');
    listing = got;
    mentions = new Map(got.mentions.map((i) => [i.number, i]));
    listed = new Map(got.issues.map((i) => [i.number, i]));
    seedGroups();
  } catch (e) {
    toast(e.message, true);
  }
  if (tab !== 'issues') return;
  if (document.getElementById('queue-search')) paintIssues(); else render();
}

/**
 * Copied into your queue, and left where it was: a checkbox in the description
 * is the PR's record and an issue is the project's, so pulling an item is taking
 * it on, not taking it away. Something already on Local is not added twice.
 */
async function pull(text, issue = null, kind = null, repo = null) {
  if (items.some((i) => TABS.local(i) && i.text === text)) {
    toast('already in your queue');
    return;
  }
  const item = { text, done: false, issue, repo, kind, deleted: false };
  if (addTo === 'top') items.unshift(item); else items.push(item);
  // A refusal has already taken it back out.
  if (!await save()) return;
  toast(`added to your queue: ${text}`);
  flashLocal();
}

/** The PR tab: the description's own checkboxes, ticked through to GitHub. */
function prList() {
  const tasks = prTasks();
  if (!tasks.length) return h('p', { className: 'empty' }, `No checkboxes in PR #${pr.number}'s description.`);
  return h('ul', { className: 'items' }, ...tasks.map((t) => {
    const box = h('input', { type: 'checkbox', checked: t.done, title: 'tick this on GitHub' });
    writeThrough(box, (v) => deps.onTask({ index: t.index, done: v, text: t.text }));
    return h('li', { className: 'item source' },
      box,
      h('span', { className: 'text', textContent: t.text }),
      h('span', { className: 'actions' },
        btn('↓', () => pull(t.text), { title: 'copy into your queue' })));
  }));
}

/**
 * Mentions, most recently updated on GitHub first, so the issue with news on it
 * is on top. `found` is the lookup, number -> { updatedAt, ... }, or null until
 * it answers. A mention with no time -- before then, or a number GitHub did not
 * find -- goes last, and the sort is stable, so those keep the order they came
 * in (by number). The timestamps are ISO strings, which compare as they read.
 */
export function newestFirst(list, found) {
  const updated = (i) => found?.get(i.number)?.updatedAt ?? '';
  return [...list].sort((a, b) => updated(b).localeCompare(updated(a)));
}

/**
 * The Issues tab: a search over the repository's open issues, and the issues
 * in groups -- what the description mentions without closing first, then one
 * group per milestone in the owner's order (rankMilestones), then the issues
 * on none. Each row can open to show the issue's body and a way to it
 * on GitHub, be typed to the coding agent with its link (▶), or be copied
 * into Local (↓). The groups are repainted on their own as the search and the
 * rows change, so the search box keeps its focus.
 */
function issueList() {
  const search = h('input', {
    id: 'queue-search', type: 'search', placeholder: 'Search issues', value: query,
    autocomplete: 'off', spellcheck: false, ariaLabel: 'search the repository\'s open issues',
  });
  search.oninput = () => {
    query = search.value;
    paintIssues();
  };
  return h('div', { className: 'issues-pane' }, search, h('div', { className: 'issue-groups' }, ...issueGroups()));
}

const paintGroups = () => document.querySelector('#queue-body .issue-groups')?.replaceChildren(...issueGroups());

/** The groups and the tab's count, leaving the search box, its focus and its caret alone. */
function paintIssues() {
  paintGroups();
  const t = document.querySelector('#queue-body .tab[data-tab="issues"]');
  if (t) t.textContent = `${LABELS.issues} (${issueCount()})`;
}

/** The group an issue with no milestone is in. */
const NONE = 'none';

/**
 * What starts closed, as each listing lands. On the first, every group but
 * the mentions and the first milestone in rank with an issue on it, which is
 * the one to focus on -- chosen from every issue, not the ones a query typed
 * before the listing came lets through. On a later one, a milestone not had
 * before, such as one made on GitHub since, joins the rest folded. A group
 * opened or closed by hand is remembered over all of it.
 */
function seedGroups() {
  const keys = [...rankMilestones(listing.milestones).map((m) => m.number), NONE];
  const focus = seen.size ? null : keys.find((k) => listing.issues.some((i) => (i.milestone ?? NONE) === k));
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key !== focus) closedGroups.add(`m:${key}`);
  }
}

function issueGroups() {
  if (!listing) return [h('p', { className: 'empty' }, 'Reading the repository\'s issues…')];
  const searching = !!query.trim();
  const byMilestone = new Map();
  for (const i of matching()) {
    const key = i.milestone ?? NONE;
    if (!byMilestone.has(key)) byMilestone.set(key, []);
    byMilestone.get(key).push(i);
  }
  const ranked = rankMilestones(listing.milestones);
  // While searching a group with a match is open and one without is closed,
  // without touching what was chosen: fold() reports its initial state too.
  const state = (key, rows) => (searching ? { open: rows.length > 0, onToggle: () => {} } : kept(closedGroups, key, 'closed'));
  const home = deps.home?.();
  // `list` is the group's issues and `rows` what they draw, which is more
  // than one element per issue once a row is open: the count is the issues'.
  const group = (key, title, list, rows, extra = []) => fold({
    className: 'milestone', dataset: { group: key }, title: [title, ...extra.flatMap((e) => [' ', e]), ' ', h('span', { className: 'count' }, String(list.length))],
    ...state(key, list),
  }, list.length ? [h('ul', { className: 'items' }, ...rows)] : [h('p', { className: 'empty' }, 'no open issues')]);

  const out = [];
  // The mentions, searched by what is known of them: the looked-up title, and
  // the body when the mention is one of the listed issues.
  const ment = mentioned().filter((i) => issueMatches({
    number: i.number, title: mentions?.get(i.number)?.title, body: listedAs(i)?.body,
  }, query));
  if (pr && ment.length) {
    out.push(group('mentioned', `Mentioned by PR #${pr.number}`, ment, newestFirst(ment, mentions).map((i) => mentionRow(i)).flat()));
  }
  for (const m of ranked) {
    const title = home ? ext(`https://github.com/${home}/milestone/${m.number}`, m.title, { title: m.description || undefined }) : m.title;
    const extra = [
      ...(m.dueOn ? [h('span', { className: 'due', title: 'due' }, m.dueOn.slice(0, 10))] : []),
      // On the tab only because an open issue is still on it (repoIssues).
      ...(m.closed ? [h('span', { className: 'closed-milestone', title: 'closed on GitHub, with open issues still on it' }, 'closed')] : []),
    ];
    const list = byMilestone.get(m.number) ?? [];
    out.push(group(`m:${m.number}`, title, list, list.map((i) => issueRow(i)).flat(), extra));
  }
  const none = byMilestone.get(NONE) ?? [];
  out.push(group(`m:${NONE}`, 'No milestone', none, none.map((i) => issueRow(i)).flat()));
  if (listing.listed < listing.total) {
    out.push(h('p', { className: 'pr-note' }, `The ${listing.listed} most recently updated of ${listing.total} open issues.`));
  }
  return out;
}

/**
 * A mention as a row: a mention that is not an open issue is a closed one, or
 * a pull request -- a bare `#N` is either on GitHub -- and is dimmed rather
 * than disappearing, since the description still points at it. The tag says
 * which of the two it is (`PR #N`), so the title is followed only by the
 * state: `· merged`, `· closed`. One that is an open issue here is drawn as
 * the listing's own row, body and all.
 */
function mentionRow(i) {
  const found = mentions?.get(i.number);
  const repo = mentionRepo(i);
  const own = listedAs(i);
  if (own) return issueRow(own);
  const title = found?.title;
  const open = found?.kind === 'issue' && found.state === 'OPEN';
  const text = !mentions ? '…'
    : !title ? 'not found on GitHub'
      : open ? title : `${title} · ${found.state?.toLowerCase() ?? 'state unknown'}`;
  return [issueRow({ number: i.number, url: i.url, title: text, body: null }, {
    repo, kind: found?.kind ?? null, closed: !open && !!mentions, text: title ?? `#${i.number}`,
  })];
}

/**
 * The listed issue a mention is, if any. A mention is the pull request's
 * repository's, and the listing is the one prcoder is in (`listing.repo`):
 * in a fork-headed checkout the two differ, and by number alone a bare `#12`
 * in upstream's description would be drawn as the fork's #12. Read against the
 * listing's own name rather than `home`, which is not known until the first
 * poll has answered.
 */
function listedAs(i) {
  const [r] = refs(i.url ?? '');
  if (!listing?.repo || !r?.owner || resolveRef(r, listing.repo).repo) return null;
  return listed.get(i.number) ?? null;
}

/**
 * One issue as a row, and the body under it when the row is open. ▶ types the
 * title with the link, unsent, and ticks nothing -- there is no item to tick;
 * ↓ copies it into Local (pull). The body is the description renderer's,
 * written against this repository, with Open on GitHub under it: reading the
 * issue is the point, and the button is the way to the rest of it.
 */
function issueRow(i, { repo = null, kind = 'issue', closed = false, text = i.title } = {}) {
  const key = `${repo ?? ''}#${i.number}`;
  const open = expanded.has(key);
  const can = i.body != null;
  const disclose = can ? btn(open ? '▾' : '▸', () => {
    if (open) expanded.delete(key); else expanded.add(key);
    paintGroups();
  }, { className: 'disclose', title: open ? 'hide the issue' : 'show the issue', ariaExpanded: String(open) }) : h('span', { className: 'disclose' });
  const row = h('li', { className: `item source${closed ? ' closed' : ''}`, dataset: { issue: String(i.number) } },
    disclose,
    ext(i.url, refLabel({ issue: i.number, kind }), { className: tagClass(kind) }),
    h('span', { className: 'text', textContent: i.title }),
    ...(i.labels ?? []).map((l) => h('span', { className: 'tag label' }, l)),
    h('span', { className: 'actions' },
      btn('▶', () => {
        const item = { text, issue: i.number, repo, kind, issueUrl: i.url };
        if (!deps.sendToClaude(forClaude(item, deps.home?.()), false)) toast('The coding agent is not connected — nothing was typed.', true);
      }, { title: 'type into the coding agent, with the link' }),
      btn('↓', () => pull(text, i.number, kind, repo), { title: 'copy into your queue' })));
  if (!open) return [row];
  const home = deps.home?.();
  const where = home ? { repo: `https://github.com/${home}`, ref: 'HEAD' } : null;
  const body = h('li', { className: 'issue-body md' },
    ...(i.body ? blocks(i.body).map((b) => blockNode(b, null, where)) : [h('p', { className: 'empty' }, 'No description.')]),
    ext(i.url, 'Open on GitHub', { className: 'primary open-issue' }));
  return [row, body];
}

/**
 * A reference's chip: outlined for an issue, tinted for a pull request, whose
 * label also says `PR` (refLabel). An unknown kind is drawn as an issue, as
 * every tag was before the two were told apart.
 */
const tagClass = (kind) => (kind === 'pull' ? 'tag pull' : 'tag issue');

/**
 * The repo a mention is in, as an item's `repo`: null for this one. A bare #N
 * in a description is the PR's repo, which is not always the one prcoder is in
 * -- so it is read off the mention's link rather than assumed, or the item
 * would link to this repo's issue of the same number and hide ◎.
 */
function mentionRepo(i) {
  const [r] = refs(i.url ?? '');
  const home = deps.home?.();
  if (!r?.owner || !home) return null;
  return resolveRef(r, home).repo;
}

/**
 * What a row's drag carries. Its own type, not text/plain: a link or a text
 * selection dropped on a row carries text/plain too, and Number() of that is
 * NaN -- which splice() reads as 0, so the first item moved and was saved.
 */
const ROW = 'application/x-prcoder-row';

const bulk = (label, fn) => btn(label, fn, { className: 'bulk' });

function row(item, above, below) {
  const idx = items.indexOf(item);
  // Order is the backlog's meaning, and only Local is a backlog -- Completed is
  // sorted by when each item was finished, and Deleted is a filtered view where
  // a drop would splice the item to a position nobody on it can see.
  const ordered = tab === 'local';

  // The keyboard's way to reorder, which a drag has no equivalent of. Moves
  // past the next row *shown*, not the next in the array: the tab filters, so
  // the array neighbour may be a done or deleted item you cannot see move.
  const grip = h('span', { className: 'grip', title: 'drag, or focus and press ↑ ↓, to reorder', tabIndex: 0 }, '⠿');
  grip.setAttribute('role', 'button');
  grip.setAttribute('aria-label', `reorder “${item.text}”: up or down arrow moves it`);
  grip.onkeydown = async (e) => {
    const past = { ArrowUp: above, ArrowDown: below }[e.key];
    if (!past) return;
    e.preventDefault();
    const at = [...document.querySelectorAll('#queue-body .item .grip')].indexOf(grip);
    // reorder() drops in front of its target, so going down targets the row after.
    reorder(items, idx, items.indexOf(past) + (e.key === 'ArrowDown' ? 1 : 0));
    // save() repaints every row, so focus goes to the grip now in the new place.
    if (await save()) document.querySelectorAll('#queue-body .item .grip')[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };

  const box = h('input', { type: 'checkbox', checked: item.done });
  box.onchange = () => { item.done = box.checked; save(); };

  const text = h('span', { className: 'text', contentEditable: 'true', textContent: item.text });
  text.onblur = () => { if (text.textContent.trim() !== item.text) { item.text = text.textContent.trim(); save(); } };
  text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };

  const li = h('li', { className: 'item', draggable: ordered },
    ordered ? grip : null,
    box,
    text,
    item.issue ? ext(item.issueUrl ?? '#', refLabel(item), { className: tagClass(item.kind) }) : null,
    h('span', { className: 'actions' },
      // Typed, not sent: the turn is left in the prompt for you to edit, which
      // is the whole of what prcoder puts into a session (docs/Design.md).
      // Handing it over is what doing an item looks like here, so it ticks the
      // box the way finishing it would: the row leaves Local for Completed, and
      // the Local tab stays a list of what has not been handed over yet. Not a
      // delete -- Completed is where you go to see what you handed over, and its
      // own checkbox puts an item back if Claude turned out not to do it.
      //
      // Only if it went. `sendToClaude` answers false on a closed socket, and
      // an item ticked off after a refused send is work nobody has done and
      // nothing will remind you of.
      //
      // With the link to the issue or PR it is about, where the text does not
      // already say which (forClaude in items.js).
      btn('▶', () => {
        if (!deps.sendToClaude(forClaude(item, deps.home?.()), false)) return toast('Claude is not connected — nothing was typed.', true);
        item.done = true;
        return save();
      }, { title: 'type into Claude, and check it off' }),
      // A move, not a flag: the issue is filed and the item leaves the queue.
      // Nothing moves into the PR description -- prcoder does not write one,
      // bar a box you tick on the PR tab. Disabled while the issue is filed: a
      // second click filed a second issue for the same item.
      //
      // Not for an item about an issue or PR in this repo, which already has a
      // home here. One about another repo's files an issue in this one, with
      // the link to the other in its body (the to-issue route).
      item.issue && !item.repo ? null : btn('◎', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        if (!await save('/api/queue/to-issue', 'POST', { items, index: idx })) b.disabled = false;
      }, { title: 'move into a new issue' }),
      item.deleted
        ? btn('↩', () => { item.deleted = false; save(); }, { title: 'restore' })
        // A tombstone, not a splice: the Deleted tab is where it goes.
        : btn('✕', () => { item.deleted = true; save(); }, { title: 'delete' }),
    ),
  );

  // Firefox hands a mousedown inside a draggable element to its drag machinery
  // instead of to the caret, so a click in the middle of an item's text landed
  // at the start of it. Confirmed in Firefox and *not* in Chromium, which is
  // why it survived being looked at. Nothing else fixes it — draggable=false on
  // the span, and -moz-user-select, both leave the caret at 0 — so the row
  // gives up being draggable for exactly as long as the pointer is on its text,
  // and the grip above is the handle that always drags.
  li.addEventListener('pointerdown', (e) => { li.draggable = ordered && !text.contains(e.target); });
  li.addEventListener('dragstart', (e) => { e.dataTransfer.setData(ROW, idx); li.classList.add('dragging'); });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes(ROW)) return;
    const from = Number(e.dataTransfer.getData(ROW));
    if (from === idx) return;
    reorder(items, from, idx);
    save();
  });

  return li;
}

/**
 * True once the server has it, so the caller knows whether to clear the input.
 *
 * Text with an issue or PR reference in it -- `#91`, `cli/cli#123`, a link --
 * is asked about first (POST /api/queue/ref). The item is about the first
 * reference, which is the row's tag, and an input that is nothing but the
 * reference takes the issue's title as its text: `#91` is no reminder of what
 * #91 was. One GitHub does not know is refused with GitHub's reason, and the
 * input keeps the text to be fixed; so is one already on Local. When GitHub
 * could not be asked at all, the text is added as it is, untagged.
 */
export async function addItem(text) {
  if (!text.trim()) return false;
  const item = { text: text.trim(), done: false, issue: null, repo: null, kind: null, deleted: false };
  if (refs(text, deps.home?.()).length) {
    let ref, unchecked;
    try {
      ({ ref, unchecked } = await api('/api/queue/ref', { text }));
    } catch (e) {
      toast(e.message, true);
      return false;
    }
    if (unchecked) toast(`Added as plain text — GitHub could not be asked about it: ${unchecked}`, true);
    if (ref) {
      Object.assign(item, { issue: ref.issue, repo: ref.repo, kind: ref.kind });
      if (ref.whole) {
        if (items.some((i) => TABS.local(i) && i.issue === ref.issue && (i.repo ?? null) === ref.repo)) {
          toast(`${refLabel(item)} is already in your queue`);
          return false;
        }
        item.text = ref.title;
      }
    }
  }
  // The end of the whole array, past any done or deleted rows: Local filters
  // without reordering, so a new item still shows last there.
  if (addTo === 'top') items.unshift(item); else items.push(item);
  // A refusal has already taken it back out; the input keeps the text.
  if (!await save()) return false;
  if (tab !== 'local') {
    flashLocal();
    return true;
  }
  // Either end can be off-screen in a list taller than the pane, and an item
  // you cannot see reads as a save that did not happen. Not scrollIntoView:
  // save() has already repainted from the server's echo, so the object above no
  // longer exists as a row -- but the end it went to is known, and that is all
  // this needs. It stays out of save() itself, which every checkbox and drag
  // also calls; the viewport should not jump for those.
  const host = document.getElementById('queue-body');
  host.scrollTop = addTo === 'top' ? 0 : host.scrollHeight;
  return true;
}
