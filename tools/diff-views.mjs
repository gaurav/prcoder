#!/usr/bin/env node
// The diff pane's views that PR #1 cannot show, driven against a pull request
// built to show them.
//
//   node tools/diff-views.mjs [label]      # PNGs to data/shots/<label>/, default `diff-views`
//
// Every file in PR #1 is one the pull request adds, so tools/browser.mjs only
// ever opens the NEW view of a file with no hunks. This drives PR #87 instead:
// a draft that is never merged, from `fixture/diff-views` into
// `fixture/diff-views-base`, an orphan base with none of prcoder's history, so
// it stays the same files whatever happens to main. Its description says what
// each file is for. `src/service.js` is modified in two places (the DIFF view,
// and an outline with two rows), `notes/old.txt` is deleted (DELETED),
// `src/Badge.tsx` is added (NEW, and the one .tsx file any real pull request
// here has -- #74), and two files are renamed, one untouched and one with a
// line changed.
//
// The server is this working tree's, pinned to the fixture by number. Nothing
// here writes to GitHub: it opens files and toggles the outline, and the only
// preferences it changes it puts back.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { openShots, pruneShots } from './shots.mjs';
import { repo, free, serverEnv, killOnExit, openPage, launchBrowser } from './driver.mjs';

const FIXTURE = 87;
const shotsRoot = path.join(repo, 'data', 'shots');
const label = process.argv[2] ?? 'diff-views';
const port = Number(process.env.PRCODER_PORT) || 17436;

// Checked before anything starts: a fixture that has been closed, or whose
// branches were deleted, loads no pull request, and every check below would
// then fail as a 30-second timeout that reads like a hung server.
const fixture = spawnSync('gh', ['pr', 'view', String(FIXTURE), '--json', 'state,headRefName,baseRefName'],
  { cwd: repo, encoding: 'utf8' });
const state = fixture.status === 0 ? JSON.parse(fixture.stdout) : null;
if (state?.state !== 'OPEN') {
  console.error(`fixture PR #${FIXTURE} is ${state ? state.state.toLowerCase() : 'not readable'}`
    + ` (${state ? `${state.headRefName} into ${state.baseRefName}` : fixture.stderr.trim()}).`
    + ' Reopen it -- the branches are fixture/diff-views and fixture/diff-views-base -- or point FIXTURE at its replacement.');
  process.exit(1);
}

await free(port);
const out = await openShots(shotsRoot, label);
const server = spawn('node', ['server.js', String(FIXTURE)], { cwd: repo, env: serverEnv(port), stdio: 'ignore' });
killOnExit(server);
console.log('pr:     ', `pinned to the fixture, #${FIXTURE}`);

const browser = await launchBrowser();
const page = await openPage(browser, port);
await page.waitForSelector('#pr-head .pr-title', { timeout: 30_000 });
await page.getByRole('button', { name: /^Files/ }).click();
await page.waitForSelector('.file');

/** Open one file, wait for its rows, and say what the pane shows. */
async function open(file) {
  await page.locator(`.file[data-path="${file}"] .path`).click();
  await page.waitForFunction((f) => document.querySelector('.file.sel')?.dataset.path === f
    && document.querySelectorAll('#diff-body .dl').length > 0, file);
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('#diff-body .dl span')];
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    return {
      title: document.querySelector('#diff h1').innerText,
      rows: [...document.querySelectorAll('#diff-outline button')].map((b) => b.textContent),
      side: shown('diff-side'),
      spans: spans.length,
      classes: [...new Set(spans.flatMap((s) => [...s.classList]))].sort().join(' '),
    };
  });
}

// --- modified: the plain DIFF view and its outline ---

const mod = await open('src/service.js');
console.log('modified:', mod.title, `(want DIFF)`);
console.log('          ', mod.spans, 'token spans', '(want 0: only a file the PR adds is highlighted, #68)');
console.log('outline: ', mod.rows.length, 'rows:', mod.rows.join(' | '), mod.side ? '' : '  <-- hidden',
  '\n           (want 2 rows, named by the function git puts after each @@)');
await page.locator('#diff').screenshot({ path: path.join(out, 'modified.png') });

// A row scrolls the body to its hunk: the second hunk's first line should be
// at the top of the body afterwards.
await page.locator('#diff-outline button').nth(1).click();
await page.waitForTimeout(200);
const scrolled = await page.evaluate(() => document.getElementById('diff-body').scrollTop);
console.log('scroll:  ', scrolled > 0 ? 'moved' : 'did not move', '(want moved -- or 0 if the diff fits the pane)');

// The gutter between the body and the outline writes a distance from <main>'s
// right edge, which is the outline's own width. Dragged, that number has to
// match where the cursor let go -- a drift would show as a mismatch.
const gut = await page.locator('#gut-outline').boundingBox();
const y = gut.y + gut.height / 2;
await page.mouse.move(gut.x + gut.width / 2, y);
await page.mouse.down();
await page.mouse.move(gut.x - 80, y, { steps: 8 });
await page.mouse.up();
const widths = await page.evaluate(() => {
  const main = document.querySelector('main').getBoundingClientRect();
  const side = document.getElementById('diff-side').getBoundingClientRect();
  return { side: Math.round(side.width), fromRight: Math.round(main.right - side.left) };
});
console.log('gutter:  ', `outline ${widths.side}px wide, its left edge ${widths.fromRight}px from <main>'s right`,
  '(want the two within a gutter width of each other)');
// Home puts it back where it was, from the keyboard, so the run leaves the
// layout as it found it.
await page.locator('#gut-outline').focus();
await page.keyboard.press('Home');

// ✕ hides the outline for every file, *Outline* in the header brings it back,
// and the choice survives a reload.
await page.locator('#diff-outline-hide').click();
const hidden = await page.evaluate(() => ({
  off: document.getElementById('diff').classList.contains('outline-off'),
  show: getComputedStyle(document.getElementById('diff-outline-show')).display !== 'none',
  focus: document.activeElement?.id,
}));
console.log('hide:    ', JSON.stringify(hidden), '(want off, show button visible, focus on diff-outline-show)');
await page.locator('#diff').screenshot({ path: path.join(out, 'outline-hidden.png') });
await page.reload();
await page.waitForSelector('#pr-head .pr-title');
await page.getByRole('button', { name: /^Files/ }).click();
await open('src/service.js');
console.log('reload:  ', await page.evaluate(() => document.getElementById('diff').classList.contains('outline-off'))
  ? 'still hidden' : 'shown again', '(want still hidden)');
await page.locator('#diff-outline-show').click();
console.log('show:    ', await page.evaluate(() => ({
  off: document.getElementById('diff').classList.contains('outline-off'),
  focus: document.activeElement?.id,
})), '(want off false, focus on diff-outline-hide)');

// --- deleted ---

const del = await open('notes/old.txt');
console.log('deleted: ', del.title, `(want DELETED)`, del.rows.length, 'outline rows', '(want 0: a whole file has no hunks)');
await page.locator('#diff').screenshot({ path: path.join(out, 'deleted.png') });

// --- added .tsx: NEW, highlighted by the grammar built on jsx and typescript ---

const tsx = await open('src/Badge.tsx');
const tags = await page.$$eval('#diff-body .tok-tag', (els) => [...new Set(els.map((e) => e.textContent.trim()).filter(Boolean))]);
console.log('tsx:     ', tsx.title, `(want NEW), ${tsx.spans} spans`);
console.log('          ', 'tags:', tags.join(' ') || '(none)', '(want span and strong among them)');
console.log('          ', tsx.classes, '\n           (want tok-tag and tok-attr-name: without jsx under it, markup is operators)');
await page.locator('#diff').screenshot({ path: path.join(out, 'tsx.png') });

// --- renamed: where it came from, alone or above a hunk ---

const rows = () => page.$$eval('#diff-body .dl', (els) => els.map((e) => e.textContent));
const moved = await open('lib/formatting.js');
const movedRows = await rows();
console.log('renamed: ', moved.title, JSON.stringify(movedRows),
  '(want only ["renamed from lib/format.js"]: nothing else changed)');
await page.locator('#diff').screenshot({ path: path.join(out, 'renamed.png') });
await open('lib/text.js');
const edited = await rows();
console.log('          ', JSON.stringify(edited[0]), `then ${edited.length - 1} rows`,
  '(want "renamed from lib/strings.js", then the hunk)');
await page.locator('#diff').screenshot({ path: path.join(out, 'renamed-edited.png') });

await browser.close();
console.log('shots:  ', out);
await pruneShots(shotsRoot);
process.exit(0);
