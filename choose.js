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
// listLines is pure, so test/choose.test.js reads it without gh; choosePr is
// the gh, git and readline around it, run from server.js before term.init().

import readline from 'node:readline/promises';
import { stackOrder, stackUnder } from './public/pr.js';
import { sortPulls, rootsInOrder, pullWord, sizeChip, age, rankMilestones, dueLabel } from './public/items.js';
import { labelValue, LABEL_KINDS } from './public/milestone.js';
import { repoPulls } from './github.js';
import { readPulls, writePulls } from './store.js';
import { currentBranch, dirtyFiles, branchesBelow, trackedPr, branchOwns, uncommitted } from './git.js';
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
 * The orders `--sort` takes, each with what the heading says of it and of it
 * reversed (`--reverse`): the PRs tab's (PULL_SORTS in public/items.js, under
 * the same names) and two the labels give, `effort` and `priority`, read as
 * the milestone viewer reads them (labelValue), older spellings too. Each
 * order's first direction is the one worth taking first: least effort, most
 * pressing.
 */
export const SORTS = {
  updated: ['most recently updated first', 'least recently updated first'],
  stale: ['least recently updated first', 'most recently updated first'],
  smallest: ['smallest first', 'largest first'],
  largest: ['largest first', 'smallest first'],
  newest: ['newest first', 'oldest first'],
  oldest: ['oldest first', 'newest first'],
  effort: ['least effort first', 'most effort first'],
  priority: ['most pressing first', 'least pressing first'],
};

// Each label order's scale, the first to take first: XS before XL, Urgent
// before Low. LABEL_KINDS lists effort the other way, largest first, which is
// the order a milestone is worked in rather than the one picked from.
const SCALES = { effort: [...LABEL_KINDS.effort.options].reverse(), priority: LABEL_KINDS.priority.options };

/**
 * The pull requests in `sort`'s order (SORTS), or its reverse. By a label,
 * the ones no label places go last whichever way it runs, by size among
 * themselves (smallest first, or largest under `reverse`): no label is not
 * the smallest effort or the lowest priority, and a guess at one from the
 * size never places a row (effortGuess in public/milestone.js). Ties go to
 * the most recently updated, then the lower number.
 */
export function sortFor(pulls, sort = 'updated', reverse = false) {
  const scale = SCALES[sort];
  if (!scale) {
    const sorted = sortPulls(pulls, sort);
    return reverse ? sorted.reverse() : sorted;
  }
  const at = (p) => scale.indexOf(labelValue(sort, p.labels ?? [])?.value);
  const by = (a, b) => {
    const [x, y] = [at(a), at(b)];
    if (x < 0 || y < 0) return (x < 0) - (y < 0) || (reverse ? b.lines - a.lines : a.lines - b.lines);
    return reverse ? y - x : x - y;
  };
  return [...pulls].sort((a, b) => by(a, b) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.number - b.number);
}

/**
 * What `--filter key=value` can ask of a pull request: for each key, the
 * values a pull request has under it (`of`, given the row's state class),
 * and, where the values are a closed set, that set, so a misspelt one is
 * refused rather than matching nothing. The keys are the names `list --json`
 * gives the same facts. Compared without case.
 */
export const FILTERS = {
  milestone: { of: (p, m) => (p.milestone == null ? ['none'] : [String(p.milestone), m.get(p.milestone)?.title ?? '']) },
  label: { of: (p) => p.labels ?? [] },
  author: { of: (p) => [p.author ?? ''] },
  state: { values: ['ready', 'stacked', 'draft', 'conflicts', 'behind-base', 'blocked', 'checks-not-passing', 'checking'], of: (p, m, cls) => [cls] },
  effort: { values: [...SCALES.effort, 'none'], of: (p) => [labelValue('effort', p.labels ?? [])?.value ?? 'none'] },
  priority: { values: [...SCALES.priority, 'none'], of: (p) => [labelValue('priority', p.labels ?? [])?.value ?? 'none'] },
  size: { values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], of: (p) => [sizeChip(p.lines)] },
};

/**
 * One `--filter` as written, `key=value[,value…]`, as `{ key, values }`:
 * any of the values matches, and every filter given has to (matches). Pure,
 * and called by parseCli, so a key or a closed value not known fails before
 * gh is asked, naming the ones there are.
 */
export function parseFilter(text) {
  const [, key, list] = /^([a-z]+)=(.+)$/i.exec(text.trim()) ?? [];
  if (!key) throw new Error(`--filter wants key=value, as in effort=S,XS; not ${text}`);
  const known = FILTERS[key.toLowerCase()];
  if (!known) throw new Error(`--filter takes ${Object.keys(FILTERS).join(', ')}; not ${key}`);
  const values = list.split(',').map((v) => v.trim()).filter(Boolean);
  const bad = known.values && values.find((v) => !known.values.some((k) => k.toLowerCase() === v.toLowerCase()));
  if (bad || !values.length) throw new Error(`--filter ${key.toLowerCase()} takes ${known.values ? known.values.join(', ') : 'a value'}; not ${bad ?? list}`);
  return { key: key.toLowerCase(), values };
}

/** Whether a pull request passes every filter: one of each filter's values among what it has under that key. */
const matches = (p, filters, milestones, cls) => filters.every(({ key, values }) => {
  const has = FILTERS[key].of(p, milestones, cls).map((v) => v.toLowerCase());
  return values.some((v) => has.includes(v.toLowerCase()));
});

// The groupings `--group` takes, the PRs tab's three, as the heading says each.
export const GROUPS = { stack: 'by stack', milestone: 'by milestone', none: 'in one list' };

// A milestone's due date coloured by how near it is, as dueLabel's class
// colours it on the page: red past it, orange within a week (bold yellow
// here, the terminal having no orange), yellow within two, green beyond.
const DUE_STYLE = { overdue: 'red', soon: ['bold', 'yellow'], coming: 'yellow', far: 'green' };

/**
 * The rows in `group`'s sections: `[{ milestone, rows }]`, `rows` as
 * stackOrder has them (`{ pr, depth }`). By stack and in one list there is
 * one section, its milestone undefined; by milestone there is one per
 * milestone with a pull request in it, No milestone (null) first and the rest
 * in the owner's order (rankMilestones), as the PRs tab groups them, and flat
 * within, since a stack cannot nest across milestones (pullGroups in
 * public/queue.js). `sorted` is already in the order asked for.
 */
function sections(sorted, group, milestones = []) {
  if (group === 'none') return [{ milestone: undefined, rows: sorted.map((pr) => ({ pr, depth: 0 })) }];
  if (group !== 'milestone') return [{ milestone: undefined, rows: rootsInOrder(stackOrder(sorted), sorted) }];
  const by = new Map();
  for (const pr of sorted) {
    const key = pr.milestone ?? null;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ pr, depth: 0 });
  }
  const ranked = rankMilestones(milestones);
  // One the listing's milestones lack is placed last, by its number, rather
  // than dropped with its pull requests.
  const keys = [null, ...ranked.map((m) => m.number), ...[...by.keys()].filter((k) => k !== null && !ranked.some((m) => m.number === k))];
  return keys.filter((k) => by.has(k)).map((k) => ({
    milestone: k === null ? null : ranked.find((m) => m.number === k) ?? { number: k, title: `milestone ${k}`, dueOn: null },
    rows: by.get(k),
  }));
}

/** A milestone section's heading line: its title, when it is due, and how many are listed under it. */
function sectionHead({ milestone, rows }, now) {
  const due = milestone?.dueOn ? dueLabel(milestone.dueOn, now) : null;
  return [
    { text: milestone ? milestone.title : 'No milestone', style: 'bold' },
    ...(due ? ['  ', { text: due.textContent, style: DUE_STYLE[due.className.split(' ')[1]] }] : []),
    '  ',
    { text: `(${rows.length})`, style: 'dim' },
  ];
}

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
 * What `prcoder list` prints, and `prcoder choose` prints and offers, from a
 * listing as readPulls or repoPulls has it: `{ lines, rows, pick, why }`.
 * `lines` are term.js lines (styled() renders them); `rows` is stackOrder
 * over the pull requests with its stacks in their roots' order (rootsInOrder,
 * as the tab's by-stack view puts them), in `view.sort`'s order (sortFor;
 * most recently updated first unless asked) among roots and among siblings,
 * each followed by what is built on it a step further in. stackOrder alone
 * groups the roots base by base, so an older root on main came before a newer
 * one on another base. `view.group` of `milestone` or `none` lists them by
 * milestone, under a heading for each, or in one list, as the tab can
 * (sections); either way flat, each root that is not on the default branch
 * saying what it is built on. `view.filters` (parseFilter's) leaves out what
 * does not match them, before the walk: a pull request whose base is left out
 * is a root, and says what it is built on as any root does.
 *
 * `pick` is the row Enter takes, and `why` says why. In the default order it
 * is the deepest one and the most recently updated of those, since the
 * deepest is usually where the last session was -- not the first of them in
 * the walk, which is the one under the newest root and can be days staler
 * than another. With an order or a grouping asked for it is the first row: `choose
 * --sort=effort` is asked so that Enter takes the least effort. Null with
 * nothing open.
 *
 * A row is the number, the size (sizeChip, coloured by band), the state in a
 * word, how long since it last moved, and the title -- last, so a narrow
 * terminal (`width`) cuts the title's tail and nothing else. A root whose
 * base is not the default branch says what it is built on after the title,
 * dim, and the title gives way to it (builtOn); `below` is git's word on
 * such bare branches, as branchesBelow gives it and the tab's rows take it.
 * `›` marks the one on the checked-out branch, as the tab marks it `here`
 * (branchOwns, with `tracked` the URL its config names).
 * Widths are terminal columns (span in term.js), the measure styled() cuts
 * by, so a wide character in a base branch's name cuts the title, not the
 * note after it.
 */
export function listLines(listing, { nameWithOwner, branch, tracked = null, defaultBranch, below = [], now = Date.now(), width = Infinity, view = {} } = {}) {
  const { sort = 'updated', reverse = false, group = 'stack', filters = [] } = view;
  const ordered = Boolean(view.sort || reverse || view.group);
  const all = listing.pulls ?? [];
  // What is under each, from the whole listing: a pull request whose base a
  // filter leaves out is still built on it, and says so.
  const unders = new Map(all.map((pr) => [pr.number, stackUnder({ pr }, all, below, defaultBranch)]));
  const byNumber = new Map((listing.milestones ?? []).map((m) => [m.number, m]));
  const shown = all.filter((p) => matches(p, filters, byNumber, pullWord(p, unders.get(p.number)).cls));
  const sorted = sortFor(shown, sort, reverse);
  const parts = sections(sorted, group, listing.milestones);
  const rows = parts.flatMap((part) => part.rows);
  const here = (p) => branchOwns(p, branch, tracked);
  const read = listing.read ? `, read ${age(new Date(listing.read).toISOString(), now)}` : '';
  const lines = [
    `Open pull requests in ${nameWithOwner}, ${GROUPS[group]}, ${SORTS[sort][reverse ? 1 : 0]}${read}:`,
    listing.listed < listing.total && `The ${listing.listed} most recently updated of ${listing.total}.`,
    filters.length > 0 && `${shown.length} of ${all.length} with ${filters.map((f) => `${f.key}=${f.values.join(',')}`).join(' ')}.`,
    '',
  ].filter((l) => l !== false);
  if (!rows.length) return { lines: [...lines, 'none'], rows, pick: null, why: '' };
  // Column widths from every row, so the title starts in one column whatever
  // the indent or the section; a number cut to fit would be a wrong number
  // that looks right.
  const number = ({ pr, depth }) => `${'  '.repeat(depth)}#${pr.number}`;
  const wide = (f) => Math.max(...rows.map((r) => f(r).length));
  const numbers = wide(number);
  const states = wide(({ pr }) => pullWord(pr, unders.get(pr.number)).word ?? '');
  const ages = wide(({ pr }) => age(pr.updatedAt, now));
  const row = (r) => {
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
    return [...head, clip(p.title, Math.max(room, 0)), { text: base, style: 'dim' }];
  };
  parts.forEach((part, i) => {
    if (part.milestone !== undefined) lines.push(...(i ? [''] : []), sectionHead(part, now));
    lines.push(...part.rows.map(row));
  });
  const newer = (a, b) => Date.parse(a.pr.updatedAt) > Date.parse(b.pr.updatedAt);
  const pick = ordered ? rows[0] : rows.reduce((best, r) => (r.depth > best.depth || (r.depth === best.depth && newer(r, best)) ? r : best), rows[0]);
  const why = ordered ? 'the first listed' : pick.depth ? 'the deepest' : 'the most recently updated';
  return { lines, rows, pick, why };
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
 * The list, the question and the start: `{ pr, ...start(pr) }`, the pull
 * request picked as the listing has it (`url`, `number`, `headRefName`,
 * `isCrossRepository` are what the start reads) with what `start` resolved,
 * or null when nothing was picked (`q`, end of input, or nothing open), which
 * the caller takes as nothing to start. `start` is the caller's checkout --
 * startOnPr in git.js, the same one `prcoder <pr>` makes -- run on each pick
 * as it is answered, against the tree as it is then: the question can wait
 * any length of time.
 *
 * Uncommitted work refuses a checkout (startOnPr), so it is said before the
 * question rather than after the pick; Enter then offers this branch's pull
 * request, the one pick that needs none, or nothing when it has none listed.
 * A pick `start` refuses -- uncommitted work, or another prcoder in the
 * working copy -- is said and asked again rather than ending the run; any
 * other failure is thrown. Before, this repeated startOnPr's check of the
 * uncommitted work alone, so a pick refused for another prcoder ended the
 * run, and a fork's pick over uncommitted work asked gh which branch it was
 * twice.
 *
 * `facts` is repoInfo's answer, which server.js has already paid for.
 */
export async function choosePr(repo, facts, { start, view = {}, input = process.stdin, output = process.stdout } = {}) {
  const { nameWithOwner, defaultBranch } = facts;
  const width = (output.columns || 80) - 1;
  const [branch, dirty, read] = await Promise.all([currentBranch(repo), dirtyFiles(repo), listing(repo, nameWithOwner)]);
  const tracked = await trackedPr(repo, branch, facts.repos).catch(() => null);
  const below = await bareBases(repo, read.pulls, defaultBranch);
  const { lines, rows, pick, why: picked } = listLines(read, { nameWithOwner, branch, tracked, defaultBranch, below, width, view });
  for (const l of lines) console.log(styled(l, width));
  if (!pick) return null;
  // What Enter takes: listLines's pick, or over uncommitted work this
  // branch's pull request -- the deepest elsewhere would only be refused.
  // A `pr-<n>` or a fork's branch is found by its config, as the mark is.
  const own = rows.find((r) => branchOwns(r.pr, branch, tracked));
  const offer = dirty.length ? own : pick;
  if (dirty.length) {
    const until = `until ${dirty.length > 1 ? 'they are' : 'it is'} committed or stashed`;
    console.log(own
      ? `${uncommitted(dirty, branch)}: only this branch's pull request, #${own.pr.number}, can be picked ${until}`
      : `${uncommitted(dirty, branch)}: no pull request listed is this branch's, and another's cannot be checked out ${until}`);
  }
  const why = !offer ? '' : dirty.length ? "this branch's" : picked;
  const prompt = offer ? `PR number [${offer.pr.number}, ${why}], or q: ` : 'PR number, or q: ';
  const rl = readline.createInterface({ input, output });
  // End of input settles nothing in readline/promises: the interface closes
  // and the question's promise is left hanging, so the close is the answer.
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)));
  try {
    for (;;) {
      const answer = await Promise.race([rl.question(prompt), closed]);
      if (answer === null || /^q$/i.test(answer.trim())) return null;
      if (answer.trim() === '' && !offer) {
        console.log('commit or stash first to pick another branch\'s pull request, or q to quit');
        continue;
      }
      const n = answer.trim() === '' ? offer.pr.number : Number(answer.trim().replace(/^#/, ''));
      const row = rows.find((r) => r.pr.number === n);
      if (!row) {
        console.log(`${answer.trim()} is not one of the open pull requests listed`);
        continue;
      }
      try {
        return { pr: row.pr, ...(await start(row.pr)) };
      } catch (e) {
        if (!e.refused) throw e;
        console.log(e.message);
      }
    }
  } finally {
    rl.close();
  }
}
