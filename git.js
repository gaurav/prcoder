// Where the local repo actually is. Nothing here is cached: every fact is one
// cheap `git` call away, and a cache is just a thing that can disagree with the
// working tree. The one exception is repoInfo(), which asks GitHub for facts
// that cannot change while the process runs.

import { run, parsePrUrl } from './github.js';
import { urlPath } from './public/tasks.js';

// Shorter than run()'s default: git here is local but for push and ls-remote,
// and run() is also what turns a credential prompt into an error.
const git = (args, cwd) => run('git', args, { cwd, timeout: 30_000 });

const text = async (args, cwd) => (await git(args, cwd)).trim();

/**
 * Trimmed stdout, or null when git exits `ok`; any other failure is a real one.
 *
 * git's exit codes are per command, and a non-zero one is often an answer.
 * `rev-parse --verify --quiet` exits 1 for a missing object where `cat-file -e`
 * exits 128; `merge-base --is-ancestor` exits 1 for "no" and 128 for a bad
 * object. So choose the command whose "no" code differs from its error code.
 */
async function answer(args, cwd, ok = 1) {
  try {
    return await text(args, cwd);
  } catch (e) {
    // execFile reports a spawn failure as a string code (ENOENT), an exit as a
    // number. Only the expected number is an answer.
    if (e.code === ok) return null;
    throw e;
  }
}

/** Exit status only. `ok` is the answer; anything else is a real failure. */
const asks = async (args, cwd, ok) => (await answer(args, cwd, ok)) !== null;

/** Whether this clone has `rev` as a commit. 1 is "no"; 128 would be a bad name. */
const hasCommit = (rev, cwd) => asks(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd);

/** Empty on a detached HEAD, which happens mid-rebase and mid-bisect. */
export const currentBranch = (cwd) =>
  text(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).catch(() => '');

/**
 * Ahead or behind without a fetch: `remoteHead` is GitHub's view of the branch,
 * which the PR metadata already carries.
 *
 * ponytail: "behind" also covers "diverged" when we lack the remote commit —
 * only a fetch separates them, and the fix is a pull either way.
 */
export function syncState({ head, remoteHead, remoteKnownLocally, remoteIsAncestor }) {
  if (!remoteHead) return 'unpushed';
  if (head === remoteHead) return 'synced';
  if (!remoteKnownLocally) return 'behind';
  return remoteIsAncestor ? 'ahead' : 'diverged';
}

/**
 * The changed files that are the user's problem, from `git status --porcelain`.
 * Every one counts: prcoder writes nothing tracked (the store is in an ignored
 * .prcoder/), and the caller's --untracked-files=no leaves out what never
 * blocks a checkout. test/git.test.js has why FUTURE.md is no exception.
 *
 * Porcelain v1 lines are `XY path`, and the status letters are significant, so
 * the prefix is sliced rather than trimmed.
 */
export const userDirt = (status) =>
  status.split('\n').filter(Boolean).map((l) => l.slice(3));

/**
 * GitHub's "open a PR for this branch" page. `nameWithOwner` is gh's base repo,
 * which in a fork clone is `upstream`'s -- but the branch was pushed to origin,
 * and a bare branch name is looked up in the base repo: a 404. `owner:branch`
 * finds it in the owner's fork, and means the same branch when origin is the
 * base repo itself (checked 2026-09-24 against uc-cdis/heal-platform-sdk).
 */
export const compareUrl = (nameWithOwner, base, branch, owner) =>
  `https://github.com/${nameWithOwner}/compare/${urlPath(base)}...${owner ? `${owner}:` : ''}${urlPath(branch)}?expand=1`;

/**
 * Where `g` sends you on GitHub: the PR, or with none the compare page the
 * Create button would open. On the default branch or a detached HEAD there is
 * nothing to compare, so the repo itself. An unpushed branch is refused rather
 * than pushed -- Create pushes, this only looks -- because its compare page
 * says only "nothing to compare". `pushed` is trackingHead's answer, so a push
 * from another machine needs a fetch before it counts.
 */
export function githubUrl({ prUrl, nameWithOwner, defaultBranch, branch, pushed, owner }) {
  if (prUrl) return prUrl;
  if (!branch || branch === defaultBranch) return `https://github.com/${nameWithOwner}`;
  if (!pushed) throw new Error(`no pull request, and ${branch} is not on GitHub yet: push it, or use Create in the pane`);
  return compareUrl(nameWithOwner, defaultBranch, branch, owner);
}

/**
 * Who owns origin, read off its URL -- `git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@github.com/o/r.git` alike. Null for a
 * URL with no `owner/repo` tail. get-url applies `insteadOf`, so this is the
 * URL a push actually goes to.
 */
export async function originOwner(cwd) {
  const url = await text(['remote', 'get-url', 'origin'], cwd);
  return url.match(/[:/]([^/:]+)\/[^/:]+?\/?$/)?.[1] ?? null;
}

/**
 * How the PR on screen relates to the checkout. A boolean would collapse these:
 * a PR in another repo can never be in sync, so its light has to be hidden
 * rather than shown red forever.
 */
export function prScope(pr, { branch, nameWithOwner }) {
  if (!pr) return 'none';
  const { owner, repo } = parsePrUrl(pr.url);
  if (`${owner}/${repo}` !== nameWithOwner) return 'other-repo';
  return pr.headRefName === branch ? 'current' : 'other-branch';
}

/** Constant for the life of the process, so worth asking once. */
export async function repoInfo(cwd) {
  const { defaultBranchRef, nameWithOwner } =
    JSON.parse(await run('gh', ['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner'], { cwd }));
  return { defaultBranch: defaultBranchRef.name, nameWithOwner };
}

/**
 * `remoteHead` comes from the caller because only the PR knows it — and for a
 * fork it is not on origin at all, so `git ls-remote origin` would miss it.
 * `branch` likewise, because the caller has just asked for it.
 */
export async function snapshot(cwd, remoteHead, branch) {
  // Independent reads, so they run together rather than one spawn at a time.
  const [head, status, known] = await Promise.all([
    text(['rev-parse', 'HEAD'], cwd),
    git(['status', '--porcelain', '--untracked-files=no'], cwd),
    remoteHead && hasCommit(remoteHead, cwd),
  ]);
  const dirty = userDirt(status);

  let sync = 'unpushed';
  let ahead = 0;
  if (remoteHead) {
    // 128 rather than 1 when the commit is unknown, so only ask once we have it.
    const isAncestor = known && await asks(['merge-base', '--is-ancestor', remoteHead, 'HEAD'], cwd);
    sync = syncState({ head, remoteHead, remoteKnownLocally: known, remoteIsAncestor: isAncestor });
    if (sync === 'ahead') ahead = Number(await text(['rev-list', '--count', `${remoteHead}..HEAD`], cwd));
  }

  return { branch, head, detached: !branch, dirtyFiles: dirty, sync, ahead };
}

/**
 * The remote head as git last saw it, from `refs/remotes/origin/<branch>` --
 * what `git status` reads for "ahead by N" / "up to date", with no network.
 * A push updates it, so the commit-then-push flow is right immediately. Null
 * when origin has never had the branch as far as this clone knows.
 *
 * This is the poll's answer on a branch with no pull request. It is git's own
 * record, not a cache of prcoder's -- the header of this file still holds --
 * and it has git's own blind spot: a push made from another machine is not
 * seen until a fetch, so `behind` cannot come out of it. That is the trade
 * against `ls-remote` once a minute per visible tab for a branch whose answer
 * changes only when someone pushes (#19). Where the answer has to be origin's
 * -- the create route pushes on it -- remoteBranchHead below still asks.
 */
export async function trackingHead(cwd, branch) {
  if (!branch) return null;
  return answer(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], cwd);
}

/**
 * The remote head from origin itself, over the network. One caller: the
 * create route, which pushes when this says the branch is not there, so it
 * has to be origin's answer rather than git's memory of it. A fork PR would
 * need headRefOid instead, since its branch is not on origin at all.
 */
export async function remoteBranchHead(cwd, branch) {
  if (!branch) return null;
  // The full ref path, because ls-remote's argument is a pattern matched
  // against the *tail* of a ref on slash boundaries: a bare `topic` matches
  // origin's `refs/heads/feature/topic` and reports a stranger's head for a
  // branch that was never pushed. `refs/heads/topic` matches only itself.
  //
  // Not caught. A branch origin does not have is a successful call that prints
  // nothing; a failure is a network, auth or timeout problem, and answering null
  // for it said "not pushed" -- which the create route acts on by pushing.
  const out = await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], cwd);
  return out.trim().split(/\s/)[0] || null;
}

/**
 * The branches under `branch` on origin, nearest first, as far down as git can
 * tell: `{ names, toDefault }`, where `toDefault` says the last one (or `branch`
 * itself) was cut from the default branch rather than from something git could
 * not name. The default branch is not in `names`. `current` walks from HEAD,
 * which may be ahead of origin's copy or not pushed at all.
 *
 * For a branch with no pull request, which has no base to ask GitHub for, so
 * the Stack tab and the branch-only pane ask this on demand (#93) rather than
 * the poll. `prs` is the open pull requests as `{ headRefName, baseRefName }`:
 * what GitHub says about a branch beats what git can guess, so the walk stops
 * at the first one that is a pull request's head -- its base is the page's to
 * follow -- and never takes a branch stacked on one it has walked for its
 * parent. Git alone cannot tell those apart: a child cut before its parent's
 * newest commit contains the parent's older ones, and names them as its own.
 */
export async function branchesBelow(cwd, branch, defaultBranch, { current = false, prs = [] } = {}) {
  const heads = new Set(prs.map((p) => p.headRefName));
  const names = [];
  const seen = new Set([branch]);
  let ref = current ? 'HEAD' : `refs/remotes/origin/${branch}`;
  for (let i = 0; i < 10; i++) {
    const parent = await parentBranch(cwd, ref, defaultBranch, [...seen, ...stackedOn(prs, seen)], prs);
    if (parent === defaultBranch) return { names, toDefault: true };
    if (!parent) break;
    seen.add(parent);
    names.push(parent);
    if (heads.has(parent)) break;
    ref = `refs/remotes/origin/${parent}`;
  }
  return { names, toDefault: false };
}

/** Every head whose base, or its base's base, is in `branches`. */
function stackedOn(prs, branches) {
  const out = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const p of prs) {
      if ((branches.has(p.baseRefName) || out.has(p.baseRefName)) && !out.has(p.headRefName)) {
        out.add(p.headRefName);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * The origin branch `ref` was cut from: the nearest commit on its first-parent
 * line that another origin branch also has. Not "which branch tips are
 * ancestors", which is one call cheaper and wrong as soon as the parent takes a
 * commit after the child was cut -- a review fix on the PR below, the normal
 * case in a stack.
 *
 * The branches that contain `ref` strictly are the ones stacked on it, and
 * would name its own commits, so they are left out; one at the same commit is
 * kept, since a branch just cut from another sits exactly there. So is every
 * branch in `skip`: the walk so far, and what is stacked on it.
 *
 * Two branches can name the same commit at the same distance -- a sibling cut
 * before the parent's newest commit has the parent's older ones too -- and
 * name-rev breaks that tie by the older tip, so by commit dates. When `prs`
 * says the branch it picked is stacked on another that also has the commit,
 * that one is lower, and the pick is dropped and name-rev asked again.
 *
 * ponytail: a child cut from `ref` before its newest commit has `ref`'s older
 * commits, and the history is the same shape as if `ref` had been cut from it,
 * so git alone can take the child for the parent. A child with a pull request
 * is never taken -- branchesBelow skips what is stacked on the walk, and the
 * tie above drops one stacked on a rival -- so this is only a bare child. Local
 * reflogs ("Created from") would say, where they exist; test/git.test.js pins
 * it.
 */
async function parentBranch(cwd, ref, defaultBranch, skip, prs = []) {
  const tip = await text(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  const above = (await text(['for-each-ref', '--contains', tip, '--format=%(objectname) %(refname)', 'refs/remotes/origin'], cwd))
    .split('\n').filter(Boolean).map((l) => l.split(' '))
    .filter(([oid]) => oid !== tip).map(([, name]) => name);
  const own = (await text(['log', '--first-parent', '--format=%H', '-n', '200', tip,
    `^refs/remotes/origin/${defaultBranch}`, '--'], cwd)).split('\n').filter(Boolean);
  // Nothing of its own above the default branch: cut from it, or merged into it.
  if (!own.length) return defaultBranch;
  const refs = [...above, ...skip.map((b) => `refs/remotes/origin/${b}`), 'refs/remotes/origin/HEAD'];
  for (;;) {
    const named = (await text(['name-rev', '--name-only', '--refs=refs/remotes/origin/*',
      ...refs.map((r) => `--exclude=${r}`), ...own], cwd)).split('\n');
    const at = named.findIndex((n) => n !== 'undefined');
    // Every commit is this branch's alone, so it forks off the default branch.
    if (at < 0) return defaultBranch;
    const hit = named[at].replace(/^remotes\/origin\//, '').replace(/[~^].*$/, '');
    const under = basesOf(prs, hit, defaultBranch);
    if (!under.length) return hit;
    const holders = new Set((await text(['for-each-ref', '--contains', own[at], '--format=%(refname:lstrip=3)',
      'refs/remotes/origin'], cwd)).split('\n'));
    if (!under.some((b) => holders.has(b))) return hit;
    refs.push(`refs/remotes/origin/${hit}`);
  }
}

/** The bases under `head` by its pull request, its base's, and so on, short of the default branch. */
function basesOf(prs, head, defaultBranch) {
  const out = [];
  for (let at = head; ;) {
    const base = prs.find((p) => p.headRefName === at)?.baseRefName;
    if (!base || base === defaultBranch || base === head || out.includes(base)) return out;
    out.push(base);
    at = base;
  }
}

// ponytail: a fixed cap. GitHub's own per-file patches run to ~50 KB on a big
// PR; past this the pane's DOM and the page's tokenizer are what pay for it.
// Raise it if a real file is refused.
const PATCH_LIMIT = 512 * 1024;

/**
 * One file's patch from local git, in the shape of GitHub's `patch` (from the
 * first @@, no trailing newline) -- for a file GitHub sent none for. It stops
 * sending them partway through a large pull request: on one with 73 files every
 * patch after the first ~860 KB came back missing, `+0` and all, while GraphQL
 * still counted the file's lines (checked 2026-09-23).
 *
 * The base is GitHub's `baseRefOid` when this clone has it, else its own
 * memory of the base branch, and `...` diffs from the merge base -- which is
 * what a pull request shows. Null when a commit is missing, the file is binary,
 * the patch is over PATCH_LIMIT, or a rename came apart into two files: this
 * stands in for GitHub's view, so it shows that or nothing.
 *
 * And null when its line counts are not GitHub's. The base's fallback is where
 * that bites: a branch that merged base commits this clone never fetched would
 * diff from an older merge base, and show those commits as the pull request's
 * own. Nothing else here would notice, and what is on screen would not be what
 * is under review. The counts come from GraphQL, which still has them when
 * REST has dropped the patch.
 */
export async function localPatch(cwd, { baseOid, baseRef, head, path, from, additions, deletions }) {
  const known = (rev) => hasCommit(rev, cwd);
  const base = await known(baseOid) ? baseOid
    : await known(`refs/remotes/origin/${baseRef}`) ? `refs/remotes/origin/${baseRef}` : null;
  if (!base || !await known(head)) return null;
  // --literal-pathspecs because the path comes from the page: `:(glob)**` is
  // otherwise every file. The rest keep a user's diff config out of it: a
  // `diff.algorithm histogram` in someone's gitconfig reaches every `git diff`
  // prcoder runs. Myers with three lines of context is what came closest to
  // GitHub's patches, and even then a few files split hunks differently
  // (7d3df58 has the comparison), which is why the line counts below are the
  // check, not the text.
  const out = await git(['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '-U3', '--diff-algorithm=myers', '-M', `${base}...${head}`, '--', ...(from ? [from] : []), path], cwd);
  const at = out.search(/^@@/m);
  if (at < 0 || out.length > PATCH_LIMIT || out.match(/^diff --git /gm).length > 1) return null;
  const patch = out.slice(at).replace(/\n$/, '');
  const count = (sign) => patch.split('\n').filter((l) => l[0] === sign).length;
  return count('+') === additions && count('-') === deletions ? patch : null;
}

export const checkoutPr = (cwd, number) =>
  run('gh', ['pr', 'checkout', String(number)], { cwd, timeout: 120_000 });

export const pushBranch = (cwd) => git(['push', '-u', 'origin', 'HEAD'], cwd);
