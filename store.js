// The queue's storage: `.prcoder/queue.json`, a directory that ignores itself.
//
// It lives here rather than in the user's repo files because a tool's working
// state should not be one of the user's artifacts. FUTURE.md was tracked and
// the PR description is public, so every tick of a checkbox wrote something the
// user owns — and git.js had to hide FUTURE.md from the dirty-file list to stop
// the branch switcher disabling itself permanently. This is the fix for that
// whole class of problem.
//
// One file, one flat array, every item visible whatever is checked out. It was
// scoped per branch for a while, because a checkout used to swap FUTURE.md and
// an ignored directory does not swap. That turned out to hide items rather than
// organise them: moving to an unrelated branch mid-task took the list away, and
// merging a branch put its unfinished items permanently out of reach. Issue #48
// is where a better answer would go if one is wanted.

import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = '.prcoder';
const FILE = 'queue.json';
const PORT_FILE = 'port.json';

// Bump only when an existing field changes meaning. Adding a field does not
// need one: reads fill in what is missing, so an older prcoder skips a field it
// does not know rather than failing on it.
export const VERSION = 1;

const dir = (repo) => path.join(repo, DIR);
const file = (repo) => path.join(dir(repo), FILE);
const portFile = (repo) => path.join(dir(repo), PORT_FILE);

const EMPTY = { version: VERSION, items: [] };

/**
 * Every field, coerced. The client PUTs back the array it was handed, which
 * decorate() has added a derived `issueUrl` to — so this constructs rather than
 * spreads, and a `branch` left on an item by an older prcoder is dropped here.
 * The markdown writer dropped unknown fields for free; JSON would keep them.
 */
export const pick = (i) => ({
  text: String(i?.text ?? ''),
  done: !!i?.done,
  inPr: !!i?.inPr,
  issue: Number.isInteger(i?.issue) ? i.issue : null,
  deleted: !!i?.deleted,
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
    store: { version: VERSION, items: parsed.items.map(pick) },
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

/**
 * `.prcoder/port.json`: the port this working copy listens on.
 *
 * The seed is a hash of the path (`portFor` in server.js), but the answer lives
 * here, so the URL is a property of the directory rather than a sum anyone
 * wanting it has to recompute. Renaming the directory keeps the bookmark;
 * editing this file pins a port for good, where PRCODER_PORT pins one run.
 *
 * The path is deliberately not recorded alongside it. Copying a working copy
 * wholesale carries this file, and both copies then want one port -- but such a
 * copy carries queue.json too, which is the larger surprise, and the collision
 * announces itself on the block. Recording the path would trade that for losing
 * the port on the rename this file exists to survive.
 */
const PORT_MIN = 1024;
const PORT_MAX = 65535;

/**
 * The recorded port, or null. Anything else on disk -- missing, truncated, a
 * hand-edit that is not a port -- reads as null and the caller derives one, the
 * same way normalise() reads damaged bytes as an empty queue rather than
 * throwing at startup.
 */
export async function readPort(repo) {
  const raw = await fs.readFile(portFile(repo), 'utf8').catch(() => '');
  let port;
  try { port = JSON.parse(raw)?.port; } catch { return null; }
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) return null;
  return port;
}

/** Written like the queue: temp file, then a rename, which is atomic in one directory. */
export async function writePort(repo, port) {
  await fs.mkdir(dir(repo), { recursive: true });
  await writeIgnore(repo);

  const target = portFile(repo);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: VERSION, port }, null, 2)}\n`);
  await fs.rename(tmp, target);
}

/** The whole list replaced, coerced on the way in. */
export const replaceItems = (store, items) => ({ ...store, items: items.map(pick) });
