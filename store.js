// The queue's storage: `.prcoder/queue.json`, a directory that ignores itself.
//
// It lives here rather than in the user's repo files because a tool's working
// state should not be one of the user's artifacts. FUTURE.md was tracked and
// the PR description is public, so every tick of a checkbox wrote something the
// user owns — and git.js had to hide FUTURE.md from the dirty-file list to stop
// the branch switcher disabling itself permanently. This is the fix for that
// whole class of problem.
//
// One file holds every branch's items in one flat array, each tagged with the
// branch it belongs to. The queue reads as per-branch because a checkout used
// to swap FUTURE.md; an ignored directory does not swap, so the scoping has to
// be written down.

import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = '.prcoder';
const FILE = 'queue.json';

// Bump only when an existing field changes meaning. Adding a field does not
// need one: reads fill in what is missing, so an older prcoder skips a field it
// does not know rather than failing on it.
export const VERSION = 1;

const dir = (repo) => path.join(repo, DIR);
const file = (repo) => path.join(dir(repo), FILE);

const EMPTY = { version: VERSION, items: [] };

/**
 * Every field, coerced. The client PUTs back the array it was handed, which
 * decorate() has added a derived `issueUrl` to and which carries a `branch`
 * that may be a checkout out of date — so this constructs rather than spreads.
 * The markdown writer dropped unknown fields for free; JSON would keep them.
 */
export const pick = (branch) => (i) => ({
  text: String(i?.text ?? ''),
  done: !!i?.done,
  inPr: !!i?.inPr,
  issue: Number.isInteger(i?.issue) ? i.issue : null,
  deleted: !!i?.deleted,
  branch,
});

/**
 * What we can make of whatever was on disk. Anything unreadable — an unknown
 * version, a truncated write, a stray character — reads as empty rather than
 * throwing, and `stale` tells the caller the bytes are worth keeping: the first
 * write moves them aside instead of overwriting them.
 *
 * Reading is not the moment to touch the user's disk. Opening the app should
 * not rename their files; the rename waits for a write that was going to
 * replace those bytes anyway.
 */
export function normalise(raw) {
  if (raw === '') return { store: EMPTY, stale: false };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { store: EMPTY, stale: true }; }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    return { store: EMPTY, stale: true };
  }
  // A file from a newer prcoder: read nothing rather than guess at a shape we
  // do not know, and keep the bytes so the newer one still has its queue.
  if (Number(parsed.version) > VERSION) return { store: EMPTY, stale: true };

  return {
    store: { version: VERSION, items: parsed.items.map((i) => pick(String(i?.branch ?? ''))(i)) },
    stale: false,
  };
}

/** The store, plus whether the bytes behind it need moving aside on write. */
export async function readStore(repo) {
  const raw = await fs.readFile(file(repo), 'utf8').catch(() => '');
  return normalise(raw);
}

/**
 * Written through a temp file and renamed, so a crash mid-write cannot leave a
 * half-written queue — rename within one directory is atomic. Not durable: no
 * fsync, so a power cut can still lose the last write.
 *
 * The pid in the temp name matters. With a fixed one, two prcoder processes on
 * the same clone can interleave and rename each other's bytes into place, which
 * is worse than not doing this at all.
 */
export async function writeStore(repo, store, { stale = false } = {}) {
  await fs.mkdir(dir(repo), { recursive: true });
  await writeIgnore(repo);

  const target = file(repo);
  if (stale) await fs.rename(target, `${target}.bak`).catch(() => {});

  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ ...store, version: VERSION }, null, 2)}\n`);
  await fs.rename(tmp, target);
}

/**
 * `*` ignores the directory's contents and this file with them, so the repo's
 * own .gitignore needs no entry and a user who never opens the directory never
 * learns it is there. Written only if absent: a hand-written one is theirs.
 */
async function writeIgnore(repo) {
  await fs.writeFile(path.join(dir(repo), '.gitignore'), '*\n', { flag: 'wx' })
    .catch((e) => { if (e.code !== 'EEXIST') throw e; });
}

/** '@{' is invalid in a ref name, so the detached bucket cannot collide. */
export const branchKey = (branch) => branch || '@{detached}';

export const forBranch = (store, branch) =>
  store.items.filter((i) => i.branch === branchKey(branch));

/**
 * The first item that belongs to a branch other than this one, if any.
 *
 * A tab can be up to a poll out of date, and Claude switches branches in the
 * terminal pane constantly. Without this, that tab's next write stamps the old
 * branch's items with the new branch and overwrites the new branch's slice
 * wholesale. Items typed since the last load carry no branch at all, so adding
 * to the queue still works while the tab catches up.
 */
export const staleBranch = (items, branch) =>
  items.find((i) => i.branch && i.branch !== branchKey(branch));

/** This branch's items replaced, every other branch's left exactly as they were. */
export const replaceBranch = (store, branch, items) => ({
  ...store,
  items: [
    ...store.items.filter((i) => i.branch !== branchKey(branch)),
    ...items.map(pick(branchKey(branch))),
  ],
});
