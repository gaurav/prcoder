// Where the local repo actually is. Nothing here is cached: every fact is one
// cheap `git` call away, and a cache is just a thing that can disagree with the
// working tree. The one exception is repoInfo(), which asks for facts that
// cannot change while the process runs.

import { run, parsePrUrl, branchPrUrl } from './github.js';
import { urlPath } from './public/tasks.js';
import { debug } from './term.js';
import { existsSync } from 'node:fs';

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

/**
 * Which of `oids` this clone has as commits, as a Set: one `cat-file
 * --batch-check` for the lot, where hasCommit is a spawn each -- the branch
 * lookup asks about every stranger's head on a page of up to a hundred. The
 * format prints the type alone, and a name git lacks prints `<name> missing`,
 * so line i answers oid i. Only a full hex oid is sent: these come from
 * GitHub, and a newline in one would shift every answer after it.
 */
export async function commitsKnown(oids, cwd) {
  const asked = oids.filter((o) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(o));
  if (!asked.length) return new Set();
  const out = await run('git', ['cat-file', '--batch-check=%(objecttype)'], { cwd, timeout: 30_000, input: `${asked.join('\n')}\n` });
  const lines = out.split('\n');
  return new Set(asked.filter((_, i) => lines[i] === 'commit'));
}

/**
 * commitsKnown with each commit asked about once for as long as the memo is
 * kept. The poll keeps one: the lookup asks about a fork's head, and snapshot
 * about the remote head, which on such a branch is the same commit. `many`
 * answers with a Set, `one` with a boolean, the shapes branchPrs and
 * snapshot take.
 */
export function commitMemo(cwd) {
  const known = new Map();
  const many = async (oids) => {
    const fresh = [...new Set(oids)].filter((o) => !known.has(o));
    if (fresh.length) {
      const got = commitsKnown(fresh, cwd);
      for (const o of fresh) known.set(o, got.then((held) => held.has(o)));
    }
    const answers = await Promise.all(oids.map((o) => known.get(o)));
    return new Set(oids.filter((_, i) => answers[i]));
  };
  return { many, one: async (oid) => (await many([oid])).has(oid) };
}

/**
 * The commit HEAD is at. The poll reads it before the branch lookup, to rank
 * the pull requests it finds (pickPr); snapshot reads its own after, beside
 * `git status`, since the lookup takes seconds and a commit can land in them.
 */
export const headCommit = (cwd) => text(['rev-parse', 'HEAD'], cwd);

/**
 * Why prcoder cannot run in `cwd`, or null when it is inside a work tree.
 *
 * Outside any repo `rev-parse` exits 128 with git's own reason on stderr --
 * not a repository, or one owned by someone else that safe.directory refuses
 * -- and that reason is the answer. Inside a `.git` directory or a bare repo it
 * exits 0 and prints `false`: a repo, but no checkout for the agent to work in.
 * A GIT_DIR or GIT_WORK_TREE in the environment answers before `cwd` does, and
 * is left to: every other git call here, and the agent, obey it too.
 */
export async function notAWorkTree(cwd) {
  try {
    if (await text(['rev-parse', '--is-inside-work-tree'], cwd) === 'true') return null;
    return 'this is a .git directory or a bare repository, not a checkout';
  } catch (e) {
    return e.code === 'ENOENT' ? 'git is not installed, or not on PATH' : e.message;
  }
}

/**
 * The top level of the working copy `cwd` is in: the same for a prcoder
 * started in any directory of it, and different in each worktree, which has
 * its own files. Where server.js keeps the running records (runningHere).
 */
export const workTreeTop = (cwd) => text(['rev-parse', '--show-toplevel'], cwd);

/**
 * `git worktree list --porcelain -z` as `[{ path, branch, detached, bare,
 * locked, prunable }]`: every working copy of the repository, the main one
 * first, as git lists them. `branch` is the short name, or null on a detached
 * HEAD and for a bare repository, which is listed first with no files of its
 * own. `prunable` is one whose directory is gone and that `git worktree
 * prune` would forget; its branch still counts as checked out until then.
 *
 * `-z` because a path may hold a newline: each line ends in NUL and each
 * record in one more. A line git adds later is ignored.
 */
export function parseWorktrees(out) {
  return out.split('\0\0').map((record) => record.split('\0').filter(Boolean)).map((lines) => {
    const line = (key) => lines.find((l) => l === key || l.startsWith(`${key} `));
    const value = (key) => line(key)?.slice(key.length + 1) || null;
    const ref = value('branch');
    return {
      path: value('worktree'),
      branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
      detached: line('detached') !== undefined,
      bare: line('bare') !== undefined,
      locked: line('locked') !== undefined,
      prunable: line('prunable') !== undefined,
    };
  }).filter((w) => w.path);
}

/** The repository's working copies (parseWorktrees), asked from any of them. */
export const worktrees = async (cwd) => parseWorktrees(await git(['worktree', 'list', '--porcelain', '-z'], cwd));

/**
 * `{ path, main, common }` when `cwd` is in a linked worktree -- one made by
 * `git worktree add` -- and null in a repository's main working copy. `path`
 * is the worktree's top level and `main` the main working copy's, or null
 * when the repository is bare and has none. `common` is the git directory
 * every working copy shares, which is there either way: where a command about
 * a worktree is run from once it must not be run inside it (removeWorktree).
 *
 * Told by the two directories git keeps: a linked worktree's own is
 * `.git/worktrees/<name>` inside the one it shares with the rest. Not by
 * `.git` being a file, which a submodule's is too.
 */
export async function linkedWorktree(cwd) {
  const [own, common] = (await text(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], cwd)).split('\n');
  if (own === common) return null;
  const [first] = await worktrees(cwd);
  return { path: await workTreeTop(cwd), main: first && !first.bare ? first.path : null, common };
}

/**
 * What `git worktree remove` would delete from the working copy `cwd` is in
 * that git does not have: `{ changed, untracked, ignored }`, the first two
 * counts of files and the last the ignored paths as git names them, a
 * directory once (`node_modules/`). Commits are not in it: a worktree's
 * branch stays when the worktree goes.
 *
 * git refuses the removal over the first two unless forced, and says nothing
 * at all about the third: with only ignored files in it a worktree is removed
 * whole, exit 0 (git 2.54, 2026-11-14, and test/git.test.js). That is a
 * `node_modules`, an `.env`, and prcoder's own `.prcoder/` with the queue in
 * it, so the caller is told about each and decides; `.prcoder/` is left to
 * the caller, which knows whether there is a queue in it.
 *
 * `--no-renames`, so a rename is a deletion and an addition, one record each:
 * with `-z` a rename's old name is a record of its own with no status on it.
 */
export async function worktreeLoss(cwd) {
  const out = await git(['status', '--porcelain', '-z', '--ignored', '--no-renames'], cwd);
  const entries = out.split('\0').filter(Boolean).map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }));
  return {
    changed: entries.filter((e) => e.status !== '??' && e.status !== '!!').length,
    untracked: entries.filter((e) => e.status === '??').length,
    ignored: entries.filter((e) => e.status === '!!' && e.path !== '.prcoder/').map((e) => e.path),
  };
}

/**
 * The commits on HEAD in `cwd` that removing its worktree would leave
 * somewhere unexpected: `{ unpushed, orphaned }`.
 *
 * `unpushed` is how many are on its branch and on no remote. They stay,
 * since the branch does, but they are on this machine alone, and a worktree
 * that goes without a word takes with it the one place that showed them as
 * work in progress. Nothing when the repository has no remote at all: there
 * is nowhere they could have been pushed.
 *
 * `orphaned` is how many are on no branch, tag or remote, which only a
 * detached HEAD can have: those do go with the worktree, as nothing else
 * names them once its HEAD and reflog are deleted.
 */
export async function commitsOnlyHere(cwd) {
  const count = async (...not) => Number(await text(['rev-list', '--count', 'HEAD', '--not', ...not], cwd));
  if (!await currentBranch(cwd)) return { unpushed: 0, orphaned: await count('--branches', '--tags', '--remotes') };
  return { unpushed: await text(['remote'], cwd) ? await count('--remotes') : 0, orphaned: 0 };
}

/**
 * `git worktree remove` of the worktree at `where`, run in `from`: the
 * shared git directory (linkedWorktree's `common`), since the worktree itself
 * is about to go and a bare repository has no main working copy to stand in.
 * `force` is git's `--force`, for one with changed or untracked files, which
 * are deleted with it. A locked worktree is refused either way: it takes two
 * `--force`, and whoever locked it meant something by that.
 *
 * The branch is not touched. Two minutes, as a checkout gets: a removal cut
 * short leaves half a directory that git no longer lists.
 */
export const removeWorktree = (from, where, { force = false } = {}) =>
  run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), where], { cwd: from, timeout: 120_000 });

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

/** The files with uncommitted changes, as the status block counts them: tracked ones only. */
export const dirtyFiles = async (cwd) => userDirt(await git(['status', '--porcelain', '--untracked-files=no'], cwd));

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
 * `owner/repo` off a GitHub remote URL, the shapes originOwner reads. Null for
 * a remote that is not on github.com: a mirror elsewhere is no repository to
 * ask gh about, and `gh pr list --repo` of its owner/name would be a stranger's
 * repository of the same name, or a 404 that fails the poll. (One more place
 * the host is assumed; #53.)
 */
export const remoteRepo = (url) =>
  url.trim().match(/github\.com[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/)?.slice(1, 3).join('/') ?? null;

/**
 * Every GitHub repository this clone's remotes point at, `[{ name, repo }]`,
 * origin first and the rest as `git remote` lists them. get-url applies
 * `insteadOf`, so each is the URL a fetch actually goes to.
 */
export async function remoteRepos(cwd) {
  const names = (await text(['remote'], cwd)).split('\n').filter(Boolean)
    .sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  const out = [];
  for (const name of names) {
    const repo = remoteRepo(await text(['remote', 'get-url', name], cwd));
    if (repo) out.push({ name, repo });
  }
  return out;
}

/**
 * The URL of the pull request `branch` was checked out for, read from its
 * config with no network, or null. `gh pr checkout` of a fork's pull request
 * leaves `branch.<b>.merge` at `refs/pull/<n>/head` and `branch.<b>.remote`
 * at the base repository's remote, or its URL when no remote names it -- and
 * gh reads the pair back to say which pull request the branch is. checkoutGone
 * marks a `pr-<n>` branch the same way, so the pair names the pull request on
 * both: whatever the branch is called, and in every later run, not only the
 * one that checked it out (isHere, server.js's poll, `prcoder choose`'s
 * offer).
 *
 * `repos` (repoInfo's) respells the repository as the first of them that
 * matches it case-blind, which is GitHub's spelling for gh's base and its
 * parent: the poll compares URLs exactly, and a remote's URL can spell the
 * owner otherwise. Null too for a remote off GitHub.
 */
export async function trackedPr(cwd, branch, repos = []) {
  if (!branch) return null;
  const merge = await answer(['config', '--get', `branch.${branch}.merge`], cwd);
  const n = merge?.match(/^refs\/pull\/([1-9]\d*)\/head$/)?.[1];
  if (!n) return null;
  const remote = await answer(['config', '--get', `branch.${branch}.remote`], cwd);
  if (!remote) return null;
  const named = (await remoteRepos(cwd)).find((r) => r.name === remote)?.repo ?? remoteRepo(remote);
  if (!named) return null;
  const spelled = repos.find((r) => r.toLowerCase() === named.toLowerCase()) ?? named;
  return `https://github.com/${spelled}/pull/${n}`;
}

/** Whether two pull request URLs are one, as GitHub reads them: case-blind. */
const samePr = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `p` is the pull request of the checked-out `branch`, without asking
 * gh: one of this repository's by its head's name, or the one `tracked`
 * names -- trackedPr, the branch's own config, which is how a
 * `pr-<n>` made for a gone branch and a fork's checked out by gh say which
 * they are. isHere's answer short of asking gh, and `prcoder choose`'s
 * offer and `›` mark.
 */
export function branchOwns(p, branch, tracked) {
  if (!branch) return false;
  if (!p.isCrossRepository && p.headRefName === branch) return true;
  return samePr(tracked, p.url);
}

/**
 * The repository a plain `git push` sends `branch` to, when it goes to a
 * branch of the same name there; null when it would go nowhere, to another
 * name, or to a remote off GitHub. `byName` is repoInfo's `repoOf`.
 *
 * `%(push)` is `refs/remotes/<remote>/<branch>` exactly then, whatever put it
 * there -- an upstream with push.default simple, push.default current, a
 * pushRemote or remote.pushDefault -- and empty for a branch with no upstream
 * under simple, or one tracking another name (git 2.54.0, 2026-10-14). It is
 * empty too for a pushRemote under simple, where a real push would go to it:
 * git resolves `simple` only against the upstream. Null then, and branchPrs
 * goes by its older rule, as with no push at all. This is the branch's own
 * repository as gh reads it: `gh pr view` builds its head label from the same
 * push config.
 */
export async function pushRepo(cwd, branch, byName) {
  if (!branch) return null;
  // A pattern matches `refs/heads/<branch>/...` as well, but git will not have
  // a branch and a directory of branches by one name, so there is one line.
  const ref = (await text(['for-each-ref', '--format=%(push)', `refs/heads/${branch}`], cwd)).split('\n')[0];
  const name = Object.keys(byName).find((r) => ref === `refs/remotes/${r}/${branch}`);
  return name ? byName[name] : null;
}

/**
 * Constant for the life of the process, so worth asking once. `prefix` is
 * where in the repo prcoder -- and so the agent's PTY -- was started: '' at
 * the root, 'public/' below it. The diff header's @ names a file from there.
 *
 * `repos` is where the branch's pull request can be, in the order to prefer
 * them: gh's base repository (the first remote, `upstream` ahead of `origin`
 * when both exist), its parent when it is a fork, then every other GitHub
 * remote. A clone of a fork with only `origin` has its pull requests in a
 * repository no remote names, which is why the parent is asked for; a branch
 * pushed to a fork no remote names is found by its commit instead (branchPrs).
 * `remotes` is each repository's remote name, for the head's labels. A remote
 * added while prcoder runs shows after a restart, like everything else here.
 */
export async function repoInfo(cwd) {
  const { defaultBranchRef, nameWithOwner, parent } =
    JSON.parse(await run('gh', ['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner,parent'], { cwd }));
  const remotes = await remoteRepos(cwd);
  const repos = [...new Set([nameWithOwner, parent?.nameWithOwner, ...remotes.map((r) => r.repo)].filter(Boolean))];
  return {
    defaultBranch: defaultBranchRef.name, nameWithOwner, repos,
    // The first remote for each repository, so origin keeps its own when
    // another remote names the same one: fromEntries keeps the last.
    remotes: Object.fromEntries(remotes.toReversed().map((r) => [r.repo, r.name])),
    // And the other way round, every remote's, for where a push goes (pushRepo).
    repoOf: Object.fromEntries(remotes.map((r) => [r.name, r.repo])),
    prefix: await text(['rev-parse', '--show-prefix'], cwd),
  };
}

/**
 * `remoteHead` comes from the caller because only the PR knows it — and for a
 * fork it is not on origin at all, so `git ls-remote origin` would miss it.
 * `branch` likewise, because the caller has just asked for it, and `has` is
 * the poll's commitMemo, which may already have asked about this very commit
 * (the lookup's stranger check, server.js). HEAD is read here, with the
 * status, and not taken from the caller: the caller's was read before the
 * lookup's gh calls, and a commit made during them would pair the old head
 * with the new tree -- "in sync" with a commit not yet pushed.
 */
export async function snapshot(cwd, remoteHead, branch, has = (rev) => hasCommit(rev, cwd)) {
  // Independent reads, so they run together rather than one spawn at a time.
  const [head, dirty, known] = await Promise.all([
    headCommit(cwd),
    dirtyFiles(cwd),
    remoteHead && has(remoteHead),
  ]);

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
 * memory of the base branch on `baseRemote` -- the remote for the pull
 * request's repository, which for a fork's pull request into its parent is
 * not origin, whose `main` is the fork's; null when no remote names that
 * repository, and then there is no memory to fall back to. `...` diffs from
 * the merge base -- which is
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
export async function localPatch(cwd, { baseOid, baseRef, baseRemote, head, path, from, additions, deletions }) {
  const known = (rev) => hasCommit(rev, cwd);
  const remembered = baseRemote && `refs/remotes/${baseRemote}/${baseRef}`;
  const base = await known(baseOid) ? baseOid
    : remembered && await known(remembered) ? remembered : null;
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

/**
 * `owner/repo` of `url` when the whole of it is a pull request's URL on
 * github.com, and an error otherwise. Anchored at both ends, where parsePrUrl
 * is not: it reads URLs gh gave, and this one comes from the page, on its way
 * to gh's argv -- `--flag github.com/o/r/pull/1` and
 * `https://elsewhere.example/github.com/o/r/pull/1` both contain one.
 */
export function wholePrRepo(url) {
  const m = String(url ?? '').match(/^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/pull\/\d+$/);
  if (!m) throw new Error(`not a pull request URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

/**
 * By URL, never by number: gh resolves a bare number in its base repository,
 * and the switcher can hold a pull request from the parent of a fork, whose
 * number names a stranger there. wholePrRepo is the check that `url` is one
 * before it reaches gh's argv; which repositories it may be in is the
 * route's to say (server.js).
 *
 * Resolves `{ unfinished }` -- gh's own words -- when gh switched branches
 * and then failed. The usual cause: on a local branch that already exists, gh
 * checks it out and then `git merge --ff-only`s it onto the pull request's
 * head, which a branch with commits of its own refuses ("Not possible to
 * fast-forward"). The merge aborts cleanly, so the branch is checked out and
 * the pane's sync light says `diverged`; reconciling is for you or the agent,
 * not a reason to start nothing. Told by the branch changing, not by git's
 * words, which a translated git prints otherwise. Not `--force`: that resets
 * the local branch to the head and drops its own commits.
 *
 * But that is not the only failure after the switch -- the timeout stopping
 * the pull, the network dropping, a config write -- and this cannot tell them
 * apart without reading the words it will not read. So a caller says what gh
 * said, rather than calling every one of them a divergence, which sent
 * someone whose pull had timed out looking for commits that were not there.
 */
export async function checkoutPr(cwd, url, opts = {}) {
  wholePrRepo(url);
  // The branch before the checkout, when the caller has just read it
  // (startOnPr); '' is a detached HEAD, so only a missing key asks again.
  const before = 'before' in opts ? opts.before : await currentBranch(cwd);
  try {
    await run('gh', ['pr', 'checkout', url], { cwd, timeout: 120_000 });
    return {};
  } catch (e) {
    if (await currentBranch(cwd) === before) throw e;
    return { unfinished: e.message };
  }
}

/**
 * A worktree that git lists and whose directory is gone: its branch is held
 * until it is pruned, so neither a checkout nor a new worktree can have it.
 * Never pruned from here: the directory may be on a disk that is not mounted.
 */
const gone = (w, what) => new Error(`${what} is checked out in a worktree whose directory is gone, ${w.path};` +
  ' `git worktree prune` forgets it, and then this can make one');

/** `dir` taken by something that is not the worktree asked for: left alone, and said. */
const taken = (dir, what) => new Error(`${dir} is in the way of a worktree for ${what}: remove it, or move it aside`);

/**
 * The working copy for `prcoder --worktree <branch>`: the one `branch` is
 * already checked out in, the main one included, or a new worktree on it at
 * `dirFor(main, branch)` (worktreeDir in cli.js). Resolves `{ path, made,
 * said }`: where it is, whether this made it, and the line to print.
 *
 * A branch this clone has is checked out as it is; one only origin has
 * becomes a local branch tracking it, fetched first; one nobody has is made
 * from origin's default branch, fetched first too, tracking nothing -- or
 * from what this clone last saw of it when origin cannot be reached, which
 * the line says. Not from HEAD: a second session is usually for other work,
 * and a branch quietly built on whatever this working copy happened to be on
 * is found out at the pull request. A stacked branch is made by hand first
 * (`git branch child parent`), and then is one this clone has.
 *
 * The name is held to git's own rule, and to being a plain name: `@{-1}`
 * passes `check-ref-format --branch` by turning into the branch it stands
 * for, which is not the one written. A directory already at the path is not
 * taken over, whatever it is.
 */
export async function worktreeFor(cwd, branch, { dirFor, defaultBranch }) {
  if (await text(['check-ref-format', '--branch', branch], cwd).catch(() => null) !== branch) {
    throw new Error(`${branch} is not a name a branch can have`);
  }
  const list = await worktrees(cwd);
  const on = list.find((w) => w.branch === branch);
  if (on?.prunable) throw gone(on, branch);
  if (on) return { path: on.path, made: false, said: `${branch} is already checked out in ${on.path}, so starting there` };
  const dir = dirFor(list[0].path, branch);
  if (existsSync(dir)) throw taken(dir, branch);
  const add = (args) => run('git', ['worktree', 'add', '-q', ...args], { cwd, timeout: 120_000 });
  if (await hasCommit(`refs/heads/${branch}`, cwd)) {
    await add([dir, branch]);
    return { path: dir, made: true, said: `made a worktree for ${branch} in ${dir}` };
  }
  // origin's own answer where it can be had, and git's memory of it where
  // origin cannot be asked (undefined). One origin has is fetched, and a fetch
  // that then fails ends the run: the alternative is a new branch of a name
  // that is already somebody's.
  const fetch = (name) => git(['fetch', '-q', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`], cwd);
  const there = await remoteBranchHead(cwd, branch).catch(() => undefined);
  if (there) await fetch(branch);
  if (there || (there === undefined && await trackingHead(cwd, branch).catch(() => null))) {
    await add(['--track', '-b', branch, dir, `refs/remotes/origin/${branch}`]);
    return { path: dir, made: true, said: `made a worktree for ${branch} in ${dir}, from origin's ${branch}${there ? '' : ' as last fetched'}` };
  }
  const fresh = await fetch(defaultBranch).then(() => true, () => false);
  const base = await hasCommit(`refs/remotes/origin/${defaultBranch}`, cwd) ? `refs/remotes/origin/${defaultBranch}`
    : await hasCommit(`refs/heads/${defaultBranch}`, cwd) ? `refs/heads/${defaultBranch}` : 'HEAD';
  const from = base === 'HEAD' ? 'the commit this working copy is on'
    : `${base.startsWith('refs/remotes/') ? "origin's " : ''}${defaultBranch}${fresh || !base.startsWith('refs/remotes/') ? '' : ' as last fetched'}`;
  await add(['--no-track', '-b', branch, dir, base]);
  return { path: dir, made: true, said: `made a worktree in ${dir} on ${branch}, a new branch from ${from}` };
}

/**
 * Which of the repository's working copies (`list`, as worktrees answers)
 * is on pull request `p`'s branch, or undefined: by the branch's name for one
 * of this repository's, by its config for a fork's or a `pr-<n>` (branchOwns).
 * No gh, so a fork's checked out by something that left no mark is missed.
 */
async function worktreeOn(cwd, p, list, repos) {
  for (const w of list) {
    if (w.branch && branchOwns(p, w.branch, await trackedPr(cwd, w.branch, repos))) return w;
  }
  return undefined;
}

/**
 * The working copy for `prcoder --worktree <pr>`: the one already on pull
 * request `p`'s branch -- by the branch's name for one of this repository's,
 * by its config for a fork's or a `pr-<n>` (branchOwns) -- or the worktree at
 * its directory from an earlier run, or a new one there, on no branch yet.
 * Resolves as worktreeFor does. The checkout is not made here: startOnPr
 * makes it in the directory this answers, as it does for `prcoder <pr>`, with
 * the same refusals and the same handling of a branch gone from GitHub.
 *
 * The directory is named for the branch when the pull request is this
 * repository's, so `--worktree topic` and `--worktree 12` for the pull
 * request on topic are one worktree; a fork's is `pr-<n>`, since what gh will
 * call its local branch is gh's to decide. A new one starts detached at this
 * working copy's commit, which is only where gh's checkout starts from.
 *
 * A worktree this makes is not removed when the checkout then fails. A
 * second start may already be in it, waiting on the first's lock; and the
 * next run finds it by its directory and tries again.
 */
export async function worktreeForPr(cwd, p, { dirFor, repos }) {
  const list = await worktrees(cwd);
  const what = `#${p.number}`;
  const on = await worktreeOn(cwd, p, list, repos);
  if (on?.prunable) throw gone(on, `${what}'s branch, ${on.branch},`);
  if (on) return { path: on.path, made: false, said: `${what} is already checked out in ${on.path}, so starting there` };
  const dir = dirFor(list[0].path, p.isCrossRepository ? `pr-${p.number}` : p.headRefName);
  if (list.some((w) => w.path === dir && !w.prunable)) return { path: dir, made: false, said: `starting in the worktree at ${dir}` };
  if (existsSync(dir)) throw taken(dir, what);
  await run('git', ['worktree', 'add', '-q', '--detach', dir], { cwd, timeout: 120_000 });
  return { path: dir, made: true, said: `made a worktree for ${what} in ${dir}` };
}

/**
 * `dirty` files, as dirtyFiles lists them, on `branch`: `1 uncommitted file on
 * main`. The one wording of them, for `prcoder choose`'s line before its
 * question as for inTheWay. No branch is a detached HEAD, which currentBranch
 * answers as '' and not null: with `??` the line ended at "on ", and a
 * worktree made for a pull request starts detached.
 */
export function uncommitted(dirty, branch) {
  return `${dirty.length} uncommitted file${dirty.length > 1 ? 's' : ''} on ${branch || 'a detached HEAD'}`;
}

/**
 * The refusal of a checkout of pull request `p` over `dirty` files on
 * `branch`: startOnPr's, and `prcoder choose`'s when it asks again, so the
 * two say it the same way.
 */
export function inTheWay(p, dirty, branch) {
  const many = dirty.length > 1;
  return `#${p.number} is on ${p.headRefName}, and ${uncommitted(dirty, branch)} ${many ? 'are' : 'is'} in the way;` +
    ` commit or stash ${many ? 'them' : 'it'} first`;
}

/**
 * A start refused before it touched anything -- another prcoder in the
 * working copy, or uncommitted work -- marked `refused`, so that `prcoder
 * choose` asks again where any other failure ends the run.
 */
const refusal = (message) => Object.assign(new Error(message), { refused: true });

/**
 * Puts the working copy on pull request `p` (`url`, `number`, `headRefName`,
 * `isCrossRepository`) for a start -- `prcoder <pr>` and a `prcoder choose`
 * pick -- and for the pane's Switch. Resolves the branch it is then on, and
 * the line to say about the checkout, or null when the branch was already
 * the pull request's; `snag` is set when that line says something went
 * other than planned (gh did not finish, or the branch was gone).
 *
 * The pane shows only the checked-out branch's pull request (docs/Design.md,
 * "The pane shows what is checked out"), so a start that cannot check one out
 * is refused rather than shown beside another branch. Uncommitted work is that
 * refusal, as it is for the pane's Switch: a checkout over it is git's to
 * refuse, or worse, to carry.
 *
 * The branch is read here, never taken from the caller: it is what
 * checkoutPr's "did gh switch?" compares against, and one read before
 * `prcoder choose`'s question could be minutes old. The refusals that
 * change nothing -- the branch is in another working copy, another prcoder
 * runs in this one, or there is uncommitted work -- are thrown marked
 * `refused` (refusal), and `prcoder choose` asks again after one: it calls this for each pick rather than
 * repeating these checks, so it cannot ask again over one and end the run
 * over the other. `inUse` is asked only
 * when there is a checkout to make, and answers with why this working copy is
 * not free to move, or nothing: server.js asks whether another prcoder is
 * running in it, whose agent and sync light a checkout here would move under
 * it.
 */
export async function startOnPr(cwd, p, { inUse = async () => null } = {}) {
  const branch = await currentBranch(cwd);
  if (await isHere(cwd, p, branch)) return { branch, said: null };
  // Its branch in another working copy: git checks a branch out once, and
  // would say so in its own words after gh had fetched -- or, for a branch
  // gone from GitHub, after two failures stacked. With a prcoder to a
  // worktree that is the usual reason a Switch cannot happen, so it is said
  // first, with where the branch is and the start that goes there. Not this
  // working copy's own: isHere has just answered for that.
  const held = await worktreeOn(cwd, p, await worktrees(cwd).catch(() => []));
  if (held) {
    throw refusal(`#${p.number} is on ${held.branch}, which is checked out in another working copy, ${held.path}` +
      (held.prunable ? ', whose directory is gone: `git worktree prune` forgets it, and then it can be checked out here'
        : `; git checks a branch out in one place at a time. To work on it there: prcoder --worktree ${p.number}`));
  }
  const busy = await inUse();
  if (busy) {
    throw refusal(`#${p.number} is on ${p.headRefName}, and ${busy}; a checkout would move the working copy` +
      ` under its agent. Quit that one first, or start in a worktree of its own: prcoder --worktree ${p.number}`);
  }
  const dirty = await dirtyFiles(cwd);
  if (dirty.length) throw refusal(inTheWay(p, dirty, branch));
  let unfinished, gone;
  try {
    ({ unfinished } = await checkoutPr(cwd, p.url, { before: branch }));
  } catch (e) {
    gone = await checkoutGone(cwd, p, e);
  }
  return {
    branch: await currentBranch(cwd),
    said: `checked out ${p.isCrossRepository ? `#${p.number}` : `${p.headRefName} for #${p.number}`}` +
      (unfinished ? `, but gh did not finish: ${unfinished}` : '') + (gone ?? ''),
    // Worth a line in the log, not only in verbose: the pane's Switch says it so.
    ...((unfinished || gone) && { snag: true }),
  };
}

/**
 * The checkout gh cannot make of a pull request whose branch is gone from
 * GitHub -- deleted on merge, as most are -- made from what is left: gh
 * fetches the head branch first, and fails with `couldn't find remote ref
 * refs/heads/<name>` (gh 2.x, 2026-11-11, `prcoder 1` here). Before
 * startOnPr checked out, such a pull request was shown without one.
 *
 * GitHub's `refs/pull/<n>/head` outlives the branch, so it is fetched, and a
 * local branch of the head's name is used only when it is the pull request's:
 * checked out as it is when it has the head (local commits on top included),
 * fast-forwarded to it when it is behind. A local branch of that name with
 * history of its own -- a name reused for other work -- is left alone, and
 * the head is checked out as `pr-<n>` instead, under the same rules. Its name
 * says nothing of the pull request, so `pr-<n>` is marked as gh marks a
 * fork's checkout, tracking `refs/pull/<n>/head` (markPr), and every later
 * run reads which pull request it is from that (trackedPr): a start on it
 * again (isHere), and the pane after a plain restart. Before the mark, only
 * the run that checked it out knew, and the next refused or lost it. With no
 * branch of the head's own name, one is made at the head, with nothing to
 * track. Resolves the note startOnPr adds to its line.
 *
 * Only for a pull request from this repository's own branch: a fork's is
 * fetched from `refs/pull/<n>/head` by gh already. Told by asking the
 * repository whether the branch is there, not by gh's words: `failed` is
 * rethrown unless the answer is that it is not, so a network failure is still
 * reported as gh said it. A failure after that -- the fetch, or a branch
 * checked out in another worktree -- is reported with gh's words before it,
 * since gh's failure is what the run was refused for.
 */
async function checkoutGone(cwd, p, failed) {
  if (p.isCrossRepository) throw failed;
  const base = wholePrRepo(p.url);
  const remote = (await remoteRepos(cwd)).find((r) => r.repo.toLowerCase() === base.toLowerCase())?.name
    ?? `https://github.com/${base}.git`;
  const there = await text(['ls-remote', '--heads', remote, `refs/heads/${p.headRefName}`], cwd).catch(() => null);
  if (there !== '') throw failed;
  const gone = `; its branch is gone from GitHub`;
  try {
    // Into a ref of its own, not FETCH_HEAD: that is every fetch's, and one
    // the agent or a hook makes between the fetch and the read would put
    // the branch at a commit of something else. Deleted once read; the
    // branch made from it is what keeps the commit.
    const held = `refs/prcoder/pull/${p.number}`;
    await git(['fetch', '-q', '--no-write-fetch-head', remote, `+refs/pull/${p.number}/head:${held}`], cwd);
    const head = await text(['rev-parse', `${held}^{commit}`], cwd)
      .finally(() => git(['update-ref', '-d', held], cwd).catch((e) => debug(`${held} not deleted: ${e.message}`)));
    const contains = (a, b) => asks(['merge-base', '--is-ancestor', a, b], cwd);
    const names = [p.headRefName, `pr-${p.number}`];
    for (const name of names) {
      const ref = `refs/heads/${name}`;
      // `so it is pr-3, made from…` under another name, `so it was made from…` under its own.
      const say = (was, how) => (name === p.headRefName ? `${gone}, so it ${was} ${how}`
        : `${gone}, and ${p.headRefName} here is other work, so it is ${name}, ${how}`);
      const own = name === p.headRefName;
      // After the checkout, which is what the run is for: a mark that fails
      // costs the next run a fresh checkout, not this one its start.
      const mark = async () => {
        if (!own) await markPr(cwd, name, remote, p.number).catch((e) => debug(`${name} not marked as #${p.number}'s: ${e.message}`));
      };
      if (!await hasCommit(ref, cwd)) {
        await git(['checkout', '-q', '-b', name, head], cwd);
        await mark();
        return say('was', `made from the pull request's head, tracking ${own ? 'nothing' : `refs/pull/${p.number}/head`}`);
      }
      if (await contains(head, ref)) {
        await git(['checkout', '-q', name], cwd);
        await mark();
        return say('is', 'as this clone last had it');
      }
      // -B resets the branch, which is a fast-forward here and nothing more,
      // and fails before it moves anything, as plain checkout does.
      if (await contains(ref, head)) {
        await git(['checkout', '-q', '-B', name, head], cwd);
        await mark();
        return say('was', "brought up to the pull request's head");
      }
    }
    throw new Error(`${names.join(' and ')} here both have history the pull request's head does not`);
  } catch (e) {
    throw new Error(`${failed.message.trim()}\nIts branch is gone from GitHub, and checking out what is left failed too: ${e.message.trim()}`);
  }
}

/**
 * Marks `branch` as pull request `n`'s in `remote` (a remote's name, or the
 * repository's URL when no remote names it), the way `gh pr checkout` marks a
 * fork's: `branch.<b>.remote` and `branch.<b>.merge = refs/pull/<n>/head`,
 * which trackedPr and gh both read back. A branch that already tracks
 * something else keeps it: a `pr-<n>` of someone's own that happens to hold
 * the head is theirs, and its upstream with it.
 *
 * Harmless to the rest of prcoder: the sync light compares against the pull
 * request's head, and trackingHead and pushRepo read `origin/<name>` and
 * `%(push)`, which this leaves as they were. A plain `git push` from it is
 * refused, as it was with nothing to track; `git pull` fetches the head.
 */
async function markPr(cwd, branch, remote, n) {
  const pull = `refs/pull/${n}/head`;
  const merge = await answer(['config', '--get', `branch.${branch}.merge`], cwd);
  if (merge && merge !== pull) return;
  await git(['config', `branch.${branch}.remote`, remote], cwd);
  await git(['config', `branch.${branch}.merge`, pull], cwd);
}

/**
 * Whether `p` is the checked-out branch's pull request, so startOnPr has
 * nothing to check out. One of this repository's is here on a branch of its
 * head's name, or on the `pr-<n>` checkoutGone made for it when that name was
 * other work. A fork's head is in the fork, so its name says nothing
 * about this clone -- the fork's `main` is not this `main` -- and the branch gh
 * checked it out to may be `owner/name`, tracking `refs/pull/N/head`. That
 * config is read first (trackedPr), and answers for either kind when it is
 * there. Otherwise, for a fork's, gh is asked which pull request this branch
 * is (branchPrUrl): a network round trip, paid only on a fork's pull request.
 * A failure there is taken as no, and the checkout goes ahead.
 */
export async function isHere(cwd, p, branch) {
  if (!branch) return false;
  // A `pr-<n>` checkoutGone made, or a fork's checked out by gh: the branch's
  // config says which, with no network, and gh would read the same pair.
  const tracked = await trackedPr(cwd, branch);
  if (branchOwns(p, branch, tracked)) return true;
  if (tracked) return false;
  if (!p.isCrossRepository) return false;
  const url = await branchPrUrl(cwd).catch((e) => (debug(`gh could not say which pull request ${branch} is: ${e.message}`), null));
  return samePr(url, p.url);
}

export const pushBranch = (cwd) => git(['push', '-u', 'origin', 'HEAD'], cwd);
