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
// running.
//
// This is not read-only, and what it writes goes to GitHub. The queue is
// per-branch, so a fresh branch has nothing to photograph; the run seeds six
// items -- at least one per tab -- and puts the branch's own queue back at the
// end, which also takes the block it mirrored back out of the PR description.
// Ticking a description checkbox edits the description on GitHub too, and so
// does mirroring a queue item with the diamond. A run that dies in between
// leaves both behind, and the next run drops the fixture rather than restoring
// it. Anything you add here that writes needs the same treatment, and needs to
// run against a repo you own.

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

// The queue is per-branch, so a fresh branch has an empty one and there is no
// row to click into or tab to count -- and the strip only shows a tab that has
// something in it, so an empty queue is a strip of two. Seed one item per tab
// through the API the pane itself uses, before the first page load, so the pane
// paints the fixture rather than an empty list it would not refetch for another
// minute.
//
// `inPr` on one of them is a real write to this repo's own PR description --
// that is the feature, and putting the old queue back at the end takes the
// block out again. `issue` is a bare number, so it links to an existing issue
// rather than filing a new one.
const queueApi = (body, method = 'PUT') =>
  fetch(`http://localhost:${port}/api/queue`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

let had = [];
for (let i = 0; i < 60; i++) {
  try { had = await queueApi(undefined, 'GET'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
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
const seeded = await queueApi(FIXTURE.map(seed));
console.log('seeded: ', Array.isArray(seeded) ? `${seeded.length} items` : JSON.stringify(seeded));

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


// Every queue tab, and what each shows. Local draining as items are carried out
// is the whole point of the set, so the counts are read rather than eyeballed
// -- and the strip is shot at the pane's own width to see whether five tabs
// wrap. `#queue-body .tab` and not `.tab`: the pull request pane has a strip of
// its own, driven further down.
const queueStrip = () => page.locator('#queue-body .tab').allTextContents();
console.log('q tabs: ', (await queueStrip()).join(' | '));
for (const name of ['Local', 'PR', 'Issues', 'Completed', 'Deleted']) {
  await page.locator('#queue-body .tab', { hasText: name }).click();
  await page.waitForTimeout(150);
  const rows = await page.locator('.item .text').allTextContents();
  const grips = await page.locator('.item .grip').count();
  console.log(`  ${name.padEnd(9)} ${JSON.stringify(rows)}${grips ? '  [draggable]' : ''}`);
  await page.locator('#queue').screenshot({ path: path.join(out, `queue-${name.toLowerCase()}.png`) });
}
// Five tabs is as many as this strip will ever hold, and 1440px is the only
// width it had been looked at -- where they fit easily. The pane the queue
// actually lives in is whatever is left after the PR column, so drag that wide
// and ask the tabs themselves whether they are still on one row: same offsetTop
// for the first and the last is the only version of "does not wrap" that does
// not depend on reading a screenshot.
await drag('#gut-pr', 980, 450);
await page.waitForTimeout(300);
const wrap = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#queue-body .tab')];
  const pane = document.getElementById('queue').getBoundingClientRect().width;
  return { rows: new Set(t.map((b) => b.offsetTop)).size, n: t.length, pane: Math.round(pane) };
});
console.log('narrow: ', `${wrap.n} tabs on ${wrap.rows} row(s) in a ${wrap.pane}px pane`,
  wrap.rows === 1 ? '' : '  <-- the strip wrapped');
await page.locator('#queue').screenshot({ path: path.join(out, 'queue-narrow.png') });
await drag('#gut-pr', 375, 450);
await page.waitForTimeout(300);

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
console.log('promoted:', (await queueStrip()).join(' | '));
console.log('  Local now', JSON.stringify(await page.locator('.item .text').allTextContents()));

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
await page.locator('#queue-body .tab', { hasText: 'Local (0)' }).waitFor({ timeout: 10_000 });
console.log('row ✕:  ', await local(), '+', await page.locator('#queue-body .tab', { hasText: /^Deleted/ }).innerText());
await page.locator('#queue-body .tab', { hasText: 'Deleted' }).click();
await page.waitForTimeout(150);
await page.locator('.item', { hasText: 'a second local item' }).locator('button[title="restore"]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (1)' }).waitFor({ timeout: 10_000 });
await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);
console.log('row ↩:  ', await local(), JSON.stringify(await page.locator('.item .text').allTextContents()));

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

// A dotfile's leading dot, which `direction: rtl` moves to the other end
// unless the <bdi> inside is doing its job -- `.gitignore` drawn as
// `gitignore.`. Measured rather than eyeballed: the dot is invisible at this
// size and reads as a full stop either way.
console.log('dotfile paths draw in order:', await page.evaluate(() => {
  const dots = [...document.querySelectorAll('.file .path')]
    .filter((a) => a.title.startsWith('.'));
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
// locator rather than on the bug it exists to catch. The fixture seeded before
// the first page load is what it clicks into now, which is why that list keeps
// a second local item after the promotion check above carries the first one
// out. The reload above left the pane on Local, the tab it opens on.
await page.waitForSelector('.item .text');

// The bug above, pinned: a click in the middle of an item's text has to land
// in the middle of it. Silent in Chromium either way, so this only earns its
// keep under PRCODER_BROWSER=firefox.
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

// Back to whatever the branch had, which also takes our block back out of the
// PR description on the way past.
console.log('restored:', (await queueApi(had)).length, 'items (was', had.length + ')');

console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
