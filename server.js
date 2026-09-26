#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a four-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { text as readBody } from 'node:stream/consumers';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, prHeads, prBody, listPrs, listIssues, setViewed, setBody, createIssue, fetchPatches, runCount } from './github.js';
import { snapshot, currentBranch, repoInfo, prScope, compareUrl, originOwner, checkoutPr, pushBranch, remoteBranchHead, trackingHead, localPatch } from './git.js';
import { groupFiles, fileUrl, fileViews } from './files.js';
import { appendTasks, toggleTask } from './queue.js';
import { readStore, writeStore, readPort, writePort, replaceItems } from './store.js';
import { counts } from './public/items.js';
import * as term from './term.js';
import { syncPhrase } from './public/pr.js';
import { grammars } from './public/diff.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
/**
 * Where a repo's port starts from: a hash of its path, so the first run in a
 * clone picks a port of its own without asking anyone. What the repo then
 * *uses* is `.prcoder/port.json` -- see resolvePort(). This stays pure so the
 * seed can be checked without a disk.
 *
 * The range is above 10080 on purpose. Browsers refuse a fixed list of
 * well-known ports outright, and Firefox says only "This address is
 * restricted" -- nothing on screen connects that to prcoder, and the old
 * 1618-2617 range held four of them (1719, 1720, 1723, 2049). The list is the
 * WHATWG fetch standard's, shared by Firefox, Chrome and Safari, and 10080 is
 * its highest entry. macOS hands out ephemeral ports from 49152, so 10240-14335
 * is clear at both ends.
 */
export const PORT_BASE = 10240;
export const PORT_SPAN = 4096;

export function portFor(repo) {
  return PORT_BASE + createHash('sha1').update(repo).digest().readUInt16BE(0) % PORT_SPAN;
}

/**
 * Every port in the range, starting at this repo's seed and wrapping. Only a
 * first run walks past the first entry, and only until something binds.
 */
export function portCandidates(repo) {
  const first = portFor(repo) - PORT_BASE;
  return Array.from({ length: PORT_SPAN }, (_, n) => PORT_BASE + (first + n) % PORT_SPAN);
}
// Args split at the first flag: everything before it is ours (an optional PR
// number, URL or branch), everything from it on is handed to `claude` verbatim.
// No table of Claude's flags to keep in sync, and no collisions to arbitrate.
export function splitArgs(argv) {
  const cut = argv.findIndex((a) => a.startsWith('-'));
  return { target: cut === 0 ? undefined : argv[0], claudeArgs: cut === -1 ? [] : argv.slice(cut) };
}

let { target, claudeArgs } = splitArgs(process.argv.slice(2));

// The PR is fetched once and reused; the queue routes need its body and node id.
let pr = null;
// owner/repo and default branch: constant while we run, and loaded at startup
// rather than lazily, because two things need it before the first poll -- the
// issue links decorate() derives, and ours(), which refuses a move into the PR
// description while it is still null.
let info = null;

// ponytail: patches fetched lazily on the first diff click, keyed by head oid
// so a push or PR switch invalidates for free. Eager prefetch in refreshPr if
// first-click latency annoys.
let patches = { key: null, map: new Map() };

// The last thing status() worked out, so the block under the log and the quit
// prompt can answer without asking git again on a keypress. Stale by up to a
// poll, which is the right trade: a keypress that shells out is a keypress that
// can hang. `checkedAt` is what stops that trade being a silent one.
let last = null;
let checkedAt = 0;
// The URL, and whether it is the one this repo is supposed to have. Both are
// only known once the server is listening.
let urls = { local: '', moved: null };
// The port this repo is meant to be on -- recorded, pinned or freshly chosen.
// ready() reports against this, not against the seed: once a port is recorded
// it *is* the usual URL, even where it is not the one the hash suggests.
let wanted = 0;

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

/** Item text, cut to something a status line can hold. */
const quote = (t) => `'${t.length > 48 ? `${t.slice(0, 47)}…` : t}'`;

/**
 * What changed in the queue, said out loud. Matched on text because that is the
 * only identity an item has -- so an edit reads as a delete and an add, which
 * is honest: nothing here can tell those apart either (see the ponytail note on
 * writeQueue).
 *
 * Returns the lines rather than printing them, which is the only reason the
 * transitions below can be checked without a terminal.
 */
export function queueChanges(was, now) {
  const before = new Map(was.map((i) => [i.text, i]));
  const lines = [];
  for (const i of now) {
    const p = before.get(i.text);
    if (!p) lines.push(`queued ${quote(i.text)}`);
    else if (p.done !== i.done) lines.push(`${i.done ? 'ticked' : 'unticked'} ${quote(i.text)}`);
    else if (p.deleted !== i.deleted) lines.push(`${i.deleted ? 'deleted' : 'restored'} ${quote(i.text)}`);
  }
  for (const i of was) {
    if (!now.some((n) => n.text === i.text)) lines.push(`dropped ${quote(i.text)}`);
  }
  return lines;
}

const requirePr = () => {
  if (!pr) throw new Error('no pull request for this branch');
  return pr;
};

async function refreshPr(detached) {
  // gh pr view fails on a detached HEAD in a way loadPr does not recognise, so
  // it would throw rather than report "no PR" — and 500 the poll every minute.
  detached ??= !(await currentBranch(repo));
  pr = !target && detached ? null : await loadPr(repo, target);
}

/**
 * Files bucketed for the pane, each carrying the two ways to read it on GitHub:
 * this file's patch in the diff viewer, and the whole file at the PR's head.
 */
function withUrls(p) {
  const groups = groupFiles(p.files);
  for (const list of Object.values(groups)) {
    for (const f of list) {
      f.url = fileUrl(p.url, f.path);
      Object.assign(f, fileViews(p.url, p.headRefOid, f.path));
    }
  }
  return groups;
}

/**
 * Whether the PR on screen is this branch's own -- the only description a queue
 * item may be moved into. `prcoder <pr-url>` pins a PR that is not the
 * checkout's, and appending your list to a stranger's description is not a move
 * anybody asked for. Fails closed while `pr` or `info` is still loading.
 */
const ours = (branch) => Boolean(pr)
  && prScope(pr, { branch, nameWithOwner: info?.nameWithOwner }) === 'current';

/**
 * The queue is yours and lives only in `.prcoder/queue.json`: nothing here reads
 * it back from GitHub. Moving an item out is a separate, one-way route (see
 * moveOut), not a flag this list keeps in step with a description.
 */
const readQueue = async () => decorate((await readStore(repo)).store.items);

/**
 * ponytail: last write wins. The store is re-read on every poll so an outside
 * edit is picked up, but two tabs racing means the slower one loses what it
 * never saw. Fixing that needs item identity — text is not it, since an edit is
 * indistinguishable from a delete plus an add — so if a lost item is ever
 * actually observed, give pick() a crypto.randomUUID() and union by id.
 */
async function writeQueue(items) {
  // The shape is the contract, and it has changed twice: the route took a bare
  // array, then `{items, branch}`, and now `{items}` again. A client that
  // missed a change -- an old tab, a curl copied from somewhere -- used to send
  // something this function then indexed into, and the TypeError said nothing
  // about what to send instead. Checked here rather than at the route, because
  // every write goes through this function.
  if (!Array.isArray(items)) {
    throw new Error('the queue must be sent as {items}');
  }
  const { store, stale } = await readStore(repo);
  for (const line of queueChanges(store.items, items)) term.verbose(line);
  await writeStore(repo, replaceItems(store, items), { stale });
  return decorate(items);
}

/**
 * Items leave the queue for somewhere permanent: written there first, then taken
 * off the list. In that order because the failure it leaves is the recoverable
 * one -- a write that did not land keeps the item where it was, and a store
 * write that fails after one that did leaves the item in both places, which the
 * error says, rather than in neither.
 */
async function moveOut(items, indices, send) {
  const moving = indices.map((n) => items[n]).filter(Boolean);
  if (!moving.length) throw new Error('nothing to move');
  // `send` answers where the items went, for the one error that has to say so:
  // "failed" without a URL is what makes someone file the same issue again.
  const where = await send(moving);
  try {
    return await writeQueue(items.filter((i) => !moving.includes(i)));
  } catch (e) {
    throw new Error(`moved to ${where}, but the queue still lists ${moving.length === 1 ? 'it' : 'them'}: ${e.message}`);
  }
}

/**
 * Read, change and write the description: the one way anything writes it.
 * Answers whether anything was sent.
 */
async function editBody(edit) {
  const cur = requirePr();
  const current = await prBody(repo, cur.url);
  const body = edit(current);
  if (body !== current) await setBody(repo, cur.url, body);
  // Only once GitHub has it: an optimistic assignment survives the failure and
  // makes the pane show a description GitHub never saw.
  cur.body = body;
  return body !== current;
}

/**
 * The store keeps only the issue number; the link is derived. From
 * nameWithOwner rather than the PR's URL, because that is the repo createIssue
 * actually files into — with a pinned foreign PR the two differ — and because
 * a queue that now works with no PR loaded would otherwise render dead links.
 */
function decorate(items) {
  return items.map((i) => ({
    ...i,
    issueUrl: i.issue && info ? `https://github.com/${info.nameWithOwner}/issues/${i.issue}` : null,
  }));
}

/**
 * How long ago the block was last true. Nothing under two minutes, because a
 * poll runs every sixty seconds and an age that is always on screen is an age
 * nobody reads.
 */
export const ago = (ms) => {
  if (!(ms >= 120_000)) return null;
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `checked ${mins}m ago` : `checked ${Math.round(mins / 60)}h ago`;
};

/**
 * The block pinned under the log: everything status() worked out anyway, for
 * the terminal that is otherwise sat idle for the whole session. Pure, so the
 * wording is testable without a tty.
 */
export function statusLines(s, u = {}) {
  // padEnd, not a slice: a label longer than the column has to push the row out
  // rather than lose its tail, or `PR #10000` prints as a real-looking `PR #1000`.
  const row = (label, ...rest) => `${label.padEnd(8)} ${rest.filter(Boolean).join('   ')}`;
  // The same predicates the pane's tabs use, so the block and the tab strip
  // cannot report the queue differently.
  const q = counts(s.queue ?? []);

  return [
    row('prcoder', s.nameWithOwner,
      s.branch ? `${s.branch} → ${s.pr?.baseRefName ?? s.defaultBranch}` : 'detached HEAD',
      [syncPhrase(s), s.dirtyFiles?.length && `${s.dirtyFiles.length} uncommitted`]
        .filter(Boolean).join(' · ')),
    s.pr ? row(`PR #${s.pr.number}`, s.pr.title) : row('PR', 'none for this branch'),
    s.pr && row('', s.pr.url),
    row('queue', `${q.local} local · ${q.done} done`),
    // The age belongs next to the tab count because the tab is the cause: the
    // browser polls only while its tab is visible, so backgrounding it stops
    // the clock on every number above while the socket stays open and the count
    // keeps cheerfully saying `1 tab`.
    row('serving', u.local, u.tabs ? `${u.tabs} tab${u.tabs > 1 ? 's' : ''}` : 'no tab open',
      ago(u.age), 'q quit · r refresh · v verbose · o open'),
    u.moved && row('', u.moved),
  ].filter(Boolean);
}

/**
 * Where the repo is, plus the PR and queue that go with it. The client polls
 * this; nothing is stored between calls, so an outside `git checkout` or an
 * edit on github.com is picked up without prcoder having to be told.
 */
async function status({ full = false } = {}) {
  const calls = runCount();
  info ??= await repoInfo(repo);

  // Taken once and threaded through: the remote head is not known yet, and
  // asking git the same four questions three times a minute is just noise.
  const branch = await currentBranch(repo);
  const detached = !branch;
  // A pinned target keeps working on a detached HEAD; branch-following cannot.
  // A full refresh reloads regardless, so it has no use for the cheap check.
  const heads = full || (detached && !target) ? null : await prHeads(repo, target);

  // The cheap call decides whether the expensive one is needed: loadPr also
  // runs a paginated GraphQL pass, which is far too much for a 60s poll.
  if (full || heads?.updatedAt !== pr?.updatedAt || heads?.number !== pr?.number) {
    if (!full && pr) term.debug(`PR #${pr.number} changed upstream — reloading into the UI`);
    await refreshPr(detached);
  }

  // With no PR there is no headRefOid to compare against, so read git's own
  // record of origin's head -- not origin: that was a `git ls-remote` a minute
  // per visible tab, on the one branch state where nothing has changed until
  // you push (#19). The create route is the one place that still asks origin,
  // because it pushes on the answer.
  const oid = pr?.headRefOid ?? heads?.headRefOid ?? await trackingHead(repo, branch);
  const snap = await snapshot(repo, oid, branch);
  const scope = prScope(pr, { branch: snap.branch, nameWithOwner: info.nameWithOwner });
  const tracked = scope === 'current' || scope === 'none';

  last = {
    ...snap,
    ...info,
    scope,
    // A PR we have not checked out can never be in sync with this working
    // tree, so its verdict is meaningless. With no PR at all the branch still
    // has one, and "not pushed yet" is what the create button needs to know.
    sync: tracked ? snap.sync : null,
    // `ahead` is derived from the same remote head, so it is meaningless in
    // exactly the same cases -- and it outlives the pane: askToQuit reads it to
    // say "N unpushed commits", which for a pinned PR on another branch was a
    // count against a branch you are not on.
    ahead: tracked ? snap.ahead : null,
    pr: pr ? { ...pr, groups: withUrls(pr) } : null,
    queue: await readQueue(),
  };
  checkedAt = Date.now();
  repaint();
  term.debug(`poll: ${runCount() - calls} subprocess calls`);
  return last;
}

/** The block, from whatever status() last worked out. Safe before the first poll. */
const repaint = () => term.status(last
  ? statusLines(last, { ...urls, tabs: wss.clients.size, age: Date.now() - checkedAt })
  : []);

/**
 * Routes that skip the serial lock. whoami is cached facts only, so it answers
 * instantly -- the whole point: it is what a *second* prcoder calls to find out
 * who took its port, and a probe queued behind a slow `gh` would time out and
 * report the wrong thing.
 */
const UNLOCKED = new Set(['GET /api/whoami']);

const routes = {
  'GET /api/status': () => status(),

  'GET /api/whoami': () => ({ prcoder: true, repo, branch: last?.branch ?? null,
    nameWithOwner: info?.nameWithOwner ?? null }),

  'GET /api/prs': () => listPrs(repo),

  'GET /api/issues': () => listIssues(repo),

  'POST /api/pr/switch': async ({ number }) => {
    await checkoutPr(repo, number);
    term.verbose(`checked out PR #${number}`);
    // Clear rather than pin: the checkout put us on the branch, so following it
    // gives the same answer and self-heals when Claude switches branches later.
    target = undefined;
    return status({ full: true });
  },

  'POST /api/pr/create': async () => {
    info ??= await repoInfo(repo);
    const branch = await currentBranch(repo);
    if (!branch) throw new Error('detached HEAD — check out a branch first');
    if (branch === info.defaultBranch) throw new Error(`on ${branch} — make a branch first`);

    // GitHub's compare page only knows about branches it has seen. Ask origin
    // rather than trusting a sync verdict computed without a remote head.
    const pushed = !(await remoteBranchHead(repo, branch));
    if (pushed) await pushBranch(repo);
    return { url: compareUrl(info.nameWithOwner, info.defaultBranch, branch, await originOwner(repo)), pushed };
  },

  'POST /api/pr/viewed': async ({ path: p, viewed }) => {
    await setViewed(repo, requirePr().nodeId, p, viewed);
    term.verbose(`marked ${p} ${viewed ? 'viewed' : 'not viewed'} on GitHub`);
    // Absent if the file list was refreshed out from under us.
    const f = pr.files.find((x) => x.path === p);
    if (f) f.viewed = viewed;
    return { ok: true };
  },

  /**
   * One checkbox in the description, ticked from the PR pane. The body is
   * re-read rather than taken from the cached PR: prose edited on github.com
   * since the last poll would otherwise be written back out of date.
   */
  'POST /api/pr/task': async ({ index, done, text }) => {
    // Unguarded on purpose: a read that failed is not the cached body. Falling
    // back to it wrote a stale description back over whatever had been added on
    // github.com since the last poll -- to tick one box. The tick fails instead,
    // and the client says so.
    await editBody((current) => toggleTask(current, index, done, text));
    term.verbose(`${done ? 'ticked' : 'unticked'} a checkbox in PR #${pr.number}'s description`);
    // The body GitHub now has, so both panes that show its checkboxes can
    // repaint from it rather than wait a minute for the poll to agree.
    return { body: pr.body };
  },

  'POST /api/diff': async ({ path: p }) => {
    const cur = requirePr();
    const key = cur.url + cur.headRefOid;
    if (patches.key !== key) patches = { key, map: await fetchPatches(repo, cur.url) };
    const got = patches.map.get(p) ?? { patch: null };
    // Only for a path the pull request has: the path is the page's to send, and
    // a file GitHub sent no patch for is one git can usually still make here.
    const file = cur.files.find((f) => f.path === p);
    if (got.patch != null || !file) return { path: p, ...got };
    return { path: p, ...got, patch: await localPatch(repo, {
      baseOid: cur.baseRefOid, baseRef: cur.baseRefName, head: cur.headRefOid, path: p, from: got.from,
      additions: file.additions, deletions: file.deletions,
    }) };
  },

  'GET /api/queue': () => readQueue(),

  'PUT /api/queue': ({ items }) => writeQueue(items),

  /** Appended to the description as checklist lines, one per item. */
  'POST /api/queue/to-pr': async ({ items, indices }) => {
    if (!ours(await currentBranch(repo))) {
      throw new Error('the pull request on screen is not this branch\'s — check it out to move items into it');
    }
    return moveOut(items, indices, async (moving) => {
      await editBody((current) => appendTasks(current, moving.map((i) => i.text)));
      const where = `PR #${pr.number}'s description`;
      term.verbose(`moved ${moving.length === 1 ? quote(moving[0].text) : `${moving.length} items`} into ${where}`);
      return where;
    });
  },

  /** Filed as an issue, one item at a time: each is its own issue. */
  'POST /api/queue/to-issue': async ({ items, index }) => {
    info ??= await repoInfo(repo);
    return moveOut(items, [index], async ([item]) => {
      const { url } = await createIssue(repo, info.nameWithOwner, item.text);
      term.verbose(`filed ${quote(item.text)} as ${url}`);
      return url;
    });
  },
};

/**
 * Whether a request states an origin, and whether it is ours.
 *
 * localhost is where the same-origin policy stops helping, in two ways this
 * server is exposed by. Any page on the web can send a simple cross-origin POST
 * to a predictable port: it cannot read the answer, but switching branches,
 * rewriting the PR description and filing issues all happen on the way out.
 * And WebSockets are not subject to the policy at all -- that same page can
 * open /pty, get a `claude` PTY in this repo, read what it prints and type at
 * it, approvals included.
 *
 * Absent is allowed, wrong is not. A browser always states an origin on a
 * WebSocket upgrade and on any request a page makes with fetch, so nothing that
 * has an origin to give is being waved through; curl, the drivers and prcoder's
 * own whoami probe send none, and the run-prcoder skill's curls keep working.
 * Compared against Host rather than a computed URL so a port fallback and an
 * ::1-vs-127.0.0.1 answer take care of themselves.
 *
 * Which is only sound once Host itself is a loopback name. DNS rebinding points
 * attacker.example at 127.0.0.1 after the page has loaded, and from then on the
 * page is same-origin with this server as far as the browser is concerned:
 * Origin and Host agree, and a same-origin GET states no Origin at all. The
 * name it used is the one thing it cannot change, so a Host that is not ours
 * is refused before anything else is looked at. A hosts-file alias for
 * 127.0.0.1 is refused with it -- use localhost.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const sameOrigin = (req) => {
  try {
    if (!LOOPBACK.has(new URL(`http://${req.headers.host}`).hostname)) return false;
  } catch { return false; }
  const { origin } = req.headers;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
};

async function handleApi(req, res, key) {
  const handler = routes[key];
  if (!handler) return res.writeHead(404).end('no such route');
  if (!sameOrigin(req)) {
    return res.writeHead(403, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'cross-origin request refused' }));
  }
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    // Serialised, and resolved *before* the header goes out: writing the 200
    // first means a throwing handler hits writeHead twice, and the second one
    // takes the whole process down with ERR_HTTP_HEADERS_SENT.
    const started = Date.now();
    const result = UNLOCKED.has(key) ? handler(body) : serial(() => handler(body));
    const payload = JSON.stringify(await result ?? null);
    term.debug(`${key} ${Date.now() - started}ms`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  } catch (e) {
    console.error(key, e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message.trim() }));
  }
}

// Browser-facing path -> file on disk. Keeps us free of a bundler.
const vendor = {
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
  // Prism core ships markup, css, clike and javascript, and the page asks for
  // one file per grammar on top of it. *Which* grammars is the page's own
  // business -- `grammars` in public/diff.js is its extension map plus what
  // those grammars are built on (tsx extends jsx and typescript) -- so a new
  // language is added there alone and served here without being named twice.
  // The paths stay literal, because they are a fact about node_modules.
  '/vendor/prism.js': 'prismjs/prism.js',
  ...Object.fromEntries(grammars
    .map((l) => [`/vendor/prism/${l}.js`, `prismjs/components/prism-${l}.min.js`])),
};

/**
 * The vendor files not on disk under `dir`'s node_modules. Nothing else says
 * so: a missing xterm is a blank page and a missing Prism is a plain file with a
 * line in the browser console. A pull that adds a dependency and no `npm
 * install` after it was exactly that on 2026-09-23.
 */
export const missingVendor = (dir = root) =>
  Object.values(vendor).filter((f) => !existsSync(path.join(dir, 'node_modules', f)));

// A second line of defence for the page that holds the PTY. A hole in the
// description renderer loads no script, and no other page can frame prcoder and
// turn a click on its own content into a click on ▶. style-src stays loose
// because xterm injects its own <style>; img-src is left unset so the data:
// favicon still loads. docs/Security.md argues the frame; #49 is the rest.
const csp = "script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

async function serveFile(res, file) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// Exported so test/api.test.js can listen on a free port in-process. Everything
// that starts a listener is under `import.meta.main` below, so importing this
// module still starts nothing.
export const server = http.createServer(async (req, res) => {
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
// Held rather than discarded: `wss.clients` is how the block and the quit
// prompt know whether anyone is looking, and `ptys` is how a deliberate quit
// takes the Claude sessions with it instead of orphaning them.
const ptys = new Set();
const wss = new WebSocketServer({ server, path: '/pty' }).on('error', () => {}).on('connection', (ws, req) => {
  // Before the spawn, not after: the PTY is the thing being protected, and one
  // that has already started has already read the repo.
  if (!sameOrigin(req)) return ws.close(1008, 'cross-origin connection refused');

  const pty = ptySpawn(process.env.CLAUDE_BIN || 'claude', claudeArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: repo,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  ptys.add(pty);
  repaint();
  pty.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  // Out of the set as soon as it is dead, so askToQuit only ever kills live ones.
  pty.onExit(() => {
    ptys.delete(pty);
    ws.close();
  });

  // A throw in a 'message' listener reaches the emitter, and an uncaught
  // exception there takes the process down -- with it every *other* tab's
  // claude session. One malformed frame, or a resize node-pty rejects, is
  // enough, so the frame is dropped and the server stays up.
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') pty.write(msg.data);
      else if (msg.type === 'resize') pty.resize(msg.cols, msg.rows);
    } catch (e) {
      term.debug(`ignored a bad websocket frame: ${e.message}`);
    }
  });
  ws.on('close', () => {
    ptys.delete(pty);
    // node-pty throws killing a pty that has already gone, and the normal end
    // of a claude session arrives here exactly that way: onExit above closes
    // the socket, which lands us here with nothing left to kill. Thrown from a
    // 'close' listener that would be an uncaught exception, so quitting claude
    // in one tab took the server and every other tab's session with it.
    try { pty.kill(); } catch { /* it exited first, which is why we are here */ }
    repaint();
  });
});

/**
 * Who has the port we wanted. Worth asking rather than guessing: the likely
 * cause is a second prcoder in the same repo, and then the useful answer is not
 * "the port is busy" but "the window you are looking for is over there".
 * A hash collision with an unrelated repo is the other case, and that one has
 * to read differently or you go hunting for a window that does not exist.
 */
async function whoHasPort(wanted) {
  try {
    const res = await fetch(`http://localhost:${wanted}/api/whoami`,
      { signal: AbortSignal.timeout(2000) });
    const other = await res.json();
    if (!other?.prcoder) return 'something that is not prcoder';
    // The path only when it is not ours. Two worktrees of one repo share a
    // nameWithOwner and are the collision worth spelling out; a second prcoder
    // in *this* directory is the common case, and there the path says nothing.
    return `another prcoder on ${other.nameWithOwner ?? 'an unknown repo'}` +
      `${other.branch ? ` (${other.branch})` : ''}${other.repo === repo ? '' : ` in ${other.repo}`}`;
  } catch {
    return 'something that is not answering as prcoder';
  }
}

async function ready() {
  const port = server.address().port;
  const url = `http://localhost:${port}`;
  urls = {
    local: url,
    // Kept in the block for the whole session, not just said once at startup:
    // a moved port is exactly what breaks the bookmark and the Dock icon, and
    // that is discovered later, by clicking one of them.
    // PRCODER_PORT means the port was named, not derived, so "the usual URL for
    // this repo" is not the true sentence -- there is no bookmark to have
    // broken, only an instruction that could not be followed.
    moved: port === wanted ? null : `http://localhost:${wanted} is taken by ${await whoHasPort(wanted)} — ` +
      (process.env.PRCODER_PORT ? 'not the port you asked for' : 'not the usual URL for this repo'),
  };

  // Through the serial chain, so a request arriving before this finishes waits
  // rather than running against a half-loaded process: ours() refuses a move
  // into the description while `pr` and `info` are still null, which would read
  // as the PR not being this branch's. `listening` fires before any connection
  // is handled, so this is always first in the chain.
  await serial(async () => {
    info ??= await repoInfo(repo).catch((e) => {
      console.error('repo:', e.message);
      return null;
    });
    await refreshPr().catch((e) => console.error('pr:', e.message));
    await status().catch((e) => console.error('status:', e.message));
  });
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  if (pr) console.log(pr.url);
  console.log(url);
  if (urls.moved) console.error(urls.moved);
  if (!process.env.PRCODER_NO_OPEN) openBrowser();
}

// ponytail: the platform's own opener, not a dependency. PRCODER_NO_OPEN=1 to
// skip; PRCODER_OPEN to run your own command with the URL appended, which is
// how a browser is told "a new window, not a tab".
function openBrowser() {
  const url = urls.local;
  const opener = { darwin: 'open', win32: 'start' }[process.platform] || 'xdg-open';
  const custom = process.env.PRCODER_OPEN;
  const child = custom
    ? spawn(`${custom} ${url}`, { detached: true, stdio: 'ignore', shell: true })
    : spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', (e) => console.error(`could not open a browser (${e.message}) — visit ${url}`)).unref();
}

/**
 * Binds the first of `ports` that is free, and answers with it; 0 means the
 * kernel picks, and always binds. Each attempt re-registers both handlers,
 * because a callback passed to listen() survives the EADDRINUSE it was
 * registered for -- one passed to the first attempt as well as the retry ran
 * ready() twice, two banners and two port probes. Anything that is not a busy
 * port is still thrown.
 */
function bind(ports) {
  return new Promise((resolve, reject) => {
    const attempt = (i) => {
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code !== 'EADDRINUSE') return reject(e);
        if (i + 1 >= ports.length) return reject(e);
        attempt(i + 1);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(ports[i], '127.0.0.1');
    };
    attempt(0);
  });
}

/**
 * Bind the port this repo should be on, and answer with the one it *wanted* --
 * which ready() compares against what it got.
 *
 * A port that has been recorded, or named in PRCODER_PORT, gets one attempt and
 * then a kernel-chosen one, so a second prcoder in this directory moves aside
 * with a note rather than silently opening a different URL from the bookmark.
 *
 * A first run has no such promise to keep, so it walks the range from the seed
 * and records whatever binds. That is what makes a collision between two repos
 * heal: without it the loser took a fresh random port every run forever.
 */
async function listenOnRepoPort() {
  const pinned = Number(process.env.PRCODER_PORT);
  if (pinned) {
    await bind([pinned, 0]);
    return pinned;                       // never recorded: a pin is for one run
  }

  const recorded = await readPort(repo);
  if (recorded) {
    await bind([recorded, 0]);
    return recorded;
  }

  // The trailing 0 is for a machine with all 4096 busy, which is not one
  // prcoder can pick a favourite on -- but is still no reason not to start.
  // Nothing is recorded in that case, so the next run tries the range again.
  const range = portCandidates(repo);
  const port = await bind([...range, 0]);
  if (!range.includes(port)) return port;
  // A repo we cannot write to still runs; it just derives its port again next
  // time, which is what every run did before this file existed.
  await writePort(repo, port).catch((e) => console.error('port:', e.message));
  return port;
}

/**
 * What quitting costs, so the answer is an informed one. Every number here is
 * already in hand; none of it shells out, because a keypress that waits on git
 * is a keypress that can hang.
 *
 * An empty list is not a question worth asking, so it is not asked: no tab open,
 * nothing left in the queue, nothing in the working tree that quitting could
 * lose.
 */
/** The queue's outstanding items. Cached, so no subprocess. */
const localOnly = () => counts(last?.queue ?? []).local;

function askToQuit() {
  const risk = [
    wss.clients.size && (wss.clients.size > 1
      ? `${wss.clients.size} browser tabs — their Claude sessions end`
      : '1 browser tab — the Claude session ends'),
    last?.ahead && `${last.ahead} unpushed commit${last.ahead > 1 ? 's' : ''}`,
    last?.dirtyFiles?.length && `${last.dirtyFiles.length} uncommitted file${last.dirtyFiles.length > 1 ? 's' : ''}`,
    // The queue is what you meant to finish this time round, and it lives only
    // on this machine: an item still in it reached neither the PR nor an issue,
    // and nobody working anywhere else will ever see it.
    localOnly() && `${localOnly()} queue item${localOnly() > 1 ? 's' : ''} not moved anywhere — move them to the PR or an issue to keep them past this machine`,
  ].filter(Boolean);
  // Killed here rather than left to the close handlers: process.exit does not
  // wait for them, and an orphaned `claude` outlives the terminal it was
  // started from.
  const quit = () => {
    for (const pty of ptys) pty.kill();
    wss.close();
    server.close();
    process.exit(0);
  };
  if (!risk.length) return quit();
  term.confirm(`quit? ${risk.join('; ')}  [y/N] `, quit);
}

if (import.meta.main) {
  // Before anything can print: init() is what routes console through the log,
  // and a line written ahead of it would sit above the block and stay there.
  term.init();
  term.keys({
    quit: askToQuit,
    key: (ch) => {
      if (ch === 'v') term.cycleVerbosity();
      else if (ch === 'o') openBrowser();
      // Serialised like any route: a poll is git and gh calls, and a keypress
      // is no reason to run them alongside a checkout.
      else if (ch === 'r') {
        term.verbose('refreshing…');
        serial(() => status({ full: true })).catch((e) => console.error('refresh:', e.message));
      }
    },
  });
  // The block is repainted by the browser's poll, which stops when its tab is
  // hidden. This does not refresh anything -- it redraws what is already known
  // so the age above stays honest, and term.status() writes nothing at all
  // while the rendered lines are unchanged.
  setInterval(repaint, 30_000).unref();

  // By package: a missing Prism is eleven files and one fix.
  const missing = new Set(missingVendor().map((f) => f.split('/').slice(0, f.startsWith('@') ? 2 : 1).join('/')));
  if (missing.size) console.error(`not in node_modules, so npm install first: ${[...missing].join(', ')}`);

  // ready() needs the port we meant to be on, so it is settled before the
  // socket is up rather than recomputed from the path afterwards.
  wanted = await listenOnRepoPort();
  await ready();
}
