// Everything GitHub goes through the `gh` CLI, which is already authenticated.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function gh(args, opts = {}) {
  const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout;
}

const PR_FIELDS = [
  'number', 'title', 'body', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName',
  'additions', 'deletions', 'changedFiles', 'files', 'statusCheckRollup',
  'closingIssuesReferences', 'reviewDecision', 'comments', 'reviews',
].join(',');

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

export function parsePrUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a pull request URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function setBody(cwd, prUrl, body) {
  await gh(['pr', 'edit', prUrl, '--body-file', '-'], { cwd, input: body });
}

export async function createIssue(cwd, prUrl, title) {
  const { owner, repo } = parsePrUrl(prUrl);
  const url = (await gh(['issue', 'create', '--repo', `${owner}/${repo}`,
    '--title', title, '--body', ''], { cwd })).trim();
  const number = Number(url.match(/\/(\d+)$/)?.[1]);
  return { url, number };
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
