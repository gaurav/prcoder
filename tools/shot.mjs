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
// running.
//
// This is not read-only, and what it writes goes to GitHub. The queue is
// per-branch, so a fresh branch has nothing to photograph; the run seeds five
// items -- one per tab -- and puts the branch's own queue back at the end,
// which also takes the block it mirrored back out of the PR description. A run
// that dies in between leaves both behind, and the next run drops the fixture
// rather than restoring it. Anything you add here that writes needs the same
// treatment, and needs to run against a repo you own.

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

// The queue is per-branch, so a fresh branch has an empty one and there is no
// row to click into or tab to count. Seed one item per tab through the API the
// pane itself uses -- before the first page load, so the pane paints the
// fixture rather than an empty list it would not refetch for another minute.
//
// `inPr` on one of them is a real write to this repo's own PR description --
// that is the feature, and putting the old queue back at the end takes the
// block out again. `issue` is a bare number, so it links to an existing issue
// rather than filing a new one.
const queue = (body, method = 'PUT') =>
  fetch(`http://localhost:${port}/api/queue`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

let had = [];
for (let i = 0; i < 60; i++) {
  try { had = await queue(undefined, 'GET'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const FIXTURE = [
  { t: 'a local item, still only on this machine' },
  // Two locals, because the promotion check below carries one out and the
  // caret check further down still needs a row on Local to click into.
  { t: 'a second local item, to click into' },
  { t: 'carried out to the pull request', inPr: true },
  { t: 'filed as an issue', issue: 20 },
  { t: 'ticked off', done: true },
  { t: 'thrown away', deleted: true },
];
const seed = (over) => ({ text: over.t, done: false, inPr: false, issue: null, deleted: false, ...over });
// A run that dies before the restore leaves its fixture in the store, and with
// it a block in the PR description. Dropping anything that looks like the
// fixture from what we are going to put back makes the next run clean up after
// the last one, rather than restoring the mess and adding to it.
const mine = new Set(FIXTURE.map((f) => f.t));
had = had.filter((i) => !mine.has(i.text));
const seeded = await queue(FIXTURE.map(seed));
console.log('seeded: ', Array.isArray(seeded) ? `${seeded.length} items` : JSON.stringify(seeded));

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

// Every tab, and what each shows. Local draining as items are carried out is
// the whole point of the set, so the counts are read rather than eyeballed --
// and the strip is shot at the pane's own width to see whether five tabs wrap.
const strip = () => page.locator('#queue-body .tab').allTextContents();
console.log('tabs:   ', (await strip()).join(' | '));
for (const name of ['Local', 'PR', 'Issues', 'Completed', 'Deleted']) {
  await page.locator('#queue-body .tab', { hasText: name }).click();
  await page.waitForTimeout(150);
  const rows = await page.locator('.item .text').allTextContents();
  const grips = await page.locator('.item .grip').count();
  console.log(`  ${name.padEnd(9)} ${JSON.stringify(rows)}${grips ? '  [draggable]' : ''}`);
  await page.locator('#queue').screenshot({ path: path.join(out, `queue-${name.toLowerCase()}.png`) });
}
// The claim the tab set is built on: carrying an item out with the row's own ◆
// takes it out of Local. Seeding an already-mirrored item proves the filter;
// only clicking the button proves the transition.
await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);
await page.locator('.item', { hasText: 'a local item' }).locator('button[title*="PR description"]').click();
// Waited for rather than slept past: mirroring is a real read-modify-write
// against the description on GitHub, so the row does not move for a second or
// two and any fixed timeout is either flaky or slower than it needs to be.
await page.locator('#queue-body .tab', { hasText: 'Local (1)' }).waitFor({ timeout: 30_000 });
console.log('promoted:', (await page.locator('#queue-body .tab').allTextContents()).join(' | '));
console.log('  Local now', JSON.stringify(await page.locator('.item .text').allTextContents()));

// The confirm is the only thing between one click and every completed item, so
// check it is load-bearing rather than decorative: dismissing it has to leave
// the counts alone, and only accepting moves them.
const tabs = async () => (await page.locator('#queue-body .tab').allTextContents()).join(' | ');
await page.locator('#queue-body .tab', { hasText: 'Completed' }).click();
await page.waitForTimeout(150);
page.once('dialog', (d) => { console.log('confirm:', JSON.stringify(d.message().split('\n')[0])); d.dismiss(); });
await page.locator('.bulk', { hasText: 'delete all' }).click();
await page.waitForTimeout(500);
console.log('  dismissed', await tabs());
page.once('dialog', (d) => d.accept());
await page.locator('.bulk', { hasText: 'delete all' }).click();
await page.waitForTimeout(800);
console.log('  accepted ', await tabs());

await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);

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

// The two toasts. The reload above is a real trigger for the first one:
// sessionStorage survives it, so ws.onopen decides the session was restarted
// and calls toast() for itself -- which is what says the plain path still
// works. Four seconds and it is gone, hence the screenshot before anything
// else. The sticky one has no read-only trigger (switching PRs would check out
// a branch in this repo), so its class is set the way toast() sets it: the CSS
// and the click-to-dismiss handler are real, the call is not.
const toastText = () => page.evaluate(() => {
  const el = document.getElementById('toast');
  return el.hidden ? null : el.textContent;
});
console.log('toast:  ', JSON.stringify(await toastText()), '  (want the restart notice)');
await page.locator('#toast').screenshot({ path: path.join(out, 'toast.png') }).catch(() => {});
await page.waitForTimeout(4500);
console.log('faded:  ', JSON.stringify(await toastText()), '  (want null -- the 4s timeout)');

// Only now, or the timeout still pending from that one hides this one. toast()
// clears it; setting the class by hand here cannot.
await page.evaluate(() => {
  const el = document.getElementById('toast');
  el.textContent = 'Switched to add-retries (#123). Claude still has the old'
    + " branch's files in mind — tell it to re-read anything it had open.";
  el.className = 'sticky';
  el.hidden = false;
});
await page.waitForTimeout(100);
await page.locator('#toast').screenshot({ path: path.join(out, 'toast-sticky.png') });
await page.screenshot({ path: path.join(out, 'full-toast.png') });   // and what it sits over
await page.waitForTimeout(4500);   // past the 4s a plain toast would have died at
console.log('sticky: ', JSON.stringify(await toastText()), '  (want it still up)');
await page.locator('#toast').click();
console.log('clicked:', JSON.stringify(await toastText()), '  (want null)');

// The bug above, pinned: a click in the middle of an item's text has to land
// in the middle of it. Silent in Chromium either way, so this only earns its
// keep under PRCODER_BROWSER=firefox.
const text = page.locator('.item .text').first();
const tb = await text.boundingBox();
await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.waitForTimeout(200);
const caret = await page.evaluate(() => window.getSelection().anchorOffset);
console.log('caret:  ', caret, caret > 0 ? '' : '  <-- click landed at the start');

// Back to whatever the branch had, which also takes our block back out of the
// PR description on the way past.
console.log('restored:', (await queue(had)).length, 'items (was', had.length + ')');

console.log('engine: ', engine === firefox ? 'firefox' : 'chromium');
console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
