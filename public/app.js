import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { renderPr, renderNoPr, renderHeader, renderQueueSync, pageTitle, api, toast } from './pr.js';
import { openDiff, closeDiff, selectedPath } from './diff.js';
import { initQueue, addItem, setItems, freeze } from './queue.js';
import './panes.js';   // draggable pane gutters; nothing here calls into it

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 14,   // one step up from the default, matching the panes' 14px body
  cursorBlink: true,
  theme: { background: '#1c1f26', foreground: '#d5d9e0' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
term.open(document.getElementById('term-host'));

const PTY_SEEN = 'prcoder:pty';
const ws = new WebSocket(`ws://${location.host}/pty`);
const send = (msg) => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
};

// A splitter drag resizes #term-host on every frame, but the PTY only cares
// when the character grid changes — which is every few pixels at most. `sent`
// records what the *server* was told, so a resize dropped while the socket was
// still opening is re-sent by the sync() in ws.onopen rather than skipped.
let sent = '';
const sync = () => {
  fit.fit();
  const dims = `${term.cols}x${term.rows}`;
  if (dims !== sent && send({ type: 'resize', cols: term.cols, rows: term.rows })) sent = dims;
};

ws.onmessage = (e) => term.write(e.data);
// A tab the browser unloaded in the background comes back as a fresh page, and
// the socket it closed on the way out has already killed the PTY — so this is a
// new Claude session nobody asked for. sessionStorage is per-tab and survives
// the restore, which is exactly what tells that apart from a first open. A
// deliberate reload lands here too, and the message is just as true there.
ws.onopen = () => {
  sync();
  term.focus();
  try {
    if (sessionStorage.getItem(PTY_SEEN)) {
      // Not the error style: the session did end, but on a deliberate reload
      // that is the answer to what you just did, not something that went wrong.
      toast('Claude was restarted — this tab\'s previous session ended when it disconnected. '
        + '/resume picks it back up, or start prcoder with --continue.');
    }
    sessionStorage.setItem(PTY_SEEN, '1');
  } catch { /* private mode: no memory, so no claim about a previous session */ }
};
ws.onclose = () => term.write('\r\n\x1b[31m[claude exited — reload to restart]\x1b[0m\r\n');

term.onData((d) => send({ type: 'input', data: d }));
new ResizeObserver(sync).observe(document.getElementById('term-host'));

// Type an item into Claude's prompt. If Claude is mid-turn it queues the
// message itself, which is exactly the behaviour we want.
function sendToClaude(text) {
  send({ type: 'input', data: text + '\r' });
  term.focus();
}

const setViewed = (path, viewed) => api('/api/pr/viewed', { path, viewed });

// The switcher only changes when PRs are opened or closed, so it is not worth a
// call every minute — page load and opening the dropdown are enough.
let prs = [];
let last = null;
const loadPrs = () => api('/api/prs', undefined, 'GET')
  .catch(() => [])   // the switcher is a convenience; a failure is not a banner
  // Repaint, or a PR opened since page load stays invisible until the next
  // poll — the switcher only rebuilds its options when the set changes.
  .then((l) => { prs = l; if (last) renderHeader(last, prs, handlers); });
document.getElementById('pr-switch').addEventListener('mousedown', loadPrs);

const NOTES = {
  'other-branch': 'Not checked out — this pull request is on another branch.',
  'other-repo': 'This pull request is in another repository.',
};

/**
 * A checkbox in the description, ticked through to GitHub. Rethrown so the box
 * snaps back, and the status reload is for the one error that matters: the
 * description moved under us, and the pane is now showing a stale copy of it.
 */
async function toggleTask(task) {
  try {
    const { queue } = await api('/api/pr/task', task);
    // Only when the line was one of the queue's own, so the two panes agree
    // without waiting for the poll.
    if (queue) setItems(queue, true);
  } catch (e) {
    toast(e.message, true);
    loadStatus();
    throw e;
  }
}

const fileHandlers = {
  onViewed: setViewed,
  onOpen: (f) => openDiff(f, { onViewed: setViewed }),
  onTask: toggleTask,
};

function paint(status) {
  const moved = last?.pr?.headRefOid !== status.pr?.headRefOid;
  last = status;
  // Named for the tab strip, not the page: which PR, in which repo. A poll
  // that fails leaves the last good name up rather than reverting to
  // "prcoder", which is why this is here and not in loadStatus's catch.
  document.title = pageTitle(status);
  renderHeader(status, prs, handlers);
  renderQueueSync(status);
  if (status.pr) {
    renderPr({ ...status.pr, note: NOTES[status.scope] },
      { ...fileHandlers, selected: selectedPath() });
  } else renderNoPr(status, { onCreate: createPr });
  // Mirroring needs the PR to be *this* branch's: prcoder will not write our
  // items into a PR we are only looking at, so the controls that would ask it
  // to must disable themselves rather than silently do nothing.
  if (status.queue) setItems(status.queue, status.scope === 'current');

  // Keep an open diff honest: close it if its file left the PR (or the PR
  // switched away), refresh it if the branch moved — the server cache is
  // keyed by head oid, so a re-open shows the freshly pushed version.
  const open = selectedPath();
  if (!open) return;
  const f = status.pr?.files.find((x) => x.path === open);
  if (!f) closeDiff();
  else if (moved) openDiff(f, { onViewed: setViewed });
}

/**
 * A failed fetch must not read as "no pull request" — that is a real state with
 * its own UI, and a laptop on a train would hit it every minute.
 */
let polledAt = 0;
async function loadStatus() {
  polledAt = Date.now();
  try {
    paint(await api('/api/status', undefined, 'GET'));
  } catch (e) {
    const failed = { error: e.message, dirtyFiles: [], pr: null };
    renderHeader(failed, prs, handlers);
    renderQueueSync(failed);
  }
}

async function switchPr(number) {
  freeze(true);
  try {
    const status = await api('/api/pr/switch', { number });
    paint(status);
    // Claude's cwd survives a checkout, but its idea of the files does not, and
    // nothing tells it: prcoder has no channel into the session that isn't a
    // typed user turn (issue #21). So this is addressed to you, not to Claude,
    // and it is sticky because it stays true until you have said something.
    toast(`Switched to ${status.branch} (#${number}). Claude still has the old`
      + " branch's files in mind — tell it to re-read anything it had open.",
    false, true);
  } catch (e) {
    toast(e.message, true);
    await loadStatus();   // re-derive: the checkout may have half-succeeded
  } finally {
    freeze(false);
  }
}

async function createPr(btn) {
  // Opened before the await, or the popup blocker eats it.
  const win = window.open('', '_blank');
  btn.disabled = true;
  try {
    const { url, pushed } = await api('/api/pr/create');
    win.location = url;
    if (pushed) toast('Pushed this branch to origin first.');
  } catch (e) {
    win.close();
    toast(e.message, true);
  }
  btn.disabled = false;
}

const askClaudeToCommit = (files) =>
  sendToClaude(`Commit the current changes: ${files.join(', ')}`);

const handlers = { onSwitch: switchPr, onCommit: askClaudeToCommit };

document.getElementById('pr-refresh').onclick = loadStatus;

// Polling is the client's job: no server timer, and a hidden tab costs nothing.
setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 60_000);
// Coming back to the tab polls too, but not one that just ran: a poll is a gh
// call plus half a dozen git spawns behind the server's serial lock, and
// alt-tabbing to Claude and back is a thing you do every few seconds.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - polledAt > 10_000) loadStatus();
});

const input = document.getElementById('queue-input');
input.addEventListener('keydown', (e) => {
  // Shift-Enter is the newline; plain Enter still saves, which is the whole
  // reason this is a textarea with a key handler rather than a form.
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  addItem(input.value);
  input.value = '';
  grow();
});
/** One line until it needs more, then up to a third of the pane. */
const grow = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
};
input.addEventListener('input', grow);

// Not awaited: the switcher's list is a whole `gh pr list` and nothing below
// needs it — renderHeader synthesises an option for the current PR until it
// lands, and loadPrs repaints the header itself when it does.
loadPrs();
await initQueue({ sendToClaude });
loadStatus();
