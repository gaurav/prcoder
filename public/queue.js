import { h, btn, ext, api, toast, pref, setPref, tabBtn, writeThrough, fold, kept, mark } from './ui.js';
import { TABS, refLabel, forClaude, rankMilestones, issueMatches, pullMatches, sortPulls, sizeChip, age, isNew, isStale, PULL_SORTS } from './items.js';
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
  if (saving || document.activeElement?.closest?.('#queue-body .text[contenteditable], #queue-search, #queue-pull-search')) return;
  if (document.querySelector('#queue-body .item.dragging')) return;
  // What the PR and Issues tabs draw from: a tick on github.com changes the
  // PR tab without changing the list, so it has to count as news too.
  const source = (p) => (p ? JSON.stringify([p.number, p.body, p.issues]) : '');
  const samePr = source(prOnScreen) === source(pr);
  // The mentions' titles and states come with the listing, looked up for the
  // pull request on screen when it was asked for. A different one, or a
  // description that mentions something new -- or the first poll's, after a
  // visit to the tab before it -- needs them asked for again, and until they
  // land a mention not looked up reads `…` (mentionRow).
  const asks = (p) => JSON.stringify([p?.url ?? null, mentioned(p).map((i) => i.number)]);
  if (tab === 'issues' && asks(prOnScreen) !== asks(pr)) loadIssues(true);
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
// The Pull requests tab's: its listing (/api/pulls' answer -- milestones,
// pulls, and `read`, when it was read, in ms), whether a read is out, its
// search, and whether its first listing has chosen what starts closed; its
// groups and opened rows share the two sets above under keys of their own.
let pullsListing = null;
let pullsReading = false;
let pullQuery = '';
let pullsSeeded = false;
// Its order and grouping, remembered as the add-to arrow is (below).
const PULL_SORT_KEY = 'prcoder:pull-sort';
const PULL_GROUP_KEY = 'prcoder:pull-group';
let pullSort = 'smallest';
let pullGroup = 'milestone';
// A listing younger than this is not read again on a visit to the tab; ⟳ always reads.
const PULLS_FRESH_FOR = 60_000;

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
  pullSort = PULL_SORTS[pref(PULL_SORT_KEY)] ? pref(PULL_SORT_KEY) : 'smallest';
  pullGroup = pref(PULL_GROUP_KEY) === 'none' ? 'none' : 'milestone';
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

const LABELS = { local: 'Local', pr: 'PR', issues: 'Issues', pulls: 'Pull requests', done: 'Completed', deleted: 'Deleted' };

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
const mentioned = (p = pr) => (p?.issues ?? []).filter((i) => !i.closes);

/**
 * The Issues tab's count: the repository's open issues, the matches while
 * searching, `…` before the first listing, and `?` when it could not be read.
 */
const issueCount = () => (!listing ? (issuesFailed ? '?' : '…') : query.trim() ? matching().length : listing.total);

/**
 * The listed issues the search lets through, worked out once per listing and
 * query: a keystroke paints both the tab's count and the groups from it, over
 * up to 500 issues with their bodies.
 */
const matching = () => {
  if (matched.listing !== listing || matched.query !== query) {
    matched = { listing, query, issues: (listing?.issues ?? []).filter((i) => issueMatches(i, query)) };
  }
  return matched.issues;
};
let matched = { listing: null, query: null, issues: [] };

/** The Pull requests tab's count, on the same rule as the Issues tab's. */
const pullCount = () => (!pullsListing ? '…' : pullQuery.trim() ? matchingPulls().length : pullsListing.total);

/** The listed pull requests the tab's search lets through. */
const matchingPulls = () => (pullsListing?.pulls ?? []).filter((p) => pullMatches(p, pullQuery));

function render() {
  const host = document.getElementById('queue-body');
  // Issues and Pull requests are always there -- a repository has both
  // whatever is checked out -- and PR only with a pull request on screen.
  const { strip, tab: active } = stripFor(items, tab, pr ? ['pr', 'issues', 'pulls'] : ['issues', 'pulls']);
  tab = active;
  // A source's count is what it still holds open; the list's own are its tabs.
  const count = (name) => (name === 'pr' ? prTasks().filter((t) => !t.done).length
    : name === 'issues' ? issueCount()
      : name === 'pulls' ? pullCount()
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
        : tab === 'pulls' ? pullList()
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
  if (name === 'pulls') loadPulls();
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
 *
 * One listing at a time: a listing is up to five pages of GitHub's, and
 * clicking Issues, Local, Issues while one was out started a second, which
 * could land first and be overwritten by the older. A visit while one is out
 * takes that one, which was asked for moments ago. `again` is for a caller
 * that knows the one out is stale, and has another asked for once it lands.
 */
function loadIssues(again = false) {
  if (issuesLoading) {
    issuesStale ||= again;
    return;
  }
  // A try after a failure says it is reading again, rather than still failed.
  if (issuesFailed) {
    issuesFailed = null;
    paintIssues();
  }
  issuesLoading = fetchIssues().finally(() => {
    issuesLoading = null;
    if (!issuesStale) return;
    issuesStale = false;
    if (tab === 'issues') loadIssues();
  });
}
let issuesLoading = null;
let issuesStale = false;
// Why the first listing could not be read, so the tab says so after the toast
// has gone: left reading "Reading…" and `…`, it looked as if it still was.
// Once there is a listing, a failed refresh keeps it and only the toast says.
let issuesFailed = null;

async function fetchIssues() {
  try {
    const got = await api('/api/issues', undefined, 'GET');
    listing = got;
    mentions = new Map(got.mentions.map((i) => [i.number, i]));
    listed = new Map(got.issues.map((i) => [i.number, i]));
    seedGroups();
  } catch (e) {
    toast(e.message, true);
    if (!listing) issuesFailed = e.message;
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
  if (!listing && issuesFailed) {
    return [h('p', { className: 'empty' }, `Could not read the repository's issues: ${issuesFailed} `,
      btn('try again', () => loadIssues(), { title: 'ask GitHub for the issues again' }))];
  }
  if (!listing) return [h('p', { className: 'empty' }, 'Reading the repository\'s issues…')];
  const searching = !!query.trim();
  const byMilestone = new Map();
  for (const i of matching()) {
    const key = i.milestone ?? NONE;
    if (!byMilestone.has(key)) byMilestone.set(key, []);
    byMilestone.get(key).push(i);
  }
  const ranked = rankMilestones(listing.milestones);
  // While searching every group drawn has a match and is open, without
  // touching what was chosen: fold() reports its initial state too. One
  // without a match is left out, as the mentions are -- drawn, it said "no
  // open issues" of a milestone that has them.
  const state = (key) => (searching ? { open: true, onToggle: () => {} } : kept(closedGroups, key, 'closed'));
  const home = deps.home?.();
  // `list` is the group's issues and `rows` what they draw, which is more
  // than one element per issue once a row is open: the count is the issues'.
  // `target` is the milestone the group stands for -- a title, or null for
  // none -- and makes its summary somewhere an issue row can be dropped; the
  // mentions have none, since they are not a milestone.
  const group = (key, title, list, rows, extra = [], target) => {
    const d = fold({
      className: 'milestone', dataset: { group: key }, title: [title, ' ', h('span', { className: 'count' }, `(${list.length})`), ...extra.flatMap((e) => [' ', e])],
      ...state(key),
    }, list.length ? [h('ul', { className: 'items' }, ...rows)] : [h('p', { className: 'empty' }, 'no open issues')]);
    if (target !== undefined) dropTarget(d.querySelector('summary'), target);
    return d;
  };

  const out = [];
  // The mentions, searched by what is known of them: one that is a listed
  // issue as that issue is, labels and body too, so the two rows match alike;
  // any other by its looked-up title.
  const ment = mentioned().filter((i) => issueMatches(listedAs(i)
    ?? { number: i.number, title: mentions?.get(i.number)?.title }, query));
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
    if (searching && !list.length) continue;
    out.push(group(`m:${m.number}`, title, list, list.map((i) => issueRow(i)).flat(), extra, m.title));
  }
  const none = byMilestone.get(NONE) ?? [];
  if (!searching || none.length) out.push(group(`m:${NONE}`, 'No milestone', none, none.map((i) => issueRow(i)).flat(), [], null));
  if (!out.length) out.push(h('p', { className: 'empty' }, 'No open issues match.'));
  if (listing.listed < listing.total) {
    out.push(h('p', { className: 'pr-note' }, `The ${listing.listed} most recently updated of ${listing.total} open issues.`));
  }
  return out;
}

/**
 * A group's summary as somewhere to drop an issue row: lit while one is over
 * it, and the drop is the move. Only a row's own drag counts (ISSUE); a link
 * or a text selection dragged across the pane is not an issue.
 */
function dropTarget(summary, milestone) {
  const carrying = (e) => e.dataTransfer.types.includes(ISSUE);
  summary.addEventListener('dragover', (e) => { if (carrying(e)) { e.preventDefault(); summary.classList.add('over'); } });
  summary.addEventListener('dragleave', () => summary.classList.remove('over'));
  summary.addEventListener('drop', (e) => {
    summary.classList.remove('over');
    if (!carrying(e)) return;
    e.preventDefault();
    mover(Number(e.dataTransfer.getData(type)), milestone);
  });
}

/**
 * A mention as a row. A bare `#N` is an issue or a pull request on GitHub, and
 * the tag says which (`PR #N`). One that is no longer open -- a closed issue, a
 * merged or closed pull request, or a number GitHub does not know -- is dimmed
 * rather than disappearing, since the description still points at it, and its
 * title is followed by its state: `· merged`, `· closed`. An open one, issue or
 * pull request, is still work in flight and is drawn at full strength; one that
 * is an open issue here is the listing's own row, body and all.
 */
function mentionRow(i) {
  const found = mentions?.get(i.number);
  const repo = mentionRepo(i);
  const own = listedAs(i);
  if (own) return issueRow(own);
  const title = found?.title;
  const open = found?.state === 'OPEN';
  // Not in the lookup is not looked up yet: every mention it was asked
  // about has an entry, with no title when GitHub did not know the number.
  const text = !found ? '…'
    : !title ? 'not found on GitHub'
      : open ? title : `${title} · ${found.state?.toLowerCase() ?? 'state unknown'}`;
  return issueRow({ number: i.number, url: i.url, title: text, body: null }, {
    repo, kind: found?.kind ?? null, closed: !open && !!found, text: title ?? `#${i.number}`,
  });
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
  // A listed issue can be dragged onto a milestone group; a mention that is
  // not listed cannot, since the move is held to the listing. No pointerdown
  // dance as Local's rows need (above): nothing here is contentEditable.
  const row = h('li', { className: `item source${closed ? ' closed' : ''}`, dataset: { issue: String(i.number) }, draggable: can },
    disclose,
    // With the repo when it is another's, as the item ↓ makes is tagged: the
    // link, ▶ and ↓ all go there, and docs/Security.md has ▶'s link match the tag.
    ext(i.url, refLabel({ issue: i.number, kind, repo }), { className: tagClass(kind) }),
    h('span', { className: 'text', textContent: i.title }),
    ...(i.labels ?? []).map((l) => h('span', { className: 'tag label' }, l)),
    h('span', { className: 'actions' },
      btn('▶', () => {
        const item = { text, issue: i.number, repo, kind, issueUrl: i.url };
        if (!deps.sendToClaude(forClaude(item, deps.home?.()), false)) toast('The coding agent is not connected — nothing was typed.', true);
      }, { title: 'type into the coding agent, with the link' }),
      btn('↓', () => pull(text, i.number, kind, repo), { title: 'copy into your queue' })));
  if (can) {
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(ISSUE, String(i.number)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  }
  if (!open) return [row];
  const home = deps.home?.();
  const where = home ? { repo: `https://github.com/${home}`, ref: 'HEAD' } : null;
  // The keyboard's way to the drag's move: every open milestone, and none.
  const pick = h('select', { className: 'milestone', ariaLabel: `milestone of #${i.number}` },
    h('option', { value: '' }, 'No milestone'),
    ...rankMilestones(listing.milestones).map((m) => h('option', { value: m.title, selected: m.number === i.milestone }, m.title)));
  pick.onchange = () => move(i.number, pick.value || null);
  const body = h('li', { className: 'issue-body md' },
    ...(i.body ? blocks(i.body).map((b) => blockNode(b, null, where)) : [h('p', { className: 'empty' }, 'No description.')]),
    h('div', { className: 'issue-ways' }, pick, ext(i.url, 'Open on GitHub', { className: 'primary open-issue' })));
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
// And what an issue row's drag carries, its number, for a milestone group to
// take; the same reason for a type of its own. A pull request row's is a
// third, so the two tabs' groups take only their own rows.
const ISSUE = 'application/x-prcoder-issue';
const PULL = 'application/x-prcoder-pull';

/**
 * An issue onto a milestone, or off one with null: the one write the Issues
 * tab makes, on a drop or a pick in the row's select, which GitHub's own rules
 * call triage. The tab reads the listing again after, so the row moves group
 * once GitHub has it and not before -- asking again even when a listing is
 * already out, since that one was asked for before the write.
 */
async function move(number, milestone) {
  try {
    await api('/api/issue/milestone', { number, milestone });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  loadIssues(true);
}

/**
 * The repository's open pull requests, for picking the next one to work on:
 * the last listing first -- the server's, or the one `.prcoder/pulls.json`
 * kept from an earlier run -- so the tab opens at once, and then GitHub's
 * behind it, since the read is seconds long on a repository with many open,
 * unless the listing is under a minute old. `force` is the tab's ⟳, which
 * reads whatever the age. The listing on screen stays until the new one
 * lands, and stays if it does not; the note under the groups says which.
 */
async function loadPulls(force = false) {
  if (pullsReading) return;
  pullsReading = true;
  try {
    if (!pullsListing) {
      // With nothing to open from, the server reads GitHub itself, and a
      // listing it answers is as fresh as the read below would be.
      try { pullsListing = await api('/api/pulls', { fresh: false }); } catch (e) { return toast(e.message, true); }
      paintPulls();
    }
    if (force || Date.now() - pullsListing.read >= PULLS_FRESH_FOR) {
      paintPulls();
      try { pullsListing = await api('/api/pulls', { fresh: true }); } catch (e) { toast(e.message, true); }
    }
  } finally {
    pullsReading = false;
  }
  paintPulls();
}

/** The groups and the tab's count repainted on their own, so the search box keeps its focus. */
function paintPulls() {
  if (tab !== 'pulls') return;
  document.querySelector('#queue-body .pull-groups')?.replaceChildren(...pullGroups());
  const t = document.querySelector('#queue-body .tab[data-tab="pulls"]');
  if (t) t.textContent = `${LABELS.pulls} (${pullCount()})`;
}

/**
 * The Pull requests tab: a search, the order within a group and whether to
 * group at all, ⟳, and the pull requests -- one group per open milestone in
 * the owner's order (rankMilestones) and then the ones on none, as the Issues
 * tab groups, or one list. Each row carries what picking the next one turns
 * on (pullRow), opens to the description, can be typed to the coding agent
 * with its link (▶), copied into Local (↓), or checked out (Switch), and is
 * dragged onto a group to put it on that milestone.
 */
function pullList() {
  const search = h('input', {
    id: 'queue-pull-search', type: 'search', placeholder: 'Search pull requests', value: pullQuery,
    autocomplete: 'off', spellcheck: false, ariaLabel: 'search the repository\'s open pull requests',
  });
  search.oninput = () => { pullQuery = search.value; paintPulls(); };
  const order = h('select', { className: 'pull-sort', ariaLabel: 'the order within a group' },
    ...Object.entries(PULL_SORTS).map(([k, { label }]) => h('option', { value: k, selected: k === pullSort }, label)));
  order.onchange = () => { pullSort = order.value; setPref(PULL_SORT_KEY, pullSort); paintPulls(); };
  const grouping = h('select', { className: 'pull-group', ariaLabel: 'how the pull requests are grouped' },
    h('option', { value: 'milestone', selected: pullGroup === 'milestone' }, 'by milestone'),
    h('option', { value: 'none', selected: pullGroup === 'none' }, 'one list'));
  grouping.onchange = () => { pullGroup = grouping.value; setPref(PULL_GROUP_KEY, pullGroup); paintPulls(); };
  const reload = btn('⟳', () => loadPulls(true), { className: 'pull-reload', title: 'read the pull requests again from GitHub', ariaLabel: 'read the pull requests again from GitHub' });
  return h('div', { className: 'pulls-pane' },
    h('div', { className: 'pull-controls' }, search, order, grouping, reload),
    h('div', { className: 'pull-groups' }, ...pullGroups()));
}

function pullGroups() {
  if (!pullsListing) return [h('p', { className: 'empty' }, 'Reading the repository\'s pull requests…')];
  const searching = !!pullQuery.trim();
  const rows = sortPulls(matchingPulls(), pullSort);
  const out = [];
  if (pullGroup === 'none') {
    out.push(rows.length ? h('ul', { className: 'items' }, ...rows.map((p) => pullRow(p)).flat())
      : h('p', { className: 'empty' }, searching ? 'No matching pull requests.' : 'No open pull requests.'));
  } else {
    const byMilestone = new Map();
    for (const p of rows) {
      const key = p.milestone ?? NONE;
      if (!byMilestone.has(key)) byMilestone.set(key, []);
      byMilestone.get(key).push(p);
    }
    const ranked = rankMilestones(pullsListing.milestones);
    // What starts closed, chosen once per page as the Issues tab chooses:
    // everything but the first milestone in rank with a pull request on it.
    if (!pullsSeeded) {
      pullsSeeded = true;
      const focus = ranked.find((m) => byMilestone.has(m.number))?.number ?? NONE;
      for (const key of [...ranked.map((m) => m.number), NONE]) if (key !== focus) closedGroups.add(`p:${key}`);
    }
    const state = (key, list) => (searching ? { open: list.length > 0, onToggle: () => {} } : kept(closedGroups, key, 'closed'));
    const home = deps.home?.();
    const group = (key, title, list, extra, target) => {
      const d = fold({
        className: 'milestone', dataset: { group: key },
        title: [title, ' ', h('span', { className: 'count' }, `(${list.length})`), ...extra.flatMap((e) => [' ', e])],
        ...state(key, list),
      }, list.length ? [h('ul', { className: 'items' }, ...list.map((p) => pullRow(p)).flat())] : [h('p', { className: 'empty' }, 'no open pull requests')]);
      dropTarget(d.querySelector('summary'), target, PULL, movePull);
      return d;
    };
    for (const m of ranked) {
      const title = home ? ext(`https://github.com/${home}/milestone/${m.number}`, m.title, { title: m.description || undefined }) : m.title;
      const extra = [
        ...(m.dueOn ? [h('span', { className: 'due', title: 'due' }, m.dueOn.slice(0, 10))] : []),
        // Listed only because an open pull request is still on it (repoPulls).
        ...(m.closed ? [h('span', { className: 'closed-milestone', title: 'closed on GitHub, with open pull requests still on it' }, 'closed')] : []),
      ];
      out.push(group(`p:${m.number}`, title, byMilestone.get(m.number) ?? [], extra, m.title));
    }
    out.push(group(`p:${NONE}`, 'No milestone', byMilestone.get(NONE) ?? [], [], null));
  }
  const { read, listed, total } = pullsListing;
  out.push(h('p', { className: 'pull-note' },
    `Read ${age(new Date(read).toISOString())}${pullsReading ? ' · updating…' : ''}`
    + (listed < total ? `. The ${listed} most recently updated of ${total} open pull requests.` : '')));
  return out;
}

/** GitHub's reviewDecision as the row says it; null, the usual case, says nothing. */
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review needed' };

/** A merge word as a class: `checks not passing` -> `checks-not-passing`, `checking…` -> `checking`. */
const wordClass = (w) => w.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

/**
 * One pull request as a row, and its description under it when the row is
 * open. The first line is what the choice turns on: `PR #N` and the title,
 * whether it can merge in a word, the review decision when there is one, its
 * size as GitHub's size label (hover for the counts) coloured green to red by
 * band, the Files tab's pie (filled by changed lines viewed, so an empty
 * one is probably still being written and a full one is reviewed and waiting
 * on something else), its labels, `new` within a week of opening, whose it
 * is, and how long since it
 * was opened and last moved, a dot between each pair of plain words; a row
 * not moved in three months is dimmed. A
 * pull request on no milestone that closes an issue on one shows that
 * milestone as a hint, since the pull request usually belongs where its
 * issue is. Under the line, the description's first paragraph, clipped to two
 * lines and as plain text. The chip is the way to the pull request on GitHub
 * (the title is not a second one), and switching is the other thing a row is
 * for, so the one on screen is marked `here` right after its title and every
 * other row has the PR pane's Switch there, under its guard, in sight; ▶ and
 * ↓ wait on hover at the end, as every queue row's do.
 */
function pullRow(p) {
  const key = `pull:${p.number}`;
  const open = expanded.has(key);
  const here = !!pr && pr.url === p.url;
  const now = Date.now();
  const home = deps.home?.();
  const disclose = btn(open ? '▾' : '▸', () => {
    if (open) expanded.delete(key); else expanded.add(key);
    paintPulls();
  }, { className: 'disclose', title: open ? 'hide the description' : 'show the description', ariaExpanded: String(open) });
  const review = REVIEW[p.reviewDecision];
  const hint = p.milestone == null ? (p.closes ?? []).find((i) => i.milestone) : null;
  const blocked = deps.blocked?.() ?? false;
  const files = `${p.changedFiles ?? 0} file${p.changedFiles === 1 ? '' : 's'}`;
  const go = () => (here ? null : btn('Switch', () => deps.onSwitch?.(p.url), {
    className: 'pr-go', disabled: blocked,
    title: blocked ? 'Commit or stash your changes first' : `Check out #${p.number} here`,
  }));
  const classes = ['item', 'source', 'pull', here ? 'here' : '', isStale(p, now) ? 'stale' : ''].filter(Boolean).join(' ');
  // The facts, each marked plain (a word) or not (a chip, the pie): a dot goes
  // between two plain neighbours and nowhere near a chip, as linkRow (pr.js)
  // sets dots -- a chip's border already separates it.
  // In three runs: the state (the merge word, the review), then what makes
  // this one worth taking or not (the size, coloured by band, the pie, labels,
  // new), then whose it is and when.
  const size = sizeChip(p.lines);
  const facts = [
    [p.merge ? h('span', { className: `pr-merge ${wordClass(p.merge)}` }, p.merge) : null, true],
    [review ? h('span', { className: 'pr-review' }, review) : null, true],
    [h('span', { className: `size ${size.toLowerCase()}`, title: `+${p.additions ?? 0} −${p.deletions ?? 0} · ${files}` }, size), false],
    [p.viewed ? mark({ p: p.viewed.p, full: p.viewed.full, label: p.viewed.label }) : null, false],
    ...(p.labels ?? []).map((l) => [h('span', { className: 'tag label' }, l), false]),
    [isNew(p, now) ? h('span', { className: 'tag new' }, 'new') : null, false],
    [p.author ? h('span', { className: 'who', title: 'opened by' }, p.author) : null, true],
    [h('span', { className: 'age', title: `opened ${p.createdAt ?? ''}` }, `opened ${age(p.createdAt, now)}`), true],
    [h('span', { className: 'age', title: `last updated ${p.updatedAt ?? ''}` }, `updated ${age(p.updatedAt, now)}`), true],
    [hint ? h('span', { className: 'tag hint', title: `closes #${hint.number}, which is on ${hint.milestone}` }, `closes #${hint.number} · ${hint.milestone}`) : null, false],
  ].filter(([node]) => node);
  const row = h('li', { className: classes, dataset: { pull: String(p.number) }, draggable: true, ...(here && { ariaCurrent: 'true' }) },
    disclose,
    ext(p.url, `PR #${p.number}`, { className: 'tag pull' }),
    h('span', { className: 'text', textContent: p.title }),
    here ? h('span', { className: 'tag here', title: 'the pull request on screen' }, 'here') : go(),
    ...facts.flatMap(([node, plain], i) => [i && plain && facts[i - 1][1] ? h('span', { className: 'sep' }, '·') : null, node]),
    h('span', { className: 'actions' },
      btn('▶', () => {
        const item = { text: p.title, issue: p.number, repo: null, kind: 'pull', issueUrl: p.url };
        if (!deps.sendToClaude(forClaude(item, home), false)) toast('The coding agent is not connected — nothing was typed.', true);
      }, { title: 'type into the coding agent, with the link' }),
      btn('↓', () => pull(p.title, p.number, 'pull', null), { title: 'copy into your queue' })),
    p.lead ? h('p', { className: 'pr-lead' }, p.lead) : null);
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(PULL, String(p.number)); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  if (!open) return [row];
  const where = home ? { repo: `https://github.com/${home}`, ref: 'HEAD' } : null;
  const pick = h('select', { className: 'milestone', ariaLabel: `milestone of pull request #${p.number}` },
    h('option', { value: '' }, 'No milestone'),
    ...rankMilestones(pullsListing.milestones).map((m) => h('option', { value: m.title, selected: m.number === p.milestone }, m.title)));
  pick.onchange = () => movePull(p.number, pick.value || null);
  const closes = (p.closes ?? []).length ? h('p', { className: 'pull-closes' }, 'Closes ', ...(p.closes).flatMap((i, n) => [
    n ? ', ' : '', ext(i.url ?? `https://github.com/${home}/issues/${i.number}`, `#${i.number} ${i.title}`),
    i.milestone ? ` (${i.milestone})` : ''])) : null;
  const body = h('li', { className: 'issue-body md' },
    ...(p.body ? blocks(p.body).map((b) => blockNode(b, null, where)) : [h('p', { className: 'empty' }, 'No description.')]),
    closes,
    h('div', { className: 'issue-ways' }, pick, go(), ext(p.url, 'Open on GitHub', { className: 'primary open-issue' })));
  return [row, body];
}

/**
 * A pull request onto a milestone, or off one with null: the Pull requests
 * tab's one write, on a drop or a pick in the opened row, as move is the
 * Issues tab's. The listing is read again after, so the row moves group once
 * GitHub has it.
 */
async function movePull(number, milestone) {
  try {
    await api('/api/pull/milestone', { number, milestone });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  await loadPulls(true);
}

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
