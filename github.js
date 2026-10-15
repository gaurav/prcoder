// Everything GitHub goes through the `gh` CLI, which is already authenticated.

import { execFile } from 'node:child_process';
import { debug } from './term.js';
import { mentions, repoUrl, printable } from './public/tasks.js';

// Every gh call and every git call comes through run(), so this is the whole
// count. What it is for: two browser tabs each poll on their own timer against
// one serial lock, and this is how you see that happening.
let calls = 0;
export const runCount = () => calls;

/**
 * `input` has to be written to the child's stdin by hand: execFile accepts the
 * option only in its *Sync* form and silently ignores it otherwise, which makes
 * a `--body-file -` call hang on a stdin that never closes.
 *
 * Every call gets a timeout and no way to prompt, because every call runs
 * behind server.js's one serial lock: a gh or git that waits -- on a stalled
 * network, or on a credential prompt nobody can see, which `gh pr checkout`'s
 * fetch would otherwise wait on -- holds every route behind it. The prompts are
 * turned into errors (GIT_TERMINAL_PROMPT, GH_PROMPT_DISABLED) whatever env a
 * caller passes; the timeout is a default a slow call raises (checkoutPr).
 *
 * A failure is quieter than it looks, so check the real tool's behaviour
 * before writing a new call's error handling. stderr is on the error only
 * because this puts it there; a non-zero exit can still carry a full stdout
 * (issueLinks); and git's codes differ per command (`answer` in git.js).
 */
const RUN_TIMEOUT = 60_000;
export function run(bin, args, { input, env, ...opts } = {}) {
  calls++;
  const started = Date.now();
  const timeout = opts.timeout ?? RUN_TIMEOUT;
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
      timeout,
      env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    },
      // execFile hands stderr to the callback and does not put it on the error,
      // so every caller matching on gh's complaints — "no pull requests found"
      // above, and the exit-code checks in git.js — was reading undefined.
      (err, stdout, stderr) => {
        // An issue title arrives as an argument, so the line is cut rather than
        // trusted to be short.
        const line = `${bin} ${args.join(' ')}`;
        debug(`${line.length > 110 ? `${line.slice(0, 109)}…` : line}` +
          `  ${err ? `exit ${err.code}` : 'ok'} ${Date.now() - started}ms`);
        if (!err) return resolve(stdout);
        // stdout goes the same way -- and a gh api graphql call that exits 1
        // over a NOT_FOUND still prints the response, partial data and all.
        err.stderr = stderr;
        err.stdout = stdout;
        // What the tool said, rather than Node's `Command failed: <argv>` -- which
        // for an issue title is the whole title. Every catch reads e.message.
        err.message = stderr.trim() || err.message;
        // Killed by the timeout, which says nothing of its own.
        if (err.killed) err.message = `${bin} ${args[0]} took over ${timeout / 1000}s and was stopped`;
        reject(err);
      });
    child.stdin.end(input);
  });
}

const gh = (args, opts) => run('gh', args, opts);

const PR_FIELDS = [
  'number', 'title', 'body', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName',
  'statusCheckRollup', 'closingIssuesReferences', 'reviewDecision', 'comments', 'reviews',
  // updatedAt gates the expensive full reload -- all but the checks, which
  // prHeads reads on every poll.
  'updatedAt', 'isCrossRepository',
  // Where the head branch lives, for the head's `owner:branch` label on a
  // cross-repository pull request. Both, because headRepository is null once
  // the fork is deleted and the owner's login is all that is left.
  'headRepository', 'headRepositoryOwner',
  // Not the files, and not what has to agree with them: the head and base
  // commits and the line counts. prFiles reads those in the same answer as the
  // list, since gh's `files` stops at 100 and two calls can straddle a push.
  // headRefOid is asked for all the same, as the commit the checks above are
  // for, and loadPr keeps it apart from the one the files are at.
  'headRefOid',
].join(',');

/** The head repository as the page reads it: its slug, or null, and its owner. */
const headSide = ({ headRepository, headRepositoryOwner, ...rest }) => ({
  ...rest,
  headRepo: headRepository?.nameWithOwner ?? null,
  headOwner: headRepositoryOwner?.login ?? null,
});

/**
 * `gh pr view`, or null when there is no PR to view. A detached HEAD -- mid-
 * rebase, mid-bisect -- is one of those: with no target gh has no branch to look
 * up, and says `could not determine current branch: ... not on any branch`
 * (gh 2.x, checked 2026-09-26) without touching the network. Answered here, so
 * no caller has to check for a branch first; a pinned target still works.
 */
async function viewPr(cwd, target, fields) {
  const args = ['pr', 'view', ...(target ? [target] : []), '--json', fields];
  try {
    return JSON.parse(await gh(args, { cwd }));
  } catch (e) {
    if (/no pull requests found|no default remote|not a git repo|could not determine current branch/i
      .test(e.stderr ?? '')) return null;
    throw e;
  }
}

/** The PR's url and nothing else, which is all the `g` key needs. */
export const prUrl = async (cwd, target) => (await viewPr(cwd, target, 'url'))?.url;

/**
 * Just enough to know whether the PR moved, without the file list loadPr pages
 * through (prFiles), which also carries the head, base and line counts.
 *
 * Plus the checks, which move without the PR: a check run belongs to the
 * commit, so finishing one leaves `updatedAt` where it was. On #120 the PR's
 * was 22:43:48Z and its one check completed at 22:45:16Z (2026-10-08), and the
 * Checks tab said pending until something else touched the PR. Same call, so
 * the poll's count is unchanged, but the call is heavier: gh fetches every
 * check on the head commit, on every poll. docs/Verifying.md has the figure.
 */
export async function prHeads(cwd, target) {
  const heads = await viewPr(cwd, target, 'number,url,headRefOid,updatedAt,statusCheckRollup');
  return heads && withChecks(heads);
}

// How far a lookup reads first, and how far again when that window came back
// full of strangers: one page of gh's, so a fork's clone on `main` pays a page
// more per poll, not the parent's whole history of `main`s (branchPrs). The
// first is small because it carries the checks, and a stranger's are wasted.
const NARROW = 5;
const WIDE = 100;

// What the cheap call reads for a branch's pull requests: prHeads's fields,
// and what the switcher's group and the head's labels need on top.
const BRANCH_FIELDS = ['number', 'title', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName',
  'headRefOid', 'updatedAt', 'headRepository', 'headRepositoryOwner', 'isCrossRepository'];

/**
 * Which of `rows`, each through headSide, are the branch's and not a
 * stranger's of the same name, by branchPrs's rules (`has` and `home` are its
 * options): a head in one of `repos` is the branch's, or -- with a push target
 * -- a stranger unless it is that target; any other is the branch's if this
 * clone has its head commit. `branch`, when given, also holds each row's head
 * to that name, which `gh pr list --head` has already done for branchPrs's.
 * lookupPrs holds a remembered pull request the search did not find to the
 * same rules, so one a looser search let in does not outlive it.
 */
export async function ownPrs(rows, repos, { branch = null, has = async () => new Set(), home = null } = {}) {
  const named = branch ? rows.filter((p) => p.headRefName === branch) : rows;
  const vouched = (p) => repos.includes(p.headRepo);
  const asked = [...new Set(named.filter((p) => !vouched(p)).map((p) => p.headRefOid))];
  const held = asked.length ? await has(asked) : new Set();
  return named.filter((p) => (vouched(p) ? !home || p.headRepo === home : held.has(p.headRefOid)));
}

/**
 * The branch's pull requests, in every repository it could have one in, open
 * ones first: the search by name that lookupPrs runs, when what it remembers
 * may be out of date, in place of `gh pr view`.
 *
 * `gh pr view` with no target finds a pull request by its head label, which
 * gh builds from the branch's push config: `owner:branch` with a remote,
 * the bare branch with none. A cross-repository pull request's label is
 * `fork:branch`, so a branch pushed to a fork by URL, with no tracking config,
 * has a pull request gh says it cannot find (nodenorm-es's
 * run-tests-in-github-actions, gh 2.102.0, 2026-10-14). `gh pr list --head
 * <branch>` filters by the branch's name alone, whichever repository the head
 * is in, and carries every field `pr view` does -- so one call per candidate
 * repository finds the lot, and the first candidate costs what `pr view` did.
 *
 * Open ones, with their checks, which is what the poll keeps the Checks tab
 * fresh from (prHeads says why). Only when none of them is the branch's -- a
 * stranger's open one in the parent does not count -- does a second pass ask
 * for merged and closed ones, which is what `gh pr view` falls
 * back to today, so a merged branch keeps showing its pull request; the
 * rollup is left out of that pass, being the heavy part of the call
 * (docs/Verifying.md), and a merged pull request's checks come with loadPr.
 *
 * Strangers are dropped. `--head main` in the parent repository matches every
 * fork's `main`, and any common branch name does the same; a row is this
 * branch's when its head is in one of `repos`, or when `has` says this clone
 * has its head commit -- the fork no remote names is exactly the case where
 * only the commit says so. `home` is the repository a push of the branch goes
 * to (pushRepo in git.js), when there is one: then a head in another of
 * `repos` is that repository's own branch of the same name -- the parent's
 * `main` in a fork's clone on `main` -- and a stranger too, commit or no
 * commit, since the two `main`s often share theirs. gh lists the newest first, so strangers can fill
 * the window and push this branch's past it: microsoft/vscode had 63 open from
 * a `main` and 200 of 200 recent ones (2026-10-14). A full window with none
 * of the branch's in it is asked again, WIDE deep and without the checks,
 * which would be a hundred strangers' rollups; one of the branch's found
 * only there gets its own from prHeads. One past WIDE is missed by this
 * search, though not once found: lookupPrs remembers what a search found, and
 * runs one only now and then, so a crowded name pays the narrow ask and the
 * wide one then, not on every poll.
 *
 * `has(oids)` is asked once per page, for every head no repository vouches
 * for, and answers with the set of them this clone has: one git call for the
 * page, not one per stranger (commitsKnown in git.js). The repositories'
 * order is kept, as the rank pickPr reads it in. The first repository is gh's own base, and a failure
 * there is the poll's; one of the others may be a parent since made private,
 * or a remote to nowhere, and is skipped with a line in the log.
 */
export async function branchPrs(cwd, repos, branch, { has = async () => new Set(), checks = true, home = null } = {}) {
  if (!branch || !repos.length) return [];
  const mine = async (rows) => (await ownPrs(rows.map(headSide), repos, { has, home }))
    .map((p) => ('statusCheckRollup' in p ? withChecks(p) : p));
  const list = async (state, fields) => (await Promise.all(repos.map(async (repo, i) => {
    const ask = async (n, f) => JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', state,
      '--limit', String(n), '--json', f.join(',')], { cwd })).map((p) => ({ ...p, repo }));
    try {
      const rows = await ask(NARROW, fields);
      const ours = await mine(rows);
      if (rows.length < NARROW || ours.length) return ours;
      const wide = await mine(await ask(WIDE, BRANCH_FIELDS));
      if (!fields.includes('statusCheckRollup')) return wide;
      return Promise.all(wide.map((p) => headChecks(cwd, p)));
    } catch (e) {
      if (!i) throw e;
      debug(`pull requests in ${repo} not read: ${e.message}`);
      return [];
    }
  }))).flat();
  const open = await list('open', checks ? [...BRANCH_FIELDS, 'statusCheckRollup'] : BRANCH_FIELDS);
  return open.length ? open : list('all', BRANCH_FIELDS);
}

/** The row with its checks from prHeads, for one read without them; as it was if that fails. */
async function headChecks(cwd, p) {
  const heads = await prHeads(cwd, p.url);
  return heads ? { ...p, checks: heads.checks } : p;
}

// What gh says for a pull request that is not there, and for a repository it
// cannot see, deleted or private (gh 2.98.0, 2026-10-15): the two read
// failures that mean a remembered pull request is gone, not just unread.
const GONE = /Could not resolve to a (PullRequest|Repository)\b/;

// How long a branch's remembered pull requests are read by URL before the
// search by name runs again, for one opened on the branch since: ten polls of
// a visible tab, so the search costs a tenth of what it did.
export const SEARCH_EVERY = 10 * 60_000;

/**
 * One remembered pull request read again by its URL, in branchPrs's shape:
 * `repo` is the repository the search found it in, and the checks come only
 * for one that was open, as branchPrs's pass for merged ones leaves them out.
 * One reopened since comes back open without them; its new state sets off a
 * search, which nearly always brings them, and lookupPrs asks prHeads only
 * when that search does not find it.
 */
async function viewKnown(cwd, { url, repo, state }, checks) {
  const fields = checks && state === 'OPEN' ? [...BRANCH_FIELDS, 'statusCheckRollup'] : BRANCH_FIELDS;
  const p = headSide({ ...JSON.parse(await gh(['pr', 'view', url, '--json', fields.join(',')], { cwd })), repo });
  return 'statusCheckRollup' in p ? withChecks(p) : p;
}

/**
 * The branch's pull requests, as branchPrs finds them, from `known` -- what an
 * earlier search found, `{ searched, prs: [{ url, repo, state }] }` (readPrs
 * in store.js) -- when that can stand: each read again by its URL, which is
 * exact however many forks share the branch's name, and one call per pull
 * request however many repositories it could be in (#147).
 *
 * `search` is the search by name, branchPrs with the caller's arguments. It
 * runs when there may be something the URLs cannot show:
 * - nothing is known: every branch with no pull request, which is the branch
 *   one is about to be opened from, is searched on every poll as before;
 * - `fresh`, which the caller passes on a change of branch, `r` and `g`;
 * - the last search is SEARCH_EVERY old, for a second pull request opened on
 *   the branch since -- into the parent, say -- or is in the future, which a
 *   clock set back or a file from another machine can make, and which would
 *   otherwise put the search off until then;
 * - one of them is not in the state it was in: a pull request closed and
 *   another opened in its place is found as soon as the first is seen closed;
 * - one of them could not be read. If gh says it is not there, nor its
 *   repository -- gone, or no longer visible to you -- it is forgotten; any
 *   other failure, a timeout or the network, is kept as it was remembered,
 *   unshown until a read works, rather than forgotten over one bad call.
 *
 * Only one in `repos` is read, the rule the switch route holds a URL to, so a
 * hand-edit of the file cannot point gh anywhere else; a remote since removed
 * takes its pull requests with it. The URL itself is held to that, not only
 * the `repo` written beside it, since the URL is what gh is given; and one a
 * search finds that fails the rule -- a repository renamed under its remote --
 * is shown but not remembered, so that branch is searched as one with none.
 *
 * A search does not forget what it does not find. gh lists the newest first,
 * and a common name's strangers can push this branch's pull request out of
 * the window (branchPrs) long after the search that found it; it is still the
 * branch's. So one known but not found is read by URL and kept, and then, as
 * branchPrs does, open ones stand alone if there are any. Kept, that is, when
 * `own` -- ownPrs with the search's arguments -- still counts it the branch's:
 * a search's rules can tighten under what an earlier one let in (a fork's
 * clone given a push target after its `main` was handed the parent's), and
 * nothing else would ever let go of it.
 *
 * Answers `{ prs, remember }`. `remember` is the new `known` after a search --
 * with no pull requests in it when there are none, which removes the branch's
 * entry -- and undefined when there is nothing to write: on a branch with none
 * known and none found, which is every poll there, it would rewrite the file
 * to say what it already says.
 */
export async function lookupPrs(cwd, repos, known, search, { own = async (rows) => rows, fresh = false, checks = true, now = Date.now() } = {}) {
  // The row, null for one that is gone, or the entry marked unread.
  const read = (k) => viewKnown(cwd, k, checks).catch((e) => {
    debug(`${k.url} not read: ${e.message}`);
    return GONE.test(e.message) ? null : { ...k, unread: true };
  });
  // Case-blind, since `repo` is spelled as a remote's URL spells it, and the
  // URL as GitHub does; readPrs holds the two together the same way.
  const held = (k) => repos.includes(k.repo) && k.url.toLowerCase().startsWith(`https://github.com/${k.repo}/pull/`.toLowerCase());
  const prs = (known?.prs ?? []).filter(held);
  const seen = new Map();
  const age = now - known?.searched;
  if (prs.length && !fresh && age >= 0 && age < SEARCH_EVERY) {
    const rows = await Promise.all(prs.map(read));
    if (rows.every((p, i) => p && !p.unread && p.state === prs[i].state)) {
      return { prs: rows, remember: prs.length === known.prs.length ? undefined : { ...known, prs } };
    }
    prs.forEach((k, i) => seen.set(k.url, rows[i]));
  }
  // What the search did not find is read after it, not beside it: beside it
  // would be a `gh pr view` for each one the search finds too, which is
  // nearly always all of them, to save a round trip on a crowded name.
  const found = await search();
  const urls = new Set(found.map((p) => p.url));
  const kept = await Promise.all(prs.filter((k) => !urls.has(k.url))
    .map((k) => (seen.has(k.url) ? seen.get(k.url) : read(k))));
  const unread = kept.filter((p) => p?.unread);
  // In the repositories' order, as branchPrs answers, which pickPr ranks by.
  // One reopened since it was remembered was read without its checks, which
  // keepPr takes for an open one; the search, had it found it, had them.
  const mine = await Promise.all((await own(kept.filter((p) => p && !p.unread)))
    .map((p) => (checks && p.state === 'OPEN' && !('checks' in p) ? headChecks(cwd, p) : p)));
  const all = [...found, ...mine]
    .sort((a, b) => repos.indexOf(a.repo) - repos.indexOf(b.repo));
  const open = all.filter((p) => p.state === 'OPEN');
  const shown = open.length ? open : all;
  // One whose URL is in a repository other than the one it was found in --
  // renamed on GitHub since the remote's URL was set -- would be dropped on
  // the next read, and written again by the search that follows, every poll.
  const entries = [...shown, ...unread].map(({ url, repo, state }) => ({ url, repo, state })).filter((k) => {
    if (!held(k)) debug(`${k.url} not remembered: not in ${k.repo}, which may have been renamed`);
    return held(k);
  });
  if (!known && !entries.length) return { prs: shown, remember: undefined };
  return { prs: shown, remember: { searched: now, prs: entries } };
}

/**
 * Which of a branch's pull requests to show. `chosen` is the one picked in
 * the switcher, for as long as it is in the list; otherwise an open one over
 * a merged or closed one, then the one at this clone's HEAD, then the one
 * shown by the last poll -- two pull requests from the same head, into a
 * fork's main and into its parent, tie on everything above, and a comment on
 * the other must not swap the pane -- then the repositories' order, which is
 * gh's base repository first, then the newest.
 */
export function pickPr(list, { head, chosen, shown, repos = [] } = {}) {
  const picked = chosen && list.find((p) => p.url === chosen);
  if (picked) return picked;
  const rank = (p) => [
    p.state === 'OPEN' ? 0 : 1,
    p.headRefOid === head ? 0 : 1,
    p.url === shown ? 0 : 1,
    repos.indexOf(p.repo),
  ];
  const first = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  };
  return [...list].sort(first)[0] ?? null;
}

/**
 * A `gh pr view` answer with its checks summarised. prHeads and loadPr both go
 * through this, so the Checks tab gets one shape whichever of them the poll
 * read the checks from.
 */
const withChecks = ({ statusCheckRollup, ...rest }) => ({ ...rest, checks: rollup(statusCheckRollup) });

/**
 * A description with LF line endings. One saved from github.com's editor comes
 * back CRLF -- 9 of cli/cli's last 30 on 2026-09-13 -- and every line pattern
 * here ends in `(.*)$`, where `.` stops at the `\r`: no line is a checkbox, a
 * heading or a list, and toggleTask cannot find the box a click in the PR pane
 * means. Both reads come through this, so nothing downstream has to know.
 */
export const lf = (body) => (body ?? '').replace(/\r\n/g, '\n');

/** The description as GitHub has it right now, for a read-modify-write. */
export async function prBody(cwd, prUrl) {
  const { body } = JSON.parse(await gh(['pr', 'view', prUrl, '--json', 'body'], { cwd }));
  return lf(body);
}

/**
 * Open PRs, for the switcher -- and, filtered by `baseRefName`, for the list of
 * pull requests into the branch you are on that the pane with no pull request
 * shows. That field is not spare: it is free here, where a `gh pr list --base`
 * of its own would be one more call on every poll. `url` is for the
 * pane's links, read off GitHub rather than built from a host (#53).
 * `isCrossRepository` is what stops a fork's `main` looking like a base here.
 */
export async function listPrs(cwd) {
  // gh stops at 30 unless told otherwise, and the ones past it simply are not
  // there -- in the switcher, and in the list of pull requests into a branch
  // with none of its own. gh pages up to the limit itself.
  const args = ['pr', 'list', '--state', 'open', '--limit', '1000', '--json',
    'number,title,headRefName,baseRefName,isDraft,url,isCrossRepository'];
  return JSON.parse(await gh(args, { cwd }));
}

/**
 * The PR `target` names -- a URL from branchPrs, or the command line's number,
 * URL or branch -- or null if there isn't one. The files come from a second
 * call, prFiles, not from `gh pr view`: per-file viewed state needs GraphQL,
 * and gh's own list stops at 100 files. The commits the files are at come
 * from that call too, not from `gh pr view`: a push landing between the two
 * left the links to each file at the old head, where a new file 404s, and
 * /api/diff diffing the old head against the new line counts.
 */
export async function loadPr(cwd, target, { pause } = {}) {
  const viewed = await viewPr(cwd, target, PR_FIELDS);
  if (!viewed) return null;
  // The commit the checks are for, which must not stand in for prFiles' head.
  const { headRefOid: checkedAt, ...pr } = viewed;
  pr.body = lf(pr.body);

  // Both need only the PR, so they run together: each is a GitHub round trip.
  const [snapshot, issues] = await Promise.all([
    prFiles(cwd, pr.url, pause),
    withLinks(cwd, pr.url, linkedIssues(pr)),
  ]);
  // The raw lists are summarised here and not sent on: every poll carries this
  // object to every tab, and nothing reads them past this point.
  const { closingIssuesReferences, comments, reviews, ...rest } = withChecks(headSide(pr));
  // A push between `gh pr view` and the file pages leaves the checks the old
  // head's, beside the new head's files and sync light. They are read again at
  // the files' head; past one more push the next poll has it, since updatedAt
  // has moved and it reloads. updatedAt stays the first call's, so that it does.
  if (checkedAt !== snapshot.headRefOid) {
    const fresh = await prHeads(cwd, pr.url);
    if (fresh?.headRefOid === snapshot.headRefOid) rest.checks = fresh.checks;
  }

  return {
    ...rest,
    ...snapshot,
    issues,
    counts: { comments: comments?.length ?? 0, reviews: reviews?.length ?? 0 },
  };
}

const FILES_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    id headRefOid baseRefOid baseRefName additions deletions changedFiles
    files(first:100,after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{ path additions deletions viewerViewedState }
    } } } }`;

// How many times prFiles reads a pull request's files before giving up on one
// that keeps moving under it, and how long it waits before each read after the
// first, times the reads so far: a burst of pushes gets a second and a half to
// settle, not three reads back to back that all straddle it. Every gh and git
// call waits behind this one (serial in server.js), so it stays short.
const READS = 3;
const PAUSE = 500;

/**
 * Every changed file, with whether you have marked it viewed; the PR's node id
 * for setViewed; and, from the same answer, what has to agree with the list.
 * headRefOid is GitHub's view of the branch head, which is what lets the sync
 * light work without a fetch and what each file's link is at. baseRefOid is
 * what /api/diff diffs from when GitHub sends a file no patch.
 *
 * `gh pr view --json files` gives the same fields but is GraphQL's
 * files(first: 100) unpaged, so a bigger PR lost the rest without a word:
 * gaurav/taxondna#76 has 110, and gh listed 100 (checked 2026-10-14). This
 * pages, in the order gh lists them.
 *
 * The pages are separate calls, so a push between two of them shifts the list
 * under the cursor, and a file is listed twice or never. Each page says which
 * head it was read at, and which base branch, and one that differs from the
 * first in either starts the read over -- READS times, then it throws, and the
 * poll after tries again -- the error names the pull request (`moving`), so
 * the server keeps the one it is showing rather than failing the poll. The
 * base's commit is not compared: the list is the
 * diff from the merge base, which the base branch moving on does not move, so
 * a busy `main` would only fail reads whose list was never at risk. A
 * retargeted pull request is a different diff, and is read again. A list that is still short of `changedFiles` with nothing
 * moving is one GitHub would not give, and goes out as it is: the Files tab
 * says how many are missing.
 */
async function prFiles(cwd, url, pause = PAUSE) {
  const { owner, repo, number } = parsePrUrl(url);
  read: for (let n = 0; n < READS; n++) {
    if (n) await new Promise((done) => setTimeout(done, pause * n));
    const files = [];
    let snapshot = null;
    let base = null;
    let after = null;
    do {
      // -f for every string, -F only for the Int. -F converts by what a value
      // looks like: an all-digit owner went as an Int and GitHub refused it
      // ("Could not coerce value 12345 to String", checked 2026-09-26), and a
      // value starting with @ is read as a file name.
      const args = ['api', 'graphql', '-f', `query=${FILES_QUERY}`,
        '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
      if (after) args.push('-f', `after=${after}`);
      const { data } = JSON.parse(await gh(args, { cwd }));
      const pr = data.repository.pullRequest;
      const { id: nodeId, headRefOid, baseRefOid, baseRefName, additions, deletions, changedFiles } = pr;
      if (!snapshot) [snapshot, base] = [{ nodeId, headRefOid, baseRefOid, additions, deletions, changedFiles }, baseRefName];
      if (headRefOid !== snapshot.headRefOid || baseRefName !== base) continue read;
      for (const { viewerViewedState, ...f } of pr.files.nodes) {
        files.push({ ...f, viewed: viewerViewedState === 'VIEWED' });
      }
      const { hasNextPage, endCursor } = pr.files.pageInfo;
      // Read as "no more pages", a next page with no cursor to it would end the
      // list short with nothing to say so -- the bug this paging is here to fix.
      if (hasNextPage && !endCursor) throw new Error(`GitHub said ${url} has more files, but gave no cursor to them`);
      after = hasNextPage ? endCursor : null;
    } while (after);
    return { ...snapshot, files };
  }
  throw Object.assign(new Error(`${url} moved on GitHub during each of ${READS} reads of its files`), { moving: url });
}

/** Ticking this here ticks the same checkbox on github.com. */
export async function setViewed(cwd, nodeId, path, viewed) {
  const op = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  await gh(['api', 'graphql', '-f', `query=mutation($id:ID!,$path:String!){
    ${op}(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`,
    // -f: a file named `404` or `@types/x.d.ts` is a string (see prFiles).
    '-f', `id=${nodeId}`, '-f', `path=${path}`], { cwd });
}

/**
 * Per-file `{patch, from}`, keyed by path. Shape confirmed against this repo's
 * PR #1 on 2026-08-26: --slurp wraps the pages in one array, the REST field is
 * `filename` where GraphQL says `path` (same string), and `patch` starts
 * at the first @@ with no file header. It is absent for binary and oversized
 * files, and files past GitHub's 300-file cap are missing entirely — both read
 * back as null/undefined and the client falls through to the GitHub link.
 *
 * `from` is `previous_filename`, set only when GitHub saw the file as renamed
 * (cli/cli#14116, checked 2026-09-18: `status: "renamed"`, a patch when it was
 * edited too). Without it a pure rename is a file with no patch, and the pane
 * would call it binary. `deleted` is `status: "removed"`, the one word for a
 * deleted file that has no patch to show it -- the diff header's @ reads it.
 *
 * This is the second read of the PR's file list, beside prFiles, and neither
 * replaces the other: GraphQL has no patches, and REST no viewed state. It is
 * the list the Files tab is *not* drawn from: prFiles' is complete and at a
 * known head, while this one stops at GitHub's cap and is read lazily, once
 * per head, when a diff is first opened (/api/diff keys it by headRefOid). So
 * it is looked up by a path from prFiles' list, and a path it is missing falls
 * through to localPatch like any file with no patch. A push between the two
 * reads can leave its patches a head ahead of the list, until the poll that
 * sees the push moves the key and it is read again.
 */
export async function fetchPatches(cwd, prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const out = await gh(['api', '--paginate', '--slurp',
    `repos/${owner}/${repo}/pulls/${number}/files`], { cwd });
  return new Map(JSON.parse(out).flat().map((f) =>
    [f.filename, { patch: f.patch ?? null, from: f.previous_filename, deleted: f.status === 'removed' }]));
}

export function parsePrUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a pull request URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function setBody(cwd, prUrl, body) {
  await gh(['pr', 'edit', prUrl, '--body-file', '-'], { cwd, input: body });
}

/**
 * The issue number out of what `gh issue create` prints. It can emit notices
 * before the URL, so the last line is the one that matters.
 *
 * Failing here rather than returning NaN is the point: output with no issue
 * URL at the end is a filing prcoder cannot vouch for, and reporting it as a
 * move would take the item off the queue on the strength of a link to nothing.
 */
export function issueNumber(out) {
  const url = out.trim().split('\n').pop()?.trim() ?? '';
  const n = Number(url.match(/\/(\d+)$/)?.[1]);
  if (!Number.isInteger(n)) throw new Error(`issue created at ${url || '(no url printed)'}, but its number could not be read — link it by hand`);
  return { url, number: n };
}

export async function createIssue(cwd, nameWithOwner, title, body = '') {
  return issueNumber(await gh(['issue', 'create', '--repo', nameWithOwner,
    '--title', title, '--body', body], { cwd }));
}

/**
 * One check's state, in the three the pane draws. A queued or running check has
 * a `status` but no `conclusion` yet, and a StatusContext has neither -- only a
 * `state` -- so anything unrecognised counts as pending rather than as a pass:
 * the optimistic reading of an unknown is the one that says "merge it".
 *
 * STALE is a finished run GitHub itself gave up on, not one still going, so it
 * is a failure: counted as pending it held the tab yellow, and its fraction
 * short, for a check that was never going to report. STARTUP_FAILURE is caught
 * by FAILURE, since the pattern is not anchored. That covers every value of
 * GitHub's CheckConclusionState and StatusState (read off the GraphQL schema
 * 2026-09-27); StatusState's EXPECTED is a status not yet posted, so pending.
 */
const state = (c) => {
  const s = c.conclusion || c.state || '';
  if (/SUCCESS|NEUTRAL|SKIPPED/i.test(s)) return 'pass';
  if (/FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STALE/i.test(s)) return 'fail';
  return 'pend';
};

/**
 * The checks, as counts for the tab label plus one row each for the tab body.
 *
 * A CheckRun and a StatusContext are different shapes for the same thing -- a
 * name and somewhere to go and read it -- so both are flattened here and the
 * pane never sees which it got. The workflow name is kept in front of the job
 * name because `test` on its own says nothing when three workflows all have one.
 *
 * A StatusContext's `targetUrl` is whatever the integration that posted it
 * said, on any repo opened with `prcoder <pr-url>`, so it is held to the rule
 * target() in public/pr.js holds description links to: http(s) or nothing. A
 * `javascript:` URL would otherwise be a live href in the page holding /pty.
 */
const web = (url) => (/^https?:\/\//.test(url ?? '') ? url : null);

export function rollup(checks) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  const list = (checks ?? []).map((c) => {
    const s = state(c);
    counts[{ pass: 'passed', fail: 'failed', pend: 'pending' }[s]]++;
    return {
      name: [c.workflowName, c.name ?? c.context].filter(Boolean).join(' / '),
      state: s,
      url: web(c.detailsUrl ?? c.targetUrl),
    };
  });
  return { ...counts, list };
}

/** Issues the PR closes, plus any bare #N mentioned in the body. */
export function linkedIssues(pr) {
  const seen = new Map();
  for (const i of pr.closingIssuesReferences ?? []) {
    seen.set(i.number, { number: i.number, url: i.url, closes: true });
  }
  const repo = repoUrl(pr.url);
  for (const number of mentions(pr.body ?? '')) {
    if (!seen.has(number)) seen.set(number, { number, url: `${repo}/issues/${number}`, closes: false });
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/**
 * The same list with GitHub's own title and URL on every entry it could get
 * them for, falling back to the number and the derived URL for the rest.
 *
 * They are their own call because no `gh pr view --json` field carries a title:
 * `closingIssuesReferences` gives number, url and repository and nothing else
 * (checked 2026-09-18), and a bare `#N` out of the body is only ever a number.
 * It rides on loadPr, which status() runs on a reload rather than on every
 * poll, so the poll's call count is unchanged and a reload costs one more.
 *
 * `issueOrPullRequest`, not `issue`: a `#N` in a description is as often a pull
 * request as an issue -- #27 in this repo's own -- and `issue(number:)` on one
 * resolves to nothing.
 */
async function withLinks(cwd, prUrl, issues) {
  // ponytail: 50 aliases is plenty for a description; if a body ever needs more,
  // chunk the numbers rather than growing one query.
  const numbers = issues.map((i) => i.number).slice(0, 50);
  const links = numbers.length ? await issueLinks(cwd, prUrl, numbers) : new Map();
  for (const i of issues) {
    const found = links.get(i.number);
    i.title = found?.title ?? null;
    // linkedIssues can only guess `/issues/N` from the repository URL, and half
    // the numbers in a description like this one are pull requests. GitHub
    // redirects, so the guess works -- but it is a guess, and the answer is
    // already in the response the title came out of.
    if (found?.url) i.url = found.url;
  }
  return issues;
}

/**
 * What GitHub knows about a list of numbers in the PR's own repository, as
 * number -> { title, url }.
 *
 * One aliased query for the lot, so a description mentioning a dozen issues is
 * still one subprocess. Only the numbers are interpolated into it; owner and
 * repo go through variables, as FILES_QUERY's do.
 *
 * A number that resolves to nothing -- a typo, or an issue that lives in
 * another repo -- comes back as a NOT_FOUND *error* beside the data rather than
 * a null inside it, and gh exits 1 over it with the whole response still on
 * stdout. Confirmed against the real API on 2026-09-18. So the failure is read
 * for its data: one bad number must not cost every other title.
 */
export async function issueLinks(cwd, prUrl, numbers) {
  const { owner, repo } = parsePrUrl(prUrl);
  try {
    return linksFrom(await gh(linksArgs(owner, repo, numbers), { cwd }));
  } catch (e) {
    return linksFrom(e.stdout);
  }
}

/**
 * The one query issueLinks and lookupRef share. Numbers only are interpolated.
 * `nameWithOwner` is GitHub's spelling of the repo, for lookupRef; linksFrom
 * passes over it, having no title.
 */
function linksArgs(owner, repo, numbers) {
  const query = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ nameWithOwner ` +
    numbers.map((n) => `i${n}: issueOrPullRequest(number:${Number(n)})` +
      `{ __typename ... on Issue { title url state updatedAt } ... on PullRequest { title url state updatedAt } }`).join(' ') + ` } }`;
  return ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`];
}

/**
 * One issue or pull request in any repo gh can read, for a reference typed
 * into the queue: `{ title, url, state, kind, updatedAt }` as linksFrom has it,
 * and `repo`, GitHub's own spelling of `owner/repo` -- so `CLI/CLI#1`, or a
 * repo since renamed, is stored the way GitHub will link it. (Asked for as
 * jashkenas/coffee-script on 2026-10-11, it said jashkenas/coffeescript.)
 *
 * Unlike issueLinks, which is decoration and swallows its failures, this is
 * the answer to "is that a real issue?", so it throws with the reason. GitHub
 * gives a good one -- "Could not resolve to a Repository with the name 'o/r'",
 * which is also what a private repo you cannot see says, and "...an issue or
 * pull request with the number of 99999" -- as a NOT_FOUND in the JSON gh
 * prints on stdout before exiting 1 (checked 2026-09-27). Read from there, so
 * it arrives without gh's `gh: ` in front; anything else keeps run()'s message.
 * `notFound` on the error says which: GitHub's no, or gh not getting an answer
 * at all -- offline, logged out, rate-limited -- which is no reason to refuse.
 */
export async function lookupRef(cwd, owner, repo, number) {
  const where = `${owner}/${repo}#${number}`;
  let out;
  try {
    out = await gh(linksArgs(owner, repo, [number]), { cwd });
  } catch (e) {
    let reason = e.message;
    let missing = false;
    try {
      const [error] = JSON.parse(e.stdout).errors;
      reason = error.message ?? reason;
      missing = error.type === 'NOT_FOUND';
    } catch { /* not GitHub's JSON */ }
    throw Object.assign(new Error(`${where}: ${reason}`), { notFound: missing });
  }
  const found = linksFrom(out).get(number);
  if (!found) throw new Error(`${where}: GitHub answered, but not with an issue or pull request`);
  let canonical = null;
  try { canonical = JSON.parse(out).data.repository.nameWithOwner ?? null; } catch { /* linksFrom read it */ }
  return { ...found, repo: canonical };
}

/** The `iN: { title, url, state, kind, updatedAt }` aliases of a response,
 *  whether or not it also carried errors. `kind` is `issue` or `pull`; `state`
 *  is GitHub's own -- OPEN or CLOSED, and MERGED for a pull request; `updatedAt`
 *  is an ISO timestamp, which any comment, label or edit moves. Anything unparseable is
 *  nothing -- these are decoration and a redirect, and a lookup that fails may
 *  not fail the pane. */
export function linksFrom(out) {
  let repo;
  try {
    repo = JSON.parse(out || '{}')?.data?.repository;
  } catch {
    return new Map();
  }
  return new Map(Object.entries(repo ?? {})
    .filter(([, v]) => v?.title)
    .map(([alias, v]) => [Number(alias.slice(1)), {
      // Anyone's text, which becomes a queue item's text through the Issues
      // tab's ↓ or a typed reference. sendToClaude cleans what ▶ types too;
      // this keeps it out of the stored item and the pane (docs/Security.md).
      // One that was nothing else would be a blank row: it is the number then.
      title: printable(v.title).trim() || alias.replace('i', '#'),
      url: v.url ?? null,
      state: v.state ?? null,
      kind: { Issue: 'issue', PullRequest: 'pull' }[v.__typename] ?? null,
      updatedAt: v.updatedAt ?? null,
    }]));
}
