#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a four-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { text as readBody } from 'node:stream/consumers';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, prHeads, prBody, listPrs, issueLinks, setViewed, setBody, createIssue, fetchPatches, runCount } from './github.js';
import { snapshot, currentBranch, repoInfo, prScope, compareUrl, githubUrl, originOwner, checkoutPr, pushBranch, remoteBranchHead, trackingHead, localPatch, branchesBelow } from './git.js';
import { bucket, fileUrl, fileViews } from './files.js';
import { readPort, writePort, useQueueFile, movedQueue } from './store.js';
import { readQueue, writeQueue, quote } from './queue.js';
import { parseCli, usage, VERSION, portCandidates, statusLines, openRepoArgs, OPEN_REPO_VARS, REPO_ENV, queueSummary, quitRisks } from './cli.js';
import * as term from './term.js';
import { toggleTask } from './public/tasks.js';
import { grammars } from './public/diff.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
// The PR to open (a number, URL or branch) and the agent's argv, both from the
// command line -- see cli.js. Parsed in main, not here: a test importing this
// module must not parse the runner's argv, and the spawn needs `agentArgs` to
// be an array either way.
let target;
let agentArgs = [];
// The PR is fetched once and reused, with its files already grouped and linked
// (decorateFiles); the PR routes need its body, node id and head.
let pr = null;
// owner/repo and default branch: constant while we run, and loaded at startup
// rather than lazily, because the issue links the queue derives need it before
// the first poll.
let info = null;
const repoFacts = async () => (info ??= await repoInfo(repo));

// A port named for this run, and whether to open a browser: env first, then
// the flags over it in main. Held here rather than written back into the env,
// because the env is what the `claude` child inherits -- a flag set that way
// reached any prcoder started from that pane, in any repo, which then never
// opened a browser or fell off a --port pin it was never given.
let pinnedPort = Number(process.env.PRCODER_PORT) || 0;
let noOpen = !!process.env.PRCODER_NO_OPEN;

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
 * `pr` in the middle of editBody's read-modify-write of the description.
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

async function refreshPr() {
  pr = await loadPr(repo, target);
  // Once per load rather than per poll: nothing it reads changes until the PR
  // is reloaded.
  if (pr) decorateFiles(pr);
}

/**
 * Each file told which of the pane's groups it is in, and the ways to read it
 * on GitHub: its patch in the diff viewer, and the whole file at the PR's head.
 * The group is a key on the file rather than a second list of the same files:
 * that list went to every tab on every poll beside `files`, each file twice.
 */
function decorateFiles(p) {
  for (const f of p.files) {
    f.group = bucket(f.path);
    f.url = fileUrl(p.url, f.path);
    Object.assign(f, fileViews(p.url, p.headRefOid, f.path));
  }
}

/**
 * Every queue write, and the copy of the queue askToQuit lists kept up with it.
 * That copy is otherwise the last poll's, so an item filed as an issue a moment
 * before `q` was still listed as on Local.
 */
async function saveQueue(items) {
  const saved = await writeQueue(repo, items, info?.nameWithOwner);
  if (last) last.queue = saved;
  return saved;
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
    return await saveQueue(items.filter((i) => !moving.includes(i)));
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
 * Where the repo is, plus the PR and queue that go with it. The client polls
 * this; nothing is stored between calls, so an outside `git checkout` or an
 * edit on github.com is picked up without prcoder having to be told.
 */
async function status({ full = false } = {}) {
  const calls = runCount();

  // Taken once and threaded through: the remote head is not known yet, and
  // asking git the same four questions three times a minute is just noise.
  const branch = await currentBranch(repo);
  // A full refresh reloads regardless, so it has no use for the cheap check.
  const heads = full ? null : await prHeads(repo, target);

  // The cheap call decides whether the expensive one is needed: loadPr also
  // runs a paginated GraphQL pass, which is far too much for a 60s poll.
  if (full || heads?.updatedAt !== pr?.updatedAt || heads?.number !== pr?.number) {
    if (!full && pr) term.debug(`PR #${pr.number} changed upstream — reloading into the UI`);
    await refreshPr();
  }
  // After the PR, so a startup whose repo lookup fails still has the PR to report.
  const facts = await repoFacts();

  // With no PR there is no headRefOid to compare against, so read git's own
  // record of origin's head -- not origin: that was a `git ls-remote` a minute
  // per visible tab, on the one branch state where nothing has changed until
  // you push (#19). The create route is the one place that still asks origin,
  // because it pushes on the answer.
  const oid = pr?.headRefOid ?? heads?.headRefOid ?? await trackingHead(repo, branch);
  const snap = await snapshot(repo, oid, branch);
  const scope = prScope(pr, { branch: snap.branch, nameWithOwner: facts.nameWithOwner });
  const tracked = scope === 'current' || scope === 'none';

  last = {
    ...snap,
    ...facts,
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
    pr,
    queue: await readQueue(repo, info?.nameWithOwner),
  };
  checkedAt = Date.now();
  repaint();
  // Seven on a clean tree or a dirty one, with or without a pull request.
  // Printed at PRCODER_VERBOSE=2 so a change that adds one shows up as a
  // number rather than as a slower poll.
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
const UNLOCKED = new Set(['GET /api/whoami', 'GET /api/status']);

/**
 * Status polls that arrive while one is still waiting for the lock share it:
 * two tabs, or a tab's timer landing on its own visibilitychange, would
 * otherwise each queue the full set of gh and git calls. Cleared as the run
 * *starts*, so a poll arriving mid-run gets a fresh one rather than an answer
 * from before whatever it queued behind.
 */
let queuedPoll = null;
const poll = () => (queuedPoll ??= serial(() => {
  queuedPoll = null;
  return status();
}));

const routes = {
  // Unlocked only because poll() takes the lock itself.
  'GET /api/status': poll,

  // `started` is what the exit bar fills its fields with: the model and effort
  // given after -- on prcoder's command line, so starting the agent again offers
  // what it was started with rather than a blank nobody remembers the meaning of.
  'GET /api/whoami': () => ({ prcoder: true, repo, branch: last?.branch ?? null,
    nameWithOwner: info?.nameWithOwner ?? null, started: startedWith(agentArgs) }),

  'GET /api/prs': () => listPrs(repo),

  // The exit panel's Quit button, asking what the terminal's q asks. Without
  // `force`, a quit that would cost something only says what it would cost, so
  // the page can put the same question to you there.
  'POST /api/quit': ({ force } = {}) => {
    // Into the terminal's scrollback, as q does: first, and whether or not the
    // question that follows is answered yes. listQueue() prints nothing new on
    // the forced request that follows a yes, and lists anything added since.
    listQueue();
    const risk = quitRisk();
    if (risk.length && !force) return { risk };
    // Deferred so the reply goes out first: process.exit doesn't wait for it.
    setTimeout(quit, 100);
    return { quit: true };
  },

  /**
   * The issues the description mentions without closing, for the queue's Issues
   * tab: title, state and kind, asked about by number. It was the repo's first
   * 200 open issues, and in a repo with more than that an open issue past the
   * cut read as "not an open issue". Capped at 50 numbers, as withLinks is.
   */
  'GET /api/issues': async () => {
    const cur = requirePr();
    const numbers = cur.issues.filter((i) => !i.closes).map((i) => i.number).slice(0, 50);
    const links = numbers.length ? await issueLinks(repo, cur.url, numbers) : new Map();
    return numbers.map((number) => ({ number, ...links.get(number) }));
  },

  'POST /api/pr/switch': async ({ number }) => {
    await checkoutPr(repo, number);
    term.verbose(`checked out PR #${number}`);
    // Clear rather than pin: the checkout put us on the branch, so following it
    // gives the same answer and self-heals when Claude switches branches later.
    target = undefined;
    return status({ full: true });
  },

  'POST /api/pr/create': async () => {
    const facts = await repoFacts();
    const branch = await currentBranch(repo);
    if (!branch) throw new Error('detached HEAD — check out a branch first');
    if (branch === facts.defaultBranch) throw new Error(`on ${branch} — make a branch first`);

    // GitHub's compare page only knows about branches it has seen. Ask origin
    // rather than trusting a sync verdict computed without a remote head.
    const pushed = !(await remoteBranchHead(repo, branch));
    if (pushed) await pushBranch(repo);
    return { url: compareUrl(facts.nameWithOwner, facts.defaultBranch, branch, await originOwner(repo)), pushed };
  },

  /**
   * What a branch with no pull request is built on, from git (#93): for the
   * branch-only pane, and for a Stack tab whose chain reached such a branch.
   * A POST only because handlers get the body and not the query, as with
   * /api/diff; it writes nothing. `prs` is the page's list as head/base pairs,
   * which says what git can't -- see branchesBelow.
   *
   * The checked-out branch walks from HEAD, pushed or not. Any other has to be
   * one origin has, and goes to git as a full `refs/remotes/...` path, which
   * can't be read as an option.
   */
  'POST /api/below': async ({ branch, prs = [] } = {}) => {
    if (typeof branch !== 'string' || !branch) throw new Error('no branch');
    const current = branch === await currentBranch(repo);
    if (!current && !(await trackingHead(repo, branch))) throw new Error(`origin has no branch ${branch}`);
    const pairs = (Array.isArray(prs) ? prs : [])
      .filter((p) => typeof p?.headRefName === 'string' && typeof p?.baseRefName === 'string');
    const { defaultBranch } = await repoFacts();
    return { branch, ...(await branchesBelow(repo, branch, defaultBranch, { current, prs: pairs })) };
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

  'GET /api/queue': () => readQueue(repo, info?.nameWithOwner),

  'PUT /api/queue': ({ items }) => saveQueue(items),

  /** Filed as an issue, one item at a time: each is its own issue. */
  'POST /api/queue/to-issue': async ({ items, index }) => {
    const { nameWithOwner } = await repoFacts();
    return moveOut(items, [index], async ([item]) => {
      const { url } = await createIssue(repo, nameWithOwner, item.text);
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
 * ticking a box in the PR description and filing issues all happen on the way out.
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

/**
 * Pure: the model and effort an argv names, '' for one it doesn't. The last of
 * each wins, as it does for claude, and both `--model x` and `--model=x` count.
 */
export function startedWith(args) {
  const got = { model: '', effort: '' };
  for (let i = 0; i < args.length; i++) {
    const m = /^--(model|effort)(?:=(.*))?$/s.exec(args[i]);
    if (m) got[m[1]] = m[2] ?? args[++i] ?? '';
  }
  return got;
}

/**
 * Pure: the /pty query string -> this `claude`'s whole argv after `base` (the
 * agent's arguments from prcoder's command line), or null to refuse the socket.
 * The exit panel's "Start coding agent again" sends it; a first open sends
 * nothing and gets `base`.
 *
 * Its settings go after `base`, so one chosen in the page wins over one given
 * there -- and a blank one leaves `base`'s in place. That is why blanking both
 * fields does not get you the agent's own default when -- named a model or
 * effort: there is nothing to send that would unsay it.
 *
 * Allowlisted rather than passed through, because this is the page choosing a
 * spawn's argv. A model has to be a name, not something starting with a dash:
 * `--model --dangerously-skip-permissions` must not reach claude as two flags.
 * `@` and `/` are in the name because Vertex IDs (`claude-sonnet-4-5@20250929`)
 * and Bedrock ARNs use them.
 *
 * A setting equal to the one `base` already ends on is dropped before the
 * check, not checked: the exit bar is filled with `base`'s (startedWith), so an
 * untouched restart sends them back, and the command line accepts names the
 * allowlist doesn't know. `base` carries it already; repeating it adds nothing.
 *
 * The real spawn was driven once by hand (2026-09-23), against a stub that
 * prints its argv: `[]` on the first open, then `[--continue --model opus
 * --effort high]` after starting it again, and the server exiting 0 after Quit.
 */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function sessionArgs(params, base = []) {
  const given = startedWith(base);
  const own = (key) => (params.get(key) === given[key] ? '' : params.get(key));
  const model = own('model');
  const effort = own('effort');
  if (model && !/^\w[\w.:@/[\]-]*$/.test(model)) return null;
  if (effort && !EFFORTS.has(effort)) return null;
  return [
    ...base,
    ...(params.has('continue') ? ['--continue'] : []),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
}

const wss = new WebSocketServer({ server, path: '/pty' }).on('error', () => {}).on('connection', (ws, req) => {
  // Before the spawn, not after: the PTY is the thing being protected, and one
  // that has already started has already read the repo.
  if (!sameOrigin(req)) return ws.close(1008, 'cross-origin connection refused');

  const args = sessionArgs(new URL(req.url, 'http://localhost').searchParams, agentArgs);
  if (!args) return ws.close(1008, 'bad session settings');

  const pty = ptySpawn(process.env.PRCODER_AGENT_BIN || 'claude', args, {
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
    // A pinned port was named, not derived, so "the usual URL for
    // this repo" is not the true sentence -- there is no bookmark to have
    // broken, only an instruction that could not be followed.
    moved: port === wanted ? null : `http://localhost:${wanted} is taken by ${await whoHasPort(wanted)} — ` +
      (pinnedPort ? 'not the port you asked for' : 'not the usual URL for this repo'),
  };

  // Through the serial chain, so a request arriving before this finishes waits
  // rather than running against a half-loaded process: an issue filed before
  // `info` loads would have no repository to link to. `listening` fires before
  // any connection is handled, so this is always first in the chain.
  // A full status rather than a PR load followed by a poll: the poll would only
  // ask GitHub again whether the PR it just loaded had changed.
  await serial(() => status({ full: true })).catch((e) => console.error('status:', e.message));
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  if (pr) console.log(pr.url);
  console.log(url);
  if (urls.moved) console.error(urls.moved);
  // Said, because nothing else would: the pane looks the same whichever file
  // it is showing, and a forgotten PRCODER_QUEUE reads as a lost queue.
  if (movedQueue()) console.log(`queue: ${movedQueue()}`);
  if (!noOpen) openBrowser();
}

// ponytail: the platform's own opener, not a dependency. --no-open (or
// PRCODER_NO_OPEN=1) to skip; PRCODER_BROWSER to run your own command with the URL
// appended, which is how a browser is told "a new window, not a tab".
function openBrowser(url = urls.local) {
  const opener = { darwin: 'open', win32: 'start' }[process.platform] || 'xdg-open';
  const custom = process.env.PRCODER_BROWSER;
  // Renamed, and only warned about: unlike a leftover CLAUDE_BIN, ignoring it
  // opens the default browser, which is wrong but harmless -- yet with no word,
  // the window someone set up just stops appearing.
  if (!custom && process.env.PRCODER_OPEN) {
    console.error('prcoder: PRCODER_OPEN is now PRCODER_BROWSER; rename it -- opening the default browser');
  }
  const shell = Boolean(custom) || process.platform === 'win32';
  const child = custom
    ? spawn(`${custom} ${url}`, { detached: true, stdio: 'ignore', shell })
    : spawn(opener, [url], { detached: true, stdio: 'ignore', shell });
  watch(child, shell, (why) => console.error(`could not open a browser (${why}) — visit ${url}`));
}

/**
 * Lets a detached opener go, but not unheard. Through a shell, a command that
 * is missing or fails is no `error` -- the shell itself started -- only a
 * nonzero exit, and with stdio ignored that is the one sign there is; so a
 * shell's exit code is reported. An argv spawn's is not: a missing command is
 * already an `error`, and explorer exits 1 when it has opened the window.
 * A signal is someone closing the window, not a failure.
 */
function watch(child, shell, failed) {
  child.on('error', (e) => failed(e.message));
  if (shell) child.on('exit', (code) => code && failed(`exit ${code}`));
  child.unref();
}

/**
 * `g`: the PR on GitHub, or what githubUrl() opens without one. gh is asked
 * again rather than trusting `pr`, which is only as fresh as the last poll --
 * and polls stop while no tab is visible, which is exactly when someone is at
 * this terminal pressing keys, and the agent may have switched branches since.
 */
async function openGithub() {
  const branch = await currentBranch(repo);
  const { nameWithOwner, defaultBranch } = await repoFacts();
  openBrowser(githubUrl({
    prUrl: (await prHeads(repo, target))?.url, nameWithOwner, defaultBranch, branch,
    pushed: Boolean(await trackingHead(repo, branch)), owner: await originOwner(repo),
  }));
}

// `t` and `f`: a terminal, or the file manager, on the repo. Detached like the
// browser above, and never from a route: the page names nothing that reaches an
// argv here, and `repo` is the server's own cwd. An override from
// OPEN_REPO_VARS comes back as a shell command line rather than an argv;
// openRepoArgs says why.
function openRepo(what) {
  const argv = openRepoArgs(what, process.platform, repo, process.env[OPEN_REPO_VARS[what]]);
  if (!argv) return console.error(`${what}: not implemented on ${process.platform} yet; ${OPEN_REPO_VARS[what]} names one`);
  const opts = { detached: true, stdio: 'ignore' };
  const child = typeof argv === 'string'
    ? spawn(argv, { ...opts, shell: true, env: { ...process.env, [REPO_ENV]: repo } })
    : spawn(argv[0], argv.slice(1), opts);
  watch(child, typeof argv === 'string', (why) => console.error(`could not open a ${what} (${why})`));
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
 * A port that has been recorded, or named by --port or PRCODER_PORT, gets one
 * attempt and then a kernel-chosen one, so a second prcoder in this directory
 * moves aside with a note rather than silently opening a different URL from the
 * bookmark.
 *
 * A first run has no such promise to keep, so it walks the range from the seed
 * and records whatever binds. That is what makes a collision between two repos
 * heal: without it the loser took a fresh random port every run forever.
 */
async function listenOnRepoPort() {
  if (pinnedPort) {
    await bind([pinnedPort, 0]);
    return pinnedPort;                   // never recorded: a pin is for one run
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
 * and nothing in the working tree only this machine has. The queue is not in
 * it. Quitting leaves `.prcoder/queue.json` as it is, and a question about it
 * read as if `y` would file the items as issues; what is still on Local is
 * printed instead, first and either way, so it is in the scrollback to copy
 * from once prcoder has gone.
 */
function quitRisk() {
  return quitRisks({ tabs: wss.clients.size, ahead: last?.ahead, dirty: last?.dirtyFiles?.length });
}

/**
 * Print what is on Local. One write, not one per item: every log line erases
 * and repaints the block. Not again when it is what was printed last: Ctrl-C,
 * `n`, Ctrl-C used to list the same items twice, and the second copy only
 * pushed the first up the scrollback. A changed queue is listed afresh.
 */
let listed = '';
function listQueue() {
  const now = queueSummary(last?.queue ?? [], movedQueue() ?? undefined).join('\n');
  if (now && now !== listed) console.log(now);
  listed = now;
}

// Kills the PTYs itself rather than leaving that to the close handlers:
// process.exit doesn't wait for them, and an orphaned `claude` outlives the
// terminal it was started from.
//
// Exits once stdout has caught up, not straight away. Piped (`prcoder | tee`),
// stdout is asynchronous on macOS and process.exit drops what is still queued
// -- the Local list askToQuit printed a moment ago, on a reader that is behind.
// An empty write calls back once everything ahead of it is out; the timer is
// for a reader that never catches up, which must not keep prcoder alive.
let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  for (const pty of ptys) pty.kill();
  wss.close();
  server.close();
  setTimeout(() => process.exit(0), 2000);
  process.stdout.write('', () => process.exit(0));
}

function askToQuit() {
  listQueue();
  const risk = quitRisk();
  if (!risk.length) return quit();
  // Listed again on yes: the queue can change while the question waits, and
  // an item added from a tab in that time would otherwise go unprinted.
  term.confirm(`quit? ${risk.join('; ')}  [y/N] `, () => { listQueue(); quit(); });
}

if (import.meta.main) {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`prcoder: ${e.message}\n${usage().split('\n')[0]}`);
    process.exit(2);
  }
  if (cli.help) { console.log(usage()); process.exit(0); }
  if (cli.version) { console.log(VERSION); process.exit(0); }
  // Renamed, and refused rather than read: ignored, a leftover CLAUDE_BIN -- a
  // driver's stub, a scratch script's /bin/cat -- would quietly spawn the real
  // `claude` in its place, one session per tab, left running.
  if (process.env.CLAUDE_BIN && !process.env.PRCODER_AGENT_BIN) {
    console.error('prcoder: CLAUDE_BIN is now PRCODER_AGENT_BIN; rename it, or unset it to run `claude`');
    process.exit(2);
  }
  ({ target, agentArgs } = cli);
  // Into the variables, never the env: see pinnedPort.
  if (cli.port) pinnedPort = cli.port;
  if (cli.noOpen) noOpen = true;
  // Into the store, not the env, for the same reason: see useQueueFile.
  useQueueFile(cli.queue ?? process.env.PRCODER_QUEUE);
  if (cli.verbose) term.setVerbosity(cli.verbose);

  // Before anything can print: init() is what routes console through the log,
  // and a line written ahead of it would sit above the block and stay there.
  term.init();
  term.keys({
    quit: askToQuit,
    key: (ch) => {
      if (ch === 'v') term.cycleVerbosity();
      else if (ch === 'o') openBrowser();
      else if (ch === 'g') openGithub().catch((e) => console.error('github:', e.message));
      else if (ch === 't') openRepo('terminal');
      else if (ch === 'f') openRepo('folder');
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
