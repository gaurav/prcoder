// `prcoder choose`: the repository's open pull requests, by stack, and one
// picked to check out and start on.
//
// The Pull requests tab's listing (repoPulls) in that tab's by-stack order
// (stackOrder), printed into the scrollback, then one question. Nothing is
// drawn in place and no key is read raw: the list is worth reading back after
// the pick, and a number typed at a prompt works in any terminal. The pane's
// Switch is the same checkout once prcoder is up; this is for picking before
// a browser tab opens on the wrong pull request.
//
// chooseLines is pure, so test/choose.test.js reads it without gh; choosePr is
// the gh, git and readline around it, run from server.js before term.init().

import readline from 'node:readline/promises';
import { stackOrder, stackUnder } from './public/pr.js';
import { sortPulls, rootsInOrder, pullWord, sizeChip, age } from './public/items.js';
import { repoPulls, branchPrUrl } from './github.js';
import { readPulls, writePulls } from './store.js';
import { currentBranch, checkoutPr, dirtyFiles, branchesBelow } from './git.js';
import { styled, clip, span, debug } from './term.js';

// A listing younger than this is printed as it is, as the Pull requests tab
// opens from one (POST /api/pulls); older, GitHub is asked first, since the
// read takes seconds only where there are many open.
export const FRESH_FOR = 60_000;

// The tab's bands and colours: green at the small end, since a small one is
// usually the next to take, red at the large.
const SIZE_STYLE = { XS: 'green', S: 'green', M: 'yellow', L: 'yellow', XL: 'red', XXL: 'red' };
// The tab's colour for each state word, by the class pullWord (public/items.js)
// gives it and the tab's stylesheet colours (`.pr-merge.<cls>` in
// public/style.css): green, the accent, red, and yellow for its --warn. A
// class not here -- draft, checking -- is dim, as the tab's default is.
const STATE_STYLE = { ready: 'green', stacked: 'cyan', conflicts: 'red', 'checks-not-passing': 'red', 'behind-base': 'yellow', blocked: 'yellow' };

/**
 * What a root is built on when that is not the default branch, as the tab's
 * row says it: `on fixture-base › main`, nearest first, down to the default
 * branch where git has said (`below`), and as far as it goes where it has
 * not. Nothing at a depth, since the indent says it, and nothing on main.
 */
const builtOn = (under, depth) => (!depth && under.nodes.length
  ? ` on ${[...under.nodes.slice().reverse().map((n) => (n.pr ? `#${n.pr.number}` : n.branch)), ...(under.into ? [under.into] : [])].join(' › ')}`
  : '');

/**
 * What `prcoder choose` prints and offers, from a listing as readPulls or
 * repoPulls has it: `{ lines, rows, pick }`. `lines` are term.js lines
 * (styled() renders them); `rows` is stackOrder over the pull requests with
 * its stacks in their roots' order (rootsInOrder, as the tab's by-stack view
 * puts them), most recently updated first among roots and among siblings,
 * each followed by what is built on it a step further in. stackOrder alone
 * groups the roots base by base, so an older root on main came before a newer
 * one on another base. `pick` is the row Enter takes, the deepest one and the
 * most recently updated of those, since the deepest is usually where the last
 * session was -- not the first of them in the walk, which is the one under
 * the newest root and can be days staler than another. Null with nothing open.
 *
 * A row is the number, the size (sizeChip, coloured by band), the state in a
 * word, how long since it last moved, and the title -- last, so a narrow
 * terminal (`width`) cuts the title's tail and nothing else. A root whose
 * base is not the default branch says what it is built on after the title,
 * dim, and the title gives way to it (builtOn); `below` is git's word on
 * such bare branches, as branchesBelow gives it and the tab's rows take it.
 * `›` marks the one on the checked-out branch, as the tab marks it `here`.
 * Widths are terminal columns (span in term.js), the measure styled() cuts
 * by, so a wide character in a base branch's name cuts the title, not the
 * note after it.
 */
export function chooseLines(listing, { nameWithOwner, branch, defaultBranch, below = [], now = Date.now(), width = Infinity } = {}) {
  const sorted = sortPulls(listing.pulls ?? [], 'updated');
  const rows = rootsInOrder(stackOrder(sorted), sorted);
  const here = (p) => !p.isCrossRepository && p.headRefName === branch;
  const read = listing.read ? `, read ${age(new Date(listing.read).toISOString(), now)}` : '';
  const lines = [
    `Open pull requests in ${nameWithOwner}, by stack, most recently updated first${read}:`,
    listing.listed < listing.total && `The ${listing.listed} most recently updated of ${listing.total}.`,
    '',
  ].filter((l) => l !== false);
  if (!rows.length) return { lines: [...lines, 'none'], rows, pick: null };
  // Column widths from the rows, so the title starts in one column whatever
  // the indent; a number cut to fit would be a wrong number that looks right.
  const number = ({ pr, depth }) => `${'  '.repeat(depth)}#${pr.number}`;
  const wide = (f) => Math.max(...rows.map((r) => f(r).length));
  const numbers = wide(number);
  const unders = new Map(rows.map(({ pr }) => [pr.number, stackUnder({ pr }, listing.pulls, below, defaultBranch)]));
  const states = wide(({ pr }) => pullWord(pr, unders.get(pr.number)).word ?? '');
  const ages = wide(({ pr }) => age(pr.updatedAt, now));
  for (const r of rows) {
    const { pr: p, depth } = r;
    const size = sizeChip(p.lines);
    const under = unders.get(p.number);
    const { word, cls } = pullWord(p, under);
    const state = word ?? '';
    const base = builtOn(under, depth);
    const head = [
      here(p) ? { text: '›', style: ['bold', 'cyan'] } : ' ',
      ' ',
      { text: number(r).padEnd(numbers), style: 'bold' },
      '  ',
      { text: size.padEnd(3), style: SIZE_STYLE[size] },
      '  ',
      { text: state.padEnd(states), style: STATE_STYLE[cls] ?? 'dim' },
      '  ',
      { text: age(p.updatedAt, now).padEnd(ages), style: 'dim' },
      '  ',
    ];
    const room = width - head.reduce((n, seg) => n + span(seg.text ?? seg), 0) - span(base);
    lines.push([...head, clip(p.title, Math.max(room, 0)), { text: base, style: 'dim' }]);
  }
  const newer = (a, b) => Date.parse(a.pr.updatedAt) > Date.parse(b.pr.updatedAt);
  const pick = rows.reduce((best, r) => (r.depth > best.depth || (r.depth === best.depth && newer(r, best)) ? r : best), rows[0]);
  return { lines, rows, pick };
}

/**
 * GitHub's listing of the open pull requests (repoPulls), with `read` in ms,
 * written to `.prcoder/pulls.json` so the next reader can open from it. The
 * one way the listing is read fresh: the Pull requests tab's (freshPulls in
 * server.js) and `prcoder choose`'s, so the two write the same file the same
 * way. A cache: a write that fails costs a read on the next start, not now.
 */
export async function githubPulls(repo, nameWithOwner) {
  const [owner, name] = nameWithOwner.split('/');
  const got = await repoPulls(repo, owner, name);
  const now = Date.now();
  await writePulls(repo, nameWithOwner, got, now).catch((e) => debug(`pulls.json not written: ${e.message}`));
  return { ...got, read: now };
}

/**
 * The listing to print: `.prcoder/pulls.json` when it is under FRESH_FOR old,
 * else GitHub's (githubPulls), written there so the Pull requests tab opens
 * from this read.
 */
async function listing(repo, nameWithOwner) {
  const held = await readPulls(repo, nameWithOwner);
  if (held && Date.now() - held.read < FRESH_FOR) return held;
  console.log(`reading the open pull requests in ${nameWithOwner}…`);
  return githubPulls(repo, nameWithOwner);
}

/**
 * Git's word on every bare branch a root is built on (branchesBelow, as the
 * tab asks through /api/below), so the row can say what is under it and
 * count it. One origin does not have -- a clone behind the listing -- is
 * left unanswered, and the row says as much as it knows.
 */
async function bareBases(repo, pulls, defaultBranch) {
  const bases = new Set(stackOrder(pulls).filter((r) => !r.depth).map((r) => r.pr.baseRefName)
    .filter((b) => b && b !== defaultBranch));
  return (await Promise.all([...bases].map((b) => branchesBelow(repo, b, defaultBranch, { prs: pulls })
    .then((r) => ({ branch: b, ...r }), () => null)))).filter(Boolean);
}

/**
 * The list, the question, and what the pick means for the start:
 * `{ url, follow }`, or null when nothing was picked (`q`, end of input, or
 * nothing open), which the caller takes as nothing to start. `follow` says the
 * checked-out branch is the pull request's, so the start follows the branch
 * and holds this pull request as the branch's choice, as the pane's Switch
 * does (POST /api/pr/switch); otherwise the URL is the start's target, shown
 * on whatever branch this is.
 *
 * A pick on another branch is checked out (checkoutPr, gh's checkout) unless
 * the tree has uncommitted changes, which the pane's Switch refuses for the
 * same reason: a checkout over them is git's to refuse, or worse, to carry.
 * Then it is said, and the pull request is shown instead.
 *
 * `facts` is repoInfo's answer, which server.js has already paid for.
 */
export async function choosePr(repo, facts, { input = process.stdin, output = process.stdout } = {}) {
  const { nameWithOwner, defaultBranch } = facts;
  const branch = await currentBranch(repo);
  const width = (output.columns || 80) - 1;
  const read = await listing(repo, nameWithOwner);
  const below = await bareBases(repo, read.pulls, defaultBranch);
  const { lines, rows, pick } = chooseLines(read, { nameWithOwner, branch, defaultBranch, below, width });
  for (const l of lines) console.log(styled(l, width));
  if (!pick) return null;
  const rl = readline.createInterface({ input, output });
  // End of input settles nothing in readline/promises: the interface closes
  // and the question's promise is left hanging, so the close is the answer.
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)));
  try {
    for (;;) {
      const why = pick.depth ? 'the deepest' : 'the most recently updated';
      const answer = await Promise.race([rl.question(`PR number [${pick.pr.number}, ${why}], or q: `), closed]);
      if (answer === null || /^q$/i.test(answer.trim())) return null;
      const n = answer.trim() === '' ? pick.pr.number : Number(answer.trim().replace(/^#/, ''));
      const row = rows.find((r) => r.pr.number === n);
      if (row) return start(repo, row.pr, branch);
      console.log(`${answer.trim()} is not one of the open pull requests listed`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Whether `p` is the checked-out branch's pull request, so there is nothing to
 * check out. A fork's head is in the fork, so its name says nothing about this
 * clone -- the fork's `main` is not this `main` -- and the branch gh checked it
 * out to may be `owner/name`, tracking `refs/pull/N/head`. gh reads that
 * config back, so it is asked which pull request this branch is
 * (branchPrUrl): a network round trip, paid only on a pick of
 * a fork's pull request. A failure there is taken as no, and the checkout goes
 * ahead as it did.
 */
export async function isHere(repo, p, branch) {
  if (!p.isCrossRepository) return p.headRefName === branch;
  if (!branch) return false;
  const url = await branchPrUrl(repo).catch((e) => (debug(`gh could not say which pull request ${branch} is: ${e.message}`), null));
  return url === p.url;
}

async function start(repo, p, branch) {
  if (await isHere(repo, p, branch)) return { url: p.url, follow: true };
  const dirty = await dirtyFiles(repo);
  if (dirty.length) {
    console.log(`not checked out: ${dirty.length} uncommitted file${dirty.length > 1 ? 's' : ''} on ${branch ?? 'a detached HEAD'}; showing #${p.number} here instead`);
    return { url: p.url, follow: false };
  }
  const { unfinished } = await checkoutPr(repo, p.url);
  console.log(`checked out ${p.isCrossRepository ? `#${p.number}` : `${p.headRefName} for #${p.number}`}` +
    (unfinished ? `, but gh did not finish: ${unfinished}` : ''));
  return { url: p.url, follow: true };
}
