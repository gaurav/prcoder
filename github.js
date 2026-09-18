// Everything GitHub goes through the `gh` CLI, which is already authenticated.

import { execFile } from 'node:child_process';
import { debug } from './term.js';

// Every gh call and every git call comes through run(), so this is the whole
// count. What it is for: two browser tabs each poll on their own timer against
// one serial lock, and this is how you see that happening.
let calls = 0;
export const runCount = () => calls;

/**
 * `input` has to be written to the child's stdin by hand: execFile accepts the
 * option only in its *Sync* form and silently ignores it otherwise, which makes
 * a `--body-file -` call hang on a stdin that never closes.
 */
export function run(bin, args, { input, ...opts } = {}) {
  calls++;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, ...opts },
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
].join(',');

/** `gh pr view`, or null when there is no PR to view. */
async function viewPr(cwd, target, fields) {
  const args = ['pr', 'view', ...(target ? [target] : []), '--json', fields];
  try {
    return JSON.parse(await gh(args, { cwd }));
  } catch (e) {
    if (/no pull requests found|no default remote|not a git repo/i.test(e.stderr ?? '')) return null;
    throw e;
  }
}

/** Just enough to know whether the PR moved, without the GraphQL viewed pass. */
export const prHeads = (cwd, target) => viewPr(cwd, target, 'number,headRefOid,updatedAt,state');

/**
 * A description with LF line endings. One saved from github.com's editor comes
 * back CRLF -- 9 of cli/cli's last 30 on 2026-09-13 -- and every line pattern
 * here ends in `(.*)$`, where `.` stops at the `\r`: no line is a checkbox, a
 * heading or a list, and a tick made on GitHub never reaches the queue. Both
 * reads come through this, so nothing downstream has to know.
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
 * of its own would be a call on a poll that already has seven.
 */
export async function listPrs(cwd) {
  const args = ['pr', 'list', '--state', 'open', '--json',
    'number,title,headRefName,baseRefName,isDraft'];
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

  const { nodeId, viewed } = await viewedState(cwd, pr.url);
  // The raw lists are summarised here and not sent on: every poll carries this
  // object to every tab, and nothing reads them past this point.
  const { statusCheckRollup, closingIssuesReferences, comments, reviews, ...rest } = pr;

  return {
    ...rest,
    files: pr.files.map((f) => ({ ...f, viewed: viewed.get(f.path) === 'VIEWED' })),
    nodeId,
    checks: rollup(statusCheckRollup),
    issues: await withTitles(cwd, pr.url, linkedIssues(pr)),
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
    const args = ['api', 'graphql', '-f', `query=${VIEWED_QUERY}`,
      '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `number=${number}`];
    if (after) args.push('-F', `after=${after}`);
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
    '-F', `id=${nodeId}`, '-F', `path=${path}`], { cwd });
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
 * Failing here rather than returning NaN is the point: the number is written
 * into FUTURE.md as `@issue#N`, and `@issue#NaN` does not match the marker
 * pattern on the way back in, so it silently becomes part of the task text.
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

export function rollup(checks) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const c of checks ?? []) {
    const s = c.conclusion || c.state || '';
    if (/SUCCESS|NEUTRAL|SKIPPED/i.test(s)) counts.passed++;
    else if (/FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/i.test(s)) counts.failed++;
    else counts.pending++;
  }
  return counts;
}

/** Issues the PR closes, plus any bare #N mentioned in the body. */
export function linkedIssues(pr) {
  const seen = new Map();
  for (const i of pr.closingIssuesReferences ?? []) {
    seen.set(i.number, { number: i.number, url: i.url, closes: true });
  }
  const repoUrl = pr.url.replace(/\/pull\/\d+$/, '');
  for (const [, n] of (pr.body ?? '').matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
    const number = Number(n);
    if (!seen.has(number)) seen.set(number, { number, url: `${repoUrl}/issues/${number}`, closes: false });
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/**
 * The same list with a title on every entry it could get one for.
 *
 * The titles are their own call because no `gh pr view --json` field carries
 * one: `closingIssuesReferences` gives number, url and repository and nothing
 * else (checked 2026-09-18), and a bare `#N` out of the body is only ever a
 * number. It rides on loadPr, which status() runs on a reload rather than on
 * every poll, so the poll's call count is unchanged and a reload costs one more.
 *
 * `issueOrPullRequest`, not `issue`: a `#N` in a description is as often a pull
 * request as an issue -- #27 in this repo's own -- and `issue(number:)` on one
 * resolves to nothing.
 */
async function withTitles(cwd, prUrl, issues) {
  // ponytail: 50 aliases is plenty for a description; if a body ever needs more,
  // chunk the numbers rather than growing one query.
  const numbers = issues.map((i) => i.number).slice(0, 50);
  const titles = numbers.length ? await issueTitles(cwd, prUrl, numbers) : new Map();
  for (const i of issues) i.title = titles.get(i.number) ?? null;
  return issues;
}

/**
 * Titles for issue numbers in the PR's own repository, as number -> title.
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
export async function issueTitles(cwd, prUrl, numbers) {
  const { owner, repo } = parsePrUrl(prUrl);
  const query = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ ` +
    numbers.map((n) => `i${n}: issueOrPullRequest(number:${n})` +
      `{ ... on Issue { title } ... on PullRequest { title } }`).join(' ') + ` } }`;
  const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `repo=${repo}`];
  try {
    return titlesFrom(await gh(args, { cwd }));
  } catch (e) {
    return titlesFrom(e.stdout);
  }
}

/** The `iN: { title }` aliases of a response, whether or not it also carried
 *  errors. Anything unparseable is no titles -- they are decoration, and a
 *  lookup that fails may not fail the pane. */
export function titlesFrom(out) {
  let repo;
  try {
    repo = JSON.parse(out || '{}')?.data?.repository;
  } catch {
    return new Map();
  }
  return new Map(Object.entries(repo ?? {})
    .filter(([, v]) => v?.title)
    .map(([alias, v]) => [Number(alias.slice(1)), v.title]));
}
