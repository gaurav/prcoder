// The queue's server side: read it, write it, and say what changed.
//
// The queue is yours and lives only in `.prcoder/queue.json` (store.js). This
// file's imports are the evidence: nothing here reaches GitHub or git, and
// test/queue-local.test.js checks the routes that call it the same way, from
// outside.

import { readStore, writeStore, replaceItems } from './store.js';
import * as term from './term.js';

/** Item text, cut to something a status line can hold. */
export const quote = (t) => `'${t.length > 48 ? `${t.slice(0, 47)}…` : t}'`;

/**
 * What changed in the queue, said out loud. Matched on text because that is the
 * only identity an item has -- so an edit reads as a delete and an add, which
 * is honest: nothing here can tell those apart either (see the ponytail note on
 * writeQueue).
 *
 * Returns the lines rather than printing them, which is the only reason the
 * transitions below can be checked without a terminal.
 */
export function queueChanges(was, now) {
  const before = new Map(was.map((i) => [i.text, i]));
  const lines = [];
  for (const i of now) {
    const p = before.get(i.text);
    if (!p) lines.push(`queued ${quote(i.text)}`);
    else if (p.done !== i.done) lines.push(`${i.done ? 'ticked' : 'unticked'} ${quote(i.text)}`);
    else if (p.deleted !== i.deleted) lines.push(`${i.deleted ? 'deleted' : 'restored'} ${quote(i.text)}`);
  }
  for (const i of was) {
    if (!now.some((n) => n.text === i.text)) lines.push(`dropped ${quote(i.text)}`);
  }
  return lines;
}

/**
 * Every item, as stored, with the link to its issue derived. Moving an item out
 * is a separate, one-way route (moveOut in server.js), not a flag this list
 * keeps in step with anything.
 */
export const readQueue = async (repo, nameWithOwner) =>
  decorate((await readStore(repo)).store.items, nameWithOwner);

/**
 * ponytail: last write wins. The store is re-read on every poll so an outside
 * edit is picked up, but two tabs racing means the slower one loses what it
 * never saw. Fixing that needs item identity — text is not it, since an edit is
 * indistinguishable from a delete plus an add — so if a lost item is ever
 * actually observed, give pick() a crypto.randomUUID() and union by id.
 */
export async function writeQueue(repo, items, nameWithOwner) {
  // The shape is the contract, and it has changed twice: the route took a bare
  // array, then `{items, branch}`, and now `{items}` again. A client that
  // missed a change -- an old tab, a curl copied from somewhere -- used to send
  // something this function then indexed into, and the TypeError said nothing
  // about what to send instead. Checked here rather than at the route, because
  // every write goes through this function.
  if (!Array.isArray(items)) {
    throw new Error('the queue must be sent as {items}');
  }
  const { store, stale } = await readStore(repo);
  for (const line of queueChanges(store.items, items)) term.verbose(line);
  // What was stored, not what was sent: replaceItems stamps `doneAt` and
  // `deletedAt`, and a client handed back the unstamped list sends it again on
  // its next write, where every item done or deleted since the last poll gets
  // stamped a second time -- all with that write's time, so the Deleted tab's
  // most-recent-first order collapses into a tie.
  const next = replaceItems(store, items);
  await writeStore(repo, next, { stale });
  return decorate(next.items, nameWithOwner);
}

/**
 * The store keeps only the issue number; the link is derived. From
 * nameWithOwner rather than the PR's URL, because that is the repo createIssue
 * actually files into — with a pinned foreign PR the two differ — and because
 * a queue that now works with no PR loaded would otherwise render dead links.
 */
function decorate(items, nameWithOwner) {
  return items.map((i) => ({ ...i, issueUrl: issueUrl(i, nameWithOwner) }));
}

/**
 * The link to a stored item's issue or PR, or null. An item about another
 * repo's carries that repo, and needs no answer from `gh repo view` to link to
 * it. Give it an item that has been through pick(), which is what holds `repo`
 * to characters that are safe in an href.
 */
export function issueUrl(i, nameWithOwner) {
  const where = i.repo ?? nameWithOwner;
  return i.issue && where ? `https://github.com/${where}/${i.kind === 'pull' ? 'pull' : 'issues'}/${i.issue}` : null;
}
