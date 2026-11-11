import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { chooseLines, choosePr } from '../choose.js';
import { writePulls } from '../store.js';
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
const lines = (over = {}) => chooseLines(LISTING, { nameWithOwner: 'gaurav/prcoder', branch: 'description-checklist-text', defaultBranch: 'main', now: NOW, ...over });

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
  const flat = chooseLines({ ...LISTING, pulls: LISTING.pulls.filter((p) => p.number === 173 || p.number === 87) }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.equal(flat.pick.pr.number, 173);
  assert.equal(flat.pick.depth, 0);
});

// What git says is under a bare branch is drawn and counted as the tab draws
// and counts it: `ready` on one is really stacked, on the bare branch.
test('git\'s word on a bare base is drawn under the root and counted in its state', () => {
  const below = [{ branch: 'fixture/diff-views-base', names: ['older-base'], toDefault: true }];
  const ready = { ...LISTING, pulls: LISTING.pulls.map((p) => (p.number === 87 ? { ...p, merge: 'ready' } : p)) };
  const text = chooseLines(ready, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, below }).lines.map(plain);
  assert.match(text[7], /^ {2}#87 +XS +stacked \(2\) .*Title of 87 on fixture\/diff-views-base › older-base › main$/);
  // Without git's answer the count is what the list alone shows.
  assert.match(chooseLines(ready, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW }).lines.map(plain)[7], /stacked \(1\) .* on fixture\/diff-views-base$/);
  // A stacked pull request is still counted by the list, with nothing to ask git.
  assert.match(text[4], /stacked \(2\)/);
});

test('a short listing says so, and an empty one offers nothing', () => {
  const { lines: out } = chooseLines({ ...LISTING, total: 90, listed: 6 }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.equal(plain(out[1]), 'The 6 most recently updated of 90.');
  const none = chooseLines({ read: NOW, total: 0, listed: 0, pulls: [] }, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
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
  const { rows, pick } = chooseLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW });
  assert.deepEqual(rows.map((r) => [r.pr.number, r.depth]), [[3, 0], [5, 1], [2, 0], [1, 0], [4, 1]]);
  assert.equal(pick.pr.number, 4);
});

// A base branch's name is measured in terminal columns, as styled() cuts: by
// its length, each CJK character counted one and the note lost its tail.
test('a wide base branch name cuts the title, not the note', () => {
  const listing = { read: NOW, total: 1, listed: 1, pulls: [pull(1, 'a', '機能-基盤', 10, 'draft', 0, { title: 'A title long enough to cut' })] };
  const [line] = chooseLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW, width: 50 }).lines.slice(-1);
  const drawn = styled(line, 50).replaceAll(/\x1b\[\d+m/g, '');
  assert.match(drawn, / on 機能-基盤$/);
});

test('a state is coloured as the tab colours its class', () => {
  const out = { isTTY: true, columns: 200, rows: 24, text: '', write(s) { this.text += s; return true; } };
  sink(out);
  const listing = { read: NOW, total: 2, listed: 2, pulls: [pull(1, 'a', 'main', 10, 'blocked', 0), pull(2, 'b', 'main', 10, 'draft', 1)] };
  const [blocked, draft] = chooseLines(listing, { nameWithOwner: 'o/r', defaultBranch: 'main', now: NOW }).lines.slice(-2).map((l) => styled(l, 200));
  assert.match(blocked, /\x1b\[33mblocked/);   // yellow, the tab's --warn
  assert.match(draft, /\x1b\[2mdraft/);        // dim, the tab's default
});

// A throwaway repo on `branch` with an uncommitted change, and choosePr run
// over `pulls` with `answers` typed at each question: what it picked, what it
// said, and the questions it asked.
async function chooseOver(branch, pulls, answers) {
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
    await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
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
    const got = await choosePr(dir, { nameWithOwner: 'gaurav/prcoder', defaultBranch: 'main' }, { input, output });
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
