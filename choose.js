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
import { stackOrder } from './public/pr.js';
import { sortPulls, sizeChip, age } from './public/items.js';
import { repoPulls } from './github.js';
import { readPulls, writePulls } from './store.js';
import { currentBranch, checkoutPr, dirtyFiles } from './git.js';
import { styled, clip } from './term.js';

// A listing younger than this is printed as it is, as the Pull requests tab
// opens from one (POST /api/pulls); older, GitHub is asked first, since the
// read takes seconds only where there are many open.
export const FRESH_FOR = 60_000;

// The tab's bands and colours: green at the small end, since a small one is
// usually the next to take, red at the large.
const SIZE_STYLE = { XS: 'green', S: 'green', M: 'yellow', L: 'yellow', XL: 'red', XXL: 'red' };
// The tab's words for a state (MERGE_WORD in github.js) in the tab's colours;
// a word not here is printed plain.
const STATE_STYLE = { ready: 'green', conflicts: 'red', 'checks not passing': 'red', blocked: 'red', draft: 'dim' };

/**
 * The tab's word for a row's state: GitHub's `ready` on a pull request built
 * on others is `stacked (N)`, ready to merge into the one under it and not
 * the default branch (pullWord in public/queue.js). N is the depth here, where
 * the tab counts bare branches too: git is not asked at the command line.
 */
const stateWord = (p, depth) => (p.merge === 'ready' && depth ? `stacked (${depth})` : p.merge ?? '');

/**
 * What `prcoder choose` prints and offers, from a listing as readPulls or
 * repoPulls has it: `{ lines, rows, pick }`. `lines` are term.js lines
 * (styled() renders them); `rows` is stackOrder over the pull requests, most
 * recently updated first among roots and among siblings, each followed by
 * what is built on it a step further in; `pick` is the row Enter takes, the
 * deepest one and the most recently updated of those, since the deepest is
 * usually where the last session was. Null with nothing open.
 *
 * A row is the number, the size (sizeChip, coloured by band), the state in a
 * word, how long since it last moved, and the title -- last, so a narrow
 * terminal (`width`) cuts the title's tail and nothing else. A root whose
 * base is not the default branch says so after the title, dim, and the title
 * gives way to it: a bare branch, which the tab asks git about and this does
 * not. `›` marks the one on the checked-out branch, as the tab marks it `here`.
 */
export function chooseLines(listing, { nameWithOwner, branch, defaultBranch, now = Date.now(), width = Infinity } = {}) {
  const rows = stackOrder(sortPulls(listing.pulls ?? [], 'updated'));
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
  const states = wide(({ pr, depth }) => stateWord(pr, depth));
  const ages = wide(({ pr }) => age(pr.updatedAt, now));
  for (const r of rows) {
    const { pr: p, depth } = r;
    const size = sizeChip(p.lines);
    const state = stateWord(p, depth);
    const base = !depth && p.baseRefName && p.baseRefName !== defaultBranch ? ` on ${p.baseRefName}` : '';
    const head = [
      here(p) ? { text: '›', style: ['bold', 'cyan'] } : ' ',
      ' ',
      { text: number(r).padEnd(numbers), style: 'bold' },
      '  ',
      { text: size.padEnd(3), style: SIZE_STYLE[size] },
      '  ',
      { text: state.padEnd(states), style: STATE_STYLE[state] ?? (state.startsWith('stacked') ? 'cyan' : undefined) },
      '  ',
      { text: age(p.updatedAt, now).padEnd(ages), style: 'dim' },
      '  ',
    ];
    const room = width - head.reduce((n, seg) => n + (seg.text ?? seg).length, 0) - base.length;
    lines.push([...head, clip(p.title, Math.max(room, 0)), { text: base, style: 'dim' }]);
  }
  const pick = rows.reduce((best, r) => (r.depth > best.depth ? r : best), rows[0]);
  return { lines, rows, pick };
}

/**
 * The listing to print: `.prcoder/pulls.json` when it is under FRESH_FOR old,
 * else GitHub's, written there so the Pull requests tab opens from this read
 * (a write that fails costs a read on the next start, as in server.js).
 */
async function listing(repo, nameWithOwner) {
  const held = await readPulls(repo, nameWithOwner);
  if (held && Date.now() - held.read < FRESH_FOR) return held;
  console.log(`reading the open pull requests in ${nameWithOwner}…`);
  const [owner, name] = nameWithOwner.split('/');
  const got = await repoPulls(repo, owner, name);
  const now = Date.now();
  await writePulls(repo, nameWithOwner, got, now).catch(() => {});
  return { ...got, read: now };
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
  const { lines, rows, pick } = chooseLines(await listing(repo, nameWithOwner), { nameWithOwner, branch, defaultBranch, width });
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

async function start(repo, p, branch) {
  if (!p.isCrossRepository && p.headRefName === branch) return { url: p.url, follow: true };
  const dirty = await dirtyFiles(repo);
  if (dirty.length) {
    console.log(`not checked out: ${dirty.length} uncommitted file${dirty.length > 1 ? 's' : ''} on ${branch ?? 'a detached HEAD'}; showing #${p.number} here instead`);
    return { url: p.url, follow: false };
  }
  await checkoutPr(repo, p.url);
  console.log(`checked out ${p.headRefName} for #${p.number}`);
  return { url: p.url, follow: true };
}
