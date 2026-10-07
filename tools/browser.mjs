// Drive the running UI in a real browser, and screenshot it. A client-side
// change is otherwise verified by reading the CSS, which is how three of them
// shipped unseen.
//
//   node tools/browser.mjs [label]         # PNGs to ./data/shots/<label>/ (gitignored)
//                                         # the label says what the run was for; default `latest`
//   PRCODER_PLAYWRIGHT=firefox node tools/browser.mjs
//
// Firefox is a separate download: `npx playwright install firefox` once.
//
// Scratch driver, not a test: add clicks and locators for whatever you are
// looking at. Two rules for anything you add.
//
// PRCODER_PLAYWRIGHT=firefox drives Firefox instead. Worth having rather than
// trusting one engine: the caret in a queue item landed at the start in Firefox
// and nowhere else, because a mousedown inside a draggable element goes to the
// drag machinery there, and every screenshot before that had been Chromium.
//
// PRCODER_AGENT_BIN is stubbed (serverEnv in tools/driver.mjs says why and with what).
//
// It writes, so it is not read-only -- but not to your queue. The server gets
// `--queue data/browser-queue.json`, a queue of its own that each run seeds
// with a fixture, so a run that dies partway leaves nothing behind in the queue
// of the working copy it runs in (#65).
//
// Nothing here clicks ◎. It moves an item into a new issue, one-way: there is
// no queue to put back that would close the issue again. Anything added here that
// writes to GitHub needs its own undo, and needs to run against a repo you own.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openShots, pruneShots } from './shots.mjs';
import { repo, free, serverEnv, killOnExit, openPage, launchBrowser } from './driver.mjs';

// data/, not a new top-level shots/: this repo's scratch space is data/, and it
// is gitignored precisely so driver output has somewhere to live. The argument
// is a label for this run rather than a path -- what you were looking at, so
// the PNGs still say so a week later -- and tools/shots.mjs is what it means.
const shotsRoot = path.join(repo, 'data', 'shots');
const label = process.argv[2] ?? 'latest';
const port = Number(process.env.PRCODER_PORT) || 17434;

await free(port);

// Before the server starts: a bad label should fail while nothing is running.
const out = await openShots(shotsRoot, label);
// Everything below is written against this repo's PR #1 -- its sections, its
// file groups, its issue chips -- and the server follows the current branch, so
// a run from any other branch drives a pull request the assertions do not fit.
// PRCODER_PR pins one; unset is the old branch-following behaviour.
const queueFile = path.join('data', 'browser-queue.json');
const server = spawn('node', ['server.js', '--queue', queueFile,
  ...(process.env.PRCODER_PR ? [process.env.PRCODER_PR] : [])], {
  cwd: repo,
  env: serverEnv(port),
  stdio: 'ignore',
});
killOnExit(server);

// Which of the server's two ways of finding a pull request this run is about to
// exercise. Worth saying out loud: pinning one is the only way to drive the
// panes from a feature branch, and it is also the way to run the whole file and
// never touch the path every real user is on. A run from `initial-implementation`
// with PRCODER_PR unset is what covers that path, and this line is how a reader
// knows which of the two they just did.
console.log('pr:     ', process.env.PRCODER_PR
  ? `pinned to #${process.env.PRCODER_PR} (branch-following not exercised)`
  : "following the current branch");
// Firefox by default, falling back to Chromium: launchBrowser() in driver.mjs.
const browser = await launchBrowser();

// One item per tab, so there is a row to click into and a tab to count -- the
// strip only shows a tab that has something in it. Seeded through the API the
// pane itself uses, before the first page load, so the pane paints the fixture
// rather than an empty list it would not refetch for another minute. The PUT
// replaces the whole list, so whatever the last run left in the file is gone.
//
// `issue` is a bare number, so it links to an existing issue rather than filing
// a new one, and the item stays on Local like any other.
const queueApi = (body, method = 'PUT') =>
  fetch(`http://localhost:${port}/api/queue`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

// Waiting on the server, which answers this once it is listening.
for (let i = 0; i < 60; i++) {
  try { await queueApi(undefined, 'GET'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const FIXTURE = [
  { t: 'a local item, still only on this machine' },
  { t: 'a second local item, to click into' },
  { t: 'linked to an issue', issue: 20 },
  { t: 'ticked off', done: true },
  { t: 'thrown away', deleted: true },
];
const seed = (over) => ({ text: over.t, done: false, issue: null, deleted: false, ...over });
const NUDGE = 'driver repaint nudge';
const SCRATCH = ['driver scratch item, put back at the end of the run', 'driver scratch item two'];
const seeded = await queueApi({ items: FIXTURE.map(seed) });
console.log('seeded: ', Array.isArray(seeded) ? `${seeded.length} items` : JSON.stringify(seeded), `in ${queueFile}`);

const page = await openPage(browser, port);
// The panes fill in from gh, so there is a second or two of "Loading…" first.
// Wait on the head rather than on a file row: the pane opens on Detail now, and
// `.file` only exists once the Files tab has been clicked.
await page.waitForSelector('#pr-head .pr-title', { timeout: 30_000 });
await page.waitForTimeout(500);

await page.screenshot({ path: path.join(out, 'full.png') });
for (const pane of ['pr', 'queue']) {
  await page.locator(`#${pane}`).screenshot({ path: path.join(out, `${pane}.png`) });
}

// The gutters, which are only ever right or wrong on screen. Each drag moves
// one line to a known coordinate, so the variables it writes are arithmetic on
// the 1440x900 viewport -- and the reload says whether they survived.
const drag = async (sel, x, y) => {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
};


// Every queue tab, and what each shows. The counts are read rather than
// eyeballed -- and the strip is shot at the pane's own width to see whether the
// tabs wrap. `#queue-body .tab` and not `.tab`: the pull request pane has a strip of
// its own, driven further down.
const queueStrip = () => page.locator('#queue-body .tab').allTextContents();
console.log('q tabs: ', (await queueStrip()).join(' | '));
for (const name of ['Local', 'Completed', 'Deleted']) {
  await page.locator('#queue-body .tab', { hasText: name }).click();
  await page.waitForTimeout(150);
  const rows = await page.locator('.item .text').allTextContents();
  const grips = await page.locator('.item .grip').count();
  console.log(`  ${name.padEnd(9)} ${JSON.stringify(rows)}${grips ? '  [draggable]' : ''}`);
  await page.locator('#queue').screenshot({ path: path.join(out, `queue-${name.toLowerCase()}.png`) });
}
// 1440px is the only width the strip had been looked at -- where the tabs and
// the bulk button fit easily. The pane the queue
// actually lives in is whatever is left after the PR column, so drag that wide
// and ask the tabs themselves whether they are still on one row: same offsetTop
// for the first and the last is the only version of "does not wrap" that does
// not depend on reading a screenshot.
await drag('#gut-pr', 980, 450);
await page.waitForTimeout(300);
const strip = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#queue-body .tab')];
  const pane = document.getElementById('queue').getBoundingClientRect().width;
  return { rows: new Set(t.map((b) => b.offsetTop)).size, n: t.length, pane: Math.round(pane) };
});
console.log('narrow: ', `${strip.n} tabs on ${strip.rows} row(s) in a ${strip.pane}px pane`,
  strip.rows === 1 ? '' : '  <-- the strip wrapped');
await page.locator('#queue').screenshot({ path: path.join(out, 'queue-narrow.png') });
await drag('#gut-pr', 375, 450);
await page.waitForTimeout(300);

// The confirm is the only thing between one click and every completed item, so
// check it is load-bearing rather than decorative: dismissing it has to leave
// the counts alone, and only accepting moves them.
await page.locator('#queue-body .tab', { hasText: 'Completed' }).click();
await page.waitForTimeout(150);
page.once('dialog', (d) => { console.log('confirm:', JSON.stringify(d.message().split('\n')[0])); d.dismiss(); });
await page.locator('.bulk', { hasText: 'delete all' }).click();
await page.waitForTimeout(500);
console.log('  dismissed', (await queueStrip()).join(' | '));
page.once('dialog', (d) => d.accept());
await page.locator('.bulk', { hasText: 'delete all' }).click();
await page.waitForTimeout(800);
console.log('  accepted ', (await queueStrip()).join(' | '));

await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);

// The single-row path into Deleted and back out again. The bulk button above
// covers the same tombstone rule, but not the ✕ and ↩ on the row itself, and
// they are the only way to delete one item rather than a tabful. Round-tripped
// rather than left deleted: the caret check below still needs this row on
// Local, and a restore that puts it back is the half worth proving anyway.
const local = () => page.locator('#queue-body .tab', { hasText: /^Local/ }).innerText();
await page.locator('.item', { hasText: 'a second local item' }).locator('button[title="delete"]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (2)' }).waitFor({ timeout: 10_000 });
console.log('row ✕:  ', await local(), '+', await page.locator('#queue-body .tab', { hasText: /^Deleted/ }).innerText());
await page.locator('#queue-body .tab', { hasText: 'Deleted' }).click();
await page.waitForTimeout(150);
await page.locator('.item', { hasText: 'a second local item' }).locator('button[title="restore"]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (3)' }).waitFor({ timeout: 10_000 });
await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);
console.log('row ↩:  ', await local(), JSON.stringify(await page.locator('.item .text').allTextContents()));

// ▶ sends the item and ticks it off in one click, so the row leaves Local for
// Completed. Both halves are checked here, because the tick is only honest if
// the text really reached the PTY: the stub echoes what it is given, so the
// terminal is the evidence that something was sent rather than just crossed
// out. Round-tripped like the ✕ above -- the caret check below still needs a
// full Local tab.
const SENT = 'a local item, still only on this machine';
await page.locator('.item', { hasText: SENT }).locator('button[title="type into Claude, and check it off"]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (2)' }).waitFor({ timeout: 10_000 });
await page.waitForTimeout(400);   // the stub echoes on the PTY's own schedule
const echoed = (await page.locator('#term-host').innerText()).includes(SENT);
console.log('row ▶:  ', await local(), '+', await page.locator('#queue-body .tab', { hasText: /^Completed/ }).innerText(),
  `, terminal echoed it: ${echoed}`, ' (want it off Local, on Completed, and echoed true)');
await page.locator('#queue-body .tab', { hasText: 'Completed' }).click();
await page.waitForTimeout(150);
// The way back, which is why this is a tick and not a delete: the box that
// checked itself unchecks. click(), not uncheck(): uncheck() reads the box
// again after clicking, and once the save has moved the row off Completed it
// waits for a box that is no longer there.
await page.locator('.item', { hasText: SENT }).locator('input[type=checkbox]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (3)' }).waitFor({ timeout: 10_000 });
await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);
console.log('unticked:', await local(), ' (want Local (3) again)');

// The source tabs, which read GitHub rather than the queue. The PR tab is this
// PR's own checklist: one box ticked from here and unticked again is two real
// edits to the description, checked to leave the body as it was -- read back
// through /api/status, whose copy is the one editBody replaced after each
// write. Issues is the issues the description mentions without closing them;
// ↓ copies one into Local without touching the issue -- into the driver's own
// queue, where the next run's seed replaces it.
const prBody = () => page.evaluate(() => fetch('/api/status').then((r) => r.json()).then((st) => st.pr?.body));
const bodyBefore = await prBody();
await page.locator('#queue-body .tab', { hasText: /^PR/ }).click();
await page.waitForTimeout(150);
await page.locator('#queue').screenshot({ path: path.join(out, 'queue-pr.png') });
const prRows = page.locator('#queue-body .item.source');
console.log('pr tab: ', await page.locator('#queue-body .tab', { hasText: /^PR/ }).innerText(), `${await prRows.count()} rows`);
const firstBox = () => page.locator('#queue-body .item.source input[type=checkbox]').first();
// A description can have no checkboxes at all -- this repo's PR #27 has none --
// and then there is nothing to tick, which is a skip rather than a hang.
if (await prRows.count()) {
  // The untick is the undo, so a run that fails between the two clicks -- a
  // timeout, a refused write, the browser going away -- would leave the box
  // ticked on GitHub. The description is snapshotted first, byte for byte from
  // gh rather than /api/status's LF copy, and put back from the snapshot in the
  // finally if it did not come back the same. The file stays in data/ if even
  // that fails, or the run is killed outright.
  const prUrl = await page.evaluate(() => fetch('/api/status').then((r) => r.json()).then((st) => st.pr.url));
  const ghBody = () => JSON.parse(execFileSync('gh', ['pr', 'view', prUrl, '--json', 'body'], { cwd: repo })).body;
  const snapshot = path.join(repo, 'data', 'pr-body-before-browser.md');
  const original = ghBody();
  fs.writeFileSync(snapshot, original);
  try {
    const wasTicked = await firstBox().isChecked();
    for (const _ of [1, 2]) {
      await firstBox().click();
      // Disabled while the write is out, and repainted from the new body after.
      await page.waitForFunction(() => {
        const box = document.querySelector('#queue-body .item.source input[type=checkbox]');
        return box && !box.disabled;
      }, null, { timeout: 30_000 });
      await page.waitForTimeout(300);
    }
    console.log('  ticked and unticked:', (await firstBox().isChecked()) === wasTicked ? 'box back as it was' : 'BOX CHANGED',
      (await prBody()) === bodyBefore ? '· body unchanged' : '· BODY CHANGED');
  } finally {
    if (ghBody() !== original) {
      execFileSync('gh', ['pr', 'edit', prUrl, '--body-file', snapshot], { cwd: repo });
      console.log('  description put back from', path.relative(repo, snapshot));
    }
    fs.rmSync(snapshot);
  }
} else console.log('  no checkboxes in this description to tick');

await page.locator('#queue-body .tab', { hasText: /^Issues/ }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('#queue-body .item.source .text')]
  .some((t) => t.textContent === '…'), null, { timeout: 30_000 });
await page.locator('#queue').screenshot({ path: path.join(out, 'queue-issues.png') });
console.log('issues: ', await page.locator('#queue-body .tab', { hasText: /^Issues/ }).innerText(),
  JSON.stringify(await page.locator('#queue-body .item.source').allInnerTexts()));
const localBefore = await local();
await page.locator('#queue-body .item.source .actions button').first().click();
await page.locator('#queue-body .tab', { hasText: /^Local \(4\)/ }).waitFor({ timeout: 10_000 });
console.log('  pulled: ', localBefore, '->', await local(), '(want one more)');
await page.locator('#queue-body .tab', { hasText: /^Local/ }).click();
await page.waitForTimeout(150);

// The tabs, and what each says about the others. `Detail (3/10)` /
// `Files (7/23)` is the whole reason the counts are on the labels -- they are
// what you can see while you are looking at another one.
const tabs = await page.locator('#pr-head .tab').allInnerTexts();
console.log('tabs:    ', tabs.join('  |  '), '  (want a count on each)');
console.log('switch:  ', (await page.$$eval('#pr-switch option', (os) => os.slice(1, 4)
  .map((o) => o.textContent.slice(0, 12)))).join('  |  '), '  (want the pinned PR first if it is not open, then each open PR with its stack indented under it)');

// The checks, which are a tab and a mark rather than the badges they used to be
// above the title: the green done circle every tab gets once everything passed,
// a yellow ring while one is pending, a red ✕ once one failed. The mark is read off the computed ::before rather than the class
// name, because the class is only a promise that the stylesheet has a rule.
// This repo's own PR is the fixture, so what it says depends on what CI is
// doing right now: the assertion is that the mark and the label agree, not
// what either one is. test/browser/suite.js pins all three against a fixture.
const checksTab = page.locator('#pr-head .tab', { hasText: /^Checks/ });
if (await checksTab.count()) {
  const label = await checksTab.innerText();
  const dot = await checksTab.evaluate((e) => {
    if (e.classList.contains('done')) return `done circle ${getComputedStyle(e, '::after').backgroundColor}`;
    const s = getComputedStyle(e, '::before');
    return /✕/.test(s.content) ? `✕ ${s.color}`
      : parseFloat(s.borderTopWidth) ? `ring ${s.borderTopColor}` : `dot ${s.backgroundColor}`;
  });
  const cls = await checksTab.getAttribute('class');
  await checksTab.click();
  await page.waitForSelector('.check');
  const rows = await page.locator('.check').allInnerTexts();
  const linked = await page.locator('.check a').count();
  console.log('checks:  ', JSON.stringify(label), cls, dot,
    ` (want N/N with the done circle 127,216,143, or a ring 240,220,154 while pending or a ✕ 245,163,163 once any failed)`);
  console.log('check rows:', rows.join(' | '), `, ${linked} of ${rows.length} link out`,
    ' (want one row per check, each linking to its run)');
  await page.locator('#pr').screenshot({ path: path.join(out, 'pr-checks.png') });
  await page.locator('#pr-head .tab').nth(0).click();
} else {
  console.log('checks:   no tab  (want none only if this PR really has no checks)');
}

// The folds. A description this long is ten collapsed lines until you open
// one, which is the point -- and the open one has to survive the poll, because
// renderPr replaces the whole pane every 60 seconds and the open set is the
// only thing outside it that remembers.
console.log('sections:', await page.locator('.md-section').count(), ' (want one per ## in the body)');
await page.locator('.md-section > summary').nth(1).click();
await page.waitForTimeout(200);
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-open.png') });
await page.locator('#pr-refresh').click();
await page.waitForTimeout(2500);
console.log('still open after a refresh:',
  JSON.stringify(await page.locator('.md-section[open] > summary h3').allInnerTexts()),
  ' (want the one clicked above)');

// The head's way out of the pane, which is one row ending in the repository and
// only on screen: the row is `.meta` with no alignment rule any more, and
// whether that leaves it at the same left edge as everything else in the head
// is a fact about the browser rather than about the stylesheet. The title is
// the control -- it never moved, and the row is supposed to agree with it. (It
// did not until 2026-09-21: the row was `justify-content: flex-end`, and this
// check measured its right edge instead. The stylesheet says why it moved back.)
//
// Which line the repository lands on depends on the slug and the pane: this
// repository's `gaurav/prcoder` fits beside the four at the default width,
// which is the case the move into the row was for.
const headRow = () => page.evaluate(() => {
  const row = document.querySelector('#pr-head .pr-links');
  const repo = row.querySelector('.pr-repo');
  const box = (el) => el.getBoundingClientRect();
  const mid = (el) => Math.round(box(el).top + box(el).height / 2);
  const title = Math.round(box(document.querySelector('#pr-head .pr-title')).left);
  const line = mid(repo) === mid(row.querySelector('a:not(.primary)')) ? 'same line' : 'next line';
  return `${[...row.querySelectorAll('a')].map((a) => a.textContent).join(' ')} | row left ${
    Math.round(box(row).left)}, title left ${title}, repo on the ${line}`;
});
console.log('head:   ', await headRow(), ' (want the two lefts the same, and the repo on the same line)');
console.log('out:    ', await page.evaluate(() =>
  [...document.querySelectorAll('#pr-head .pr-links a')].map((a) => a.href).join(' ')));
// The repository ends that row because it is the one link with no bound on its
// width: where it does not fit it wraps whole onto a line of its own, and clips
// only there.
//
// Both lines say `whole` against this repository and that is the right answer:
// `gaurav/prcoder` is 14 characters and fits the 180px floor with room over.
// The clipping itself is pinned in test/browser/suite.js, whose fixture carries
// a 44-character slug; what a driver run adds is the shape of the block at a
// width a drag can really reach, which is pr-head-narrow.png -- the links row
// wraps there, and the repository, on a line of its own by then, does not.
//
// So this is a check that goes quiet on a long slug: `owner ... clipped` here
// means the run was against a repository whose name this pane cannot hold, and
// what to look at then is whether the *name* is still whole beside it.
const repoLine = async () => page.evaluate(() => {
  const state = (sel) => { const e = document.querySelector(sel);
    return `${JSON.stringify(e.textContent)} ${e.scrollWidth > e.clientWidth ? 'clipped' : 'whole'}`; };
  return `owner ${state('#pr-head .pr-repo .owner')}, name ${state('#pr-head .pr-repo .name')}`;
});
console.log('repo:   ', await repoLine(), ' (want both whole -- this repo\'s slug is short)');
await page.evaluate(() => document.querySelector('main').style.setProperty('--w-pr', '180px'));
console.log('repo180:', await repoLine(),
  ' (want the name whole; the owner clips only where the slug is long)');
console.log('head180:', await headRow(), ' (want the repo on the next line: the four fill 180px)');
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-head-narrow.png') });
await page.evaluate(() => document.querySelector('main').style.removeProperty('--w-pr'));
// The dots between them are delimiters, and were an `a::before` -- which is
// inside the link's box, so they were underlined with it and a press on one
// followed the link to its right. Hit-tested rather than read off the DOM: that
// a separator is its own element says nothing about where a click lands.
console.log('dots:   ', await page.evaluate(() =>
  [...document.querySelectorAll('#pr-head .pr-links > .sep')].map((sep) => {
    const b = sep.getBoundingClientRect();
    return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.tagName;
  }).join(' ')), ' (want SPAN each, never A)');

// The two link kinds that only mean something against a repository: a relative
// path, which GitHub leaves for the page to resolve and prcoder resolves to a
// blob URL on the head branch, and a bare #N. Both showed as their own source
// until they were rendered; this repo's own description carries one of each.
console.log('links:  ', await page.evaluate(() => {
  const find = (re) => [...document.querySelectorAll('#pr-body .md a')]
    .find((a) => re.test(a.textContent));
  return `${find(/^README$/)?.href} | ${find(/^#\d+$/)?.href}`;
}), ' (want a /blob/<head>/README.md URL, and an /issues/N one)');

// The issue lists' titles. Where the lists sit and how a row is shaped is
// test/browser/suite.js's now, against a fixture -- what a fixture cannot say is
// whether the real title lookup (a second gh call, github.js issueLinks) came
// back with anything, and an untitled row is the only thing on screen that shows
// it did not.
console.log('titled: ', await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#pr-body .issues a')];
  return `${rows.filter((a) => a.querySelector('.ttl')).length} of ${rows.length}`;
}), ' (want every row titled: a bare number is a lookup that returned nothing)');

// A number in a description is as often a pull request as an issue, and only
// GitHub can say which: the chip's URL is the one the titles query returned, not
// `/issues/<n>` built from the number. #27 is this repo's queue-tabs PR, so it is
// the one that says whether that held -- /issues/27 redirects, and a redirect is
// exactly what this stops being the answer.
console.log('chip 27:', await page.evaluate(() => [...document.querySelectorAll('#pr-body .issues a')]
  .find((a) => a.textContent.startsWith('#27 '))?.href), ' (want /pull/27, not /issues/27)');

// Where each tab was left. The two offsets are kept apart in module state, and
// the switch is what used to lose them: renderPrTab read scrollTop *after*
// switchTo had already moved `tab`, so Detail's offset was filed under Files
// and handed straight back. Scroll one, cross to the other and back.
const scrollTo = (px) => page.$eval('#pr-body', (el, n) => {
  el.scrollTop = n;
  return el.scrollTop;
}, px);
const scrollNow = () => page.$eval('#pr-body', (el) => el.scrollTop);
const onDetail = await scrollTo(300);
await page.waitForTimeout(100);
await page.locator('#pr-head .tab').nth(1).click();
const filesFresh = await scrollNow();
await scrollTo(150);
await page.waitForTimeout(100);
await page.locator('#pr-head .tab').nth(0).click();
console.log('scroll:  ', `Files opened at ${filesFresh}, Detail came back to ${await scrollNow()}`,
  `  (want 0, then ${onDetail})`);

// The third tab, which lists the open PRs built on this one's branch. They are
// nested by base, each with a #N link out and a Switch. Back to Detail after
// it, since everything below expects the default tab. By name, not position:
// #60 adds a Checks tab to the same row.
await page.locator('#pr-head .tab', { hasText: 'Stack' }).click();
await page.waitForSelector('#pr-body .pr-into, #pr-body .empty');
console.log('stack:   ', await page.$$eval('#pr-body .pr-row .pr-num', (as) => as.map((a) => a.textContent).join(' ')
  || document.querySelector('#pr-body .empty')?.textContent),
'  (want every open PR based on this head, as #N links)');
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-stack.png') });
await page.locator('#pr-head .tab').nth(0).click();

// The measure, which is inert at the pane's 375px default and is the whole
// reason for the cap at the other end of its range.
await drag('#gut-pr', 900, 450);
await page.waitForTimeout(300);
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-wide.png') });
console.log('measure:', await page.evaluate(() => {
  const p = document.querySelector('.md p');
  const face = getComputedStyle(p).fontFamily.split(',')[0];
  return `${Math.round(p.getBoundingClientRect().width)}px of ${Math.round(
    document.getElementById('pr-body').getBoundingClientRect().width)}px, in ${face}`;
}), ' (want the prose capped well under the pane)');
await drag('#gut-pr', 375, 450);

const filesTab = page.getByRole('button', { name: /^Files/ });
await filesTab.click();
await page.waitForSelector('.file');
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-files.png') });

// The file groups fold too, open by default -- the opposite of a description's
// sections, and the opposite default for the opposite reason.
console.log('groups open on arrival:', await page.locator('.group[open]').count(),
  'of', await page.locator('.group').count(), ' (want all of them)');
// The second level: one fold per directory inside each group, and rows that say
// only what the fold above them does not. The order is the pane's own -- a
// directory ahead of what is inside it, siblings alphabetical -- so this is
// where a comparator that has quietly become a string compare shows up.
console.log('dirs:    ', (await page.locator('.dir > summary h3').allInnerTexts()).join(' '),
  ' (want each ending in /, a parent before its children, alphabetical)');
console.log('rows:    ', (await page.locator('.dir').first().locator('.file .path').allInnerTexts()).join(' '),
  ' (want names without the directory above them, most lines changed first)');
// Files at the top of the repository are not a fold: they are the group's first
// rows, above every directory in it. Counted per group rather than over the
// pane, because "before the first .dir" is only a claim within one group.
console.log('root rows lead their group:', await page.evaluate(() => {
  const groups = [...document.querySelectorAll('.group > .sec-body')];
  const say = groups.map((b) => {
    const kids = [...b.children];
    const rows = kids.filter((k) => k.classList.contains('file'));
    const firstDir = kids.findIndex((k) => k.classList.contains('dir'));
    const late = rows.some((r) => firstDir !== -1 && kids.indexOf(r) > firstDir);
    return `${rows.length}${late ? ' AFTER A DIR' : ''}`;
  });
  return `${say.join(', ')} across ${groups.length} groups`;
}), ' (want a count per group and no AFTER A DIR)');
await page.locator('.group > summary').first().click();
await page.waitForTimeout(200);
console.log('after collapsing one:', await page.locator('.group[open]').count(), 'open');

// A dotfile's leading dot, which `direction: rtl` moves to the other end
// unless the <bdi> inside is doing its job -- `.gitignore` drawn as
// `gitignore.`. Measured rather than eyeballed: the dot is invisible at this
// size and reads as a full stop either way.
console.log('dotfile paths draw in order:', await page.evaluate(() => {
  const dots = [...document.querySelectorAll('.file .path')]
    // The drawn text, not the title: a row inside a directory fold shows the
    // name alone, so `.github/workflows/test.yml` draws as `test.yml` and has no
    // leading dot left to get wrong. What is still at risk is a name that
    // starts with one -- `.gitignore` at the root, a dotfile in any directory.
    .filter((a) => a.textContent.startsWith('.'));
  if (!dots.length) return 'no dotfile in this PR to check';
  const bad = dots.filter((a) => {
    const t = document.createTreeWalker(a, NodeFilter.SHOW_TEXT).nextNode();
    const r = (i, j) => { const x = document.createRange(); x.setStart(t, i); x.setEnd(t, j); return x.getBoundingClientRect(); };
    return r(0, 1).left >= r(1, 2).left;   // the dot is not left of what follows
  });
  return bad.length ? `BAD: ${bad.map((a) => a.title).join(', ')}` : `${dots.length} checked, all leading-dot-first`;
}));
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-files-collapsed.png') });
await page.locator('.group > summary').first().click();
await page.waitForTimeout(200);

// A .js file by name, not the first row: the first is whatever the first group
// holds, which since Config & docs went first is `.gitignore` -- no grammar,
// so every highlight check below read zero spans and then timed out waiting.
const highlighted = page.locator('.file[data-path$=".js"] .path').first();
await highlighted.click();   // opens the diff pane (Files tab)
await page.waitForSelector('main.diff-open');
// The title says whether the pane holds a change or a whole file; every file in
// PR #1 is one the PR adds, so it should read NEW there and DIFF nowhere.
await page.waitForFunction(() => document.querySelectorAll('#diff-body .dl').length > 0);
console.log('diff title:', await page.locator('#diff h1').innerText(), ' (want NEW: every file in PR #1 is added)');
console.log('outline:', await page.evaluate(() => {
  const d = (id) => getComputedStyle(document.getElementById(id)).display;
  return `${document.getElementById('diff-outline').children.length} rows, ${d('diff-side')}, show button ${d('diff-outline-show')}`;
}), ' (want 0 rows, none, show button none: a whole file has no hunks to list, or to bring back)');

// The NEW view is the highlighted one, and the colours are the whole of what
// says so -- a regression to plain text is a screenshot that looks ordinary.
// So the classes are printed too: they are prcoder's own `tok-` names over
// Prism's token tree, and the file open here is a .js one the PR adds.
const tokens = () => page.evaluate(() => {
  const spans = [...document.querySelectorAll('#diff-body .dl span')];
  return { n: spans.length, names: [...new Set(spans.flatMap((s) => [...s.classList]))].sort().join(' ') };
});
const hi = await tokens();
console.log('highlight:', `${hi.n} spans:`, hi.names || '(none)',
  '\n           (want spans in tok- classes: comment, keyword, string at least)');
await page.locator('#diff').screenshot({ path: path.join(out, 'diff.png') });

// The header's @ types the file's mention into the agent's prompt, unsent. The
// stub echoes its input, so the terminal is the evidence it reached the PTY --
// and the prompt is then left holding it, which the stub does not mind.
const openPath = await page.locator('#diff-path').innerText();
await page.locator('#diff-mention').click();
await page.waitForTimeout(400);   // the stub echoes on the PTY's own schedule
console.log('diff @:  ', `terminal echoed @${openPath}:`,
  (await page.locator('#term-host').innerText()).includes(`@${openPath}`), ' (want true)');

// The diff pane's two ways out: the file itself at this PR's head, and the
// patch in GitHub's diff viewer. Both hrefs are read rather than assumed
// because the blob one is assembled from a sha the payload carries -- a missing
// one would render as `/blob/undefined/`, which looks like a link and 404s.
const diffLinks = await page.locator('#diff header a').evaluateAll(
  (as) => as.map((a) => `${a.innerText} ${a.href}`));
console.log('diff out:', diffLinks.join('\n          '),
  '\n           (want Diff at /pull/N/files#diff-<64-hex> first, then',
  'File/Blame/History at /blob|blame|commits/<40-hex>/<path>; no ↗ on any)');
// The same path with `language` answering null: an extension with no grammar
// is not a file that fails to highlight, it is one that is never handed to
// Prism at all, and the two look identical until you count the spans.
const plain = page.locator('.file[data-path=".gitignore"] .path');
if (await plain.count()) {
  await plain.click();
  await page.waitForFunction(() => document.getElementById('diff-path').textContent === '.gitignore'
    && document.querySelectorAll('#diff-body .dl').length > 0);
  const none = await tokens();
  console.log('plain:    ', `${none.n} spans`, none.names, ' (want 0 spans: .gitignore has no grammar)');
  // Back to the highlighted file, which is what the screenshots below hold.
  await highlighted.click();
  await page.waitForFunction(() => document.querySelectorAll('#diff-body .dl span').length > 0);
} else {
  console.log('plain:     no extensionless file in this PR to check');
}

await drag('#gut-pr', 520, 450);
await drag('#gut-diff', 720, 300);
await drag('#gut-queue', 720, 640);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'dragged.png') });
const dragged = await page.evaluate(() => document.querySelector('main').style.cssText);
await page.reload();
// Detail is the expected tab after a reload: the choice is module state, not
// localStorage, on purpose -- see the comment on `tab` in public/pr.js.
await page.waitForSelector('#pr-head .pr-title');
const onTab = await page.locator('#pr-head .tab.on').innerText();
const restored = await page.evaluate(() => document.querySelector('main').style.cssText);
console.log('after reload, tab is', JSON.stringify(onTab), ' (want Detail)');

console.log('dragged: ', dragged, '  (want --w-pr 520, --h-diff 300, --h-queue 260)');
console.log('restored:', restored, restored === dragged ? '' : '  <-- did not persist');

// The other way to move a gutter, which has no cursor to watch: tab to it and
// press a key. Right by 10, then shift-Right by 50, then Home back to the
// stylesheet's own default -- so the three numbers say that focus lands, that
// the step sizes differ, and that the reset is reachable without a mouse.
const wPr = () => page.evaluate(() =>
  Math.round(document.querySelector('#pr').getBoundingClientRect().width));
await page.locator('#gut-pr').focus();
const focused = await page.evaluate(() => document.activeElement?.id);
const valuenow = () => page.locator('#gut-pr').getAttribute('aria-valuenow');
const before = await wPr();
const nowBefore = await valuenow();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(50);
const nudged = await wPr();
await page.keyboard.press('Shift+ArrowRight');
await page.waitForTimeout(50);
const shoved = await wPr();
const nowShoved = await valuenow();
await page.keyboard.press('Home');
await page.waitForTimeout(50);
const homed = await page.evaluate(() =>
  document.querySelector('main').style.getPropertyValue('--w-pr'));
console.log('keys:    ', `focus ${focused}, ${before} -> ${nudged} -> ${shoved}`,
  `  (want gut-pr, +10 then +50)`);
console.log('home:    ', JSON.stringify(homed), '  (want "" -- back to the template)');
// Moved, and said so: a ResizeObserver on the 1px gutter never fired on a move.
console.log('valuenow:', `${nowBefore} -> ${nowShoved} -> ${await valuenow()} after Home`,
  ' (want a percentage of <main> that moves with the keys and again with Home)');

// Home just put the pane back to its 375px default, which is the one width where
// the balanced wrap does anything: a real title runs to three lines there, and
// a greedy wrap leaves the last of them holding a word or two. Range rectangles
// rather than a screenshot -- the claim is about how wide the lines come out,
// and `text-wrap: balance` is a property no stylesheet can be read for.
const wrap = await page.evaluate(() => {
  const r = document.createRange();
  r.selectNodeContents(document.querySelector('#pr-head .pr-title'));
  return [...r.getClientRects()].map((b) => Math.round(b.width));
});
console.log('wrap:    ', `${await page.locator('#pr').evaluate((e) => Math.round(e.getBoundingClientRect().width))}px pane,`,
  `lines ${wrap.join(', ')}`, ' (want three of similar width, not two full and a stub)');

// The two toasts. The reload above is a real trigger for the first one:
// sessionStorage survives it, so ws.onopen decides the session was restarted
// and calls toast() for itself -- which is what says the plain path still
// works. Four seconds and it is gone, hence the screenshot before anything
// else. The sticky one has no read-only trigger (switching PRs would check out
// a branch in this repo), so it calls toast() itself, through the same module
// instance the page loaded -- as test/browser/suite.js does.
const toastText = () => page.evaluate(() => {
  const el = document.getElementById('toast');
  return el.hidden ? null : el.textContent;
});
console.log('toast:  ', JSON.stringify(await toastText()), '  (want the restart notice)');
await page.locator('#toast').screenshot({ path: path.join(out, 'toast.png') }).catch(() => {});
await page.waitForTimeout(4500);
console.log('faded:  ', JSON.stringify(await toastText()), '  (want null -- the 4s timeout)');

await page.evaluate(async () => (await import('/pr.js')).toast('Switched to add-retries (#123). Claude still'
  + " has the old branch's files in mind — tell it to re-read anything it had open.", false, true));
await page.waitForTimeout(100);
await page.locator('#toast').screenshot({ path: path.join(out, 'toast-sticky.png') });
await page.screenshot({ path: path.join(out, 'full-toast.png') });   // and what it sits over
await page.waitForTimeout(4500);   // past the 4s a plain toast would have died at
console.log('sticky: ', JSON.stringify(await toastText()), '  (want it still up)');
await page.locator('#toast').click();
console.log('clicked:', JSON.stringify(await toastText()), '  (want null)');

// The caret check needs a row on the Local tab to click into, and this repo's
// queue is legitimately empty the moment the last item has been finished or
// filed -- which it was, on 2026-09-06, and the driver then failed on a missing
// locator rather than on the bug it exists to catch. The fixture seeded before
// the first page load is what it clicks into now. The reload above left the
// pane on Local, the tab it opens on.
await page.waitForSelector('.item .text');

// The bug above, pinned: a click in the middle of an item's text has to land
// in the middle of it. Silent in Chromium either way, so this only earns its
// keep under PRCODER_PLAYWRIGHT=firefox.
//
// Aimed at the glyphs and not at the box. `.item .text` is `flex: 1`, so its
// box runs to the end of the row and the middle of *that* is well past the end
// of the sentence -- clicking there put the caret at the end of the text, and
// `caret > 0` called it a pass. It read as a real offset for as long as nobody
// compared it to the length: 34 of 34. So measure the text node and aim inside
// it, and fail a caret that has snapped to either end rather than only to the
// start.
const span = await page.locator('.item .text').first().evaluate((el) => {
  const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
  const r = document.createRange();
  r.selectNodeContents(t);
  const { x, y, width, height } = r.getBoundingClientRect();
  return { x, y, width, height, len: t.data.length };
});
await page.mouse.click(span.x + span.width * 0.4, span.y + span.height / 2);
await page.waitForTimeout(200);
const caret = await page.evaluate(() => window.getSelection().anchorOffset);
console.log('caret:  ', `${caret} of ${span.len}`,
  caret > 0 && caret < span.len ? ''
    : caret === 0 ? '  <-- click landed at the start of the text'
      : '  <-- click landed at the end of the text');

// Then two scratch rows on Local for the reorder checks, on top of the fixture
// and put back after, in a finally: everything between here and the restore
// drives a browser, and a hang would otherwise leave them in the store.
const getQueue = () => page.evaluate(() => fetch('/api/queue').then((r) => r.json()));
const queue = await getQueue();
const putQueue = (items) => page.evaluate((body) => fetch('/api/queue', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()), { items });
await putQueue([...queue, ...SCRATCH.map((text) => ({ text }))]);
try {
  await page.reload();
  // The PR head, not a queue row. The checks below read /api/queue half a second
  // after each drop, and the drop's PUT goes through the server's serial lock --
  // behind the page's first status poll, which is several gh calls. Started
  // before that poll lands, the drop worked and the read still saw the old order.
  await page.waitForSelector('#pr-head .pr-title', { timeout: 30_000 });
  await page.waitForTimeout(500);

  // A poll's repaint replaces every row, so one landing mid-drag took the row
  // from under the pointer and the drop reordered nothing. setItems holds a
  // repaint back while a row is marked as dragging; checked directly rather than
  // by racing a real drag against the 60s timer. The control is the same refresh
  // without the mark, which does replace the row.
  //
  // Each refresh has to bring a change: a poll whose list matches the one on
  // screen is skipped without a repaint, so an unchanged refresh keeps every
  // row and the control would pass for the wrong reason. NUDGE goes into the
  // stored queue before each refresh and comes out after.
  const refresh = () => Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/status')),
    page.locator('#pr-refresh').click(),
  ]);
  const nudge = async (on) => {
    const now = (await getQueue()).filter((i) => i.text !== NUDGE);
    await queueApi({ items: on ? [...now, seed({ t: NUDGE })] : now });
  };
  const heldRow = async (dragging) => {
    const row = await page.evaluateHandle(() => document.querySelector('#queue-body .item'));
    if (dragging) await row.evaluate((el) => el.classList.add('dragging'));
    await nudge(true);
    await refresh();
    await page.waitForTimeout(300);
    const kept = await row.evaluate((el) => el.isConnected);
    await row.evaluate((el) => el.classList.remove('dragging'));
    await nudge(false);
    return kept;
  };
  console.log('repaint:', `mid-drag row ${await heldRow(true) ? 'kept' : 'REPLACED'},`,
    `idle row ${await heldRow(false) ? 'KEPT' : 'replaced'}`, '  (want kept, then replaced)');
  await refresh();

  // A row drag carries its own data type. It carried text/plain, which a link
  // or a text selection dropped on a row also carries; Number() of that is NaN,
  // splice() reads NaN as 0, and the queue's first item moved and was saved.
  // The synthetic drop is that case, and the queue must come out of it as the
  // real drag left it.
  const scratch = () => getQueue()
    .then((items) => items.filter((i) => i.text.startsWith('driver scratch')).map((i) => i.text.replace(/^driver scratch item,? /, '')));
  const scratchRows = page.locator('.item', { hasText: 'driver scratch' });
  await scratchRows.nth(1).locator('.grip').dragTo(scratchRows.nth(0));
  await page.waitForTimeout(500);
  const reordered = await scratch();
  const before = (await getQueue()).map((i) => i.text);
  await scratchRows.nth(0).evaluate((li) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'a dropped selection');
    li.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  const after = (await getQueue()).map((i) => i.text);
  console.log('drag:   ', reordered.join(' | '), '  (want "two" first)');

  // The same move without a pointer: the grip takes focus, and Down moves its
  // row past the next one shown -- which puts the pair back how they started --
  // with focus following the row rather than staying put on the old position.
  await scratchRows.nth(0).locator('.grip').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  const keyed = await scratch();
  const focusedRow = await page.evaluate(() => document.activeElement?.closest('.item')?.querySelector('.text')?.textContent);
  console.log('rowkeys:', keyed.join(' | '), `, focus on "${focusedRow}"`,
    '  (want "two" last, focus still on "driver scratch item two")');
  console.log('drop:   ', JSON.stringify(after) === JSON.stringify(before) ? 'unchanged' : 'MOVED',
    '  (want unchanged -- a text drop is not a row)');
} finally {
  await putQueue(queue);
}
console.log('queue:  ', (await getQueue()).length, 'items  (want', queue.length + ')');


// The tab icon, which goes blue while a turn is running and back to green two
// seconds after its output stops -- prcoder's only reading of "Claude is
// working". A PTY echoes what is typed at it, which is what the first half
// turns on: the echo of a keystroke is output, and the icon has to stay green
// through it or it reports busy while Claude is waiting on the operator. Enter
// starts the turn; the stub's echo of the line is then what holds it open.
//
// The last reading is the other bug: the stub keeps sending the cursor-position
// probe throughout, five times a second, exactly as a real session does. Green
// after 2.5s means those are being skipped rather than holding the turn open.
// Before they were, the icon stayed busy from the first paint until the tab
// closed, and every check on a /bin/cat stub passed, because cat never asks.
const iconFill = () => page.evaluate(() =>
  document.querySelector('link[rel=icon]').href.match(/%23(\w{6})/)[1]);
await page.locator('#term-host').click();
await page.keyboard.type('hello');
await page.waitForTimeout(200);
const typing = await iconFill();
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const busy = await iconFill();
await page.waitForTimeout(2500);
console.log('icon:   ', `${typing} while typing, ${busy} after Enter, ${await iconFill()} after 2.5s of probes only`,
  '  (want 238636, 1f6feb, 238636)');

console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
// Last, so this run's label is the newest and is never its own candidate.
await pruneShots(shotsRoot);
