// Where the local repo actually is. Nothing here is cached: every fact is one
// cheap `git` call away, and a cache is just a thing that can disagree with the
// working tree. The one exception is repoInfo(), which asks GitHub for facts
// that cannot change while the process runs.

import { run, parsePrUrl } from './github.js';

// GIT_TERMINAL_PROMPT=0 turns a credential prompt into an error. Without it a
// push over SSH with a passphrase waits on a tty that does not exist, and with
// the serial chain in server.js that hangs every route behind it.
const git = (args, cwd) => run('git', args, {
  cwd,
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});

/** Exit status only. `ok` is the answer; anything else is a real failure. */
async function asks(args, cwd, ok = 1) {
  try {
    await git(args, cwd);
    return true;
  } catch (e) {
    // execFile reports a spawn failure as a string code (ENOENT), an exit as a
    // number. Only the expected number is an answer.
    if (e.code === ok) return false;
    throw e;
  }
}

const text = async (args, cwd) => (await git(args, cwd)).trim();

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

/** GitHub's "open a PR for this branch" page. */
export const compareUrl = (nameWithOwner, base, branch) =>
  `https://github.com/${nameWithOwner}/compare/${base}...${branch}?expand=1`;

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
 */
export async function snapshot(cwd, remoteHead = null) {
  // Empty on a detached HEAD, which happens mid-rebase and mid-bisect. `gh pr
  // view` fails there in a way loadPr does not recognise, so callers skip it.
  const branch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).catch(() => '');
  const head = await text(['rev-parse', 'HEAD'], cwd);

  // FUTURE.md is prcoder's own scratch file and is dirty during normal use;
  // untracked files never block a checkout. Neither is the user's work.
  // Porcelain v1 is `XY path`, and the status letters matter, so no trimming.
  const status = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(3))
    .filter((f) => f !== 'FUTURE.md');

  let sync = 'unpushed';
  let ahead = 0;
  if (remoteHead) {
    const known = await asks(['rev-parse', '--verify', '--quiet', `${remoteHead}^{commit}`], cwd);
    // 128 rather than 1 when the commit is unknown, so only ask once we have it.
    const isAncestor = known && await asks(['merge-base', '--is-ancestor', remoteHead, 'HEAD'], cwd);
    sync = syncState({ head, remoteHead, remoteKnownLocally: known, remoteIsAncestor: isAncestor });
    if (sync === 'ahead') ahead = Number(await text(['rev-list', '--count', `${remoteHead}..HEAD`], cwd));
  }

  return { branch, head, detached: !branch, dirty: dirty.length > 0, dirtyFiles: dirty, sync, ahead };
}

/**
 * The remote head when no PR carries it — the only case is a branch with no
 * pull request, where `ls-remote` is the whole answer. A fork PR would need
 * headRefOid instead, since its branch is not on origin at all.
 */
export async function remoteBranchHead(cwd, branch) {
  if (!branch) return null;
  const out = await git(['ls-remote', '--heads', 'origin', branch], cwd).catch(() => '');
  return out.trim().split(/\s/)[0] || null;
}

export const checkoutPr = (cwd, number) =>
  run('gh', ['pr', 'checkout', String(number)], { cwd, timeout: 120_000 });

export const pushBranch = (cwd) => git(['push', '-u', 'origin', 'HEAD'], cwd);
