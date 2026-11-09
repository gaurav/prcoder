// The queue pane's History tab: what you sent the coding agent from this
// working copy, by day and by session, with times -- for coming back after a
// break and asking what you were doing, whether the tests are written, whether
// /code-review has been run. The server reads it from Claude Code's own file
// (history.js at the root); nothing here records anything.
//
// Imported by queue.js, which test/queue-pane.test.js loads in Node, so
// nothing at module scope touches the DOM (public/CLAUDE.md).

import { h, btn, api, toast, kept, fold } from './ui.js';
import { byDay, dayKey, timeLabel, commandOf, historyMatches } from './items.js';

export const LABEL = 'History';

// The queue's two ways out of a row, handed over by initQueue (queue.js): `type`
// puts text into the coding agent's prompt, unsent, and says whether it went;
// `pull` copies text into Local. Through a hook rather than an import, since
// queue.js imports this file and the reverse would be a cycle.
let ways = {};
export function initHistory(w) { ways = w; }

// /api/history's answer -- prompts newest first, the sessions' titles, and
// `read`, when, in ms -- or null before the first; `failed` is why the last
// read did not land, shown in place of the groups.
let listing = null;
let failed = null;
// The read out, for a tab opened again while one is running.
let loading = null;
let query = '';
// The days folded shut, kept across repaints and not across a reload, as the
// Issues tab's groups are. Everything after the second day starts closed: the
// question is what happened today and last night, and the rest is there to
// open. A day seen is remembered so a later read does not fold it again.
const closedDays = new Set();
const seen = new Set();
// Rows opened past the three-line clamp.
const opened = new Set();

const now = () => Date.now();

/**
 * The tab's count: the prompts sent today, `…` before the first read, `?`
 * after one that failed, and the matches while searching.
 */
export const historyCount = () => {
  if (!listing) return failed ? '?' : '…';
  if (query.trim()) return matching().length;
  const today = dayKey(now());
  return listing.prompts.filter((p) => dayKey(p.at) === today).length;
};

const matching = () => (listing?.prompts ?? []).filter((p) => historyMatches(p, query));

/**
 * Read the history, once per visit unless `force` (the tab's ⟳, and a prompt
 * sent while the tab is showing). A read already out is shared. The groups
 * on screen stay until the new listing lands, and stay if it does not.
 */
export function loadHistory(force = false) {
  if (loading) return loading;
  if (listing && !force) return Promise.resolve();
  loading = api('/api/history').then((h) => {
    failed = null;
    listing = h.enabled ? h : { prompts: [], sessions: {}, read: now() };
  }, (e) => {
    failed = e.message;
    if (!listing) toast(`Could not read the prompt history: ${e.message}`, true);
  }).finally(() => {
    loading = null;
    paintHistory();
  });
  return loading;
}

/**
 * The newest prompt, for the notice the Claude pane puts up when the agent
 * connects (lastPromptNotice in app.js): after a read, forced, since after
 * Start in the exit bar it is the prompt the session died on that is wanted,
 * and loadHistory(true) joins a read already out -- on opening the page,
 * setHistoryOn's. Null with nothing sent, or nothing readable.
 */
export async function lastPrompt() {
  await loadHistory(true);
  return listing?.prompts?.[0] ?? null;
}

/**
 * A prompt was just sent from this page: once Claude Code has written it,
 * the file is read again, so the tab's count and, when it is showing, its
 * list do not lag behind the terminal beside them. A second, since the file
 * is written as the turn starts. Nothing when nothing has ever been read:
 * the tab is off, and there is no count to keep.
 */
export function historyStale() {
  if (!listing && !failed && !loading) return;
  setTimeout(() => loadHistory(true), 1000);
}

/**
 * The tab's count, and the groups when the tab is showing, repainted on
 * their own, so the search box keeps its focus. The count whatever tab
 * shows: the file is read before a visit (setHistoryOn in queue.js).
 */
export function paintHistory() {
  const t = document.querySelector('#queue-body .tab[data-tab="history"]');
  if (t) t.textContent = `${LABEL} (${historyCount()})`;
  document.querySelector('#queue-body .history-pane .history-groups')?.replaceChildren(...historyGroups());
}

/**
 * The tab: a search over the prompts' text, ⟳, and the days, each a fold of
 * its sessions, each session its prompts. A row's ▶ types its prompt back into
 * the agent, unsent, as every queue row's ▶ types (docs/Security.md, "Nothing
 * sends to Claude without a click"): the prompt is one the user already sent.
 */
export function historyList() {
  const search = h('input', {
    id: 'queue-history-search', type: 'search', placeholder: 'Search what was sent', value: query,
    autocomplete: 'off', spellcheck: false, ariaLabel: 'search the prompts sent to the coding agent',
  });
  search.oninput = () => { query = search.value; paintHistory(); };
  const reload = btn('⟳', () => loadHistory(true), { className: 'history-reload', title: 'read the prompt history again', ariaLabel: 'read the prompt history again' });
  return h('div', { className: 'history-pane' },
    h('div', { className: 'pull-controls' }, search, reload),
    h('div', { className: 'history-groups' }, ...historyGroups()));
}

function historyGroups() {
  if (!listing && failed) {
    return [h('p', { className: 'empty' }, `Could not read the prompt history: ${failed} `,
      btn('try again', () => loadHistory(true), { title: 'read the prompt history again' }))];
  }
  if (!listing) return [h('p', { className: 'empty' }, 'Reading what was sent to the coding agent…')];
  if (!listing.prompts.length) return [h('p', { className: 'empty' }, 'Nothing sent to the coding agent from this working copy yet.')];
  const searching = !!query.trim();
  const days = byDay(matching(), now());
  if (!days.length) return [h('p', { className: 'empty' }, 'No prompts match.')];
  // While searching every day with a match is open, without touching what was
  // chosen: fold() reports its initial state too.
  if (!searching) {
    for (const [n, d] of days.entries()) {
      if (seen.has(d.key)) continue;
      seen.add(d.key);
      if (n > 1) closedDays.add(d.key);
    }
  }
  const state = (key) => (searching ? { open: true, onToggle: () => {} } : kept(closedDays, key, 'closed'));
  const out = days.map((d) => {
    const n = d.sessions.reduce((sum, s) => sum + s.rows.length, 0);
    return fold({
      className: 'day', dataset: { group: d.key },
      title: [d.label, ' ', h('span', { className: 'count', title: `${n} prompt${n === 1 ? '' : 's'}${searching ? ' matching' : ''}` }, String(n))],
      ...state(d.key),
    }, d.sessions.map((s) => session(s)));
  });
  if (listing.skipped) {
    out.push(h('p', { className: 'pr-note' }, `${listing.skipped} line${listing.skipped === 1 ? '' : 's'} of the history file could not be read as a prompt.`));
  }
  return out;
}

/**
 * One session's prompts under its heading: the title Claude Code gave it, or
 * the time its first prompt of the day was sent; and where it ran, when that
 * was a worktree under data/ rather than the working copy itself.
 */
function session(s) {
  const title = listing.sessions[s.id]?.title;
  const first = s.rows[s.rows.length - 1];
  const where = first.where ? h('span', { className: 'where', title: 'the worktree this session ran in' }, ` in ${first.where}`) : null;
  return h('div', { className: 'session' },
    h('h4', { className: title ? 'titled' : '' }, title ?? `Session from ${timeLabel(first.at)}`, where),
    h('ul', { className: 'items' }, ...s.rows.map((p) => row(p))));
}

/**
 * A prompt: when, then its text as typed, clamped to three lines until
 * clicked (a click that selected something is a selection, not a toggle),
 * then the row's ways out in the order every queue row keeps them: ▶ types
 * the prompt into the agent again, unsent, to edit and send -- the way back
 * into the task a session died on; ↓ copies it into Local, untagged, for a
 * prompt worth sending again later; ⧉ puts it on the clipboard. A slash
 * command is marked by its word.
 */
function row(p) {
  const key = `${p.session}:${p.at}`;
  const command = commandOf(p.text);
  const rest = command ? p.text.trimStart().slice(command.length) : p.text;
  const text = h('div', { className: 'text', title: opened.has(key) ? 'show less' : 'show the whole prompt' },
    command ? h('span', { className: 'cmd' }, command) : null, rest);
  const li = h('li', { className: `item history${command ? ' command' : ''}${opened.has(key) ? ' open' : ''}` },
    h('span', { className: 'when', title: new Date(p.at).toLocaleString('en', { dateStyle: 'full', timeStyle: 'short' }) }, timeLabel(p.at)),
    text,
    h('span', { className: 'actions' },
      btn('▶', () => ways.type?.(p.text), { title: 'type this prompt into the coding agent again, to edit and send', ariaLabel: 'type this prompt into the coding agent again, to edit and send' }),
      btn('↓', () => ways.pull?.(p.text), { title: 'copy into your queue', ariaLabel: 'copy this prompt into your queue' }),
      copyButton(p.text)));
  text.onclick = () => {
    if (!getSelection()?.isCollapsed) return;
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    li.classList.toggle('open', opened.has(key));
    text.title = opened.has(key) ? 'show less' : 'show the whole prompt';
  };
  return li;
}

// As the diff header's ⧉ (app.js): a ✓ for a moment to say it went, and a
// toast when the browser refused the clipboard.
function copyButton(text) {
  const b = btn('⧉', async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return toast('The browser refused the clipboard — the prompt was not copied.', true);
    }
    b.textContent = '✓';
    setTimeout(() => { b.textContent = '⧉'; }, 1200);
  }, { className: 'copy', title: 'copy this prompt', ariaLabel: 'copy this prompt' });
  return b;
}
