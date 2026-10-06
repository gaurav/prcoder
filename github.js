// Everything GitHub goes through the `gh` CLI, which is already authenticated.

import { execFile } from 'node:child_process';
import { debug } from './term.js';
import { mentions, repoUrl } from './public/tasks.js';

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
  'additions', 'deletions', 'changedFiles', 'files', 'statusCheckRollup',
  'closingIssuesReferences', 'reviewDecision', 'comments', 'reviews',
  // headRefOid is GitHub's view of the branch head, which is what lets the sync
  // light work without a fetch. updatedAt gates the expensive full reload.
  'headRefOid', 'updatedAt', 'isCrossRepository',
  // What /api/diff diffs from when GitHub sends a file no patch.
  'baseRefOid',
].join(',');

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

/**
 * Just enough to know whether the PR moved, without the GraphQL viewed pass --
 * and its url, which is all the `g` key needs.
 */
export const prHeads = (cwd, target) => viewPr(cwd, target, 'number,headRefOid,updatedAt,state,url');

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
 * of its own would be a call on a poll that already has seven. `url` is for the
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
 * The PR for the current branch, or null if there isn't one. Per-file viewed
 * state needs GraphQL — `gh pr view` doesn't expose it — so it comes from a
 * second call and is merged in by path.
 */
export async function loadPr(cwd, target) {
  const pr = await viewPr(cwd, target, PR_FIELDS);
  if (!pr) return null;
  pr.body = lf(pr.body);

  // Both need only the PR, so they run together: each is a GitHub round trip.
  const [{ nodeId, viewed }, issues] = await Promise.all([
    viewedState(cwd, pr.url),
    withLinks(cwd, pr.url, linkedIssues(pr)),
  ]);
  // The raw lists are summarised here and not sent on: every poll carries this
  // object to every tab, and nothing reads them past this point.
  const { statusCheckRollup, closingIssuesReferences, comments, reviews, ...rest } = pr;

  return {
    ...rest,
    files: pr.files.map((f) => ({ ...f, viewed: viewed.get(f.path) === 'VIEWED' })),
    nodeId,
    checks: rollup(statusCheckRollup),
    issues,
    counts: { comments: comments?.length ?? 0, reviews: reviews?.length ?? 0 },
  };
}

const VIEWED_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    id files(first:100,after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{ path viewerViewedState }
    } } } }`;

async function viewedState(cwd, url) {
  const { owner, repo, number } = parsePrUrl(url);
  const viewed = new Map();
  let nodeId = null;
  let after = null;

  do {
    // -f for every string, -F only for the Int. -F converts by what a value
    // looks like: an all-digit owner went as an Int and GitHub refused it
    // ("Could not coerce value 12345 to String", checked 2026-09-26), and a
    // value starting with @ is read as a file name.
    const args = ['api', 'graphql', '-f', `query=${VIEWED_QUERY}`,
      '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
    if (after) args.push('-f', `after=${after}`);
    const { data } = JSON.parse(await gh(args, { cwd }));
    const pr = data.repository.pullRequest;
    nodeId = pr.id;
    for (const n of pr.files.nodes) viewed.set(n.path, n.viewerViewedState);
    after = pr.files.pageInfo.hasNextPage ? pr.files.pageInfo.endCursor : null;
  } while (after);

  return { nodeId, viewed };
}

/** Ticking this here ticks the same checkbox on github.com. */
export async function setViewed(cwd, nodeId, path, viewed) {
  const op = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  await gh(['api', 'graphql', '-f', `query=mutation($id:ID!,$path:String!){
    ${op}(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`,
    // -f: a file named `404` or `@types/x.d.ts` is a string (see viewedState).
    '-f', `id=${nodeId}`, '-f', `path=${path}`], { cwd });
}

/**
 * Per-file `{patch, from}`, keyed by path. Shape confirmed against this repo's
 * PR #1 on 2026-08-26: --slurp wraps the pages in one array, the REST field is
 * `filename` where `gh pr view` says `path` (same string), and `patch` starts
 * at the first @@ with no file header. It is absent for binary and oversized
 * files, and files past GitHub's 300-file cap are missing entirely — both read
 * back as null/undefined and the client falls through to the GitHub link.
 *
 * `from` is `previous_filename`, set only when GitHub saw the file as renamed
 * (cli/cli#14116, checked 2026-09-18: `status: "renamed"`, a patch when it was
 * edited too). Without it a pure rename is a file with no patch, and the pane
 * would call it binary.
 */
export async function fetchPatches(cwd, prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const out = await gh(['api', '--paginate', '--slurp',
    `repos/${owner}/${repo}/pulls/${number}/files`], { cwd });
  return new Map(JSON.parse(out).flat().map((f) =>
    [f.filename, { patch: f.patch ?? null, from: f.previous_filename }]));
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

export async function createIssue(cwd, nameWithOwner, title) {
  return issueNumber(await gh(['issue', 'create', '--repo', nameWithOwner,
    '--title', title, '--body', ''], { cwd }));
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
 * repo go through variables, as VIEWED_QUERY's do.
 *
 * A number that resolves to nothing -- a typo, or an issue that lives in
 * another repo -- comes back as a NOT_FOUND *error* beside the data rather than
 * a null inside it, and gh exits 1 over it with the whole response still on
 * stdout. Confirmed against the real API on 2026-09-18. So the failure is read
 * for its data: one bad number must not cost every other title.
 */
export async function issueLinks(cwd, prUrl, numbers) {
  const { owner, repo } = parsePrUrl(prUrl);
  const query = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ ` +
    numbers.map((n) => `i${n}: issueOrPullRequest(number:${n})` +
      `{ __typename ... on Issue { title url state updatedAt } ... on PullRequest { title url state updatedAt } }`).join(' ') + ` } }`;
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`];
  try {
    return linksFrom(await gh(args, { cwd }));
  } catch (e) {
    return linksFrom(e.stdout);
  }
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
      title: v.title,
      url: v.url ?? null,
      state: v.state ?? null,
      kind: { Issue: 'issue', PullRequest: 'pull' }[v.__typename] ?? null,
      updatedAt: v.updatedAt ?? null,
    }]));
}
