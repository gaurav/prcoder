#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a three-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, prHeads, prBody, listPrs, setViewed, setBody, createIssue, fetchPatches } from './github.js';
import { snapshot, currentBranch, repoInfo, prScope, compareUrl, checkoutPr, pushBranch, remoteBranchHead } from './git.js';
import { groupFiles, fileUrl } from './files.js';
import { parseFuture, renderPrBlock, syncFromPrBlock, toggleTask } from './queue.js';
import { readStore, writeStore, forBranch, replaceBranch, branchKey, staleBranch } from './store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
/**
 * The port is a function of the repo's path, so a repo's URL is the same every
 * run. That is what makes the URL worth keeping: bookmark it, add it to the
 * Dock, embed it in an IDE. A busy port falls back to a free one (see ready()).
 * Worktrees have their own paths, and so their own ports, like their queues.
 */
export function portFor(repo, env = process.env) {
  if (Number(env.PRCODER_PORT)) return Number(env.PRCODER_PORT);
  return 1618 + createHash('sha1').update(repo).digest().readUInt16BE(0) % 1000;
}
// Args split at the first flag: everything before it is ours (an optional PR
// number, URL or branch), everything from it on is handed to `claude` verbatim.
// No table of Claude's flags to keep in sync, and no collisions to arbitrate.
export function splitArgs(argv) {
  const cut = argv.findIndex((a) => a.startsWith('-'));
  return { target: cut === 0 ? undefined : argv[0], claudeArgs: cut === -1 ? [] : argv.slice(cut) };
}

let { target, claudeArgs } = splitArgs(process.argv.slice(2));
// Set when a mirror write fails, cleared when one succeeds. See mirrors().
let mirrorFailed = false;

// The PR is fetched once and reused; the queue routes need its body and node id.
let pr = null;
// owner/repo and default branch: constant while we run, and loaded at startup
// rather than lazily, because two things now need it before the first poll —
// the issue links decorate() derives, and mirrors(), which fails closed and so
// would quietly mirror nothing while it was still null.
let info = null;

// ponytail: patches fetched lazily on the first diff click, keyed by head oid
// so a push or PR switch invalidates for free. Eager prefetch in refreshPr if
// first-click latency annoys.
let patches = { key: null, map: new Map() };

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

/**
 * Whether the PR on screen is the one this branch's queue is a projection of.
 *
 * This gates the mirror in both directions, and it is load-bearing rather than
 * tidy. syncFromPrBlock tombstones any mirrored item missing from the block, so
 * a body that is not ours is not evidence that anything was deleted — and our
 * items are not something to write into someone else's description. Two ways to
 * get there: `prcoder <pr-url>` pins a PR that is not the checkout's, and a
 * failed mirror leaves GitHub holding a body we know is out of date.
 *
 * It fails closed. A missed merge is recovered on the next poll; a wrong one
 * buries every mirrored item the branch has.
 */
const mirrors = (branch) => Boolean(pr)
  && !mirrorFailed
  && prScope(pr, { branch, nameWithOwner: info?.nameWithOwner }) === 'current';

async function readQueue(branch) {
  branch ??= await currentBranch(repo);
  const { store } = await readStore(repo);
  const mine = forBranch(store, branch);
  return decorate(mirrors(branch) ? syncFromPrBlock(mine, pr.body ?? '') : mine, branch);
}

/**
 * The store is the source of truth and the PR description is a projection of
 * it, so they move together. Writing one alone leaves readQueue's merge running
 * against a stale body, which then undoes the write that just happened: a tick
 * reverts, and an item whose text was edited gets buried as deleted because its
 * old line no longer matches anything. The network call only happens when the
 * rendered block actually changes, so ticking a local-only item stays offline.
 *
 * ponytail: last write wins on a branch's slice. The store is re-read on every
 * poll so an outside edit is picked up, but two tabs racing means the slower
 * one loses what it never saw. Fixing that needs item identity — text is not
 * it, since an edit is indistinguishable from a delete plus an add — so if a
 * lost item is ever actually observed, give pick() a crypto.randomUUID() and
 * union by id.
 */
async function writeQueue(items, branch) {
  branch ??= await currentBranch(repo);
  const key = branchKey(branch);

  // A write from a tab that has not noticed a checkout would file this branch's
  // items under the next one. Refusing is visible; the alternative is silent.
  if (staleBranch(items, branch)) {
    throw new Error(`the branch changed to ${key} under the queue — refresh`);
  }

  const { store, stale: staleBytes } = await readStore(repo);
  await writeStore(repo, replaceBranch(store, branch, items), { stale: staleBytes });

  if (mirrors(branch)) {
    // Re-read rather than trusting the cached copy: someone may have edited the
    // prose around our block on github.com since the last poll, and
    // renderPrBlock only owns what is between the markers.
    const current = await prBody(repo, pr.url).catch(() => pr.body ?? '');
    const body = renderPrBlock(items, current);
    if (body !== current) {
      try {
        await setBody(repo, pr.url, body);
        // Only once GitHub has it: an optimistic assignment survives the failure
        // and makes prcoder report items the PR has never seen.
        pr.body = body;
        mirrorFailed = false;
      } catch (e) {
        // The store already has the change, so nothing is lost — but the body
        // on GitHub is now behind, and merging against it would bury the very
        // item that failed to go out. mirrors() stops trusting it until a write
        // succeeds. Offline on a train is the case this is for.
        mirrorFailed = true;
        console.error('pr body not updated:', e.stderr || e.message);
      }
    }
  }
  return decorate(items, branch);
}

/**
 * The store keeps only the issue number; the link is derived. From
 * nameWithOwner rather than the PR's URL, because that is the repo createIssue
 * actually files into — with a pinned foreign PR the two differ — and because
 * a queue that now works with no PR loaded would otherwise render dead links.
 *
 * `branch` is stamped on the way out so the client hands it back on the next
 * write, which is what lets writeQueue notice a checkout it has missed.
 */
function decorate(items, branch) {
  const key = branchKey(branch);
  return items.map((i) => ({
    ...i,
    branch: key,
    issueUrl: i.issue && info ? `https://github.com/${info.nameWithOwner}/issues/${i.issue}` : null,
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
    queue: await readQueue(snap.branch),
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
    // The queue is keyed by branch, and status() reloads the PR first, so the
    // new branch's items are merged against the new branch's PR and not the
    // one we just left.
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

  /**
   * One checkbox in the description, ticked from the PR pane. The body is
   * re-read rather than taken from the cached PR for the same reason
   * writeQueue does it: prose edited on github.com since the last poll would
   * otherwise be written back out of date.
   */
  'POST /api/pr/task': async ({ index, done, text }) => {
    const cur = requirePr();
    const current = await prBody(repo, cur.url).catch(() => cur.body ?? '');
    const { body, inBlock } = toggleTask(current, index, done, text);
    await setBody(repo, cur.url, body);
    pr.body = body;

    // Our own block is a projection of the queue, so a tick there has to reach
    // the store: readQueue folds the new body back into the items and
    // writeQueue persists them. It re-renders the block from those items and
    // finds it unchanged, so this costs a read and no second write.
    //
    // Only when the block is this branch's own projection, though. A tick
    // elsewhere in the description, or anywhere in a PR we are merely looking
    // at, is the PR pane's business and none of the queue's.
    const branch = await currentBranch(repo);
    if (!inBlock || !mirrors(branch)) return { queue: null };
    return { queue: await writeQueue(await readQueue(branch), branch) };
  },

  'POST /api/diff': async ({ path: p }) => {
    const cur = requirePr();
    const key = cur.url + cur.headRefOid;
    if (patches.key !== key) patches = { key, map: await fetchPatches(repo, cur.url) };
    return { path: p, patch: patches.map.get(p) ?? null };
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
// A WebSocketServer re-emits its http server's errors, and an unhandled one is
// fatal -- the busy-port fallback below never gets its turn. The http server's
// own handler reports it, so nothing to do here but not die.
new WebSocketServer({ server, path: '/pty' }).on('error', () => {}).on('connection', (ws) => {
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

/**
 * FUTURE.md's queue, once, for a repo that has no store yet.
 *
 * Not left to the PR description to recover: an item that is both mirrored and
 * an issue renders as a bare `- [ ] #42`, which parses back with no text at
 * all, and items never mirrored are not there to recover. Ordering goes too.
 *
 * It runs at startup rather than inside readQueue so it lands before the first
 * merge against the PR body — otherwise the body's lines match nothing, and
 * every mirrored item arrives a second time as a new one. FUTURE.md is left
 * byte-identical: rewriting it would be prcoder's last write to a tracked
 * file, done unasked, on the way to never writing one again.
 *
 * Once per repo, for the branch you started on. Telling "never imported" from
 * "you deleted them all" needs bookkeeping this does not earn.
 */
async function importFuture() {
  const { store, stale } = await readStore(repo);
  if (store.items.length || stale) return;

  const text = await fs.readFile(path.join(repo, 'FUTURE.md'), 'utf8').catch(() => '');
  const items = parseFuture(text);
  if (!items.length) return;

  const branch = await currentBranch(repo);
  await writeStore(repo, replaceBranch(store, branch, items));
  console.log(`imported ${items.length} items from FUTURE.md into .prcoder/queue.json`);
  console.log('prcoder no longer reads or writes FUTURE.md; your copy is untouched');
}

async function ready() {
  const url = `http://localhost:${server.address().port}`;
  info ??= await repoInfo(repo).catch((e) => {
    console.error('repo:', e.stderr || e.message);
    return null;
  });
  await refreshPr().catch((e) => console.error('pr:', e.stderr || e.message));
  await importFuture().catch((e) => console.error('import:', e.message));
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  console.log(url);
  // ponytail: the platform's own opener, not a dependency. PRCODER_NO_OPEN=1 to
  // skip; PRCODER_OPEN to run your own command with the URL appended, which is
  // how a browser is told "a new window, not a tab".
  if (!process.env.PRCODER_NO_OPEN) {
    const opener = { darwin: 'open', win32: 'start' }[process.platform] || 'xdg-open';
    const custom = process.env.PRCODER_OPEN;
    const child = custom
      ? spawn(`${custom} ${url}`, { detached: true, stdio: 'ignore', shell: true })
      : spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', (e) => console.error(`could not open a browser (${e.message}) — visit ${url}`)).unref();
  }
}

if (import.meta.main) {
  const port = portFor(repo);
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`port ${port} is busy (another prcoder in this repo?) — taking a free one`);
    server.listen(0, '127.0.0.1', ready);
  });
  server.listen(port, '127.0.0.1', ready);
}
