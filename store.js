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
const VERSION = 1;

const dir = (repo) => path.join(repo, DIR);
const file = (repo) => queueFile ?? path.join(dir(repo), FILE);

/**
 * A queue file of the caller's choosing, in place of `.prcoder/queue.json`:
 * `--queue` or PRCODER_QUEUE, set once by server.js's main. What it is for is
 * tools/browser.mjs, which drives the queue pane against a file in `data/` and
 * so never writes the queue of the working copy it runs in (#65). Resolved
 * against the directory prcoder started in. Only the queue moves; port.json
 * prs.json and pulls.json stay in `.prcoder/`, and so does the `.gitignore` -- a file named here is
 * wherever you put it, ignored or not.
 */
let queueFile = null;
export const useQueueFile = (p) => { queueFile = p ? path.resolve(p) : null; };
/** The file named with useQueueFile, or null for the repo's own. */
export const movedQueue = () => queueFile;
const portFile = (repo) => path.join(dir(repo), PORT_FILE);

const EMPTY = { version: VERSION, items: [] };

// GitHub's own characters for `owner/name`, since a repo ends up in an href.
const REPO = /^[\w.-]+\/[\w.-]+$/;
const LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d{0,9})$/;

/** What an item's link on disk says: the number, the repo and, for a pull
 *  request, the kind. Null for anything else, a hand-edit included. */
function link(u) {
  const m = typeof u === 'string' ? LINK.exec(u) : null;
  return m ? { issue: Number(m[3]), repo: m[1], kind: m[2] === 'pull' ? 'pull' : null } : null;
}

/**
 * The link to an item's issue or PR, or null. An item about another repo's
 * carries that repo, and needs no answer from `gh repo view` to link to it;
 * one about this repo's needs `home`, its `owner/name`. Give it an item that
 * has been through pick(), which is what holds `repo` to characters that are
 * safe in an href.
 */
export function issueUrl(i, home) {
  const where = i.repo ?? home;
  return i.issue && where ? `https://github.com/${where}/${i.kind === 'pull' ? 'pull' : 'issues'}/${i.issue}` : null;
}

/**
 * An item as it is written. `issue` is the link, which says which repo and
 * whether it is a pull request, so `repo` and `kind` are not written beside
 * it. A bare number is what files from before the link hold, and pick() reads
 * it as an issue in this repo; it is also what is written for one when `home`
 * is not known yet, the one time there is no link to write.
 *
 * The link is also why VERSION stayed at 1 when `issue` stopped meaning only
 * this repo's. An older prcoder reads a link as no issue at all: it keeps the
 * item and loses its tag, where a number beside a `repo` it does not know would
 * have linked to this repo's issue of that number.
 */
export const toDisk = ({ repo, kind, ...i }, home) =>
  ({ ...i, issue: issueUrl({ ...i, repo, kind }, home) ?? i.issue });

/**
 * Every field, coerced. The client PUTs back the array it was handed, which
 * decorate() in queue.js has added a derived `issueUrl` to — so this
 * constructs rather than spreads. The markdown writer dropped unknown fields
 * for free; JSON would keep them.
 *
 * Constructing is also the whole migration from older prcoders. A `branch` from
 * the per-branch queue goes, and so do `inPr` and `pr` from the description
 * mirror: an item that was mirrored stays in the queue as an ordinary one,
 * because a duplicate of a line already in the description is something you can
 * delete, and an item dropped on the word of a block nobody re-read is not.
 */
export const pick = (i) => ({
  text: String(i?.text ?? ''),
  done: !!i?.done,
  // The number of the issue or pull request this item is about, if any: one
  // pulled in from the Issues tab, or typed in as a reference (refs() in
  // public/tasks.js). On disk it is the link instead (toDisk), read back here.
  issue: Number.isInteger(i?.issue) ? i.issue : link(i?.issue)?.issue ?? null,
  // Where that is, as `owner/name`, when it is not the repo prcoder is in --
  // null means this one, which is every item from before the field existed.
  // Held to GitHub's own characters, since it ends up in a link's href. A link
  // read from disk always names a repo, this one included; decorate() in
  // queue.js knows which repo that is, and folds it back to null.
  repo: Number.isInteger(i?.issue) && REPO.test(i?.repo ?? '') ? i.repo : link(i?.issue)?.repo ?? null,
  // `issue` or `pull`, so the link goes straight to a pull request's page.
  // Null when nobody asked GitHub, and /issues/N is the link: GitHub
  // redirects it to the pull request when that is what N is. Read back from
  // that link, `issue` is null too, since the two link the same way.
  kind: Number.isInteger(i?.issue) && ['issue', 'pull'].includes(i?.kind) ? i.kind : link(i?.issue)?.kind ?? null,
  // A tombstone, so nothing typed disappears without the Deleted tab to get it
  // back from.
  deleted: !!i?.deleted,
  // When it was ticked, for the Completed tab's order. Meaningless once it is
  // not done, so an untick clears it and a re-tick is stamped afresh.
  doneAt: i?.done && Number.isFinite(i?.doneAt) ? i.doneAt : null,
  // When it was deleted, for the Deleted tab's order, on the same terms.
  deletedAt: i?.deleted && Number.isFinite(i?.deletedAt) ? i.deletedAt : null,
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
 *
 * `home` is this repo's `owner/name`, for the links toDisk writes.
 */
export async function writeStore(repo, store, { stale = false, home } = {}) {
  if (stale) await fs.rename(file(repo), `${file(repo)}.bak`).catch(() => {});
  await writeJson(repo, file(repo), { ...store, items: store.items.map((i) => toDisk(i, home)), version: VERSION });
}

/** The temp-then-rename write above, for every file in the directory -- and
 *  for a --queue file outside it, which gets its directory but no .gitignore. */
async function writeJson(repo, target, obj) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (path.dirname(target) === dir(repo)) await writeIgnore(repo);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`);
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
export const writePort = (repo, port) => writeJson(repo, portFile(repo), { version: VERSION, port });

/**
 * `.prcoder/prs.json`: each branch's pull requests as the last lookup by name
 * found them, and when it ran, so a poll can read them by URL instead of
 * searching again (lookupPrs in github.js has the rules). Per working copy, as
 * the queue is, so two worktrees on different branches each keep their own;
 * and a cache, so a file it cannot read -- damaged, hand-edited, a newer
 * prcoder's -- is read as empty and overwritten, which costs one search.
 *
 * `{ version, branches: { <branch>: { searched, prs: [{ url, repo, state, unread? }] } } }`,
 * `searched` an ISO time, and `unread` the time a read of that pull request
 * first failed, for one that has failed since. Only a branch with some are kept: one with none is
 * searched on every poll, as it was before this file, since that is the branch
 * a new one is opened from.
 */
const PRS_FILE = 'prs.json';
const prsFile = (repo) => path.join(dir(repo), PRS_FILE);

// A branch not looked at for this long is dropped on the next write, so the
// file does not keep every branch the working copy has ever had. Coming back
// to one costs a search, which is what it cost before this file.
const FORGET = 30 * 24 * 60 * 60_000;

const STATES = ['OPEN', 'CLOSED', 'MERGED'];

/**
 * One branch's entry, or null for anything that is not one. Each URL is held
 * to the whole of a pull request's link, in `repo`, because the URL becomes an
 * argument to `gh pr view` and `repo` is what is compared with the
 * repositories the caller trusts: a hand-edit may not put a flag in the URL,
 * nor pair a trusted `repo` with a URL somewhere else (docs/Security.md). A
 * search only ever records a pull request under the repository it is in. The
 * two are compared case-blind, as GitHub names them: `repo` is spelled as a
 * remote's URL spells it, and the link as GitHub does.
 */
function prsEntry(e) {
  const searched = Date.parse(e?.searched);
  if (!Number.isFinite(searched) || !Array.isArray(e?.prs)) return null;
  const prs = e.prs.filter((p) => {
    const l = link(p?.url);
    return l?.kind === 'pull' && typeof p.repo === 'string' && l.repo.toLowerCase() === p.repo.toLowerCase()
      && STATES.includes(p.state);
  }).map(({ url, repo, state, unread }) => {
    const since = Date.parse(unread);
    return { url, repo, state, ...(Number.isFinite(since) && { unread: since }) };
  });
  return prs.length ? { searched, prs } : null;
}

/**
 * Every branch's entry, by name, with whatever could not be read left out. A
 * Map, since a branch's name is anything git allows: on a plain object a
 * branch called `constructor` reads back a function, and one called
 * `__proto__` is never stored at all.
 */
async function readAllPrs(repo) {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(prsFile(repo), 'utf8')); } catch { return new Map(); }
  if (Number(parsed?.version) > VERSION || !parsed?.branches || typeof parsed.branches !== 'object') return new Map();
  return new Map(Object.entries(parsed.branches)
    .map(([b, e]) => [b, prsEntry(e)]).filter(([, e]) => e));
}

/** The branch's entry, `{ searched, prs }` with `searched` in ms, or null. */
export const readPrs = async (repo, branch) => (branch && (await readAllPrs(repo)).get(branch)) || null;

/**
 * The branch's entry replaced, or removed with null, and every branch not
 * searched within FORGET dropped. A read, a change and a write: callers hold
 * server.js's lock, so two of these do not interleave. A search in the future
 * -- a clock set back, a file from another machine -- is written as now, so
 * it is forgotten a FORGET from now rather than from then; and so is a failed
 * read in the future, for lookupPrs's UNREAD_FOR.
 */
export async function writePrs(repo, branch, entry, now = Date.now()) {
  const all = await readAllPrs(repo);
  if (entry?.prs.length) all.set(branch, entry);
  else all.delete(branch);
  const branches = Object.fromEntries([...all]
    .map(([b, e]) => [b, { ...e, searched: Math.min(e.searched, now) }])
    .filter(([, e]) => now - e.searched < FORGET)
    .map(([b, e]) => [b, { searched: new Date(e.searched).toISOString(), prs: e.prs.map((p) => (p.unread
      ? { ...p, unread: new Date(Math.min(p.unread, now)).toISOString() } : p)) }]));
  await writeJson(repo, prsFile(repo), { version: VERSION, branches });
}

/**
 * `.prcoder/pulls.json`: the repository's open pull requests and milestones as
 * the queue's Pull requests tab last read them (repoPulls in github.js), and
 * when. The read takes seconds on a repository with many open -- the figure is
 * in docs/Verifying.md -- so the tab opens from this file at once and reads
 * GitHub behind it. One repository's list, named in the file, so a working copy
 * whose pull requests are now looked for elsewhere (a fork's, a renamed one's)
 * reads GitHub rather than opening on the old list. A cache, as prs.json is:
 * a file that cannot be read -- damaged, hand-edited, a newer prcoder's -- is
 * read as none, which costs one read of GitHub.
 *
 * `{ version, nameWithOwner, read, milestones, pulls, total, listed }`, `read`
 * an ISO time, the rest as repoPulls answers. Two values from a row reach gh:
 * a pull request's number and a milestone's title, through /api/pull/milestone's
 * hold on the listing the tab was shown (pullMove in server.js) -- and a hand-edit
 * can put anything in a row. So a pull request is kept only with an integer number
 * and a URL that is the whole of a pull request link in this repository, compared
 * case-blind as prsEntry compares, and a milestone only with an integer number and
 * a string title. The rest of a row is drawn as text, or rendered through the
 * description's allowlist (docs/Security.md).
 */
const PULLS_FILE = 'pulls.json';
const pullsFile = (repo) => path.join(dir(repo), PULLS_FILE);

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The listing as read from disk, or null for anything that is not this repository's. */
function pullsEntry(parsed, nameWithOwner) {
  if (!parsed || Number(parsed.version) > VERSION || !sameRepo(parsed.nameWithOwner, nameWithOwner)) return null;
  const read = Date.parse(parsed.read);
  if (!Number.isFinite(read) || !Array.isArray(parsed.pulls) || !Array.isArray(parsed.milestones)) return null;
  const pulls = parsed.pulls.filter((p) => {
    const l = link(p?.url);
    return Number.isInteger(p.number) && l?.kind === 'pull' && l.issue === p.number && sameRepo(l.repo, nameWithOwner);
  });
  const milestones = parsed.milestones.filter((m) => m && Number.isInteger(m.number) && typeof m.title === 'string' && m.title);
  const total = Number.isInteger(parsed.total) ? parsed.total : pulls.length;
  return { read, milestones, pulls, total, listed: pulls.length };
}

/** The last listing written for `nameWithOwner`, `read` in ms, or null. */
export async function readPulls(repo, nameWithOwner) {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(pullsFile(repo), 'utf8')); } catch { return null; }
  return pullsEntry(parsed, nameWithOwner);
}

/** The listing replaced whole, stamped with when it was read. Not under the server's lock: a temp file and a rename, so a reader sees the old file or the new. */
export const writePulls = (repo, nameWithOwner, listing, now = Date.now()) =>
  writeJson(repo, pullsFile(repo), { version: VERSION, nameWithOwner, ...listing, read: new Date(now).toISOString() });

/**
 * The whole list replaced, coerced on the way in -- and where `doneAt` and
 * `deletedAt` are stamped, because every write passes through here. An item
 * arriving done (or deleted) with no time has just been ticked (or deleted);
 * one already so carries the time it was handed back. That needs no item
 * identity, which the queue does not have. Items from before either field
 * existed are stamped by the first write, together, and so sit below anything
 * done or deleted after it.
 */
export const replaceItems = (store, items, now = Date.now()) => ({
  ...store,
  items: items.map(pick).map((i) => ({
    ...i,
    doneAt: i.done && i.doneAt == null ? now : i.doneAt,
    deletedAt: i.deleted && i.deletedAt == null ? now : i.deletedAt,
  })),
});
