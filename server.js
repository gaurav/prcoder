#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a three-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, prHeads, prBody, listPrs, setViewed, setBody, createIssue } from './github.js';
import { snapshot, repoInfo, prScope, compareUrl, checkoutPr, pushBranch, remoteBranchHead } from './git.js';
import { groupFiles, fileUrl } from './files.js';
import { parseFuture, renderFuture, renderPrBlock, syncFromPrBlock } from './queue.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
// 0 means "any free port": two prcoder sessions never collide, and the browser
// is opened for us, so nobody has to know the number.
const port = Number(process.env.PRCODER_PORT) || 0;
// Args split at the first flag: everything before it is ours (an optional PR
// number, URL or branch), everything from it on is handed to `claude` verbatim.
// No table of Claude's flags to keep in sync, and no collisions to arbitrate.
export function splitArgs(argv) {
  const cut = argv.findIndex((a) => a.startsWith('-'));
  return { target: cut === 0 ? undefined : argv[0], claudeArgs: cut === -1 ? [] : argv.slice(cut) };
}

let { target, claudeArgs } = splitArgs(process.argv.slice(2));
const futureFile = path.join(repo, 'FUTURE.md');

// The PR is fetched once and reused; the queue routes need its body and node id.
let pr = null;
let info = null;   // owner/repo and default branch: constant while we run

/**
 * Every gh/git call runs one at a time. `gh pr checkout` is a fetch, a checkout
 * and a fast-forward, and a status poll landing between the last two reads a
 * branch at the wrong commit. Serialising is also what stops a poll reloading
 * `pr` in the middle of writeQueue's read-modify-write of the description.
 *
 * ponytail: one global lock; split per-route only if a slow gh call visibly
 * stalls the UI.
 */
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

const requirePr = () => {
  if (!pr) throw new Error('no pull request for this branch');
  return pr;
};

async function refreshPr(detached) {
  // gh pr view fails on a detached HEAD in a way loadPr does not recognise, so
  // it would throw rather than report "no PR" — and 500 the poll every minute.
  detached ??= (await snapshot(repo)).detached;
  if (!target && detached) { pr = null; return null; }
  pr = await loadPr(repo, target);
  return pr && { ...pr, groups: withUrls(pr) };
}

/** Files bucketed for the pane, each linking into GitHub's diff viewer. */
function withUrls(p) {
  const groups = groupFiles(p.files);
  for (const list of Object.values(groups)) {
    for (const f of list) f.url = fileUrl(p.url, f.path);
  }
  return groups;
}

async function readQueue() {
  const text = await fs.readFile(futureFile, 'utf8').catch(() => '');
  return decorate(syncFromPrBlock(parseFuture(text), pr?.body ?? ''));
}

/**
 * FUTURE.md is the source of truth and the PR description is a projection of
 * it, so they move together. Writing one alone leaves readQueue's merge running
 * against a stale body, which then undoes the write that just happened: a tick
 * reverts, and an item whose text was edited gets buried as deleted because its
 * old line no longer matches anything. The network call only happens when the
 * rendered block actually changes, so ticking a local-only item stays offline.
 */
async function writeQueue(items) {
  const existing = await fs.readFile(futureFile, 'utf8').catch(() => '');
  await fs.writeFile(futureFile, renderFuture(items, existing));

  if (pr) {
    // Re-read rather than trusting the cached copy: someone may have edited the
    // prose around our block on github.com since the last poll, and
    // renderPrBlock only owns what is between the markers.
    const current = await prBody(repo, pr.url).catch(() => pr.body ?? '');
    const body = renderPrBlock(items, current);
    if (body !== current) {
      await setBody(repo, pr.url, body);
      // Only once GitHub has it: an optimistic assignment survives the failure
      // and makes prcoder report items the PR has never seen.
      pr.body = body;
    }
  }
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

/**
 * Where the repo is, plus the PR and queue that go with it. The client polls
 * this; nothing is stored between calls, so an outside `git checkout` or an
 * edit on github.com is picked up without prcoder having to be told.
 */
async function status({ full = false } = {}) {
  info ??= await repoInfo(repo);

  // Taken once and threaded through: the remote head is not known yet, and
  // asking git the same four questions three times a minute is just noise.
  const { branch, detached } = await snapshot(repo);
  // A pinned target keeps working on a detached HEAD; branch-following cannot.
  const heads = detached && !target ? null : await prHeads(repo, target);

  // The cheap call decides whether the expensive one is needed: loadPr also
  // runs a paginated GraphQL pass, which is far too much for a 60s poll.
  if (full || heads?.updatedAt !== pr?.updatedAt || heads?.number !== pr?.number) {
    await refreshPr(detached);
  }

  // With no PR there is no headRefOid to compare against, so ask origin.
  const oid = pr?.headRefOid ?? heads?.headRefOid ?? await remoteBranchHead(repo, branch);
  const snap = await snapshot(repo, oid);
  const scope = prScope(pr, { branch: snap.branch, nameWithOwner: info.nameWithOwner });

  return {
    ...snap,
    ...info,
    scope,
    onDefaultBranch: snap.branch === info.defaultBranch,
    // A PR we have not checked out can never be in sync with this working
    // tree, so its verdict is meaningless. With no PR at all the branch still
    // has one, and "not pushed yet" is what the create button needs to know.
    sync: scope === 'current' || scope === 'none' ? snap.sync : null,
    pr: pr ? { ...pr, groups: withUrls(pr) } : null,
    queue: await readQueue(),
  };
}

const routes = {
  'GET /api/pr': () => refreshPr(),

  'GET /api/status': () => status(),

  'GET /api/prs': () => listPrs(repo),

  'POST /api/pr/switch': async ({ number }) => {
    await checkoutPr(repo, number);
    // Clear rather than pin: the checkout put us on the branch, so following it
    // gives the same answer and self-heals when Claude switches branches later.
    target = undefined;
    // The new branch has its own FUTURE.md, and status() reloads the PR first
    // so the queue's issue links are decorated from the right repo.
    return status({ full: true });
  },

  'POST /api/pr/create': async () => {
    info ??= await repoInfo(repo);
    const { branch, detached } = await snapshot(repo);
    if (detached) throw new Error('detached HEAD — check out a branch first');
    if (branch === info.defaultBranch) throw new Error(`on ${branch} — make a branch first`);

    // GitHub's compare page only knows about branches it has seen. Ask origin
    // rather than trusting a sync verdict computed without a remote head.
    const pushed = !(await remoteBranchHead(repo, branch));
    if (pushed) await pushBranch(repo);
    return { url: compareUrl(info.nameWithOwner, info.defaultBranch, branch), pushed };
  },

  'POST /api/pr/viewed': async ({ path: p, viewed }) => {
    await setViewed(repo, requirePr().nodeId, p, viewed);
    // Absent if the file list was refreshed out from under us.
    const f = pr.files.find((x) => x.path === p);
    if (f) f.viewed = viewed;
    return { ok: true };
  },

  'GET /api/queue': () => readQueue(),

  'PUT /api/queue': (items) => writeQueue(items),

  'POST /api/queue/issue': async ({ items, index }) => {
    info ??= await repoInfo(repo);
    const { number } = await createIssue(repo, info.nameWithOwner, items[index].text);
    items[index].issue = number;
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
    // Serialised, and resolved *before* the header goes out: writing the 200
    // first means a throwing handler hits writeHead twice, and the second one
    // takes the whole process down with ERR_HTTP_HEADERS_SENT.
    const payload = JSON.stringify(await serial(() => handler(body)) ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
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
  const url = `http://localhost:${server.address().port}`;
  await refreshPr().catch((e) => console.error('pr:', e.stderr || e.message));
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  console.log(url);
  // ponytail: the platform's own opener, not a dependency. PRCODER_NO_OPEN=1 to skip.
  if (!process.env.PRCODER_NO_OPEN) {
    const opener = { darwin: 'open', win32: 'start' }[process.platform] || 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
      .on('error', (e) => console.error(`could not open a browser (${e.message}) — visit ${url}`))
      .unref();
  }
});
