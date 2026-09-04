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
        err.stderr = stderr;
        reject(err);
      });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
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

/** Just enough to know whether the PR moved, without the GraphQL viewed pass. */
export async function prHeads(cwd, target) {
  const args = ['pr', 'view', ...(target ? [target] : []), '--json', 'number,headRefOid,updatedAt,state'];
  try {
    return JSON.parse(await gh(args, { cwd }));
  } catch (e) {
    if (/no pull requests found|no default remote|not a git repo/i.test(e.stderr ?? '')) return null;
    throw e;
  }
}

/** The description as GitHub has it right now, for a read-modify-write. */
export async function prBody(cwd, prUrl) {
  const { body } = JSON.parse(await gh(['pr', 'view', prUrl, '--json', 'body'], { cwd }));
  return body ?? '';
}

/** Open PRs, for the switcher. */
export async function listPrs(cwd) {
  const args = ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft'];
  return JSON.parse(await gh(args, { cwd }));
}

/**
 * The PR for the current branch, or null if there isn't one. Per-file viewed
 * state needs GraphQL — `gh pr view` doesn't expose it — so it comes from a
 * second call and is merged in by path.
 */
export async function loadPr(cwd, target) {
  let pr;
  try {
    const args = ['pr', 'view', ...(target ? [target] : []), '--json', PR_FIELDS];
    pr = JSON.parse(await gh(args, { cwd }));
  } catch (e) {
    if (/no pull requests found|no default remote|not a git repo/i.test(e.stderr ?? '')) return null;
    throw e;
  }

  const { nodeId, viewed } = await viewedState(cwd, pr.url);
  const files = pr.files.map((f) => ({ ...f, viewed: viewed.get(f.path) === 'VIEWED' }));

  return {
    ...pr,
    files,
    nodeId,
    checks: rollup(pr.statusCheckRollup),
    issues: linkedIssues(pr),
    counts: { comments: pr.comments?.length ?? 0, reviews: pr.reviews?.length ?? 0 },
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
 * Per-file patch text, keyed by path. Shape confirmed against this repo's PR #1
 * on 2026-08-26: --slurp wraps the pages in one array, the REST field is
 * `filename` where `gh pr view` says `path` (same string), and `patch` starts
 * at the first @@ with no file header. It is absent for binary and oversized
 * files, and files past GitHub's 300-file cap are missing entirely — both read
 * back as null/undefined and the client falls through to the GitHub link.
 */
export async function fetchPatches(cwd, prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const out = await gh(['api', '--paginate', '--slurp',
    `repos/${owner}/${repo}/pulls/${number}/files`], { cwd });
  return new Map(JSON.parse(out).flat().map((f) => [f.filename, f.patch ?? null]));
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
    seen.set(i.number, { number: i.number, title: i.title, url: i.url, closes: true });
  }
  const repoUrl = pr.url.replace(/\/pull\/\d+$/, '');
  for (const [, n] of (pr.body ?? '').matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
    const number = Number(n);
    if (!seen.has(number)) seen.set(number, { number, url: `${repoUrl}/issues/${number}`, closes: false });
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}
