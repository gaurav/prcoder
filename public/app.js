import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { renderPr, renderNoPr, renderHeader } from './pr.js';
import { initQueue, addItem, setItems, freeze } from './queue.js';

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#1c1f26', foreground: '#d5d9e0' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
term.open(document.getElementById('term-host'));

const ws = new WebSocket(`ws://${location.host}/pty`);
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

const sync = () => { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); };

ws.onmessage = (e) => term.write(e.data);
ws.onopen = () => { sync(); term.focus(); };
ws.onclose = () => term.write('\r\n\x1b[31m[claude exited — reload to restart]\x1b[0m\r\n');

term.onData((d) => send({ type: 'input', data: d }));
new ResizeObserver(sync).observe(document.getElementById('term-host'));

// Type an item into Claude's prompt. If Claude is mid-turn it queues the
// message itself, which is exactly the behaviour we want.
function sendToClaude(text) {
  send({ type: 'input', data: text + '\r' });
  term.focus();
}

const setViewed = (path, viewed) =>
  fetch('/api/pr/viewed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, viewed }),
  }).then((r) => r.json()).then((d) => { if (d.error) throw new Error(d.error); });

/** A transient line over the panes. The only other error surface is alert(). */
let toastTimer;
function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : 4000);
}

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
  return data;
};

// The switcher only changes when PRs are opened or closed, so it is not worth a
// call every minute — page load and opening the dropdown are enough.
let prs = [];
const loadPrs = () => fetch('/api/prs').then((r) => (r.ok ? r.json() : [])).then((l) => { prs = l; });
document.getElementById('pr-switch').addEventListener('mousedown', loadPrs);

const NOTES = {
  'other-branch': 'Not checked out — this pull request is on another branch.',
  'other-repo': 'This pull request is in another repository.',
};

function paint(status) {
  renderHeader(status, prs, { onSwitch: switchPr, onCommit: askClaudeToCommit });
  if (status.pr) renderPr({ ...status.pr, note: NOTES[status.scope] }, { onViewed: setViewed });
  else renderNoPr(status, { onCreate: createPr });
  if (status.queue) setItems(status.queue);
}

/**
 * A failed fetch must not read as "no pull request" — that is a real state with
 * its own UI, and a laptop on a train would hit it every minute.
 */
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
    paint(data);
  } catch (e) {
    renderHeader({ error: e.message, dirty: false, dirtyFiles: [], pr: null }, prs,
      { onSwitch: switchPr, onCommit: askClaudeToCommit });
  }
}

async function switchPr(number) {
  freeze(true);
  try {
    const status = await post('/api/pr/switch', { number });
    paint(status);
    // Claude's cwd survives a checkout, but its idea of the files does not.
    term.write(`\r\n\x1b[33m[prcoder: switched to ${status.branch} (#${number})` +
      ' — re-read any open files]\x1b[0m\r\n');
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
    const { url, pushed } = await post('/api/pr/create');
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

document.getElementById('pr-refresh').onclick = loadStatus;

// Polling is the client's job: no server timer, and a hidden tab costs nothing.
setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadStatus();
});

const input = document.getElementById('queue-input');
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  addItem(input.value);
  input.value = '';
});

await loadPrs();
await initQueue({ sendToClaude });
loadStatus();
