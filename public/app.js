import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { renderPr } from './pr.js';
import { initQueue, addItem } from './queue.js';

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

async function loadPr() {
  const pr = await fetch('/api/pr').then((r) => r.json());
  renderPr(pr?.error ? null : pr, { onViewed: setViewed });
}

document.getElementById('pr-refresh').onclick = loadPr;

const input = document.getElementById('queue-input');
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  addItem(input.value);
  input.value = '';
});

loadPr();
initQueue({ sendToClaude });
