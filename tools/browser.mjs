// Drive the running UI in a real browser, and screenshot it. A client-side
// change is otherwise verified by reading the CSS, which is how three of them
// shipped unseen.
//
//   node tools/browser.mjs [outdir]        # default: ./shots (gitignored)
//   PRCODER_BROWSER=firefox node tools/browser.mjs
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
// checkbox edits the description on GitHub, and so does mirroring a queue item
// with the diamond. The queue itself is safe -- it writes only `.prcoder/`,
// which is gitignored. Undo what you write, or stay read-only as this does.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(repo, 'shots'));
const port = Number(process.env.PRCODER_PORT) || 17434;

// server.js falls back to a free port when the one it is given is taken, and
// says so only on a stdout this spawns with `ignore` -- so a driver whose port
// is already held would sail past it and drive whatever *is* on that port. That
// was not hypothetical: a leaked server from an earlier run held this one, and
// the next run screenshotted yesterday's state. Fail here instead, where the
// message can say which port and why.
const free = (p) => new Promise((res, rej) => {
  const probe = createServer();
  probe.once('error', () => rej(new Error(`port ${p} is taken -- something else would be driven instead of this run's server. Stop it, or set PRCODER_PORT.`)));
  probe.once('listening', () => probe.close(res));
  probe.listen(p, '127.0.0.1');
});
await free(port);

await fs.mkdir(out, { recursive: true });
const server = spawn('node', ['server.js'], {
  cwd: repo,
  env: { ...process.env, PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', CLAUDE_BIN: '/bin/cat' },
  stdio: 'ignore',
});
// The kill at the end of the file is load-bearing twice over: a live child
// handle keeps the event loop open, so without it this never exits on its own.
// It only runs if the file reaches the end, though. A throw in between -- a
// missing browser download is the easy one -- left the server up polling gh
// every 60s, and a kill of a run that hung left another; eight accumulated in
// one afternoon. `exit` covers the throw, and the signals are wired to exit
// because their default action would skip the handler. Same three as term.js.
process.on('exit', () => server.kill());
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(130));

// Firefox by default, because that is what prcoder is used in and it is where
// the selection and drag bugs live. Playwright drives its own patched build,
// never the Firefox in /Applications, so this asks whether
// `npx playwright install firefox` has been run -- not whether the machine has
// Firefox. Chromium is the fallback, and PRCODER_BROWSER=chromium|firefox is
// the override; which one ran matters for reading the output, so it is logged.
const engine = { chromium, firefox }[process.env.PRCODER_BROWSER]
  ?? (existsSync(firefox.executablePath()) ? firefox : chromium);
console.log('engine: ', engine.name());
const browser = await engine.launch();
// 1440 is where the PR pane's 26% and its 375px floor cross, so this is the
// width at which the column is doing what it was sized to do.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

for (let i = 0; i < 30; i++) {
  try { await page.goto(`http://localhost:${port}/`); break; } catch { await page.waitForTimeout(500); }
}
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

// The two tabs, and what each says about the other. `Detail (3/10)` /
// `Files (7/23)` is the whole reason the counts are on the labels -- they are
// what you can see while you are looking at the other half.
const tabs = await page.locator('#pr-head .tab').allInnerTexts();
console.log('tabs:    ', tabs.join('  |  '), '  (want a count on each)');

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

// The measure, which is inert at the pane's 375px floor and is the whole reason
// for the cap at the other end of its range.
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
await page.locator('.group > summary').first().click();
await page.waitForTimeout(200);
console.log('after collapsing one:', await page.locator('.group[open]').count(), 'open');
await page.locator('#pr').screenshot({ path: path.join(out, 'pr-files-collapsed.png') });
await page.locator('.group > summary').first().click();
await page.waitForTimeout(200);

await page.locator('.file .path').first().click();   // opens the diff pane (Files tab)
await page.waitForSelector('main.diff-open');
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

// The caret check needs a row on the Local tab to click into, and this repo's
// queue is legitimately empty the moment the last item has been finished or
// filed -- which it was, on 2026-09-06, and the driver then failed on a missing
// locator rather than on the bug it exists to catch. So seed one and put the
// queue back exactly as it was. A local-only item leaves the rendered block
// unchanged, and writeQueue calls setBody only when the block differs, so this
// writes `.prcoder/` and never GitHub.
const queue = await page.evaluate(() => fetch('/api/queue').then((r) => r.json()));
const putQueue = (items) => page.evaluate((i) => fetch('/api/queue', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(i),
}).then((r) => r.json()), items);
await putQueue([...queue, { text: 'driver scratch item, put back at the end of the run' }]);
await page.reload();
await page.waitForSelector('.item .text');

// The bug above, pinned: a click in the middle of an item's text has to land
// in the middle of it. Silent in Chromium either way, so this only earns its
// keep under PRCODER_BROWSER=firefox.
const text = page.locator('.item .text').first();
const tb = await text.boundingBox();
await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.waitForTimeout(200);
const caret = await page.evaluate(() => window.getSelection().anchorOffset);
console.log('caret:  ', caret, caret > 0 ? '' : '  <-- click landed at the start');
await putQueue(queue);
console.log('queue:  ', (await page.evaluate(() => fetch('/api/queue').then((r) => r.json()))).length, 'items  (want', queue.length + ')');

console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
