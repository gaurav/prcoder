import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { renderPr, renderNoPr, renderHeader, pageTitle, api, toast } from './pr.js';
import { openDiff, closeDiff, selectedPath, setViewed } from './diff.js';
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
  // A line sent is the start of a turn -- Enter in the terminal, or an item
  // sent from the queue, which appends its own. See the tab icon below.
  if (msg.type === 'input' && msg.data.endsWith('\r')) turn(true);
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

// The tab icon, blue while a turn is running, so a session left in a
// background tab says whether it is still going without switching to it.
// The PTY carries no "thinking" signal and nothing here reads the frames, so a
// turn is bracketed rather than detected: sending a line starts one, and the
// output holds it open. Claude repaints its spinner every few hundred ms
// mid-turn -- measured 2026-09-11 against a turn with a 12s tool call in it, no
// gap ran over 750ms until the turn ended -- so 2s of quiet is the end of one.
//
// Output cannot *start* a turn, because a PTY echoes what is typed at it:
// Claude repainting its prompt as you type is output too, and keying off that
// alone turned the icon busy while it was waiting on the operator -- which is
// the one state it exists to tell apart.
//
// Amber is deliberately not used: it is held for the third state, "stopped to
// ask you something", which prcoder cannot see yet -- issue #51.
//
// One sequence has to come out of the signal even so, because it is a question
// rather than output, and it arrives *during* a turn where the bracketing above
// cannot help: Claude asks the terminal where the cursor is (DSR,
// `ESC [ ? 6 n`) every ~200ms for as long as the session is up, and xterm
// answers every one, so the stream is never quiet for two seconds and a turn
// once started never ended. It only happens against a terminal that answers:
// measured 2026-09-12 against a bare PTY with nothing replying, Claude asks
// once and never again, which is why a driver on a `cat` stub saw nothing
// wrong. Dropping a frame that is nothing but probes is not parsing the TUI --
// it is a question for the terminal, answered by the terminal, and this never
// looks at anything Claude drew.
const PROBE = /^(?:\x1b\[\?6n)+$/;
const link = document.querySelector('link[rel=icon]');
// Derived, not written out a second time -- so the icon in index.html stays the
// one definition of it. Change its colour there and change this to match.
const IDLE = link.href;
const BUSY = IDLE.replace('%23238636', '%231f6feb');
// Re-inserted rather than mutated in place: browsers disagree about whether an
// href changed on a live <link rel=icon> is noticed at all.
// Tracked here rather than read back off the element: `link.href` returns the
// URL re-resolved, and a compare against that is a compare against something
// the browser wrote, not something this did.
let shown = IDLE;
const icon = (href) => {
  if (shown === href) return;
  shown = link.href = href;
  link.remove();
  document.head.append(link);
};
let quiet;
const turn = (on) => {
  clearTimeout(quiet);
  icon(on ? BUSY : IDLE);
  // ponytail: typing during a turn echoes, and the echo holds the turn open, so
  // busy can outlast the turn's real end by as long as you keep typing. Closing
  // that needs what the frames say rather than when they arrive -- see #51,
  // which is the same wall from the other side.
  if (on) quiet = setTimeout(() => icon(IDLE), 2000);
};
ws.onmessage = (e) => {
  term.write(e.data);
  if (PROBE.test(e.data)) return;
  if (shown === BUSY) turn(true);   // holds an open turn open; cannot start one
};
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
ws.onclose = () => {
  turn(false);
  term.write('\r\n\x1b[31m[claude exited — reload to restart]\x1b[0m\r\n');
};

term.onData((d) => send({ type: 'input', data: d }));
new ResizeObserver(sync).observe(document.getElementById('term-host'));

// Type an item into Claude's prompt. If Claude is mid-turn it queues the
// message itself, which is exactly the behaviour we want.
//
// `submit` false types the text and stops there: the prompt is left ready to
// edit and send by hand, which is what the queue's ▶ wants. Trailing
// whitespace is cut either way -- a newline in the text *is* the Enter that
// would have sent it half-written.
//
// Whether it went is the return value, because the queue ticks an item off on
// the strength of it: `send` refuses on a socket that is not open -- a dead PTY,
// a reload in flight -- and an item checked off after a refused send is one
// nobody has done and nobody is going to be reminded of.
function sendToClaude(text, submit = true) {
  const sent = send({ type: 'input', data: text.replace(/\s+$/, '') + (submit ? '\r' : '') });
  term.focus();
  return sent;
}

// The switcher only changes when PRs are opened or closed, so it is not worth a
// call every minute — page load, opening the dropdown, and a checkout are
// enough. The branch-only pane's list of what merges into this branch comes out
// of the same array, and is as fresh as that.
let prs = [];
let last = null;
const loadPrs = () => api('/api/prs', undefined, 'GET')
  .catch(() => [])   // the switcher is a convenience; a failure is not a banner
  // Repaint, or a PR opened since page load stays invisible until the next
  // poll — the switcher only rebuilds its options when the set changes. The
  // whole status, because the branch-only pane reads this list too; `last` is
  // already the branch this fetch was for, so nothing asks for it again.
  .then((l) => { prs = l; if (last) paint(last); });
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
    const { body } = await api('/api/pr/task', task);
    // The PR pane and the queue's PR tab both draw these boxes; a tick in one
    // has to show in the other without waiting for the poll.
    if (last?.pr) {
      last.pr.body = body;
      paint(last);
    }
  } catch (e) {
    toast(e.message, true);
    loadStatus();
    throw e;
  }
}

const fileHandlers = {
  onViewed: setViewed,
  onOpen: openDiff,
  onTask: toggleTask,
};

function paint(status) {
  const moved = last?.pr?.headRefOid !== status.pr?.headRefOid;
  // A checkout is the one thing that changes which pull requests merge into the
  // branch under you, and the branch-only pane lists them. Refreshed here rather
  // than on the poll, which is the whole reason that list is affordable.
  // `last &&`, or the first paint counts as a change and fetches the list a
  // second time behind the one the page load already asked for.
  const switched = last && last.branch !== status.branch;
  last = status;
  // Named for the tab strip, not the page: which PR, in which repo. A poll
  // that fails leaves the last good name up rather than reverting to
  // "prcoder", which is why this is here and not in loadStatus's catch.
  document.title = pageTitle(status);
  renderHeader(status, prs, handlers);
  if (status.pr) {
    renderPr({ ...status.pr, note: NOTES[status.scope] },
      { ...fileHandlers, selected: selectedPath() });
  } else renderNoPr(status, prs, { onCreate: createPr, onSwitch: switchPr });
  if (switched) loadPrs();
  // Moving an item in needs the PR to be *this* branch's: prcoder will not write
  // into a PR we are only looking at, so the controls that would ask it to must
  // disable themselves rather than silently do nothing. Reading its checklist
  // into the PR tab needs only a PR on screen.
  if (status.queue) setItems(status.queue, status.scope === 'current', status.pr);

  // Keep an open diff honest: close it if its file left the PR (or the PR
  // switched away), refresh it if the branch moved — the server cache is
  // keyed by head oid, so a re-open shows the freshly pushed version.
  const open = selectedPath();
  if (!open) return;
  const f = status.pr?.files.find((x) => x.path === open);
  if (!f) closeDiff();
  else if (moved) openDiff(f);
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
  // Opened before the await, or the popup blocker eats it. Blocked outright and
  // this is null -- which used to throw on `win.location`, throw again on
  // `win.close()` inside the catch, and leave the button disabled for good with
  // nothing said. The request is still worth making; only the tab is lost.
  const win = window.open('', '_blank');
  btn.disabled = true;
  try {
    const { url, pushed } = await api('/api/pr/create');
    if (win) win.location = url;
    else toast(`Popup blocked — the compare page is at ${url}`, true, true);
    if (pushed) toast('Pushed this branch to origin first.');
  } catch (e) {
    win?.close();
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
input.addEventListener('keydown', async (e) => {
  // Shift-Enter is the newline; plain Enter still saves, which is the whole
  // reason this is a textarea with a key handler rather than a form.
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  // Cleared only once the server has the item. addItem is async and save()
  // reports a refusal with a toast rather than a throw, so clearing on the way
  // past threw the text away on a stale-branch refusal, on any API failure, and
  // on an Enter pressed during a branch switch.
  if (await addItem(input.value)) {
    input.value = '';
    grow();
  }
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
await initQueue({ sendToClaude, onTask: toggleTask });
loadStatus();
