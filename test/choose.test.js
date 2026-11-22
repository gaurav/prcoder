import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { listLines, choosePr, parseFilter } from '../choose.js';
import { writePulls } from '../store.js';
import { startOnPr } from '../git.js';
import { plain, styled, sink } from '../term.js';
import { withGh } from './stub-gh.js';

// The one test here that runs git does it in a throwaway repo, and a git
// hook's GIT_DIR would aim it at the clone the suite runs in (test/CLAUDE.md).
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
const git = promisify(execFile);

const NOW = Date.parse('2026-11-05T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400_000).toISOString();
const pull = (number, headRefName, baseRefName, lines, merge, updated, extra = {}) => ({
  number, title: `Title of ${number}`, url: `https://github.com/gaurav/prcoder/pull/${number}`,
  headRefName, baseRefName, isCrossRepository: false, lines, merge, updatedAt: day(updated), ...extra,
});
// A chain of three on main, a root beside it, a fork's pull request, and a
// root on a bare branch: every shape stackOrder gives a row.
const LISTING = {
  read: NOW - 3 * 60_000, total: 6, listed: 6,
  pulls: [
    pull(159, 'pulls-tab', 'main', 2565, 'ready', 1),
    pull(163, 'description-checklist-text', 'pulls-tab', 405, 'ready', 0),
    pull(170, 'x', 'description-checklist-text', 10, 'ready', 4),
    pull(87, 'fixture/diff-views', 'fixture/diff-views-base', 21, 'draft', 60),
    pull(200, 'main', 'main', 60, 'conflicts', 6, { isCrossRepository: true }),
    pull(173, 'snakemake-highlight', 'main', 35, 'ready', 5),
  ],
};
const lines = (over = {}) => listLines(LISTING, { nameWithOwner: 'gaurav/prcoder', branch: 'description-checklist-text', defaultBranch: 'main', now: NOW, ...over });

test('the list is the tab\'s by-stack order, most recently updated first, and Enter takes the deepest', () => {
  const { lines: out, rows, pick } = lines();
  assert.deepEqual(rows.map((r) => [r.pr.number, r.depth]), [[159, 0], [163, 1], [170, 2], [173, 0], [200, 0], [87, 0]]);
  assert.equal(pick.pr.number, 170);
  const text = out.map(plain);
  assert.equal(text[0], 'Open pull requests in gaurav/prcoder, by stack, most recently updated first, read 3 minutes ago:');
  assert.equal(text[1], '');
  // Indented a step under what it is built on, the title last and in one
  // column, the state in the tab's words: `stacked (N)` for a ready one built on N.
  assert.match(text[2], /^ {2}#159 +XXL +ready +1 day ago +Title of 159$/);
  assert.match(text[3], /^› {3}#163 +L +stacked \(1\) +just now +Title of 163$/);
  assert.match(text[4], /^ {6}#170 +XS +stacked \(2\) +4 days ago +Title of 170$/);
  assert.match(text[6], /^ {2}#200 +S +conflicts/);
  // A root on a bare branch says so, as far as it knows without git; one on
  // the default branch says nothing.
  assert.match(text[7], /^ {2}#87 +XS +draft .*Title of 87 on fixture\/diff-views-base$/);
  assert.doesNotMatch(text[2], / on main/);
  // Every title starts in the same column, whatever the indent before its number.
  assert.equal(new Set(text.slice(2).map((l) => l.indexOf('Title of'))).size, 1);
  assert.ok(text.every((l) => !/[\x00-\x1f]/.test(l)), 'no escape bytes in the plain text');
});

test('the marker follows the checked-out branch, and the default is the newest root with nothing stacked', () => {
  const { lines: out } = lines({ branch: 'snakemake-highlight' });
  assert.match(out.map(plain)[5], /^› #173/);
  assert.ok(!out.map(plain)[3].startsWith('›'));
  // A fork's head is in the fork, whatever it is called.
  assert.ok(!lines({ branch: 'main' }).lines.map(plain).some((l) => l.startsWith('›')));
  // But the branch gh checked it out to says which it is in its config.
  const fork = lines({ branch: 'someone/main', tracked: 'https://github.com/Gaurav/Prcoder/pull/200' }).lines.map(plain);
  assert.deepEqual(fork.filter((l) => l.startsWith('›')).map((l) => l.match(/#\d+/)[0]), ['#200']);
  const flat = listLines({ ...LISTING, pulls: LISTING.pulls.filter((p) => p.number === 173 || p.number === 87) }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.equal(flat.pick.pr.number, 173);
  assert.equal(flat.pick.depth, 0);
});

// What git says is under a bare branch is drawn and counted as the tab draws
// and counts it: `ready` on one is really stacked, on the bare branch.
test('git\'s word on a bare base is drawn under the root and counted in its state', () => {
  const below = [{ branch: 'fixture/diff-views-base', names: ['older-base'], toDefault: true }];
  const ready = { ...LISTING, pulls: LISTING.pulls.map((p) => (p.number === 87 ? { ...p, merge: 'ready' } : p)) };
  const text = listLines(ready, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, below }).lines.map(plain);
  assert.match(text[7], /^ {2}#87 +XS +stacked \(2\) .*Title of 87 on fixture\/diff-views-base › older-base › main$/);
  // Without git's answer the count is what the list alone shows.
  assert.match(listLines(ready, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW }).lines.map(plain)[7], /stacked \(1\) .* on fixture\/diff-views-base$/);
  // A stacked pull request is still counted by the list, with nothing to ask git.
  assert.match(text[4], /stacked \(2\)/);
});

test('a short listing says so, and an empty one offers nothing', () => {
  const { lines: out } = listLines({ ...LISTING, total: 90, listed: 6 }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.equal(plain(out[1]), 'The 6 most recently updated of 90.');
  const none = listLines({ read: NOW, total: 0, listed: 0, pulls: [] }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.equal(none.pick, null);
  assert.deepEqual(none.rows, []);
  assert.equal(plain(none.lines.at(-1)), 'none');
});

test('on a tty the size and the state are coloured, and a narrow terminal cuts only the title', () => {
  const out = { isTTY: true, columns: 60, rows: 24, text: '', write(s) { this.text += s; return true; } };
  sink(out);
  const row = lines({ width: 50 }).lines[4];
  const drawn = styled(row, 50);
  assert.match(drawn, /\x1b\[32mXS \x1b\[39m/);              // green: small
  assert.match(drawn, /\x1b\[36mstacked \(2\)\x1b\[39m/);    // cyan: ready once what is under it merges
  const bare = drawn.replaceAll(/\x1b\[\d+m/g, '');
  assert.equal(bare.length, 50);
  assert.match(bare, /Title $/);
  // The base note outlives the title's tail, since it is the part that says what the row is built on.
  assert.match(plain(lines({ width: 76 }).lines[7]), /Title on fixture\/diff-views-base$/);
  assert.match(styled(lines().lines[6]), /\x1b\[31mconflicts/);
  assert.match(styled(lines().lines[2]), /\x1b\[31mXXL/);
});

// stackOrder alone lists the roots base by base, so #1 on main came before
// the newer #2 on another base; and Enter took the deepest row first in the
// walk, #5 under the newest root, over #4, five days newer, under an older one.
test('roots on different bases are in update order, and Enter takes the newest of the deepest', () => {
  const listing = { read: NOW, total: 5, listed: 5, pulls: [
    pull(3, 'three', 'main', 10, 'ready', 0),
    pull(2, 'two', 'release', 10, 'ready', 4),
    pull(1, 'one', 'main', 10, 'ready', 8),
    pull(5, 'five', 'three', 10, 'ready', 6),
    pull(4, 'four', 'one', 10, 'ready', 1),
  ] };
  const { rows, pick } = listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.deepEqual(rows.map((r) => [r.pr.number, r.depth]), [[3, 0], [5, 1], [2, 0], [1, 0], [4, 1]]);
  assert.equal(pick.pr.number, 4);
});

// A base branch's name is measured in terminal columns, as styled() cuts: by
// its length, each CJK character counted one and the note lost its tail.
test('a wide base branch name cuts the title, not the note', () => {
  const listing = { read: NOW, total: 1, listed: 1, pulls: [pull(1, 'a', '機能-基盤', 10, 'draft', 0, { title: 'A title long enough to cut' })] };
  const [line] = listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, width: 50 }).lines.slice(-1);
  const drawn = styled(line, 50).replaceAll(/\x1b\[\d+m/g, '');
  assert.match(drawn, / on 機能-基盤$/);
});

test('a state is coloured as the tab colours its class', () => {
  const out = { isTTY: true, columns: 200, rows: 24, text: '', write(s) { this.text += s; return true; } };
  sink(out);
  const listing = { read: NOW, total: 2, listed: 2, pulls: [pull(1, 'a', 'main', 10, 'blocked', 0), pull(2, 'b', 'main', 10, 'draft', 1)] };
  const [blocked, draft] = listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW }).lines.slice(-2).map((l) => styled(l, 200));
  assert.match(blocked, /\x1b\[33mblocked/);   // yellow, the tab's --warn
  assert.match(draft, /\x1b\[2mdraft/);        // dim, the tab's default
});

// --sort's label orders put what no label places last whichever way they
// run, so `--reverse` is the most effort first, not the unjudged first.
test('a label order puts the unlabelled last both ways, and an order asked for makes Enter take the first row', () => {
  const listing = { read: NOW, total: 5, listed: 5, pulls: [
    pull(1, 'a', 'main', 10, 'ready', 0),
    pull(2, 'b', 'main', 900, 'ready', 1, { labels: ['Effort: L', 'Priority: Low'] }),
    pull(3, 'c', 'main', 30, 'ready', 2, { labels: ['Effort: XS'] }),
    pull(4, 'd', 'main', 400, 'ready', 3, { labels: ['Size: M', 'Priority: Critical'] }),
    pull(5, 'e', 'main', 70, 'ready', 4),
    pull(6, 'f', 'a', 5, 'ready', 5, { labels: ['Effort: XS'] }),
  ] };
  const at = (view) => listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, view });
  const order = (view) => at(view).rows.map((r) => r.pr.number);
  // #6 is built on #1, so it follows it, a step in, wherever #1 sorts.
  assert.deepEqual(order({ sort: 'effort' }), [3, 4, 2, 1, 6, 5]);
  assert.deepEqual(order({ sort: 'effort', reverse: true }), [2, 4, 3, 5, 1, 6]);
  // `Priority: Critical` is the old spelling of Urgent.
  assert.deepEqual(order({ sort: 'priority' }), [4, 2, 1, 6, 3, 5]);
  assert.deepEqual(order({ reverse: true }), [5, 4, 3, 2, 1, 6]);
  const sorted = at({ sort: 'effort' });
  assert.equal(sorted.pick.pr.number, 3);
  assert.equal(sorted.why, 'the first listed');
  assert.match(plain(sorted.lines[0]), /^Open pull requests in o\/r, by stack, least effort first, read just now:$/);
  assert.match(plain(at({ sort: 'effort', reverse: true }).lines[0]), /most effort first/);
  // With no order asked for, Enter keeps to the deepest.
  assert.equal(at({}).pick.pr.number, 6);
  assert.equal(at({}).why, 'the deepest');
});

// The tab's other two groupings: by milestone, No milestone first and the
// rest in the owner's order, and one list. Both are flat, so a pull request
// built on another says so after its title as a root does.
test('by milestone and in one list, the rows are flat, and a stacked one says what it is on', () => {
  const listing = { ...LISTING,
    milestones: [{ number: 9, title: 'Not urgent', dueOn: null }, { number: 7, title: 'Release', dueOn: '2026-11-08T00:00:00Z' }],
    pulls: LISTING.pulls.map((p) => ({ ...p, milestone: { 163: 9, 170: 7, 173: 7 }[p.number] ?? null })) };
  const at = (view) => listLines(listing, { nameWithOwner: 'o/r', branch: 'x', defaultBranch: 'main', now: NOW, view });
  const by = at({ group: 'milestone' });
  const text = by.lines.map(plain);
  assert.equal(text[0], 'Open pull requests in o/r, by milestone, most recently updated first, read 3 minutes ago:');
  assert.deepEqual(text.slice(2).map((l) => (l.match(/^[ ›] +#\d+/)?.[0] ?? l).trim()), [
    'No milestone  (3)', '#159', '#200', '#87', '',
    'Release  due in 3 days  (2)', '› #170', '#173', '',
    'Not urgent  (1)', '#163',
  ]);
  assert.ok(by.rows.every((r) => r.depth === 0));
  assert.match(text.find((l) => l.includes('#170')), /stacked \(2\) .*Title of 170 on #163$/);
  // An order or a grouping asked for: Enter takes the first row listed.
  assert.equal(by.pick.pr.number, 159);
  const one = at({ group: 'none' });
  assert.equal(plain(one.lines[0]), 'Open pull requests in o/r, in one list, most recently updated first, read 3 minutes ago:');
  assert.deepEqual(one.rows.map((r) => r.pr.number), [163, 159, 170, 173, 200, 87]);
  // Due-date colours follow the page's: within a week is the nearest band short of overdue.
  const out = { isTTY: true, columns: 200, rows: 24, text: '', write(x) { this.text += x; return true; } };
  sink(out);
  assert.match(styled(by.lines.find((l) => plain(l).startsWith('Release'))), /\x1b\[33mdue in 3 days/);
});

// A filter's values are any of; filters given together are all of. A pull
// request whose base is filtered out becomes a root that says what it is on.
test('filters narrow the list, any of a filter\'s values and all of the filters', () => {
  const listing = { ...LISTING, milestones: [{ number: 7, title: 'Release', dueOn: null }],
    pulls: LISTING.pulls.map((p) => ({ ...p, author: p.number === 200 ? 'someone' : 'gaurav', milestone: p.number === 173 ? 7 : null,
      labels: { 163: ['Effort: S'], 170: ['Effort: XS', 'bug'], 173: ['effort: high'] }[p.number] ?? [] })) };
  const at = (...filters) => listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, view: { filters: filters.map(parseFilter) } });
  const numbers = (...f) => at(...f).rows.map((r) => r.pr.number);
  // `effort: high` is the old spelling of L.
  assert.deepEqual(numbers('effort=xs,S'), [163, 170]);
  assert.deepEqual(numbers('effort=XS,S', 'label=bug'), [170]);
  // The state is the word the row shows: #163 is GitHub's ready, but stacked.
  assert.deepEqual(numbers('effort=XS,S', 'state=ready'), []);
  assert.deepEqual(numbers('effort=none'), [159, 200, 87]);
  assert.deepEqual(numbers('effort=L'), [173]);
  assert.deepEqual(numbers('state=stacked'), [163, 170]);
  assert.deepEqual(numbers('author=Someone'), [200]);
  assert.deepEqual(numbers('label=BUG'), [170]);
  assert.deepEqual(numbers('milestone=release'), [173]);
  assert.deepEqual(numbers('milestone=7'), [173]);
  assert.deepEqual(numbers('size=XS', 'milestone=none'), [170, 87]);
  const text = at('effort=XS,S').lines.map(plain);
  assert.equal(text[1], '2 of 6 with effort=XS,S.');
  // #163's base, #159, is left out, so #163 is a root and says it is built on it.
  assert.match(text[4], /^ {2}#163 +L +S +stacked \(1\) .*Title of 163 on #159$/);
  assert.match(text[5], /^ {4}#170 /);
  assert.equal(plain(at('author=nobody').lines.at(-1)), 'none');
});

// Effort and priority get a column each only where some row has one, and
// the columns are then named, since size and effort share their bands.
test('effort and priority are columns when some row has one, named over the rows, an old spelling dim', () => {
  const out = { isTTY: true, columns: 200, rows: 24, text: '', write(x) { this.text += x; return true; } };
  sink(out);
  const listing = { read: NOW, total: 3, listed: 3, pulls: [
    pull(1, 'a', 'main', 900, 'ready', 0, { labels: ['Effort: XS', 'Priority: Urgent'] }),
    pull(2, 'b', 'main', 10, 'draft', 1, { labels: ['size: l'] }),
    pull(3, 'c', 'main', 10, 'ready', 2),
  ] };
  const { lines: out3 } = listLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  const text = out3.map(plain);
  assert.equal(text[2], '  #   size  effort  priority  state  updated     title');
  assert.match(text[3], /^ {2}#1 +XL +XS +Urgent +ready +just now +Title of 1$/);
  assert.match(text[4], /^ {2}#2 +XS +L +draft +1 day ago +Title of 2$/);
  assert.equal(new Set(text.slice(2).map((l) => l.search(/title|Title/))).size, 1);
  assert.match(styled(out3[3]), /\x1b\[32mXS/);                // a small effort is green, as a small size is
  assert.match(styled(out3[3]), /\x1b\[31mUrgent/);
  assert.match(styled(out3[4]), /\x1b\[2mL /);                  // `size: l` is an older spelling of Effort: L
  // Without a label to show, no columns for them and no line naming the rest.
  const bare = listLines({ ...listing, pulls: [listing.pulls[2]] }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW }).lines.map(plain);
  assert.match(bare[2], /^ {2}#3 +XS +ready/);
});

test('a filter not known, or a closed value not in its set, is refused naming the ones there are', () => {
  assert.deepEqual(parseFilter('Effort=xs, S'), { key: 'effort', values: ['xs', 'S'] });
  assert.throws(() => parseFilter('effort'), /--filter wants key=value, as in effort=S,XS; not effort/);
  assert.throws(() => parseFilter('colour=red'), /--filter takes milestone, label, author, state, effort, priority, size; not colour/);
  assert.throws(() => parseFilter('effort=huge'), /--filter effort takes XS, S, M, L, XL, none; not huge/);
  assert.throws(() => parseFilter('state=merged'), /--filter state takes ready, stacked, .*; not merged/);
  assert.throws(() => parseFilter('label=,'), /--filter label takes a value; not ,/);
});

// A throwaway repo on `branch` with an uncommitted change, and choosePr run
// over `pulls` with `answers` typed at each question: what it picked, what it
// said, and the questions it asked.
async function chooseOver(branch, pulls, answers, { setup = async () => {}, dirty = true, inUse } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-choose-'));
  const said = [];
  const asked = [];
  const log = console.log;
  try {
    const run = (...args) => git('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    await git('git', ['init', '-q', '-b', 'main', dir]);
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    await run('add', 'a.txt');
    await run('commit', '-q', '-m', 'x');
    if (branch !== 'main') await run('checkout', '-q', '-b', branch);
    await setup(run);
    if (dirty) await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
    await writePulls(dir, 'gaurav/prcoder', { total: pulls.length, milestones: [], pulls });
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', (d) => {
      const q = String(d);
      if (!/PR number/.test(q)) return;
      asked.push(q);
      input.write(`${answers.shift() ?? 'q'}\n`);
    });
    console.log = (...a) => said.push(plain(a.join(' ')));
    // The start server.js passes, less its claim: a refusal is startOnPr's own.
    const start = (p) => startOnPr(dir, p, { inUse });
    const got = await choosePr(dir, { nameWithOwner: 'gaurav/prcoder', defaultBranch: 'main' }, { start, input, output });
    return { got, said, asked };
  } finally {
    console.log = log;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Uncommitted work refuses a checkout, so `prcoder choose` says so before the
// question, offers this branch's pull request on Enter rather than the newest
// (which would only be refused), and asks again after a pick of another
// branch's rather than ending the run after the list has been read.
test('with uncommitted work, Enter offers this branch\'s, and a pick on another is asked again', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const { got, said, asked } = await chooseOver('topic',
    [pull(5, 'elsewhere', 'main', 10, 'ready', 1), pull(6, 'topic', 'main', 10, 'ready', 2)], ['5', '']);
  assert.equal(got.pr.number, 6);
  assert.equal(asked[0], "PR number [6, this branch's], or q: ");
  assert.ok(said.includes("1 uncommitted file on topic: only this branch's pull request, #6, can be picked until it is committed or stashed"), said.join('\n'));
  assert.ok(said.includes('#5 is on elsewhere, and 1 uncommitted file on topic is in the way; commit or stash it first'), said.join('\n'));
});

// With none of the listed on this branch, nothing is offered on Enter, and a
// fork's pull request -- whose head's name says nothing about this clone -- is
// asked of gh (isHere), and asked again when it is not this branch's, as a
// pull request from this repository's own branch is.
test('with uncommitted work and nothing of this branch\'s, Enter offers nothing and a fork is asked again', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const fork = pull(7, 'main', 'main', 10, 'ready', 2, { isCrossRepository: true });
  const { got, said, asked } = await withGh(() => `echo '{"url":"https://github.com/gaurav/prcoder/pull/1"}'`,
    () => chooseOver('main', [pull(5, 'elsewhere', 'main', 10, 'ready', 1), fork], ['', '7', 'q']));
  assert.equal(got, null);
  assert.equal(asked[0], 'PR number, or q: ');
  assert.ok(said.includes("1 uncommitted file on main: no pull request listed is this branch's, and another's cannot be checked out until it is committed or stashed"), said.join('\n'));
  assert.ok(said.includes("commit or stash first to pick another branch's pull request, or q to quit"), said.join('\n'));
  assert.ok(said.includes('#7 is on main, and 1 uncommitted file on main is in the way; commit or stash it first'), said.join('\n'));
  assert.equal(asked.length, 3);
  // The fork's own pull request checked out here is no checkout, and is taken.
  const here = await withGh(() => `echo '{"url":"${fork.url}"}'`,
    () => chooseOver('someone/main', [fork], ['7']));
  assert.equal(here.got.pr.number, 7);
});

// A `pr-<n>` made for a pull request whose branch is gone has not the head's
// name, but its config says which pull request it is, and Enter offers that
// one over uncommitted work rather than telling you to stash for nothing.
test('with uncommitted work on a pr-<n> branch, Enter offers the pull request it tracks', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const { got, said, asked } = await chooseOver('pr-6',
    [pull(5, 'elsewhere', 'main', 10, 'ready', 1), pull(6, 'topic', 'main', 10, 'ready', 2)], [''], { setup: async (run) => {
      await run('remote', 'add', 'origin', 'https://github.com/gaurav/prcoder.git');
      await run('config', 'branch.pr-6.remote', 'origin');
      await run('config', 'branch.pr-6.merge', 'refs/pull/6/head');
    } });
  assert.equal(got.pr.number, 6);
  assert.equal(asked[0], "PR number [6, this branch's], or q: ");
  assert.ok(said.includes("1 uncommitted file on pr-6: only this branch's pull request, #6, can be picked until it is committed or stashed"), said.join('\n'));
});

// A pick refused for another prcoder in the working copy is asked again, as
// one refused over uncommitted work is: both are startOnPr's refusals, which
// change nothing. Before, choose repeated only the uncommitted-work check, and
// this one ended the run with exit 2 after the list had been read.
test('a pick refused for another prcoder running here is asked again', { skip: process.platform === 'win32' && 'sh' }, async () => {
  let asked = 0;
  const inUse = async () => (asked++, 'another prcoder is running in this directory');
  const { got, said } = await chooseOver('main', [pull(5, 'elsewhere', 'main', 10, 'ready', 1)], ['5', 'q'], { dirty: false, inUse });
  assert.equal(got, null);
  assert.equal(asked, 1);
  assert.ok(said.some((l) => l.startsWith('#5 is on elsewhere, and another prcoder is running in this directory;')), said.join('\n'));
});
