// Screenshot the running UI. A client-side change is otherwise verified by
// reading the CSS, which is how three of them shipped unseen.
//
//   node tools/shot.mjs [outdir]        # default: ./shots (gitignored)
//   PRCODER_BROWSER=firefox node tools/shot.mjs
//
// Firefox is a separate download: `npx playwright install firefox` once.
//
// Scratch driver, not a test: add clicks and locators for whatever you are
// looking at. Two rules for anything you add.
//
// PRCODER_BROWSER=firefox drives Firefox instead. Worth having rather than
// trusting one engine: the caret in a queue item landed at the start in Firefox
// and nowhere else, because a mousedown inside a draggable element goes to the
// drag machinery there, and every screenshot before that had been Chromium.
//
// CLAUDE_BIN is stubbed because every page load opens a websocket and spawns
// it in a PTY -- unstubbed, each run starts a real Claude session and leaves it
// running. And the UI's controls hit the live PR: ticking a description
// checkbox edits the description on GitHub, adding a queue item rewrites
// FUTURE.md. Undo what you write (`git checkout -- FUTURE.md`), or stay
// read-only as this does.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(repo, 'shots'));
const port = Number(process.env.PRCODER_PORT) || 7434;

await fs.mkdir(out, { recursive: true });
const server = spawn('node', ['server.js'], {
  cwd: repo,
  env: { ...process.env, PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', CLAUDE_BIN: '/bin/cat' },
  stdio: 'ignore',
});

const engine = process.env.PRCODER_BROWSER === 'firefox' ? firefox : chromium;
const browser = await engine.launch();
// 1440 is where the PR pane's 26% and its 375px floor cross, so this is the
// width at which the column is doing what it was sized to do.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

for (let i = 0; i < 30; i++) {
  try { await page.goto(`http://localhost:${port}/`); break; } catch { await page.waitForTimeout(500); }
}
// The panes fill in from gh, so there is a second or two of "Loading…" first.
await page.waitForSelector('.file', { timeout: 30_000 });
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
await page.locator('.file .path').first().click();   // opens the diff pane
await page.waitForSelector('main.diff-open');
await drag('#gut-pr', 520, 450);
await drag('#gut-diff', 720, 300);
await drag('#gut-queue', 720, 640);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'dragged.png') });
const dragged = await page.evaluate(() => document.querySelector('main').style.cssText);
await page.reload();
await page.waitForSelector('.file');
const restored = await page.evaluate(() => document.querySelector('main').style.cssText);

console.log('dragged: ', dragged, '  (want --w-pr 520, --h-diff 300, --h-queue 260)');
console.log('restored:', restored, restored === dragged ? '' : '  <-- did not persist');

// The bug above, pinned: a click in the middle of an item's text has to land
// in the middle of it. Silent in Chromium either way, so this only earns its
// keep under PRCODER_BROWSER=firefox.
const text = page.locator('.item .text').first();
const tb = await text.boundingBox();
await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.waitForTimeout(200);
const caret = await page.evaluate(() => window.getSelection().anchorOffset);
console.log('caret:  ', caret, caret > 0 ? '' : '  <-- click landed at the start');

console.log('engine: ', engine === firefox ? 'firefox' : 'chromium');
console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
