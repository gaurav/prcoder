import { h, btn, ext, api, toast, pref, setPref, tabBtn, writeThrough, fold, kept, mark, fraction, actions } from './ui.js';
import { TABS, refLabel, refClass, forClaude, rankMilestones, issueMatches, pullMatches, sortPulls, sizeChip, age, dueLabel, isNew, PULL_SORTS } from './items.js';
import { refs, resolveRef, blocks } from './tasks.js';
import { blockNode, inline, stackUnder, stackOrder } from './pr.js';
import { LABEL as HISTORY_LABEL, historyList, historyCount, loadHistory, initHistory } from './history.js';

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
  // So is a row's milestone select and Move (groupsInUse), which a repaint
  // would close. Not the rest of the row's ways: a pull request's has Switch,
  // and focus left on it must not keep the checkout's poll from landing.
  if (saving || document.activeElement?.closest?.('#queue-body .text[contenteditable], #queue-search, #queue-pull-search, #queue-body .move-to')) return;
  if (document.querySelector('#queue-body .item.dragging')) return;
  // What the PR and Issues tabs draw from: a tick on github.com changes the
  // PR #N tab without changing the list, so it has to count as news too.
  const source = (p) => (p ? JSON.stringify([p.number, p.body, p.issues]) : '');
  const samePr = source(prOnScreen) === source(pr);
  // The mentions' titles and states come with the listing, looked up for the
  // pull request on screen when it was asked for (askedFor). A different one,
  // or a description that mentions something new -- or the first poll's,
  // after a visit to the tab before it -- needs them asked for again while a
  // tab that draws them is up, and until they land a mention not looked up
  // reads `…` (mentionRow).
  if ((tab === 'issues' || tab === 'pr') && asks(prOnScreen) !== askedFor) loadIssues(true);
  // A different pull request is a different checklist: its tab starts at the top.
  if (prOnScreen?.url !== pr?.url) scrolled.pr = 0;
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
// the PR #N tab; and the repository's open issues, fetched when the Issues tab is
// opened, since nothing else needs them. `listing` is /api/issues' answer --
// milestones, issues, and the mentions the description makes without closing,
// which `mentions` indexes by number as it always did; `listed` indexes the
// listing's issues the same way.
let pr = null;
let listing = null;
let mentions = null;
let listed = new Map();
// What the listing out, or on hand, was asked about: the pull request and the
// mentions its description made when fetchIssues started. A tab that draws
// the mentions reads again when the one on screen asks something else.
let askedFor = null;
const asks = (p) => JSON.stringify([p?.url ?? null, mentioned(p).map((i) => i.number)]);
const listingStale = () => !listing || askedFor !== asks(pr);
// The Issues tab's own state, kept across the repaint every poll causes and
// not across a reload, like the file groups' folds: the search, which groups
// are closed, which rows are open, and which groups a listing has had, so a
// new one can be given its starting state (seedGroups).
let query = '';
const closedGroups = new Set();
const expanded = new Set();
const seen = new Set();
// The PRs tab's: its listing (/api/pulls' answer -- milestones,
// pulls, and `read`, when it was read, in ms), whether a read is out, its
// search, and whether its first listing has chosen what starts closed; its
// groups and opened rows share the two sets above under keys of their own.
let pullsListing = null;
let pullsReading = false;
// The read out, and everything after it (loadPulls), for what waits on it.
let pullsLoading = null;
// A forced read was asked for while one was out (loadPulls).
let pullsStale = false;
// A visit to the tab arrived while a read was out, and is owed its age check.
let pullsVisit = false;
let pullQuery = '';
let pullsSeeded = false;
// Its order and grouping, remembered as the add-to arrow is (below).
const PULL_SORT_KEY = 'prcoder:pull-sort';
const PULL_GROUP_KEY = 'prcoder:pull-group';
let pullSort = 'smallest';
let pullGroup = 'milestone';
// A listing younger than this is not read again on a visit to the tab; ⟳ always reads.
const PULLS_FRESH_FOR = 60_000;
// How long after the page's first status the issues are read for the Issues
// tab's count (primeIssues): past the page-load `gh pr list` and a clone's
// first pull request read, so the one GitHub call that is up to five pages
// does not land on top of them.
const ISSUES_AFTER_POLL = 3000;
// Whether the History tab is drawn: /api/whoami's `history`, which app.js
// hands over when it lands (setHistoryOn). Off until then, and off for good
// under --no-history, so the tab is never drawn and then taken away.
let historyOn = false;

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
/** The button's click, and Alt+Shift+↑ / ↓ in the input (app.js). */
export function setAddTo(where) {
  addTo = where;
  setPref(ADD_TO_KEY, addTo);
  paintWhere();
}

/**
 * The History tab switched on, once whoami has said it is there to read --
 * and read at once, so its count is on the tab before a visit: the file is
 * local and cheap, and the count is today's prompts, which is the question
 * on coming back.
 */
export function setHistoryOn(on) {
  if (historyOn === !!on) return;
  historyOn = !!on;
  render();
  if (historyOn) loadHistory();
}

export async function initQueue(d) {
  deps = d;
  initHistory({ type: typeInto, pull: (text) => pull(text) });
  // Read here rather than at module scope: initQueue only ever runs in a
  // browser, so the module stays importable by a node test that has no
  // localStorage to touch.
  addTo = readAddTo();
  pullSort = PULL_SORTS[pref(PULL_SORT_KEY)] ? pref(PULL_SORT_KEY) : 'smallest';
  pullGroup = ['none', 'stack'].includes(pref(PULL_GROUP_KEY)) ? pref(PULL_GROUP_KEY) : 'milestone';
  document.getElementById('queue-where').onclick = () => setAddTo(addTo === 'bottom' ? 'top' : 'bottom');
  // Before the fetch, so a remembered ↑ is not shown as the markup's ↓ for as
  // long as /api/queue takes to answer.
  paintWhere();
  // The last pull request listing, for the PRs tab's count before a visit.
  loadPulls(false, { visit: false });
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

// `PRs` and `Issues`, the repository's, then `PR #N`, the one on screen: the
// short word for the listing and the number for the one, so the two tabs
// about pull requests are never confused (they were `Pull requests` and
// `PR` until 2026-11-08). tabName() puts the number in.
const LABELS = { local: 'Local', pr: 'PR', issues: 'Issues', pulls: 'PRs', history: HISTORY_LABEL, done: 'Completed', deleted: 'Deleted' };
const tabName = (n) => (n === 'pr' && pr ? `PR #${pr.number}` : LABELS[n]);

/**
 * The source tabs, in the strip's order: the repository's pull requests
 * first, since picking the next one is what the queue is most often opened
 * for, then its issues, then the pull request on screen when there is one,
 * then the History tab when there is a file to read. Pure, for the test.
 */
export const sourcesFor = (prOnScreen, history) => ['pulls', 'issues', ...(prOnScreen ? ['pr'] : []), ...(history ? ['history'] : [])];

// Local is always there because an *empty* Local is the thing worth seeing --
// it is how a tidy session ends. Completed is always there because it is where
// the delete-all lives. Deleted hides when it holds nothing.
const ALWAYS = ['local', 'done'];

/**
 * Which tabs the strip draws, and which of them is active: your own list's tabs,
 * with the `sources` that are available (sourcesFor) between Local and the
 * rest. Pure, and exported only so it can
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
 * The PR #N tab's count: what the pull request still points at that is open
 * -- its unticked boxes, and the mentions not known to be closed, which is
 * the rule every source's count keeps. A mention counts until the listing
 * says it is closed, so the label never reads `…` and only drops as closed
 * ones are found. The issues it closes are left out: they are what the pull
 * request answers, and would not drop until it merges.
 */
const prCount = () => prTasks().filter((t) => !t.done).length
  + mentioned().filter((i) => { const f = mentions?.get(i.number); return !f || f.state === 'OPEN'; }).length;

/**
 * The issues the description mentions and does not close. The ones it closes
 * are what the PR already answers; a bare `#N` elsewhere is work it points at.
 * The PR #N tab's Mentions fold, looked up with the Issues listing.
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

/** The PRs tab's count, on the same rule as the Issues tab's. */
const pullCount = () => (!pullsListing ? '…' : pullQuery.trim() ? matchingPulls().length : pullsListing.total);

/** The listed pull requests the tab's search lets through, by the state word each row shows. */
const matchingPulls = () => (pullsListing?.pulls ?? []).filter((p) => pullMatches(p, pullQuery, pullWord(p, underOf(p)).word));

// Each tab's scroll offset, put back when it is drawn again: the list is one
// scroller under a strip that stays put, and a Local row ticked should not
// land you at the top of Local, nor a switch to Issues at the offset you had
// on the PRs tab. As the pull request pane's (renderPrTab in pr.js).
const scrolled = {};

function render() {
  const head = document.getElementById('queue-head');
  const list = document.getElementById('queue-list');
  // Recorded as it happens, not read before the replace: queueTab sets `tab`
  // to the tab being switched to before this runs, so a read here would file
  // the outgoing tab's offset under the incoming one (pr.js has the same note).
  list.onscroll = () => { scrolled[tab] = list.scrollTop; };
  // PRs and Issues are always there -- a repository has both whatever is
  // checked out -- and PR #N only with a pull request on screen (sourcesFor).
  const { strip, tab: active } = stripFor(items, tab, sourcesFor(pr, historyOn));
  tab = active;
  // A source's count is what it still holds open; the list's own are its tabs.
  const count = (name) => (name === 'pr' ? prCount()
    : name === 'issues' ? issueCount()
      : name === 'pulls' ? pullCount()
        : name === 'history' ? historyCount()
          : items.filter(TABS[name]).length);
  const label = (n) => `${tabName(n)} (${count(n)})`;
  const shown = TABS[tab] ? items.filter(TABS[tab]) : [];
  // Most recent first on Completed and Deleted, so the item you just ticked or
  // deleted by mistake is on top to be taken back. The store stamps the times;
  // one it has not stamped yet (from before the field existed) goes last, and
  // the sort is stable, so ties keep the queue's own order.
  const at = { done: 'doneAt', deleted: 'deletedAt' }[tab];
  if (at) shown.sort((a, b) => (b[at] ?? -Infinity) - (a[at] ?? -Infinity));

  head.replaceChildren(
    h('div', { className: 'tabs' },
      ...strip.map((n) => queueTab(n, label(n))),
      h('span', { className: 'spacer' }),
      ...bulks(),
    ),
  );
  list.replaceChildren(
    tab === 'pr' ? prTab()
      : tab === 'issues' ? issueList()
        : tab === 'pulls' ? pullList()
          : tab === 'history' ? historyList()
            : h('ul', { className: 'items' }, ...shown.map((i, n) => row(i, shown[n - 1], shown[n + 1]))),
  );
  // Assigning forces layout, so this lands against the new content.
  list.scrollTop = scrolled[tab] ?? 0;
  staleBreakdown();
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
    ? 'new items go to the bottom — click, or Alt+Shift+↑ in the input, to add to the top'
    : 'new items go to the top — click, or Alt+Shift+↓ in the input, to add to the bottom';
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
  if (name === 'issues') {
    issuesVisited = true;
    loadIssues();
  }
  // The mentions come with the Issues listing, read once in the background
  // (primeIssues) and usually on hand: asked for only when it is not, or was
  // asked about another pull request.
  if (name === 'pr' && listingStale()) loadIssues(true);
  if (name === 'pulls') loadPulls();
  if (name === 'history') loadHistory();
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
    // Painted here, once the read is no longer out, so the line under the
    // groups does not say `updating…` of a listing that has just landed.
    paintAfterRead();
    if (!issuesStale) return;
    issuesStale = false;
    if (tab === 'issues') loadIssues();
  });
  // And now, so the line says `updating…` while it is.
  if (listing && (tab === 'issues' || tab === 'pr')) paintGroups();
}

/**
 * After a read lands or fails: the counts whatever tab shows, and the groups
 * on a tab that draws them -- in place when they are up, since the search
 * box is there before the listing and a render() would take it out from
 * under a query being typed; drawn whole otherwise.
 */
function paintAfterRead() {
  if (tab !== 'issues' && tab !== 'pr') return paintCounts();
  if (document.querySelector('#queue-body :is(.issue-groups, .pr-parts)')) paintIssues(); else render();
}
let issuesLoading = null;
let issuesStale = false;
// The tab has been visited, so a visit's read is out or in and the page-open
// read (primeIssues) has nothing to add.
let issuesVisited = false;
// When the listing on hand was read, in ms, for the line under the groups.
let issuesRead = 0;

/**
 * One read of the issues a few seconds after the page's first status lands
 * (paint in app.js), so the Issues tab's count is on the strip before a
 * visit -- unless a visit has already asked, a read is out, or the first
 * read failed, which the tab says and a visit tries again; a failure here
 * leaves `?` and says nothing, since nobody asked. After the first status,
 * not before: GET /api/issues looks the mentions up for the pull request
 * the server has, which the first poll is what gives it.
 */
export function primeIssues() {
  setTimeout(() => {
    if (listing || issuesLoading || issuesFailed || issuesVisited) return;
    loadIssues();
  }, ISSUES_AFTER_POLL);
}
// Why the first listing could not be read, so the tab says so after the toast
// has gone: left reading "Reading…" and `…`, it looked as if it still was.
// Once there is a listing, a failed refresh keeps it and only the toast says.
let issuesFailed = null;

async function fetchIssues() {
  askedFor = asks(pr);
  try {
    const got = await api('/api/issues', undefined, 'GET');
    listing = got;
    mentions = new Map(got.mentions.map((i) => [i.number, i]));
    listed = new Map(got.issues.map((i) => [i.number, i]));
    issuesRead = Date.now();
    seedGroups();
  } catch (e) {
    // The toast is for a read someone is waiting on; a read behind another
    // tab (primeIssues) leaves `?` on the strip and keeps quiet.
    if (tab === 'issues' || tab === 'pr') toast(e.message, true);
    if (!listing) issuesFailed = e.message;
  }
}

/**
 * Text into the coding agent's prompt, typed and not sent -- the turn is left
 * for you to edit and submit, which is the whole of what prcoder puts into a
 * session (docs/Design.md). Whether it went: `sendToClaude` answers false on a
 * closed socket, and the one toast for that lives here rather than beside
 * every ▶.
 */
function typeInto(text) {
  const went = deps.sendToClaude(text, false);
  if (!went) toast('The coding agent is not connected — nothing was typed.', true);
  return went;
}

/**
 * The two buttons every source row has, and a Local row too, built here so
 * they say and do the same thing on every tab (actions in ui.js has the
 * order). ▶ types `text` -- or what the function gives, for a row whose text
 * can change under an edit before the click -- and runs `then` only if it
 * went; ↓ copies `text` into Local, tagged with the issue when there is one.
 */
const typeBtn = (text, { title = 'type into the coding agent, with the link', then } = {}) => btn('▶', () => {
  if (typeInto(typeof text === 'function' ? text() : text)) then?.();
}, { title });
const pullBtn = (text, issue = null, kind = null, repo = null) => btn('↓', () => pull(text, issue, kind, repo), { title: 'copy into your queue' });

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

/**
 * The PR #N tab: everything the pull request's description points at, in
 * three folds -- its own checklist, ticked through to GitHub; the issues and
 * pull requests it mentions without closing, drawn as the Issues tab draws a
 * mention; and the issues it closes, dimmed, since they are what it answers.
 * Folds rather than headings, as every listing tab is: an agent-written
 * checklist can run to dozens of lines and would bury the mentions, and a
 * fold carries its count and remembers being closed across the poll's
 * repaints (closedGroups, under keys no milestone has). The parts are
 * repainted on their own as the listing lands (paintIssues), so an open row
 * stays open.
 */
function prTab() {
  return h('div', { className: 'pr-pane' }, groupsList('pr-parts', prParts()));
}

function prParts() {
  if (!pr) return [];
  const tasks = prTasks();
  const ment = newestFirst(mentioned(), mentions);
  const closes = (pr.issues ?? []).filter((i) => i.closes);
  // `milestone` is the groups' face in style.css, `part` what the PR #N tab
  // adds to it; the suite's groupsOf reads the Issues tab by the first.
  const part = (key, title, n, label, rows, progress) => fold({
    className: 'milestone part', dataset: { group: key },
    title: [title, ' ', badge(n, label)], progress, ...kept(closedGroups, key, 'closed'),
  }, [h('ul', { className: 'items' }, ...rows)]);
  const out = [];
  if (tasks.length) {
    const done = tasks.filter((t) => t.done).length;
    out.push(part('tasks', 'Checklist', tasks.length - done, `${tasks.length - done} of ${tasks.length} ${tasks.length - done === 1 ? 'box' : 'boxes'} still to tick`,
      tasks.map((t) => taskRow(t)), { ...fraction({ done, total: tasks.length }), label: `${done} of ${tasks.length} ticked` }));
  }
  if (ment.length) out.push(part('mentioned', 'Mentions', ment.length, `${ment.length} ${several(ment.length, 'issues')} or pull requests the description mentions without closing`, ment.map((i) => mentionRow(i)).flat()));
  if (closes.length) out.push(part('closes', 'Closes', closes.length, `${closes.length} ${several(closes.length, 'issues')} this pull request closes`, closes.map((i) => closesRow(i)).flat()));
  if (!out.length) out.push(h('p', { className: 'empty' }, `Nothing in PR #${pr.number}'s description to point at: no checkboxes, no mentions.`));
  return out;
}

/** A checklist line: its box, ticked through to GitHub, and the row's ways. */
function taskRow(t) {
  // Named by its line, or every box in the list is called by the one title.
  const box = h('input', { type: 'checkbox', checked: t.done, title: 'tick this on GitHub', ariaLabel: t.text });
  writeThrough(box, (v) => deps.onTask({ index: t.index, done: v, text: t.text }));
  // ▶ types the line and ticks nothing: the box is GitHub's, and typing a
  // task to the agent is not doing it.
  return h('li', { className: 'item source' },
    box,
    h('span', { className: 'text', textContent: t.text }),
    actions(typeBtn(t.text, { title: 'type into the coding agent' }), pullBtn(t.text)));
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
 * in groups -- the issues on no milestone first, which are the ones to
 * triage, then one group per milestone in the owner's order (rankMilestones);
 * what the pull request on screen mentions is the PR #N tab's (prParts), read
 * with this listing. Each row can open to show the issue's body and a way to it
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
  // ⟳ as the PRs and History tabs have it, `again` so that one pressed while
  // a read is out still causes a read after it.
  const reload = btn('⟳', () => loadIssues(true), { className: 'issue-reload', title: 'read the issues again from GitHub', ariaLabel: 'read the issues again from GitHub' });
  return h('div', { className: 'issues-pane' }, h('div', { className: 'pull-controls' }, search, reload), groupsList('issue-groups', issueGroups()));
}

/**
 * Whether a repaint would take something out from under the user: the row being
 * dragged, with the group's line it is over and the drag's end event, or a row's
 * select, which closes when it is replaced. Each visit to the tab and each move
 * reads a listing that takes seconds, so one landing mid-gesture is ordinary.
 * Safe to hold on for the reason setItems holds on the search box: both end with
 * the next click anywhere else. Move counts with its select, since focus crosses
 * to it on the way to what it acts on.
 */
const groupsInUse = () => !!(document.querySelector('#queue-body .item.dragging')
  || document.activeElement?.closest?.('#queue-body .move-to'));
// A repaint held back, drawn once what held it is over.
let groupsOwed = false;
// What each tab that draws from the Issues listing paints its groups into,
// and with what: the Issues tab its milestone groups, the PR #N tab its parts.
const GROUPS = { issues: ['.issue-groups', issueGroups], pr: ['.pr-parts', prParts] };
const drawGroups = () => {
  groupsOwed = false;
  const [host, groups] = GROUPS[tab] ?? [];
  if (host) document.querySelector(`#queue-body ${host}`)?.replaceChildren(...groups());
  staleBreakdown();
};
const paintGroups = () => { if (groupsInUse()) groupsOwed = true; else drawGroups(); };
/**
 * The element a tab's groups are repainted into. A repaint held back is paid on
 * the next task after focus leaves: during focusout the new focus is not settled
 * yet, and may be the other half of the same control.
 */
const groupsList = (className, groups) => {
  const list = h('div', { className }, ...groups);
  list.addEventListener('focusout', () => setTimeout(payGroups));
  return list;
};
const payGroups = () => {
  // The PR #N tab's rows move through the Issues listing's MOVES.
  if (groupsOwed) (tab === 'pr' ? MOVES.issues : MOVES[tab])?.paint();
};

/**
 * The groups of whichever tab draws from the Issues listing, and both tabs'
 * counts, leaving the search box, its focus and its caret alone.
 */
function paintIssues() {
  paintGroups();
  paintCounts();
}

/** The two tabs' counts drawn from the Issues listing, whatever tab shows. */
function paintCounts() {
  const t = document.querySelector('#queue-body .tab[data-tab="issues"]');
  if (t) t.textContent = `${LABELS.issues} (${issueCount()})`;
  const p = document.querySelector('#queue-body .tab[data-tab="pr"]');
  if (p) p.textContent = `${tabName('pr')} (${prCount()})`;
}

/** The group an issue with no milestone is in. */
const NONE = 'none';

/** No milestone's badge, when it holds something: the issues or pull requests not yet triaged. */
const triage = (list) => (list.length ? [h('span', { className: 'triage', title: 'on no milestone yet, so not triaged: it could belong at any level' }, 'to triage')] : []);

/**
 * A group's count, as the badge right after its title: the rows it lists,
 * which while searching are the ones that match. Beside the title and not at
 * the line's end, where on a wide pane it was too far off to read as the
 * milestone's (2026-10-24). `noun` is the plural, `issues` or `pull requests`.
 */
const countBadge = (n, noun, searching) => badge(n,
  `${n} open ${several(n, noun)} ${searching ? (n === 1 ? 'matches the search' : 'match the search') : 'listed'}`);
/** The badge itself: the digits, hollow at 0, with `title` saying what they count. */
const badge = (n, title) => h('span', { className: n ? 'count' : 'count none', title }, String(n));

/** `noun`, a plural, as one of them when `n` is 1: `issue`, `pull request`. */
const several = (n, noun) => (n === 1 ? noun.replace(/s$/, '') : noun);

/**
 * A milestone's counts (`counts` from milestoneRow in github.js) as its pie
 * draws them, or null when there is nothing to draw: no counts -- a pulls.json
 * older than them -- counts that are not whole numbers, as in one damaged, or
 * a milestone that has never held anything. The pie is the whole milestone,
 * pull requests and issues together, so it is the same on either tab. Done is
 * what merged or closed; a pull request closed without merging is in neither
 * figure, since it is not done and not still to do (the owner's call, 2026-10-24).
 */
function tally(counts) {
  const { open, merged, closed } = counts?.pulls ?? {};
  const { open: issues, closed: shut } = counts?.issues ?? {};
  if (![open, merged, closed, issues, shut].every((n) => Number.isInteger(n) && n >= 0)) return null;
  const total = open + merged + issues + shut;
  return total ? { pulls: { open, merged, closed }, issues: { open: issues, closed: shut }, done: merged + shut, total } : null;
}

/**
 * What follows a milestone's count on its line, from its tally: how many of
 * the other kind are open on it -- `9 issues` on the PRs tab, `2 PRs`
 * on the Issues tab, `noun` being the tab's own rows -- so the line says what
 * the milestone holds beyond the rows listed; the pie of how much of it is
 * done; how many pull requests have merged into it, which is what says whether
 * a release is ready, and which a pie mostly of issues would hide; then when
 * it is due (dueLabel), and `closed` for a closed one still holding rows. The
 * two figures are left out at 0, and with the pie when there is no tally.
 */
function milestoneExtra(m, noun) {
  const t = tally(m.counts);
  const [other, them, short] = noun === 'issues' ? [t?.pulls.open, 'pull requests', 'PRs'] : [t?.issues.open, 'issues', 'issues'];
  return [
    ...(other ? [h('span', { className: 'other-kind', title: `${other} open ${several(other, them)} on this milestone on GitHub` },
      `${other} ${several(other, short)}`)] : []),
    ...(t ? [pieButton(m, t)] : []),
    ...(t?.pulls.merged ? [h('span', { className: 'merged', title: `${t.pulls.merged} ${several(t.pulls.merged, 'pull requests')} merged into this milestone` },
      `${t.pulls.merged} merged`)] : []),
    ...(m.dueOn ? [h('span', dueLabel(m.dueOn))] : []),
    ...(m.closed ? [h('span', { className: 'closed-milestone', title: `closed on GitHub, with open ${noun} still on it` }, 'closed')] : []),
  ];
}

/**
 * A milestone's pie, as the button that opens its breakdown. The figure is
 * its tooltip, as a mark's is, and its name, with what a press does.
 */
function pieButton(m, t) {
  const label = `${t.done} of ${t.total} done: ${t.pulls.merged} ${several(t.pulls.merged, 'pull requests')} merged, `
    + `${t.issues.closed} ${several(t.issues.closed, 'issues')} closed`;
  const b = h('button', { type: 'button', className: 'breakdown', title: label }, mark(fraction(t)));
  b.setAttribute('aria-label', `${label}; show the breakdown`);
  b.setAttribute('aria-haspopup', 'dialog');
  // A press while it is open for this pie closes it. The popover's light
  // dismiss has already hidden it by the click, on pointerdown, so that is
  // read there; a key press has no pointerdown and finds it still open.
  let wasOpen = false;
  b.onpointerdown = () => { wasOpen = popFor === b && pop.matches(':popover-open'); };
  b.onclick = () => {
    if (wasOpen || (popFor === b && pop.matches(':popover-open'))) { wasOpen = false; pop.hidePopover(); return; }
    showBreakdown(m, t, b);
  };
  return b;
}

/** The one breakdown popover, made on first use, and the pie it was opened from. */
let pop = null;
let popFor = null;

/**
 * Every figure the line draws a part of, as a table under the pie: pull
 * requests open, merged and closed without merging, and issues open and
 * closed, then the pie's figure, saying what it leaves out. A popover rather
 * than a longer line or a tooltip: the line is already as long as a narrow
 * pane allows, and a tooltip is one line of words, where this is a table to
 * read across. `auto`, so Escape and a click anywhere else close it. One on
 * <body> for every line, anchored by CSS to the pie it was opened from, which
 * alone carries the anchor's name (`.milestone-pop` in style.css); Firefox 153
 * and Chromium 151 both anchor (checked 2026-10-24). A button inside a
 * <summary> takes its own click and keys, so a press does not fold the group
 * (checked in both, the same day).
 */
function showBreakdown(m, t, at) {
  if (!pop) {
    pop = document.body.appendChild(h('div', { className: 'milestone-pop', popover: 'auto' }));
    pop.setAttribute('role', 'dialog');
  }
  const cells = (row, ...ns) => h('tr', {}, h('th', { scope: 'row' }, row), ...ns.map((n) => h('td', {}, n)));
  const { open, merged, closed } = t.pulls;
  pop.setAttribute('aria-label', `${m.title}: what it holds`);
  pop.replaceChildren(
    h('p', { className: 'head' }, m.title, m.dueOn ? ` · due ${dueLabel(m.dueOn).title}` : ''),
    h('table', {},
      h('thead', {}, h('tr', {}, h('td'), ...['open', 'merged', 'closed'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, cells('pull requests', String(open), String(merged), String(closed)),
        cells('issues', String(t.issues.open), '–', String(t.issues.closed)))),
    h('p', {}, `${t.done} of ${t.total} done`
      + (closed ? `, leaving out the ${closed} ${several(closed, 'pull requests')} closed without merging` : '')));
  popFor?.style.removeProperty('anchor-name');
  popFor = at;
  at.style.setProperty('anchor-name', '--milestone-pie');
  pop.showPopover();
}

/**
 * Close the breakdown when a repaint -- a poll, a search, a new listing -- has
 * taken away the pie it hangs from, which would leave it anchored to nothing.
 * Each of the pane's three repaints calls this after it.
 */
function staleBreakdown() {
  if (popFor && !popFor.isConnected && pop.matches(':popover-open')) pop.hidePopover();
}

/**
 * What starts closed, as each listing lands. On the first, every group but
 * the mentions and the first in the drawn order with an issue on it, which is
 * the one to focus on: No milestone whenever it holds anything, since those
 * are the issues to triage, or else the first milestone in rank -- chosen
 * from every issue, not the ones a query typed before the listing came lets
 * through. On a later one, a milestone not had
 * before, such as one made on GitHub since, joins the rest folded. A group
 * opened or closed by hand is remembered over all of it.
 */
function seedGroups() {
  const keys = [NONE, ...rankMilestones(listing.milestones).map((m) => m.number)];
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
  // without a match is left out -- drawn, it said "no open issues" of a
  // milestone that has them.
  const state = (key) => (searching ? { open: true, onToggle: () => {} } : kept(closedGroups, key, 'closed'));
  const home = deps.home?.();
  // `list` is the group's issues and `rows` what they draw, which is more
  // than one element per issue once a row is open: the count is the issues'.
  // `target` is the milestone the group stands for -- a title, or null for
  // none -- and makes its summary somewhere an issue row can be dropped; a
  // closed milestone has none. No milestone with anything on it is marked as
  // the pile to triage (untriaged in style.css).
  const group = (key, title, list, rows, extra = [], target) => {
    const d = fold({
      className: target === null && list.length ? 'milestone untriaged' : 'milestone', dataset: { group: key }, title: [title, ' ', countBadge(list.length, 'issues', searching), ...extra.flatMap((e) => [' ', e])],
      ...state(key),
    }, list.length ? [h('ul', { className: 'items' }, ...rows)] : [h('p', { className: 'empty' }, 'no open issues')]);
    if (target !== undefined) dropTarget(d.querySelector('summary'), target);
    return d;
  };

  const out = [];
  // No milestone before the milestones: an issue on none is untriaged, and
  // could belong at any level, Critical included.
  const none = byMilestone.get(NONE) ?? [];
  if (!searching || none.length) out.push(group(`m:${NONE}`, 'No milestone', none, none.map((i) => issueRow(i)).flat(), triage(none), null));
  for (const m of ranked) {
    const title = home ? ext(`https://github.com/${home}/milestone/${m.number}`, m.title, { title: m.description || undefined }) : m.title;
    // A closed one is on the tab only because an open issue is still on it (repoIssues).
    const extra = milestoneExtra(m, 'issues');
    const list = byMilestone.get(m.number) ?? [];
    if (searching && !list.length) continue;
    // A closed one is on the tab for the issues still on it; nothing moves onto it.
    out.push(group(`m:${m.number}`, title, list, list.map((i) => issueRow(i)).flat(), extra, m.closed ? undefined : m.title));
  }
  if (!out.length) out.push(h('p', { className: 'empty' }, 'No open issues match.'));
  // When the listing was read, and that a read is out, as the PRs and
  // History tabs say it under their groups.
  out.push(h('p', { className: 'pull-note' },
    `Read ${age(new Date(issuesRead).toISOString())}${issuesLoading ? ' · updating…' : ''}`
    + (listing.listed < listing.total ? `. The ${listing.listed} most recently updated of ${listing.total} open issues.` : '')));
  return out;
}

/**
 * What a row is dragged onto a milestone by. A grip and not the row: a draggable
 * row takes a press on its title for a drag, so the title could not be selected
 * to copy, and every drag starting in it -- the #N link's, a selection's -- would
 * have been tagged as the row and moved it when dropped on a group.
 */
const dragGrip = () => h('span', { className: 'grip', draggable: true, ariaHidden: 'true', title: 'drag onto a milestone to move it there' }, '⠿');

/** `grip`'s drag as `row`'s: it carries `number` as `type`, and the row follows the pointer. */
function carries(grip, row, type, number) {
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(type, String(number));
    const at = row.getBoundingClientRect();
    e.dataTransfer.setDragImage(row, e.clientX - at.left, e.clientY - at.top);
    row.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => { row.classList.remove('dragging'); payGroups(); });
}

/**
 * An opened row's way to the move its drag makes, for the keyboard: a select of
 * none and every open milestone in rank, and Move. A closed milestone is listed
 * only to show that the row is on it, and cannot be picked -- the server refuses
 * a move onto it (heldMove) -- as a closed group's line is not somewhere to drop
 * a row.
 *
 * Written by Move, not on change. On Linux and Windows, Chromium and Firefox
 * fire change for every arrow key on a closed select, so stepping to a milestone
 * two down wrote the one in between to GitHub on the way. What a repaint does to
 * a choice not yet moved is put it back: nothing was written.
 */
function moveControl(name, number, current, ariaLabel) {
  const kind = MOVES[name];
  const pick = h('select', { className: 'milestone', ariaLabel, dataset: { move: String(number) } },
    h('option', { value: '' }, 'No milestone'),
    ...rankMilestones(kind.milestones()).filter((m) => !m.closed || m.number === current).map((m) => h('option',
      { value: m.title, selected: m.number === current, disabled: !!m.closed }, m.closed ? `${m.title} (closed)` : m.title)));
  const was = pick.value;
  const go = btn('Move', async () => {
    go.disabled = true;
    const from = pick.closest('[data-group]')?.dataset.group;
    await moveRow(name, number, pick.value || null);
    await kind.settled();
    // The repaint took the focus with it, and the row may have gone to a folded
    // group: the keyboard follows it there, unless it has since gone elsewhere.
    // A list with no groups (one of the PRs tab's) has only the row.
    const now = kind.row(number);
    if (tab !== name || !now || (document.activeElement && document.activeElement !== document.body)) return;
    const to = from && kind.group(now.milestone, from);
    if (to && !kind.searching() && closedGroups.delete(to)) kind.draw();
    document.querySelector(`#queue-body ${to ? `[data-group="${to}"]` : ''} select.milestone[data-move="${number}"]`)?.focus();
  }, { title: 'set this milestone on GitHub', disabled: true });
  pick.onchange = () => { go.disabled = pick.value === was; };
  return h('span', { className: 'move-to' }, pick, go);
}

/**
 * A group's summary as somewhere to drop a row: lit while one is over it, and
 * the drop is `mover(number, milestone)`. Only a grip's drag of `type` counts --
 * ISSUE on the Issues tab, PULL on Pull requests -- so a link or a text selection dragged across the pane is not a row, nor is a row from the
 * other tab.
 */
function dropTarget(summary, milestone, type = ISSUE, mover = move) {
  const carrying = (e) => e.dataTransfer.types.includes(type);
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
  // Dragged only on the Issues tab, where a milestone's line is a drop target.
  if (own) return issueRow(own, { drag: tab === 'issues' });
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
 * An issue the pull request closes, as a row on the PR #N tab: the listing's
 * own row when it is one of this repository's open issues, body and all, or
 * else the number and the title the description's links carry (withLinks in
 * github.js), with no state to look up -- GitHub's closing references are
 * open issues. Dimmed and under the Closes heading, since it is what the pull
 * request answers, and with no grip: nothing on this tab is dropped anywhere.
 */
function closesRow(i) {
  const own = listedAs(i);
  if (own) return issueRow(own, { closes: true, drag: false });
  const text = i.title ?? `#${i.number}`;
  return issueRow({ number: i.number, url: i.url, title: text, body: null }, {
    repo: i.repo ?? mentionRepo(i), kind: i.kind ?? 'issue', closes: true, drag: false, text,
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
function issueRow(i, { repo = null, kind = 'issue', closed = false, closes = false, drag = true, text = i.title } = {}) {
  // Shared between the Issues and PR #N tabs: a row opened on one is open on
  // the other, which is the same issue either way.
  const key = `${repo ?? ''}#${i.number}`;
  const open = expanded.has(key);
  const can = i.body != null;
  const disclose = can ? btn(open ? '▾' : '▸', () => {
    if (open) expanded.delete(key); else expanded.add(key);
    // Not held: this is the user's own click, which some browsers answer
    // without moving focus off another row's select.
    drawGroups();
  }, { className: 'disclose', title: open ? 'hide the issue' : 'show the issue', ariaExpanded: String(open) }) : h('span', { className: 'disclose' });
  // A listed issue can be dragged onto a milestone group; a mention that is
  // not listed cannot, since the move is held to the listing, and gets an empty
  // grip so the rows still line up.
  const grip = can && drag ? dragGrip() : h('span', { className: 'grip' });
  const row = h('li', { className: `item source${closed ? ' closed' : ''}${closes ? ' closes' : ''}`, dataset: { issue: String(i.number) } },
    grip,
    disclose,
    // With the repo when it is another's, as the item ↓ makes is tagged: the
    // link, ▶ and ↓ all go there, and docs/Security.md has ▶'s link match the tag.
    ext(i.url, refLabel({ issue: i.number, kind, repo }), { className: tagClass(kind) }),
    h('span', { className: 'text', textContent: i.title }),
    ...(i.labels ?? []).map((l) => h('span', { className: 'tag label' }, l)),
    actions(typeBtn(() => forClaude({ text, issue: i.number, repo, kind, issueUrl: i.url }, deps.home?.())), pullBtn(text, i.number, kind, repo)));
  if (can && drag) carries(grip, row, ISSUE, i.number);
  if (!open) return [row];
  const home = deps.home?.();
  const where = home ? { repo: `https://github.com/${home}`, ref: 'HEAD' } : null;
  const body = h('li', { className: 'issue-body md' },
    ...(i.body ? blocks(i.body).map((b) => blockNode(b, null, where)) : [h('p', { className: 'empty' }, 'No description.')]),
    h('div', { className: 'issue-ways' }, moveControl('issues', i.number, i.milestone, `milestone of #${i.number}`), ext(i.url, 'Open on GitHub', { className: 'primary open-issue' })));
  return [row, body];
}

/** A reference's chip, drawn as its kind (refClass), whose label also says `PR` (refLabel). */
const tagClass = (kind) => `tag ${refClass(kind)}`;

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
// And what a grip's drag carries, its row's number, for a milestone group to
// take; the same reason for a type of its own. One per tab, so the two tabs'
// groups take only their own rows.
const ISSUE = 'application/x-prcoder-issue';
const PULL = 'application/x-prcoder-pull';

/**
 * What differs between the two tabs that move a row onto a milestone: the route,
 * which listing holds its milestones and rows, and how that listing is painted
 * and read again.
 */
const MOVES = {
  issues: {
    route: '/api/issue/milestone',
    milestones: () => listing?.milestones ?? [],
    row: (number) => listed.get(number),
    paint: () => paintGroups(),
    draw: () => drawGroups(),
    read: () => loadIssues(true),
    settled: async () => { while (issuesLoading) await issuesLoading; },
    // The PR #N tab's mentions are drawn wherever a row's milestone says, so
    // a row moved from there is still in that group; from a milestone's
    // group on the Issues tab, it has gone.
    group: (milestone, from) => (from === 'mentioned' ? from : `m:${milestone ?? NONE}`),
    searching: () => query.trim(),
  },
  pulls: {
    route: '/api/pull/milestone',
    milestones: () => pullsListing?.milestones ?? [],
    row: (number) => pullsListing?.pulls.find((p) => p.number === number),
    paint: () => paintPulls(),
    draw: () => drawPulls(),
    read: () => loadPulls(true),
    settled: async () => { while (pullsLoading) await pullsLoading; },
    group: (milestone) => `p:${milestone ?? NONE}`,
    searching: () => pullQuery.trim(),
  },
};

/**
 * A row onto a milestone, or off one with null, on a drop or Move: the one write
 * each of the Issues and PRs tabs makes, which GitHub's own rules call
 * triage. The tab reads the listing again after, so the row moves group once
 * GitHub has it and not before -- asking again even when a listing is already
 * out, since that one was asked for before the write.
 *
 * After a refusal too. The listing the server holds the move to can differ from
 * the one drawn -- it starts empty after a restart, and a milestone can be
 * renamed on GitHub -- and left alone every move stays refused until the tab is
 * left and come back to. The repaint is for the row's select, which is still
 * showing what was refused, and which the listing may take seconds to put back.
 */
async function moveRow(name, number, milestone) {
  const kind = MOVES[name];
  // Off the select, or the repaint this is for would be held back until the
  // user next clicks somewhere (groupsInUse).
  if (document.activeElement?.closest?.('#queue-body .move-to')) document.activeElement.blur();
  // Where it already is: a row dropped on its own group, which is easily done
  // with the group's line just above it, is not worth a write and a re-list.
  const target = milestone === null ? null : kind.milestones().find((m) => m.title === milestone)?.number;
  if ((kind.row(number)?.milestone ?? null) === target) return;
  try {
    await api(kind.route, { number, milestone });
  } catch (e) {
    toast(e.message, true);
    kind.paint();
  }
  kind.read();
}
const move = (number, milestone) => moveRow('issues', number, milestone);
const movePull = (number, milestone) => moveRow('pulls', number, milestone);

/**
 * The repository's open pull requests, for picking the next one to work on:
 * the last listing first -- the server's, or the one `.prcoder/pulls.json`
 * kept from an earlier run -- so the tab opens at once, and then GitHub's
 * behind it, since the read is seconds long on a repository with many open,
 * unless the listing is under a minute old. `force` is the tab's ⟳, which
 * reads whatever the age. The listing on screen stays until the new one
 * lands, and stays if it does not; the note under the groups says which.
 *
 * Not a `visit` when the page opens (initQueue): the last listing is read
 * then too, so the tab's count is there before a visit -- a millisecond from
 * the file, or GitHub once in a clone that has none, which the file then
 * keeps -- but the fresh read behind it waits for a visit, since nobody is
 * looking yet.
 */
function loadPulls(force = false, { visit = true } = {}) {
  // A forced read asked for during another -- a move, whose write that read
  // was sent before -- runs once that one is in, as loadIssues's `again` does;
  // and a visit during the page-open read gets its age check once that is in.
  if (pullsLoading) {
    pullsStale ||= force;
    pullsVisit ||= visit;
    return pullsLoading;
  }
  pullsLoading = readPulls(force, visit).finally(() => {
    pullsLoading = null;
    paintPulls();
    if (pullsStale) {
      pullsStale = false;
      loadPulls(true);
    } else if (pullsVisit) {
      pullsVisit = false;
      loadPulls();
    }
  });
  return pullsLoading;
}

async function readPulls(force, visit) {
  pullsReading = true;
  try {
    if (!pullsListing) {
      // With nothing to open from, the server reads GitHub itself, and a
      // listing it answers is as fresh as the read below would be.
      try { pullsListing = await api('/api/pulls', { fresh: false }); } catch (e) { return toast(e.message, true); }
      paintPulls();
    }
    if (force || (visit && Date.now() - pullsListing.read >= PULLS_FRESH_FOR)) {
      paintPulls();
      try { pullsListing = await api('/api/pulls', { fresh: true }); } catch (e) { toast(e.message, true); }
    }
  } finally {
    pullsReading = false;
  }
}

/**
 * The groups and the tab's count repainted on their own, so the search box
 * keeps its focus. Exported for app.js, which calls it when git's answer about
 * a bare branch in a stack lands (loadBelow), as the PR pane is repainted then.
 */
const drawPulls = () => {
  groupsOwed = false;
  document.querySelector('#queue-body .pull-groups')?.replaceChildren(...pullGroups());
  staleBreakdown();
};

export function paintPulls() {
  // The count whatever tab shows -- the listing is read before a visit -- and
  // the groups only on this one.
  const t = document.querySelector('#queue-body .tab[data-tab="pulls"]');
  if (t) t.textContent = `${LABELS.pulls} (${pullCount()})`;
  if (tab !== 'pulls') return;
  if (groupsInUse()) groupsOwed = true; else drawPulls();
}

/**
 * The PRs tab: a search, the order within a group and whether to
 * group at all, ⟳, and the pull requests -- the ones on no milestone, to
 * triage, and then one group per open milestone in the owner's order
 * (rankMilestones), as the Issues tab groups, or one list. Each row carries what picking the next one turns
 * on (pullRow), opens to the description, can be typed to the coding agent
 * with its link (▶), copied into Local (↓), or checked out (Switch), and is
 * dragged by its grip onto a group to put it on that milestone.
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
    h('option', { value: 'none', selected: pullGroup === 'none' }, 'one list'),
    h('option', { value: 'stack', selected: pullGroup === 'stack' }, 'by stack'));
  grouping.onchange = () => { pullGroup = grouping.value; setPref(PULL_GROUP_KEY, pullGroup); paintPulls(); };
  const reload = btn('⟳', () => loadPulls(true), { className: 'pull-reload', title: 'read the pull requests again from GitHub', ariaLabel: 'read the pull requests again from GitHub' });
  return h('div', { className: 'pulls-pane' },
    h('div', { className: 'pull-controls' }, search, order, grouping, reload),
    groupsList('pull-groups', pullGroups()));
}

function pullGroups() {
  if (!pullsListing) return [h('p', { className: 'empty' }, 'Reading the repository\'s pull requests…')];
  const searching = !!pullQuery.trim();
  const rows = sortPulls(matchingPulls(), pullSort);
  const out = [];
  if (pullGroup !== 'milestone') {
    // By stack: the switcher's order (stackOrder), each pull request followed
    // by the ones built on it, indented a step deeper. The rows are sorted
    // first, and the walk keeps that order among siblings, so the roots and
    // each stack's branches both come in the chosen order. A parent the
    // search hides leaves its children roots of their own, which is what a
    // narrowed list should show. A stack cannot nest across milestone groups,
    // so this is a grouping of its own and not a mode of the other.
    const list = pullGroup === 'stack' ? stackOrder(rows) : rows.map((pr) => ({ pr, depth: 0 }));
    out.push(list.length ? h('ul', { className: 'items' }, ...list.flatMap(({ pr: p, depth }) => pullRow(p, depth)))
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
    // everything but the first group drawn with a pull request in it -- No
    // milestone when it has one, or else the first milestone in rank.
    if (!pullsSeeded) {
      pullsSeeded = true;
      const keys = [NONE, ...ranked.map((m) => m.number)];
      const focus = keys.find((k) => byMilestone.has(k)) ?? NONE;
      for (const key of keys) if (key !== focus) closedGroups.add(`p:${key}`);
    }
    const state = (key, list) => (searching ? { open: list.length > 0, onToggle: () => {} } : kept(closedGroups, key, 'closed'));
    const home = deps.home?.();
    const group = (key, title, list, extra, target) => {
      const d = fold({
        className: target === null && list.length ? 'milestone untriaged' : 'milestone', dataset: { group: key },
        title: [title, ' ', countBadge(list.length, 'pull requests', searching), ...extra.flatMap((e) => [' ', e])],
        ...state(key, list),
      }, list.length ? [h('ul', { className: 'items' }, ...list.map((p) => pullRow(p)).flat())] : [h('p', { className: 'empty' }, 'no open pull requests')]);
      if (target !== undefined) dropTarget(d.querySelector('summary'), target, PULL, movePull);
      return d;
    };
    const none = byMilestone.get(NONE) ?? [];
    out.push(group(`p:${NONE}`, 'No milestone', none, triage(none), null));
    for (const m of ranked) {
      const title = home ? ext(`https://github.com/${home}/milestone/${m.number}`, m.title, { title: m.description || undefined }) : m.title;
      // A closed one is listed only because an open pull request is still on it (repoPulls).
      const extra = milestoneExtra(m, 'pull requests');
      out.push(group(`p:${m.number}`, title, byMilestone.get(m.number) ?? [], extra, m.closed ? undefined : m.title));
    }
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
 * What a listed pull request is built on (stackUnder in pr.js), for its row and
 * the search alike. Asking git about a bare base is the row's to do (onBelow),
 * so this only reads. Kept per pull request until the listing, git's answers
 * or the default branch change: the search asks for every row on each
 * keystroke, two or three times over (the count, the groups), and each
 * stackUnder walks the list at every step down.
 */
let unders = null;
function underOf(p) {
  const pulls = pullsListing.pulls;
  const below = deps.below?.() ?? [];
  const def = deps.defaultBranch?.();
  if (!unders || unders.pulls !== pulls || unders.def !== def
    || unders.below.length !== below.length || unders.below.some((b, i) => b !== below[i])) {
    unders = { pulls, below, def, by: new Map() };
  }
  if (!unders.by.has(p.number)) unders.by.set(p.number, stackUnder({ pr: p }, pulls, below, def));
  return unders.by.get(p.number);
}

/**
 * The word a row shows for its state, and its class. GitHub's `ready` is
 * ready to merge into the base, which for a stacked pull request is the one
 * under it and not the default branch, so there it is `stacked (N)`, N the
 * steps that merge first -- pull requests, or now and then a bare branch. The
 * other words say more than that one does, and stay.
 */
const pullWord = (p, under) => (p.merge === 'ready' && under.nodes.length
  ? { word: `stacked (${under.nodes.length})`, cls: 'stacked' }
  : { word: p.merge, cls: p.merge ? wordClass(p.merge) : '' });

/**
 * One pull request as a row, and when the row is open, its milestone and its
 * ways out under it -- not its description, which is read on GitHub:
 * the row is for picking, and the lead says enough to pick by. The first line is `PR #N`, the title, what it is built on, and Switch; the second, under
 * the title, is what the choice turns on:
 * whether it can merge in a word, the review decision when there is one, its
 * size as a size label, XS to XXL (hover for the counts) coloured green to red by
 * band, the Files tab's pie (filled by changed lines viewed, so an empty
 * one is probably still being written and a full one is reviewed and waiting
 * on something else), its labels, `new` within a week of opening, whose it
 * is, and how long since it
 * was opened and last moved, a dot between each pair of plain words. Under
 * the line, the description's first paragraph, clipped to two lines and
 * through inline(), so its bold, code and links are drawn as the opened
 * description draws them rather than as their markdown; and under that the
 * issues it closes, each linked, with its milestone after it when that is not
 * the pull request's own -- the one on no milestone usually belongs where its
 * issue is, and one on the wrong milestone reads the same way. The chip is
 * the way to the pull request on GitHub (the title is not a second one), and
 * switching is the other thing a row is for, so the one on screen is marked
 * `here` right after its title and every other row has the PR pane's Switch
 * there, under its guard, in sight; ▶ and ↓ wait on hover at the end, as every
 * queue row's do.
 */
function pullRow(p, depth = 0) {
  const key = `pull:${p.number}`;
  const open = expanded.has(key);
  const here = !!pr && pr.url === p.url;
  const now = Date.now();
  const home = deps.home?.();
  const where = home ? { repo: `https://github.com/${home}`, ref: 'HEAD' } : null;
  const disclose = btn(open ? '▾' : '▸', () => {
    if (open) expanded.delete(key); else expanded.add(key);
    // Not held, as an issue row's (issueRow): this is the user's own click.
    drawPulls();
  }, { className: 'disclose', title: open ? 'hide its milestone and ways out' : 'show its milestone and ways out', ariaExpanded: String(open) });
  const review = REVIEW[p.reviewDecision];
  // `p.milestone` is a number and an issue's is a title (pullRow in github.js).
  const mine = pullsListing.milestones.find((m) => m.number === p.milestone)?.title ?? null;
  const closes = (p.closes ?? []).length ? h('p', { className: 'pull-closes' }, 'Closes ', ...(p.closes).flatMap((i, n) => [
    n ? ', ' : '', ext(i.url ?? `https://github.com/${home}/issues/${i.number}`, `#${i.number} ${i.title}`),
    i.milestone && i.milestone !== mine ? ` (${i.milestone})` : ''])) : null;
  const blocked = deps.blocked?.() ?? false;
  const files = `${p.changedFiles ?? 0} file${p.changedFiles === 1 ? '' : 's'}`;
  const go = () => (here ? null : btn('Switch', () => deps.onSwitch?.(p.url), {
    className: 'pr-go', disabled: blocked,
    title: blocked ? 'Commit or stash your changes first' : `Check out #${p.number} here`,
  }));
  const classes = ['item', 'source', 'pull', here ? 'here' : '', pullGroup === 'milestone' ? 'gripped' : ''].filter(Boolean).join(' ');
  // What it is built on, nearest first, down to the branch the bottom one
  // merges into: `on main`, or `on #13 › #12 › main`. The first word says
  // whether it can merge straight away, and the rest how far the stack runs.
  // Each #N is a link to that pull request on GitHub -- another pull request,
  // not a second way to this one -- with its title on hover. A base with no
  // open pull request is a bare branch, and what is under that is git's to
  // say: the row asks as the PR pane's Stack tab asks (onBelow), draws the
  // line as far as it goes meanwhile, and is painted again when the answer
  // lands. Nothing until the status has said which branch is the default.
  // Nothing at a depth either: by stack, the indent already says it.
  // A stacked one's line is `.stacked`, and each #N in it the tinted chip the
  // row's own `PR #N` is, so a stack stands out where `on main` stays quiet.
  const under = underOf(p);
  if (under.ask) deps.onBelow?.(under.ask);
  const stack = !depth && (under.nodes.length || under.into) ? h('span', { className: under.nodes.length ? 'pr-stack stacked' : 'pr-stack' }, 'on ', ...[
    ...under.nodes.slice().reverse().map((n) => (n.pr ? ext(n.pr.url, `#${n.pr.number}`, { className: 'tag pull', title: n.pr.title }) : h('code', { className: 'branch' }, n.branch))),
    ...(under.into ? [h('code', { className: 'branch' }, under.into)] : []),
  ].flatMap((node, i) => (i ? [' › ', node] : [node]))) : null;
  // The facts, each marked plain (a word) or not (a chip, the pie): a dot goes
  // between two plain neighbours and nowhere near a chip, as linkRow (pr.js)
  // sets dots -- a chip's border already separates it.
  // In three runs: the state (the merge word, the review), then what makes
  // this one worth taking or not (the size, coloured by band, the pie, labels,
  // new), then whose it is and when.
  const size = sizeChip(p.lines);
  const state = pullWord(p, under);
  const facts = [
    [state.word ? h('span', { className: `pr-merge ${state.cls}` }, state.word) : null, true],
    [review ? h('span', { className: 'pr-review' }, review) : null, true],
    [h('span', { className: `size ${size.toLowerCase()}`, title: `+${p.additions ?? 0} −${p.deletions ?? 0} · ${files}` }, size), false],
    [p.viewed ? mark({ p: p.viewed.p, full: p.viewed.full, label: p.viewed.label }) : null, false],
    ...(p.labels ?? []).map((l) => [h('span', { className: 'tag label' }, l), false]),
    [isNew(p, now) ? h('span', { className: 'tag new' }, 'new') : null, false],
    [p.author ? h('span', { className: 'who', title: 'opened by' }, p.author) : null, true],
    [h('span', { className: 'age', title: `opened ${p.createdAt ?? ''}` }, `opened ${age(p.createdAt, now)}`), true],
    [h('span', { className: 'age', title: `last updated ${p.updatedAt ?? ''}` }, `updated ${age(p.updatedAt, now)}`), true],
  ].filter(([node]) => node);
  // `depth` is the by-stack list's indent, a CSS variable the row and its
  // opened body both carry (--depth), so the body stays under its row.
  // Only where there are groups to drop it on.
  const grip = pullGroup === 'milestone' ? dragGrip() : null;
  const row = h('li', { className: classes, dataset: { pull: String(p.number) }, style: `--depth:${depth}`, ...(here && { ariaCurrent: 'true' }) },
    grip,
    disclose,
    ext(p.url, `PR #${p.number}`, { className: 'tag pull' }),
    // The title and what follows it in one box, so a long title wraps inside it
    // and Switch follows its last word; apart, the title took a line of its own.
    h('span', { className: 'pull-title' }, h('span', { className: 'text', textContent: p.title }), ' ', stack, stack ? ' ' : null,
      here ? h('span', { className: 'tag here', title: 'the pull request on screen' }, 'here') : go()),
    actions(typeBtn(() => forClaude({ text: p.title, issue: p.number, repo: null, kind: 'pull', issueUrl: p.url }, home)), pullBtn(p.title, p.number, 'pull', null)),
    h('div', { className: 'pr-facts' }, ...facts.flatMap(([node, plain], i) => [i && plain && facts[i - 1][1] ? h('span', { className: 'sep' }, '·') : null, node])),
    p.lead ? h('p', { className: 'pr-lead', innerHTML: inline(p.lead, where) }) : null,
    closes);
  if (grip) carries(grip, row, PULL, p.number);
  if (!open) return [row];
  const body = h('li', { className: 'issue-body md', style: `--depth:${depth}` },
    h('div', { className: 'issue-ways' }, moveControl('pulls', p.number, p.milestone, `milestone of pull request #${p.number}`), go(), ext(p.url, 'Open on GitHub', { className: 'primary open-issue' })));
  return [row, body];
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

  // Named by the item, as the grip is. Its text can be edited in place, but an
  // edit ends in save(), which redraws this row whether or not it was accepted.
  const box = h('input', { type: 'checkbox', checked: item.done, ariaLabel: item.text });
  box.onchange = () => { item.done = box.checked; save(); };

  const text = h('span', { className: 'text', contentEditable: 'true', textContent: item.text });
  text.onblur = () => { if (text.textContent.trim() !== item.text) { item.text = text.textContent.trim(); save(); } };
  text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };

  // The tag before the text, as every source row and the PR pane's Closes list
  // draw it: after a text that takes the row's width it sat at the far right,
  // beside the buttons, away from the words it labels.
  const li = h('li', { className: 'item', draggable: ordered },
    ordered ? grip : null,
    box,
    item.issue ? ext(item.issueUrl ?? '#', refLabel(item), { className: tagClass(item.kind) }) : null,
    text,
    actions(
      // Typed, not sent: the turn is left in the prompt for you to edit, which
      // is the whole of what prcoder puts into a session (docs/Design.md).
      // Handing it over is what doing an item looks like here, so it ticks the
      // box the way finishing it would: the row leaves Local for Completed, and
      // the Local tab stays a list of what has not been handed over yet. Not a
      // delete -- Completed is where you go to see what you handed over, and its
      // own checkbox puts an item back if the agent turned out not to do it.
      //
      // Only if it went (typeBtn): an item ticked off after a refused send is
      // work nobody has done and nothing will remind you of. The text is read
      // at the click, since an edit can change it after the row is drawn.
      //
      // With the link to the issue or PR it is about, where the text does not
      // already say which (forClaude in items.js).
      typeBtn(() => forClaude(item, deps.home?.()), {
        title: 'type into the coding agent, and check it off',
        then: () => { item.done = true; save(); },
      }),
      // A move, not a flag: the issue is filed and the item leaves the queue.
      // Nothing moves into the PR description -- prcoder does not write one,
      // bar a box you tick on the PR #N tab. Disabled while the issue is filed: a
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
  const host = document.getElementById('queue-list');
  host.scrollTop = addTo === 'top' ? 0 : host.scrollHeight;
  return true;
}
