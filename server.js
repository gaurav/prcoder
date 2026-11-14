#!/usr/bin/env node
// prcoder — a PR-focused shell around Claude Code.
// Serves a four-pane UI at localhost and pipes a real `claude` PTY to the browser.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { text as readBody } from 'node:stream/consumers';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { loadPr, pullRequestFor, prBody, parsePrUrl, listPrs, branchPrs, lookupPrs, ownPrs, pickPr, issueLinks, lookupRef, setViewed, setBody, createIssue, fetchPatches, runCount, repoIssues, repoMilestones, setIssueMilestone } from './github.js';
import { notAWorkTree, snapshot, currentBranch, headCommit, commitsKnown, commitMemo, repoInfo, pushRepo, compareUrl, githubUrl, originOwner, wholePrRepo, startOnPr, trackedPr, workTreeTop, pushBranch, remoteBranchHead, trackingHead, localPatch, branchesBelow, worktrees, linkedWorktree, worktreeLoss, removeWorktree, worktreeFor, worktreeForPr, commitsOnlyHere } from './git.js';
import { bucket, fileUrl, fileViews } from './files.js';
import { readPort, writePort, readRunning, writeRunning, dropRunning, alive, claimStart, releaseStart, readPrs, writePrs, pick, useQueueFile, movedQueue, issueUrl, readPulls, markMade, madeHere } from './store.js';
import { readQueue, writeQueue, quote } from './queue.js';
import { readHistory } from './history.js';
import { parseCli, usage, VERSION, portCandidates, statusLines, openRepoArgs, OPEN_REPO_VARS, REPO_ENV, queueSummary, quitRisks, worktreeLosses, leaveQuestion, worktreeDir, agentWorktree } from './cli.js';
import { choosePr, githubPulls } from './choose.js';
import * as term from './term.js';
import { toggleTask, refs, wholeRef, resolveRef } from './public/tasks.js';
import { grammars } from './public/diff.js';
import { QUIT_CODE } from './public/ui.js';

const root = path.dirname(fileURLToPath(import.meta.url));
// Where prcoder was started, and what every git and gh call, the agent and
// `.prcoder/` are given. Not a const for one reason: `--worktree` moves this
// process into the worktree before anything else starts (startInWorktree).
let repo = process.cwd();
// The working copy's top level, which `repo` is or is inside: where the
// running records are kept, and what another prcoder is matched by
// (runningHere). Settled in main, once `repo` is known to be in a work tree.
let top = repo;
// The worktree this working copy is, when it is one `git worktree add` made
// (linkedWorktree in git.js), and null in a repository's main working copy.
// Settled in main with `top`, and what a quit reads to offer the removal.
let linked = null;
// The agent's argv, from the command line -- see cli.js. Parsed in main, not
// here: a test importing this module must not parse the runner's argv, and the
// spawn needs `agentArgs` to be an array either way.
let agentArgs = [];
// Which of the branch's pull requests to show, `{ branch, url }`: picked in the
// switcher, or named on the command line and checked out there (main). Only
// ever one of the checked-out branch's (docs/Design.md, "The pane shows what is
// checked out"), and dropped as soon as the poll finds another checked out.
let chosen = null;

/**
 * The URL of the pull request to show on `branch` whatever the search by name
 * says: the one chosen for it in this run, or else the one its config says it
 * was checked out for (trackedPr in git.js) -- a `pr-<n>` made for a gone
 * branch, or a fork's gh checked out to `owner/name`. Neither has the pull
 * request's head name, so the search would drop it, and before the config was
 * read a restart on such a branch showed no pull request. Null otherwise.
 */
async function choiceFor(branch, repos) {
  if (chosen?.branch === branch) return chosen.url;
  return trackedPr(repo, branch, repos).catch((e) => (term.debug(`${branch}'s pull request not read from its config: ${e.message}`), null));
}
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
// --no-history, or PRCODER_NO_HISTORY: the History tab off. The agent's name
// is held with it (cli.js, AGENTS): the history prcoder reads is Claude
// Code's own file (history.js), so another agent has none to show.
let noHistory = !!process.env.PRCODER_NO_HISTORY;
let agent = 'claude';
// Whether the History tab is on. CLAUDE_CODE_SKIP_PROMPT_HISTORY is Claude
// Code's own switch: set in the environment the `claude` child inherits, it
// writes no history, so the tab would show the prompts from before it was set
// and nothing after -- better hidden than half there.
const historyOn = () => !noHistory && agent === 'claude' && !process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY;

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

/**
 * `what` is the URL the branch lookup picked;
 * nothing means no pull request, and is not handed to gh, whose own lookup by
 * branch is what branchPrs replaces.
 */
async function refreshPr(what) {
  try {
    pr = what ? await loadPr(repo, what) : null;
  } catch (e) {
    // Pushed to faster than it can be read (prFiles): the one on screen stays,
    // and its updatedAt has moved, so the next poll reads it again. Another
    // pull request, or none shown yet, is a failure as before.
    if (e.moving && e.moving === pr?.url) {
      term.debug(e.message);
      return;
    }
    throw e;
  }
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
 * Whether the PR the last poll loaded still stands, by the cheap answer the
 * poll picked (pickPr over findPrs: branchPrs's rows, or one read by URL) --
 * and if it does, it takes its checks from that answer. updatedAt decides,
 * because loadPr also runs a paginated GraphQL pass, far too much for a 60s
 * poll; but not for the checks, since one finishing leaves updatedAt alone
 * (prHeads in github.js). No PR before and none now stands too, or a branch
 * without one would pay for a loadPr on every poll.
 *
 * The URL is the identity, not the number: a fork's pull request and one in
 * its parent can share a number. A cheap answer that carries no checks -- a
 * merged pull request's, which branchPrs reads without them -- leaves the
 * ones loadPr read.
 */
export function keepPr(pr, heads) {
  if (heads?.updatedAt !== pr?.updatedAt || heads?.url !== pr?.url) return false;
  if (pr && heads.checks) pr.checks = heads.checks;
  return true;
}

/** The branch's pull requests as the page gets them: no checks, which every poll would carry to every tab. */
const forPage = ({ checks, ...p }) => p;

/**
 * The branch's pull requests: read by URL from what `.prcoder/prs.json`
 * remembers, or searched for by name when that may be out of date, and the
 * answer remembered (lookupPrs in github.js has the rules). `fresh` searches
 * whatever is remembered. `facts` is the caller's repoFacts(), so that what is
 * searched and what the caller ranks and scopes by are the same repositories.
 * Run under the serial lock, since it writes the file.
 * Where the branch pushes is asked once, being for branchPrs and for ownPrs's
 * test of what is remembered, which is held to it on every poll. `chosen` is
 * the URL picked for this branch (the switcher, `prcoder <pr>`, or its config:
 * choiceFor), remembered
 * with the rest so that one the search by name cannot find -- a fork's checked
 * out to `owner/name`, a merged one beside an open one -- is read by URL like
 * them (lookupPrs). Before it was, `prcoder <fork's PR>` showed another pull
 * request, or none, though the start said it was on the one named.
 */
async function findPrs(branch, { repos, repoOf }, { has, checks, chosen = null, fresh = false }) {
  if (!branch) return [];
  let pushes;
  const home = () => (pushes ??= pushRepo(repo, branch, repoOf));
  const search = async () => branchPrs(repo, repos, branch, { has, checks, home: await home() });
  const own = async (rows) => ownPrs(rows, repos, { branch, has, home: await home() });
  const { prs, remember } = await lookupPrs(repo, repos, await readPrs(repo, branch), search, { own, chosen, fresh, checks });
  // A cache: a write that fails costs a search on the next poll, not this one.
  // Nothing to write on a branch with none known and none found (lookupPrs).
  if (remember) await writePrs(repo, branch, remember).catch((e) => term.debug(`prs.json not written: ${e.message}`));
  return prs;
}

/**
 * Where the repo is, plus the PR and queue that go with it. The client polls
 * this; nothing is stored between calls, so an outside `git checkout` or an
 * edit on github.com is picked up without prcoder having to be told. The one
 * exception is which pull requests the branch has, remembered in the file so
 * that a poll asks about them by URL (findPrs); `search` looks for them by name
 * again, which is `r` and the page's ⟳.
 */
async function status({ full = false, search = false } = {}) {
  const calls = runCount();

  // The branch is taken once and threaded through: the remote head is not
  // known yet, and asking git the same four questions three times a minute is
  // just noise. HEAD here only ranks the branch's pull requests; snapshot reads
  // it again beside the tree's status, which is what the sync light compares.
  const [branch, head] = await Promise.all([currentBranch(repo), headCommit(repo)]);
  if (chosen && chosen.branch !== branch) chosen = null;

  // The branch's pull requests are looked for in the repositories this names;
  // a lookup that fails fails the poll, as it should -- gh that cannot say
  // which repository this is cannot list its pull requests either.
  const facts = await repoFacts();
  // The branch's pull requests, wherever they are: the poll's cheap check,
  // whose checks keepPr takes.
  // One answer per commit for the whole poll (commitMemo). A change of branch
  // since the last poll searches, as `r` does; a restart starts from what the
  // file remembers.
  const commits = commitMemo(repo);
  const fresh = search || (last != null && last.branch !== branch);
  const choice = await choiceFor(branch, facts.repos);
  const found = await findPrs(branch, facts, { has: commits.many, checks: true, chosen: choice, fresh });
  const heads = pickPr(found, { head, chosen: choice, shown: pr?.url, repos: facts.repos });
  // Reloaded when the cheap check says it changed. A full refresh reloads
  // regardless, so it has no use for the cheap check.
  if (full || !keepPr(pr, heads)) {
    if (!full && pr) term.debug(`PR #${pr.number} changed upstream — reloading into the UI`);
    await refreshPr(heads?.url);
  }

  // With no PR there is no headRefOid to compare against, so read git's own
  // record of origin's head -- not origin: that was a `git ls-remote` a minute
  // per visible tab, on the one branch state where nothing has changed until
  // you push (#19). The create route is the one place that still asks origin,
  // because it pushes on the answer.
  const oid = pr?.headRefOid ?? heads?.headRefOid ?? await trackingHead(repo, branch);
  const snap = await snapshot(repo, oid, branch, commits.one);
  // The sync light and `ahead` are always the working copy's: the pull request
  // on screen is only ever the checked-out branch's (docs/Design.md, "The pane
  // shows what is checked out"), so its head is this branch's to compare with.
  last = {
    ...snap,
    ...facts,
    branchPrs: found.map(forPage),
    pr,
    queue: await readQueue(repo, info?.nameWithOwner),
  };
  checkedAt = Date.now();
  repaint();
  // How many depends on the branch, not the tree; docs/Verifying.md has the
  // figures. Printed at PRCODER_VERBOSE=2 so a change that adds one shows up
  // as a number rather than as a slower poll.
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
 *
 * The queue's reference lookup is a GitHub round trip that reads and writes
 * nothing of prcoder's -- the item is saved by a later PUT, which does take
 * the lock -- so it does not hold up the poll, saves and ticks behind it. The
 * Issues tab's listing is the same and much longer: up to five pages of a
 * hundred issues with their bodies, on every visit to the tab. The PR pane's
 * list of milestones to pick from is the same and short. The Pull
 * requests tab's listing is seconds long on a repository with many open;
 * what it writes, `.prcoder/pulls.json`, is its own file, replaced whole by
 * a rename (writePulls), and its fresh reads queue among themselves
 * (freshPulls) rather than behind everything else. The History tab's read
 * touches neither git nor `.prcoder/`: Claude Code's own files, read only.
 * The worktree line's list is one local git call that writes nothing, and a
 * probe of each other working copy's prcoder, which can take its two seconds
 * over a port that never answers -- two seconds the poll should not wait out.
 */
const UNLOCKED = new Set(['GET /api/whoami', 'GET /api/status', 'POST /api/queue/ref', 'GET /api/issues', 'POST /api/milestones', 'POST /api/pulls', 'POST /api/history', 'GET /api/worktrees']);

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

// What the Issues tab was last shown (GET /api/issues), for a route that acts
// on one of its rows: numbers and milestones, without the bodies of up to 500
// issues, which nothing here reads again.
let listing = null;

// What the PRs tab was last shown (POST /api/pulls, from the cache
// or GitHub), and the last listing this process read from GitHub, which is
// what the route that acts on a row holds a move to: pulls.json can be days
// old, and a pull request merged since is still a row in it.
let pulls = null;
let pullsFromGitHub = null;

// What the PR pane's milestone picker was last offered, by repository
// (`owner/name`): `{ at, list }`, with `at` when it was read from GitHub. A
// page load or a move to another repository is answered from here while it is
// younger than PICKER_LIST_FOR, so each one is not a gh call of its own; the
// picker asks for a fresh read as the pointer or the focus reaches it. And a
// pick is held to it (pickerMove), as the tabs' moves are to their listings.
const pickerLists = new Map();
const PICKER_LIST_FOR = 5 * 60_000;

async function pickerList(owner, name, fresh) {
  const held = pickerLists.get(`${owner}/${name}`);
  if (!fresh && held && Date.now() - held.at < PICKER_LIST_FOR) return held.list;
  const list = await repoMilestones(repo, owner, name);
  pickerLists.set(`${owner}/${name}`, { at: Date.now(), list });
  return list;
}

/**
 * What /api/pr/milestone may put the pull request `pr` on: `number` if it is
 * null, the milestone the pull request is already on, or one of `listed`, the
 * open milestones the picker was offered for its repository. Anything else --
 * a closed milestone, one the picker never showed, a number from a stale tab
 * or a script -- is refused before gh, as issueMove and pullMove refuse a
 * milestone their tab did not list. Pure, and exported for test/api.test.js.
 */
export const pickerMove = (listed, pr, number) => {
  if (number === null || number === pr.milestone?.number) return number;
  if (!listed?.some((m) => m.number === number)) throw new Error(`#${number} is not an open milestone the picker listed`);
  return number;
};

/**
 * What /api/pr/switch hands gh as the pull request to look up: the whole of a
 * pull request's URL (wholePrRepo), or, with no URL, a number -- a positive
 * integer and a JSON number, never a string, which could be a flag or a
 * branch's name by the time it is in gh's argv. Anything else is refused
 * here. Pure, and exported for test/api.test.js.
 */
export const switchTarget = ({ url, number } = {}) => {
  if (url !== undefined) {
    wholePrRepo(url);
    return url;
  }
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${JSON.stringify(number) ?? 'nothing'} is not a pull request's number`);
  return String(number);
};

/**
 * `fn` on a chain of its own, with poll()'s sharing: a call that arrives while
 * one is waiting shares it, and one arriving mid-run waits for that run and
 * then gets one of its own -- whatever it came to read may have changed since
 * the running one started. At most one runs, which keeps a slow read from
 * being repeated by every tab that asks, and two writes of its file apart.
 * `pending()` is the run under way, or else the one waiting, or null: for a
 * caller that wants any fresh answer, not one started after it arrived.
 * Exported for test/api.test.js.
 */
export const queuedRun = (fn) => {
  let tail = Promise.resolve();
  let waiting = null;
  let running = null;
  const run = () => (waiting ??= (tail = tail.catch(() => {}).then(() => {
    waiting = null;
    return (running = fn()).finally(() => { running = null; });
  })));
  run.pending = () => running ?? waiting;
  return run;
};

/**
 * The PRs tab's fresh read: GitHub's listing, written to
 * `.prcoder/pulls.json` (githubPulls, which `prcoder choose` reads by too)
 * and kept as `pulls`. Queued (queuedRun), not under the
 * server's lock: two at once each paid for the seconds-long read and wrote
 * the same temp file (writeJson's name is per process), which could leave it
 * interleaved or fail the second rename.
 */
const freshPulls = queuedRun(async () => (pulls = pullsFromGitHub = await githubPulls(repo, (await repoFacts()).nameWithOwner)));

/**
 * What /api/issue/milestone may do, from `listing`: `{ number, milestone, title }`
 * where `number` is an open issue the tab was shown and `milestone` the number
 * of one of its open milestones, found by title, or null to take the milestone
 * off. A closed one is listed only because an issue is still on it (repoIssues),
 * and is somewhere to move off, not onto.
 * The page's strings choose; the listing's are what reach gh -- the same hold
 * /api/pr/choose keeps on a pick. Pure, and exported for test/api.test.js.
 * pullMove is the same hold for /api/pull/milestone, on the pulls listing.
 */
export const issueMove = (listing, body) => heldMove(listing?.issues, listing?.milestones, 'issue', 'Issues', body);
export const pullMove = (listing, body) => heldMove(listing?.pulls, listing?.milestones, 'pull request', 'PRs', body);

function heldMove(rows, milestones, what, tab, { number, milestone } = {}) {
  const row = rows?.find((r) => r.number === number);
  if (!row) throw new Error(`#${number ?? '?'} is not an open ${what} the ${tab} tab listed`);
  // null exactly, not == null: a body with no `milestone` at all, which is what
  // JSON.stringify makes of an undefined, has not asked for it to be taken off.
  if (milestone === null) return { number: row.number, milestone: null, title: null };
  // A closed milestone is listed for the rows still on it, not as somewhere to move one.
  const found = milestones?.find((m) => m.title === milestone && !m.closed);
  if (!found) throw new Error(`"${milestone}" is not an open milestone the ${tab} tab listed`);
  return { number: row.number, milestone: found.number, title: found.title };
}

const routes = {
  // Unlocked only because poll() takes the lock itself.
  'GET /api/status': poll,
  // The page's ⟳: a poll that also searches for the branch's pull requests
  // afresh, as `r` does, for one opened on github.com or by the agent since;
  // a poll on its own reads only the ones prs.json already knows (findPrs).
  'POST /api/status': () => status({ search: true }),

  // `started` is what the exit bar fills its fields with: the model and effort
  // given after -- on prcoder's command line, so starting the agent again offers
  // what it was started with rather than a blank nobody remembers the meaning of.
  // `history` is whether the History tab is there to draw (historyOn).
  'GET /api/whoami': () => ({ prcoder: true, version: VERSION, repo, top, branch: last?.branch ?? null,
    nameWithOwner: info?.nameWithOwner ?? null, started: startedWith(agentArgs), history: historyOn() }),

  /**
   * The History tab: what was sent to the coding agent from this working copy,
   * read from Claude Code's own history file (readHistory) -- never written,
   * and nothing of the pastes. `limit` is how many of the newest, for a
   * caller that wants only those; the page reads the whole listing once, on
   * opening, and draws both the tab and the Claude pane's last-prompt notice
   * from it.
   * `{ enabled: false }` with the tab off, so the page can tell "nothing yet"
   * from "not read".
   */
  'POST /api/history': async ({ limit } = {}) => {
    if (!historyOn()) return { enabled: false };
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
    return { enabled: true, ...await readHistory(repo, { limit: n }) };
  },

  'GET /api/prs': () => listPrs(repo),

  // The pane's worktree line: every working copy of this repository, and
  // where the prcoder running in each one is (workingCopies).
  'GET /api/worktrees': () => workingCopies(),

  // The exit panel's Quit button, asking what the terminal's q asks. Without
  // `force`, a quit that would cost something only says what it would cost, so
  // the page can put the same question to you there.
  //
  // In a worktree the answer also carries `worktree`, what removing it would
  // delete (leaving), and the question has a third answer: the forced request
  // says `worktree: 'remove'` or `'keep'`. Those two words are all the page
  // can say about it. The directory removed is this server's own, and whether
  // git is told `--force` is decided here, from what is in it.
  'POST /api/quit': async ({ force, worktree } = {}) => {
    if (worktree !== undefined && worktree !== 'remove' && worktree !== 'keep') throw new Error('worktree: remove or keep');
    // Into the terminal's scrollback, as q does: first, and whether or not the
    // question that follows is answered yes. listQueue() prints nothing new on
    // the forced request that follows a yes, and lists anything added since.
    listQueue();
    const risk = quitRisk();
    const wt = await leaving();
    const unasked = tidy(risk, wt);
    if (!force && !unasked && (risk.length || wt)) {
      return { risk, ...(wt && { worktree: { name: wt.name, path: wt.path, lose: wt.lose, unpushed: wt.unpushed } }) };
    }
    if (worktree === 'remove' && !wt) throw new Error('this working copy is not a worktree prcoder can remove');
    const remove = worktree === 'remove' || (unasked && worktree === undefined) ? wt : null;
    // Deferred so the reply goes out first: process.exit doesn't wait for it.
    setTimeout(() => quit({ remove }), 100);
    // `removed`, for the page to say: nothing else would, once it has gone.
    return { quit: true, ...(remove && { removed: remove.path }) };
  },

  /**
   * The repository's open issues and milestones for the queue's Issues tab
   * (repoIssues), with the repository they are in as `repo`, and, with a pull
   * request on screen, the issues its
   * description mentions without closing as `mentions`: title, state and kind,
   * asked about by number, capped at 50 as withLinks is -- one past the cap is
   * there with its number alone, as one GitHub does not know is, so that every
   * mention has an answer and the tab can tell one not asked about yet, a
   * mention added since, from one asked about and not found. Two calls rather than
   * one query: issueLinks already reads an answer gh exited 1 on for the
   * numbers it did resolve, and a listing should not have to. No pull request
   * is needed -- a repository has issues whatever branch is checked out.
   *
   * Unlocked (UNLOCKED), so a poll can swap `pr` while this waits on GitHub:
   * the mentions are the pull request that was on screen when it was asked.
   * The listing is kept (`listing`) so a write about an issue can be held to
   * what the tab was last shown, as /api/pr/choose holds a pick to the poll.
   */
  'GET /api/issues': async () => {
    const { nameWithOwner } = await repoFacts();
    const [owner, name] = nameWithOwner.split('/');
    const cur = pr;
    const numbers = (cur?.issues ?? []).filter((i) => !i.closes).map((i) => i.number);
    const [found, links] = await Promise.all([
      repoIssues(repo, owner, name),
      numbers.length ? issueLinks(repo, cur.url, numbers.slice(0, 50)) : new Map(),
    ]);
    listing = { issues: found.issues.map(({ number }) => ({ number })), milestones: found.milestones };
    return { ...found, repo: nameWithOwner, mentions: numbers.map((number) => ({ number, ...links.get(number) })) };
  },

  /**
   * An issue dropped on a milestone group in the Issues tab, or one picked in
   * its row: the milestone is set on GitHub (setIssueMilestone), and the tab reads
   * the listing again. `milestone` is a title from the listing, or null to
   * take it off; issueMove holds both to what the tab was shown.
   */
  'POST /api/issue/milestone': async (body = {}) => {
    const { number, milestone, title } = issueMove(listing, body);
    const [owner, name] = (await repoFacts()).nameWithOwner.split('/');
    await setIssueMilestone(repo, { owner, repo: name, number }, milestone);
    term.verbose(`put #${number} on ${title ? `milestone ${quote(title)}` : 'no milestone'}`);
    return { ok: true };
  },

  /**
   * The repository's open pull requests and milestones for the queue's Pull
   * requests tab (repoPulls), with `read`, when the listing was read, in ms.
   * Without `fresh` it is the last listing -- the one on hand, or the one
   * `.prcoder/pulls.json` holds from an earlier run -- so the tab opens at
   * once; GitHub is read only when there is none. With `fresh` it is read now
   * and the file replaced, which is what the tab asks for behind the first
   * answer, and on its ⟳. With nothing on hand or on disk, a read already
   * under way is shared rather than queued behind: any listing will do. A
   * read that fails throws: the tab keeps what it was showing.
   */
  'POST /api/pulls': async ({ fresh = false } = {}) => {
    if (!fresh) {
      const held = pulls ?? await readPulls(repo, (await repoFacts()).nameWithOwner);
      // ??=: a fresh read that landed while the file was read is newer.
      if (held) return (pulls ??= held);
      return freshPulls.pending() ?? freshPulls();
    }
    return freshPulls();
  },

  /**
   * A pull request dropped on a milestone group in the PRs tab, or
   * one picked in its opened row: the milestone is set on GitHub
   * (setIssueMilestone, as an issue's is), and the tab reads the listing again.
   * pullMove holds the number and the title to the last listing read from
   * GitHub, not pulls.json's, where a pull request merged since the file was
   * written is still open -- the Issues tab's hold is always to a fresh read.
   * A move made while the tab shows only the file waits for the read the tab
   * asked for behind it.
   */
  'POST /api/pull/milestone': async (body = {}) => {
    const shown = pullsFromGitHub ?? await freshPulls.pending();
    if (!shown) throw new Error('The PRs tab has not read GitHub yet: press ⟳, then move it again');
    const { number, milestone, title } = pullMove(shown, body);
    const [owner, name] = (await repoFacts()).nameWithOwner.split('/');
    await setIssueMilestone(repo, { owner, repo: name, number }, milestone);
    term.verbose(`put pull request #${number} on ${title ? `milestone ${quote(title)}` : 'no milestone'}`);
    return { ok: true };
  },

  /**
   * The switcher's checkout: startOnPr, the one `prcoder <pr>` and `prcoder
   * choose` make, so a merged pull request whose branch is gone is checked
   * out from what is left, a pull request already checked out is no
   * checkout, and uncommitted work or another prcoder in the working copy
   * (runningHere: this one has its record already) refuses it. It called
   * checkoutPr directly before, and had none of that.
   *
   * Only into a repository the branch's pull requests are looked for in,
   * which is every one the page can list: the number-only route this
   * replaced could not reach any other, and this one should not either.
   * wholePrRepo holds the URL to one before it reaches gh's argv;
   * pullRequestFor then reads what startOnPr needs and holds it to `repos`
   * case-blind, as the command line's is -- a remote's URL can spell the
   * owner otherwise than GitHub does, which an exact match refused.
   *
   * Or `{ number }`, from the switcher's search field, for a pull request its
   * list of open ones does not have: a merged or closed one, or one opened
   * since the list was read. switchTarget takes a number only as a positive
   * integer, and gh reads a bare one in its base repository -- the list's own
   * -- so the same pullRequestFor finds its URL and holds it to `repos`.
   */
  'POST /api/pr/switch': async (body = {}) => {
    const p = await pullRequestFor(repo, switchTarget(body), (await repoFacts()).repos);
    const { branch, said, snag } = await startOnPr(repo, p, { inUse: runningHere });
    if (snag) console.log(said);
    else term.verbose(said ?? `${p.url} is already checked out`);
    // The choice made on the old branch goes with it, and the one asked for here
    // is the new branch's: of two pull requests on it into different bases,
    // pickPr has nothing to tell them apart by but age, and the one clicked
    // must be the one shown. Like any choice, it goes when the branch does.
    chosen = { branch, url: p.url };
    return status({ full: true });
  },

  /**
   * One of the branch's own pull requests, picked in the switcher: shown from
   * now on, for as long as the branch is checked out. Nothing is checked out,
   * since the branch is already this one. Only a URL the last poll listed for
   * the branch is taken, which is the only kind the page can offer.
   */
  'POST /api/pr/choose': async ({ url } = {}) => {
    const found = last?.branchPrs?.find((p) => p.url === url);
    if (!found) throw new Error(`${url ?? '(nothing)'} is not a pull request for this branch`);
    chosen = { branch: last.branch, url };
    term.verbose(`showing ${url} for ${last.branch}`);
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

  /**
   * The open milestones of the repository the pull request on screen is in,
   * for the PR pane's milestone picker, with that repository as `repo` so the
   * page can tell an answer about a pull request it has since left. The pull
   * request's repository, not the clone's: a fork's pull request into its
   * parent is on the parent's milestones. The list this process last read for
   * that repository while it is fresh enough (pickerList), and GitHub's now
   * with `fresh`. Unlocked (UNLOCKED), as the Issues tab's listing is.
   */
  'POST /api/milestones': async ({ fresh = false } = {}) => {
    const { owner, repo: name } = parsePrUrl(requirePr().url);
    return { repo: `${owner}/${name}`, milestones: await pickerList(owner, name, fresh === true) };
  },

  /**
   * The pull request on screen put on milestone `number`, or taken off one for
   * null, from the PR pane's picker. `url` is the pull request the page drew
   * the picker for: a poll can have moved the pane to another since, and the
   * pick was not about that one. `number` is held to the list the picker was
   * offered (pickerMove), read now if this process has none for the
   * repository -- a page left open across a restart. The answer is the
   * milestone GitHub now has, which the cached pull request takes too: the page
   * is drawn from that until a poll sees updatedAt move and reads the pull
   * request again.
   */
  'POST /api/pr/milestone': async ({ url, number } = {}) => {
    // Reaches gh's -F, which converts by shape (setIssueMilestone): a positive
    // integer or null, and nothing else.
    if (number !== null && !(Number.isInteger(number) && number > 0)) throw new Error(`not a milestone number: ${JSON.stringify(number)}`);
    const cur = requirePr();
    if (url !== cur.url) throw new Error(`${url ?? '(nothing)'} is no longer the pull request on screen`);
    const where = parsePrUrl(cur.url);
    const listed = pickerLists.get(`${where.owner}/${where.repo}`)?.list ?? await pickerList(where.owner, where.repo, true);
    const milestone = await setIssueMilestone(repo, where, pickerMove(listed, cur, number));
    cur.milestone = milestone;
    term.verbose(milestone ? `put PR #${cur.number} on ${quote(milestone.title)}` : `took PR #${cur.number} off its milestone`);
    return { milestone };
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
    const { owner, repo: name } = parsePrUrl(cur.url);
    return { path: p, ...got, patch: await localPatch(repo, {
      baseOid: cur.baseRefOid, baseRef: cur.baseRefName, baseRemote: (await repoFacts()).remotes[`${owner}/${name}`] ?? null,
      head: cur.headRefOid, path: p, from: got.from,
      additions: file.additions, deletions: file.deletions,
    }) };
  },

  'GET /api/queue': () => readQueue(repo, info?.nameWithOwner),

  'PUT /api/queue': ({ items }) => saveQueue(items),

  /**
   * The first issue or pull request `text` refers to, looked up so the queue
   * can add an item about it: its title for an input that is nothing but the
   * reference, and the number, repo and kind for the item's tag. `{ref: null}`
   * for text with no reference, which the pane adds as it is; a reference
   * GitHub does not know throws with GitHub's reason, which the pane shows
   * while keeping the text in the input to be fixed. A lookup that got no
   * answer at all is `{ref: null, unchecked: reason}`: the queue worked
   * without GitHub before it read references, and still adds the text as it
   * is rather than holding it hostage to the network.
   *
   * The repo is GitHub's spelling from the answer, not the typed one, so a
   * `CLI/CLI#1` or a renamed repo is stored the way GitHub will link it.
   */
  'POST /api/queue/ref': async ({ text }) => {
    let home, first, other, number, found;
    try {
      home = (await repoFacts()).nameWithOwner;
      [first] = refs(String(text ?? ''), home);
      if (!first) return { ref: null };
      ({ repo: other, number } = resolveRef(first, home));
      const [owner, name] = (other ?? home).split('/');
      found = await lookupRef(repo, owner, name, number);
    } catch (e) {
      if (e.notFound) throw e;
      return { ref: null, unchecked: e.message };
    }
    const canonical = found.repo ?? other ?? home;
    return { ref: {
      whole: !!wholeRef(String(text), home),
      issue: number,
      repo: canonical.toLowerCase() === home?.toLowerCase() ? null : canonical,
      kind: found.kind,
      title: found.title,
    } };
  },

  /**
   * Filed as an issue, one item at a time: each is its own issue. Always in
   * this repo; an item about another repo's issue or PR (the pane offers ◎ on
   * no other kind that has one) puts the link to it in the new issue's body,
   * built here from the item rather than taken from the page.
   */
  'POST /api/queue/to-issue': async ({ items, index }) => {
    const { nameWithOwner } = await repoFacts();
    return moveOut(items, [index], async ([item]) => {
      const stored = pick(item);
      const body = stored.repo ? issueUrl(stored, nameWithOwner) : '';
      const { url } = await createIssue(repo, nameWithOwner, item.text, body);
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
 * The exit panel's "Start coding agent" sends it; a first open sends
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
  let other;
  try {
    other = await whoami(wanted);
  } catch {
    return 'something that is not answering as prcoder';
  }
  if (!other?.prcoder) return 'something that is not prcoder';
  // The path only when it is not ours. Two worktrees of one repo share a
  // nameWithOwner and are the collision worth spelling out; a second prcoder
  // in *this* directory is the common case, and there the path says nothing.
  return `another prcoder on ${other.nameWithOwner ?? 'an unknown repo'}` +
    `${other.branch ? ` (${other.branch})` : ''}${other.repo === repo ? '' : ` in ${other.repo}`}`;
}

/**
 * What answers `GET /api/whoami` on localhost:`port`, parsed, or a throw when
 * nothing answers in time or the answer is not JSON. The one probe of another
 * port, for whoHasPort and runningHere.
 */
async function whoami(port) {
  const res = await fetch(`http://localhost:${port}/api/whoami`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

/**
 * Where the prcoder running in the working copy at `where` is, as a URL, or
 * null when none answers there. From that working copy's own running records,
 * each asked who it is: a pid can be reused and a port taken by something
 * else, and only `whoami` saying it is a prcoder in that working copy counts.
 * A record whose process has gone is passed over and left, since it is that
 * working copy's to drop (runningHere).
 */
async function prcoderIn(where) {
  const live = (await readRunning(where)).filter(({ pid, port }) => port && pid !== process.pid && alive(pid));
  const answers = await Promise.all(live.map(({ port }) => whoami(port).then((other) => ({ port, other }), () => null)));
  const found = answers.find((a) => a?.other?.prcoder && (a.other.top ?? a.other.repo) === where);
  return found ? `http://localhost:${found.port}` : null;
}

/**
 * The repository's working copies, for the pane's worktree line: the main one
 * and each `git worktree add` made, as git lists them, with the branch each is
 * on, which one this prcoder is in (`here`), and the URL of the prcoder
 * running in each of the others. A bare repository is not one, having no
 * files, and one whose directory is gone (`prunable`) is listed, since its
 * branch still cannot be checked out anywhere else until it is pruned.
 *
 * Asked for when the page loads and when the line is reached, not on the
 * poll: a worktree is made or removed a few times a day, and whether a
 * prcoder is running in each is a probe of its port.
 */
async function workingCopies() {
  const row = async (w, i) => {
    const here = w.path === top;
    return {
      path: w.path, name: path.basename(w.path), branch: w.branch, main: i === 0, here, prunable: w.prunable,
      url: here || w.prunable ? null : await prcoderIn(w.path),
    };
  };
  // Numbered before the bare one is left out: `main` is the first git lists.
  return (await Promise.all((await worktrees(repo)).map((w, i) => (w.bare ? null : row(w, i))))).filter(Boolean);
}

/**
 * Whether another prcoder is running in this working copy, said for
 * startOnPr's refusal, or null. Asked on every port one could be on: each
 * running prcoder's own record (`.prcoder/running/` at the top level,
 * writeRunning in store.js), which finds one pinned to another port or moved
 * aside to a free one, and the ports this run would bind first -- the pinned
 * one and the one in port.json -- for a prcoder from before the records,
 * which wrote none. All at once, so a port held by something that never
 * answers costs its 2s once, not once a port. A record whose process has gone
 * (a killed run) is dropped unasked; one whose pid has been reused is asked
 * and does not answer as a prcoder here. A record with no port is one still
 * starting, before it listens, and counts as running: there is nothing to
 * ask, and its agent is about to start on whatever is checked out.
 *
 * The working copy is the top level (`top`), not the directory: one started
 * in a subdirectory, or at the top while this one runs in a subdirectory,
 * moves the same files, and its records are kept and its `whoami` answers
 * there. One in another worktree has a top level of its own. A prcoder from
 * before `whoami` said `top` is matched by its directory, as it was.
 */
async function runningHere() {
  const records = (await readRunning(top)).filter(({ pid }) => pid !== process.pid);
  for (const { pid } of records.filter(({ pid }) => !alive(pid))) dropRunning(top, pid);
  const live = records.filter(({ pid }) => alive(pid));
  const starting = live.find(({ port }) => !port);
  if (starting) return `another prcoder is starting in this working copy (pid ${starting.pid})`;
  // Not this one's own port, once it listens: the Switch asks too, and
  // would find itself.
  const own = server.listening ? server.address().port : null;
  const ports = [...new Set([pinnedPort, await readPort(repo), ...(top === repo ? [] : [await readPort(top)]),
    ...live.map(({ port }) => port)].filter((port) => port && port !== own))];
  const answers = await Promise.all(ports.map((port) => whoami(port).then((other) => ({ port, other }), () => null)));
  const found = answers.find((a) => a?.other?.prcoder && (a.other.top ?? a.other.repo) === top);
  if (!found) return null;
  const { port, other } = found;
  const where = other.repo === repo ? 'this directory' : `this working copy (in ${other.repo})`;
  return `another prcoder is running in ${where} (http://localhost:${port}${other.branch ? `, on ${other.branch}` : ''})`;
}

/**
 * startOnPr's `inUse` for a start (main): runningHere's answer, taken under
 * the start lock (claimStart in store.js) and, when it is no, held -- with a
 * record saying this one is starting -- until the start has checked out
 * (release), so that a second start in the same working copy, now or a
 * moment from now, finds this one rather than checking out beside it. Asked
 * only when there is a checkout to make. A lock or record that cannot be
 * written is left out, as the record was before: the check still runs.
 */
async function claim() {
  const holder = await claimStart(top).catch((e) => (term.debug(`start lock not taken: ${e.message}`), null));
  if (holder) return `another prcoder is starting in this working copy (pid ${holder})`;
  const busy = await runningHere();
  if (busy) {
    releaseStart(top);
    return busy;
  }
  await writeRunning(top, null).catch((e) => term.debug(`running record not written: ${e.message}`));
  return null;
}

async function ready() {
  const port = server.address().port;
  // Read by a later `prcoder <pr>` here before it checks anything out
  // (runningHere): the record main wrote as this one started, now with the
  // port to ask. Without it that one asks only the ports it would bind.
  await writeRunning(top, port).catch((e) => term.debug(`running record not written: ${e.message}`));
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
  // The repository and nothing that changes: the title is for finding the
  // window for a repo, and the block has the branch and the pull request.
  term.title(`${info?.nameWithOwner ?? path.basename(repo)} · prcoder`);
  console.log(`prcoder: ${repo}`);
  console.log(pr ? `PR #${pr.number}: ${pr.title}` : 'no pull request for this branch');
  if (pr) console.log(pr.url);
  console.log(url);
  if (urls.moved) console.error(urls.moved);
  // Here, with the rest of what this run is, and not as it parsed: a line
  // written before the block exists is left above it, out of the log.
  if (agentWorktree(agentArgs)) console.error(agentWorktree(agentArgs));
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
 * The same lookup as the poll's, less the checks, which a URL has no use for,
 * and a search whatever is remembered: `g` is often pressed just after opening
 * a pull request on github.com. Under the lock, since the search is remembered.
 */
async function openGithub() {
  const [branch, head] = await Promise.all([currentBranch(repo), headCommit(repo)]);
  const facts = await repoFacts();
  const { nameWithOwner, defaultBranch, repos } = facts;
  const choice = await choiceFor(branch, repos);
  const found = await serial(() => findPrs(branch, facts, { has: (oids) => commitsKnown(oids, repo), checks: false, chosen: choice, fresh: true }));
  const url = pickPr(found, { head, chosen: choice, shown: pr?.url, repos })?.url;
  openBrowser(githubUrl({
    prUrl: url, nameWithOwner, defaultBranch, branch,
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

// Every tab is told, with a close code of its own (QUIT_CODE), so the page
// locks itself rather than offering to start an agent on a server that is
// about to be gone. Resolves once every tab's socket has closed, or after `ms`
// for a tab that never answers. Waited on, not just sent: a close frame queues
// behind whatever the socket has not yet written -- a burst of the agent's
// output -- and a process that exits with it still queued leaves the page a
// bare 1006, the exit bar and a Start that reaches nothing. A socket already
// closing (the PTY's own close, when kill() lands) ignores the second close
// and still fires 'close'. wss.clients drops a socket on its 'close', so none
// here has fired it already.
function tellTabs(ms) {
  const closed = [...wss.clients].map((ws) => new Promise((r) => ws.once('close', r)));
  for (const ws of wss.clients) ws.close(QUIT_CODE, 'prcoder quit');
  return Promise.race([Promise.all(closed), new Promise((r) => setTimeout(r, ms).unref())]);
}

// Kills the PTYs itself rather than leaving that to the close handlers:
// process.exit doesn't wait for them, and an orphaned `claude` outlives the
// terminal it was started from.
//
// Exits once the tabs have been told and stdout has caught up, not straight
// away. Piped (`prcoder | tee`), stdout is asynchronous on macOS and
// process.exit drops what is still queued -- the Local list askToQuit printed
// a moment ago, on a reader that is behind. An empty write calls back once
// everything ahead of it is out; the timer is for a reader that never catches
// up, which must not keep prcoder alive.
//
// `remove` is the worktree to take away on the way out (leaving), once the
// tabs are told and the agents killed, since they are in it. The hard stop
// waits for git then: a removal is given two minutes (removeWorktree).
let quitting = false;
function quit({ remove = null } = {}) {
  if (quitting) return;
  quitting = true;
  const told = tellTabs(2000);
  for (const pty of ptys) pty.kill();
  wss.close();
  server.close();
  const written = () => new Promise((r) => process.stdout.write('', r));
  setTimeout(() => process.exit(0), remove ? 125_000 : 2000);
  Promise.all([told, written()])
    .then(() => remove && removeHere(remove).then(written))
    .then(() => process.exit(0));
}

/**
 * What a quit can do about the worktree this prcoder is in: `{ name, path,
 * lose, unpushed, force, made }`, or null when there is nothing to offer -- the repository's
 * main working copy, a worktree another prcoder is also running in, or one
 * someone locked. `lose` is what removing it would delete that git does not
 * have (worktreeLosses), and `force` whether git has to be told `--force`,
 * which it does over changed and untracked files and not over ignored ones.
 * `unpushed` is the commits on its branch that no remote has: kept, with the
 * branch, but worth the question. `made` is whether prcoder made it.
 *
 * The queue is in `lose` only while its file is in the worktree: one moved
 * with --queue stays where it is. A failure to read any of this is no offer,
 * said at debug: a quit must not fail on the way to asking about a removal.
 */
async function leaving() {
  if (!linked) return null;
  try {
    if (await runningHere()) return null;
    if ((await worktrees(repo)).find((w) => w.path === top)?.locked) return null;
    const loss = await worktreeLoss(top);
    const { unpushed, orphaned } = await commitsOnlyHere(top);
    return {
      name: path.basename(top), path: top, force: loss.changed + loss.untracked > 0,
      lose: worktreeLosses({ ...loss, orphaned, queue: movedQueue() ? [] : last?.queue ?? [] }),
      // Not said twice: ahead of its pull request, they are among the risks.
      unpushed: last?.ahead ? 0 : unpushed,
      made: await madeHere(top),
    };
  } catch (e) {
    term.debug(`removing this worktree not offered: ${e.message}`);
    return null;
  }
}

/**
 * Removes the worktree this prcoder ran in, as its last act. From the shared
 * git directory, with this process moved there first: the directory it is
 * standing in is the one going. This run's record and start lock go before
 * it, so the exit handler finds nothing left to drop. The branch stays, and
 * the line says so, since "removed" beside a branch's name reads otherwise.
 * A refusal -- a file made since the question, a submodule -- is git's words
 * and the command that would do it, and the worktree is left as it is.
 */
async function removeHere({ path: where, force }) {
  const branch = await currentBranch(top).catch(() => '');
  releaseStart(top);
  dropRunning(top);
  try {
    process.chdir(linked.common);
    await removeWorktree(linked.common, where, { force });
    console.log(`removed the worktree ${where}${branch ? `; its branch, ${branch}, is kept` : ''}`);
  } catch (e) {
    console.error(`worktree not removed: ${e.message.trim()}\nit is still at ${where}; \`git worktree remove --force ${where}\` removes it`);
  }
}

/**
 * Whether a quit removes worktree `wt` without asking: one prcoder made
 * (`--worktree`), with nothing in it that git lacks, no commit on its branch
 * that is on this machine alone, and nothing else about the quit to ask over. Then the removal deletes a directory this command
 * made and can make again, and the question would be a keypress on every
 * quit. Anything else is asked about -- a worktree made by hand above all,
 * which is its maker's however clean it is.
 */
const tidy = (risk, wt) => Boolean(wt?.made && !wt.lose.length && !wt.unpushed && !risk.length);

// One question at a time: leaving() takes a moment, and a second q inside it
// would ask twice.
let asking = false;
async function askToQuit() {
  if (asking || quitting) return;
  asking = true;
  try {
    listQueue();
    const risk = quitRisk();
    const wt = await leaving();
    // Listed again on yes: the queue can change while the question waits, and
    // an item added from a tab in that time would otherwise go unprinted.
    const go = (opts) => () => { listQueue(); quit(opts); };
    if (tidy(risk, wt)) quit({ remove: wt });
    else if (wt) term.ask(leaveQuestion(risk, wt), { r: go({ remove: wt }), k: go() });
    else if (risk.length) term.confirm(`quit? ${risk.join('; ')}  [y/N] `, go());
    else quit();
  } finally {
    asking = false;
  }
}

/**
 * `prcoder --worktree <branch|pr>`: the worktree for it found or made
 * (worktreeFor, worktreeForPr in git.js), and this process moved into it, so
 * that everything after is a start in that directory like any other -- its
 * own port, queue and running record, the agent started there, and a quit
 * that offers to remove it. Resolves the pull request it named, still to be
 * checked out there, which the start block takes in place of its own lookup;
 * null for a branch, which the worktree is already on. A refusal ends
 * the run before anything of this one's has started.
 *
 * The pull request is looked up, and the repository's facts read, from the
 * directory prcoder was started in, and the facts are kept: they are the
 * repository's, the same from every working copy of it, but for `prefix`,
 * which is where in the working copy this run stands -- the top, after the
 * move. `repo` is taken from the process again rather than from the path
 * asked for, so it is spelled as a later plain `prcoder` there will spell it:
 * the port's seed is a hash of that string.
 *
 * A worktree this made is marked as prcoder's (markMade), which is what lets
 * a quit remove it without asking once nothing in it is unsaved.
 */
async function startInWorktree(target) {
  try {
    const facts = await repoInfo(repo);
    const base = process.env.PRCODER_WORKTREES ? path.resolve(process.env.PRCODER_WORKTREES) : path.join(os.homedir(), '.prcoder', 'worktrees');
    const dirFor = (main, name) => worktreeDir(base, main, name);
    const p = target.pr ? await pullRequestFor(repo, target.pr, facts.repos) : null;
    const found = p ? await worktreeForPr(repo, p, { dirFor, repos: facts.repos })
      : await worktreeFor(repo, target.branch, { dirFor, defaultBranch: facts.defaultBranch });
    console.log(found.said);
    process.chdir(found.path);
    repo = process.cwd();
    top = await workTreeTop(repo);
    linked = await linkedWorktree(repo);
    info = { ...facts, prefix: '' };
    if (found.made) await markMade(top).catch((e) => term.debug(`worktree not marked as prcoder's: ${e.message}`));
    return p;
  } catch (e) {
    console.error(`prcoder: ${e.message}`);
    process.exit(2);
  }
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
  // Every fact prcoder shows comes from git, and outside a checkout it used to
  // start anyway: one `status: failed to run git` line, a pane with no pull
  // request, and an agent in a directory with nothing to commit to. Refused
  // here, before the port, the terminal or the agent.
  const why = await notAWorkTree(repo);
  if (why) {
    console.error(`prcoder: ${repo} is not inside a git checkout\n  ${why}\nrun prcoder from inside a repository's working tree`);
    process.exit(2);
  }
  top = await workTreeTop(repo).catch((e) => (term.debug(`top level not read, so ${repo} stands for it: ${e.message}`), repo));
  linked = await linkedWorktree(repo).catch((e) => (term.debug(`not read whether this is a worktree: ${e.message}`), null));
  // This run's record and start lock go with it, whatever ends it: a refusal
  // below, a quit, or a crash (claim writes the record for a checkout, the
  // line after the start block for everything else, and ready() its port).
  process.on('exit', () => {
    releaseStart(top);
    dropRunning(top);
  });
  ({ agentArgs } = cli);
  // Into the variables, never the env: see pinnedPort.
  if (cli.port) pinnedPort = cli.port;
  if (cli.noOpen) noOpen = true;
  if (cli.noHistory) noHistory = true;
  // Into the store, not the env, for the same reason: see useQueueFile.
  useQueueFile(cli.queue ?? process.env.PRCODER_QUEUE);
  if (cli.verbose) term.setVerbosity(cli.verbose);

  // `prcoder choose` and `prcoder <pr>`: the list, the question and the
  // checkout come before the block exists, so they are plain lines in the
  // scrollback, and before the port, so a pick of nothing or a refusal starts
  // nothing. Either way the pull request is checked out (startOnPr), since the
  // pane shows only the checked-out branch's, and held as that branch's choice
  // the way the pane's Switch holds one: of two pull requests on one branch,
  // the one asked for is the one shown.
  // The checkout is refused while another prcoder runs in this working copy,
  // or is starting in it (claim): it would move that one's agent onto another
  // branch, or two checkouts would run at once.
  //
  // `--worktree <pr>` is the same start one step later: the worktree is made
  // or found first, this process moves into it (startInWorktree), and the
  // pull request it named is checked out there.
  const named = cli.worktree ? await startInWorktree(cli.worktree) : null;
  if (cli.choose || cli.target || named) {
    try {
      const facts = await repoFacts();
      // choosePr runs this on each pick, and asks again after a refusal.
      const start = async (pr) => startOnPr(repo, pr, { inUse: claim }).finally(() => releaseStart(top));
      const started = cli.choose
        ? await choosePr(repo, facts, { start })
        : await Promise.resolve(named ?? pullRequestFor(repo, cli.target, facts.repos)).then(async (pr) => ({ pr, ...(await start(pr)) }));
      if (!started) process.exit(0);
      if (started.said) console.log(started.said);
      chosen = { branch: started.branch, url: started.pr.url };
    } catch (e) {
      console.error(`prcoder: ${e.message}`);
      process.exit(2);
    }
  }
  // Starting, as far as a start in this working copy from now on can see:
  // its agent will be on whatever is checked out, so a checkout is refused.
  await writeRunning(top, null).catch((e) => term.debug(`running record not written: ${e.message}`));

  // Before anything can print: init() is what routes console through the log,
  // and a line written ahead of it would sit above the block and stay there.
  // A signal -- SIGHUP from closing the terminal this runs in, SIGTERM, a
  // SIGINT with no tty -- tells the tabs too and waits a moment for them, as
  // quit() does, or they would offer to start an agent on a server that is
  // gone. A second signal goes at once.
  let leaving = false;
  term.init({
    leave: (code) => {
      if (leaving) process.exit(code);
      leaving = true;
      tellTabs(1000).then(() => process.exit(code));
    },
  });
  // The ways out that cannot wait -- the second Ctrl-C at the question, which
  // must exit at once, and an uncaught exception -- still try. Best effort: an
  // 'exit' handler runs only synchronous code, so the close frame goes only if
  // the socket can write it there and then, with nothing queued ahead of it.
  // Only a SIGKILL gets past this altogether.
  process.on('exit', () => { for (const ws of wss.clients) ws.close(QUIT_CODE, 'prcoder quit'); });
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
        serial(() => status({ full: true, search: true })).catch((e) => console.error('refresh:', e.message));
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
