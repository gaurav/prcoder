// Drive the running UI in a real browser, and screenshot it. A client-side
// change is otherwise verified by reading the CSS, which is how three of them
// shipped unseen.
//
//   node tools/browser.mjs [outdir]        # default: ./data/shots (gitignored)
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
// running. The stub is `tools/claude-stub.mjs` rather than /bin/cat: it echoes
// as cat does, and it also sends the cursor-position probe a real session sends
// between turns, which is the half the icon check needs.
//
// It writes, so it is not read-only. The run replaces the repo's queue with a
// fixture -- at least one item per tab -- and puts the queue back at the end; a
// run that dies in between leaves the fixture behind, and the next run drops it
// rather than restoring it. The queue itself writes only `.prcoder/`.
//
// Nothing here clicks ◇ or ◎. Those move an item into the PR description or a
// new issue, one-way: there is no queue to put back that would take the line
// out of the description again, or close the issue. Anything added here that
// writes to GitHub needs its own undo, and needs to run against a repo you own.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// data/, not a new top-level shots/: this repo's scratch space is data/, and it
// is gitignored precisely so driver output has somewhere to live.
const out = path.resolve(process.argv[2] ?? path.join(repo, 'data', 'shots'));
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
  env: { ...process.env, PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', CLAUDE_BIN: path.join(repo, 'tools', 'claude-stub.mjs') },
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

// The repo's queue may be empty, and then there is no
// row to click into or tab to count -- and the strip only shows a tab that has
// something in it, so an empty queue is a strip of two. Seed one item per tab
// through the API the pane itself uses, before the first page load, so the pane
// paints the fixture rather than an empty list it would not refetch for another
// minute.
//
// `issue` is a bare number, so it links to an existing issue rather than filing
// a new one, and the item stays on Local like any other.
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
  { t: 'a second local item, to click into' },
  { t: 'linked to an issue', issue: 20 },
  { t: 'ticked off', done: true },
  { t: 'thrown away', deleted: true },
];
const seed = (over) => ({ text: over.t, done: false, issue: null, deleted: false, ...over });
// A run that dies before the restore leaves its fixture in the store. Dropping
// anything that looks like the fixture from what we are going to put back makes
// the next run clean up after the last one, rather than restoring the mess and
// adding to it.
const mine = new Set(FIXTURE.map((f) => f.t));
had = had.filter((i) => !mine.has(i.text));
const seeded = await queueApi({ items: FIXTURE.map(seed) });
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
await page.locator('.item', { hasText: SENT }).locator('button[title="send to Claude, and check it off"]').click();
await page.locator('#queue-body .tab', { hasText: 'Local (2)' }).waitFor({ timeout: 10_000 });
await page.waitForTimeout(400);   // the stub echoes on the PTY's own schedule
const echoed = (await page.locator('#term-host').innerText()).includes(SENT);
console.log('row ▶:  ', await local(), '+', await page.locator('#queue-body .tab', { hasText: /^Completed/ }).innerText(),
  `, terminal echoed it: ${echoed}`, ' (want it off Local, on Completed, and echoed true)');
await page.locator('#queue-body .tab', { hasText: 'Completed' }).click();
await page.waitForTimeout(150);
// The way back, which is why this is a tick and not a delete: the box that
// checked itself unchecks.
await page.locator('.item', { hasText: SENT }).locator('input[type=checkbox]').uncheck();
await page.locator('#queue-body .tab', { hasText: 'Local (3)' }).waitFor({ timeout: 10_000 });
await page.locator('#queue-body .tab', { hasText: 'Local' }).click();
await page.waitForTimeout(150);
console.log('unticked:', await local(), ' (want Local (3) again)');

// The source tabs, which read GitHub rather than the queue. The PR tab is this
// PR's own checklist: one box ticked from here and unticked again is two real
// edits to the description, checked to leave the body as it was -- read back
// through /api/status, whose copy is the one editBody replaced after each
// write. Issues is the issues the description mentions without closing them;
// ↓ copies one into Local without touching the issue, and the queue restore at
// the end takes the copy back out.
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

// The head's way out of the pane, which is only right-aligned on screen: the
// stylesheet says `justify-content: flex-end` on a row that is `.meta` as well,
// and whether those two agree is a fact about the browser. Measured against the
// head's own content box, with the title's left edge as the control -- the row
// moved, the rest of the head did not.
console.log('head:   ', await page.evaluate(() => {
  const row = document.querySelector('#pr-head .pr-links');
  const head = document.getElementById('pr-head');
  const pad = parseFloat(getComputedStyle(head).paddingRight);
  const edge = Math.round(head.getBoundingClientRect().right - pad);
  const title = document.querySelector('#pr-head .pr-title').getBoundingClientRect();
  return `${[...row.querySelectorAll('a')].map((a) => a.textContent).join(' ')} | row right ${
    Math.round(row.getBoundingClientRect().right)} of ${edge}, title left ${Math.round(title.left)}`;
}), ' (want the row flush with the head edge, the title still at the margin)');
console.log('out:    ', await page.evaluate(() =>
  [...document.querySelectorAll('#pr-head .pr-links a')].map((a) => a.href).join(' ')));
// The dots between them are delimiters, and were an `a::before` -- which is
// inside the link's box, so they were underlined with it and a press on one
// followed the link to its right. Hit-tested rather than read off the DOM: that
// a separator is its own element says nothing about where a click lands.
console.log('dots:   ', await page.evaluate(() =>
  [...document.querySelectorAll('#pr-head .pr-links span')].map((sep) => {
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

// Home just put the pane back on its 375px floor, which is the one width where
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
// the first page load is what it clicks into now. The reload above left the
// pane on Local, the tab it opens on.
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

// Then two scratch rows on Local for the reorder checks, on top of the fixture
// and put back after, in a finally: everything between here and the restore
// drives a browser, and a hang would otherwise leave them in the store.
const queue = await page.evaluate(() => fetch('/api/queue').then((r) => r.json()));
const putQueue = (items) => page.evaluate((body) => fetch('/api/queue', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()), { items });
await putQueue([...queue,
  { text: 'driver scratch item, put back at the end of the run' },
  { text: 'driver scratch item two' }]);
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
  const heldRow = async (dragging) => {
    const row = await page.evaluateHandle(() => document.querySelector('#queue-body .item'));
    if (dragging) await row.evaluate((el) => el.classList.add('dragging'));
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/status')),
      page.locator('#pr-refresh').click(),
    ]);
    await page.waitForTimeout(300);
    const kept = await row.evaluate((el) => el.isConnected);
    await row.evaluate((el) => el.classList.remove('dragging'));
    return kept;
  };
  console.log('repaint:', `mid-drag row ${await heldRow(true) ? 'kept' : 'REPLACED'},`,
    `idle row ${await heldRow(false) ? 'KEPT' : 'replaced'}`, '  (want kept, then replaced)');

  // A row drag carries its own data type. It carried text/plain, which a link
  // or a text selection dropped on a row also carries; Number() of that is NaN,
  // splice() reads NaN as 0, and the queue's first item moved and was saved.
  // The synthetic drop is that case, and the queue must come out of it as the
  // real drag left it.
  const scratch = () => page.evaluate(() => fetch('/api/queue').then((r) => r.json()))
    .then((items) => items.filter((i) => i.text.startsWith('driver scratch')).map((i) => i.text.replace(/^driver scratch item,? /, '')));
  const scratchRows = page.locator('.item', { hasText: 'driver scratch' });
  await scratchRows.nth(1).locator('.grip').dragTo(scratchRows.nth(0));
  await page.waitForTimeout(500);
  const reordered = await scratch();
  const before = (await page.evaluate(() => fetch('/api/queue').then((r) => r.json()))).map((i) => i.text);
  await scratchRows.nth(0).evaluate((li) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'a dropped selection');
    li.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  const after = (await page.evaluate(() => fetch('/api/queue').then((r) => r.json()))).map((i) => i.text);
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
console.log('queue:  ', (await page.evaluate(() => fetch('/api/queue').then((r) => r.json()))).length, 'items  (want', queue.length + ')');

// Back to whatever the repo had.
console.log('restored:', (await queueApi({ items: had })).length, 'items (was', had.length + ')');

// The tab icon, which goes blue while the PTY is printing and back to green two
// seconds after it stops -- prcoder's only reading of "Claude is working". A
// PTY echoes what is typed at it, so a keystroke here is the same burst of
// output a Claude turn is made of.
//
// The green half is the one that matters: the stub keeps sending the
// cursor-position probe throughout, five times a second, exactly as a real
// session does between turns. Green here means those are being skipped. Before
// they were, the icon stayed busy from the first paint until the tab closed,
// and every check on a /bin/cat stub passed, because cat never asks.
const iconFill = () => page.evaluate(() =>
  document.querySelector('link[rel=icon]').href.match(/%23(\w{6})/)[1]);
await page.locator('#term-host').click();
await page.keyboard.type('hello');
await page.waitForTimeout(200);
const busy = await iconFill();
await page.waitForTimeout(2500);
console.log('icon:   ', `${busy} while printing, ${await iconFill()} after 2.5s of probes only`,
  '  (want 1f6feb then 238636)');

console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
