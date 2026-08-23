#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a three-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, setViewed, setBody, createIssue } from './github.js';
import { groupFiles, fileUrl } from './files.js';
import { parseFuture, renderFuture, renderPrBlock, syncFromPrBlock } from './queue.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
const port = Number(process.env.PRCODER_PORT) || 1618;
// Args split at the first flag: everything before it is ours (an optional PR
// number, URL or branch), everything from it on is handed to `claude` verbatim.
// No table of Claude's flags to keep in sync, and no collisions to arbitrate.
export function splitArgs(argv) {
  const cut = argv.findIndex((a) => a.startsWith('-'));
  return { target: cut === 0 ? undefined : argv[0], claudeArgs: cut === -1 ? [] : argv.slice(cut) };
}

const { target, claudeArgs } = splitArgs(process.argv.slice(2));
const futureFile = path.join(repo, 'FUTURE.md');

// The PR is fetched once and reused; the queue routes need its body and node id.
let pr = null;

async function refreshPr() {
  pr = await loadPr(repo, target);
  if (!pr) return null;
  const groups = groupFiles(pr.files);
  for (const list of Object.values(groups)) {
    for (const f of list) f.url = fileUrl(pr.url, f.path);
  }
  return { ...pr, groups };
}

async function readQueue() {
  const text = await fs.readFile(futureFile, 'utf8').catch(() => '');
  return decorate(syncFromPrBlock(parseFuture(text), pr?.body ?? ''));
}

async function writeQueue(items) {
  const existing = await fs.readFile(futureFile, 'utf8').catch(() => '');
  await fs.writeFile(futureFile, renderFuture(items, existing));
  return decorate(items);
}

/** FUTURE.md stores only the issue number; the link is derived from the PR. */
function decorate(items) {
  const repoUrl = pr?.url.replace(/\/pull\/\d+$/, '');
  return items.map((i) => ({
    ...i,
    issueUrl: i.issue && repoUrl ? `${repoUrl}/issues/${i.issue}` : null,
  }));
}

/** Push the `inPr` items into the PR description. */
async function pushToPr(items) {
  if (!pr) throw new Error('no pull request for this branch');
  pr.body = renderPrBlock(items, pr.body ?? '');
  await setBody(repo, pr.url, pr.body);
  return items;
}

const routes = {
  'GET /api/pr': () => refreshPr(),

  'POST /api/pr/viewed': async ({ path: p, viewed }) => {
    await setViewed(repo, pr.nodeId, p, viewed);
    pr.files.find((f) => f.path === p).viewed = viewed;
    return { ok: true };
  },

  'GET /api/queue': () => readQueue(),

  'PUT /api/queue': (items) => writeQueue(items),

  'POST /api/queue/push': async (items) => writeQueue(await pushToPr(items)),

  'POST /api/queue/issue': async ({ items, index }) => {
    const { number } = await createIssue(repo, pr.url, items[index].text);
    items[index].issue = number;
    if (items[index].inPr) await pushToPr(items);
    return writeQueue(items);
  },
};

async function handleApi(req, res, key) {
  const handler = routes[key];
  if (!handler) return res.writeHead(404).end('no such route');
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await handler(body) ?? null));
  } catch (e) {
    console.error(key, e.stderr || e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (e.stderr || e.message).trim() }));
  }
}

// Browser-facing path -> file on disk. Keeps us free of a bundler.
const vendor = {
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
};

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

async function serveFile(res, file) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, `${req.method} ${url.pathname}`);

  if (vendor[url.pathname]) return serveFile(res, path.join(root, 'node_modules', vendor[url.pathname]));

  // Static files under public/, with path traversal blocked.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(root, 'public', rel);
  if (!file.startsWith(path.join(root, 'public'))) return res.writeHead(403).end('forbidden');
  return serveFile(res, file);
});

// One PTY per WebSocket. Closing the tab kills the session; that is intentional
// for a prototype — Claude Code's own --resume covers getting back in.
new WebSocketServer({ server, path: '/pty' }).on('connection', (ws) => {
  const term = ptySpawn(process.env.CLAUDE_BIN || 'claude', claudeArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: repo,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  term.onExit(() => ws.close());

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
  });
  ws.on('close', () => term.kill());
});

if (import.meta.main) server.listen(port, '127.0.0.1', async () => {
  await refreshPr().catch((e) => console.error('pr:', e.stderr || e.message));
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  console.log(`http://localhost:${port}`);
});
