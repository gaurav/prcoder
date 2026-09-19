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
// between turns, which is the half the icon check needs. And the UI's controls hit the live PR: ticking a description
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
// Everything below is written against this repo's PR #1 -- its sections, its
// file groups, its issue chips -- and the server follows the current branch, so
// a run from any other branch drives a pull request the assertions do not fit.
// PRCODER_PR pins one; unset is the old branch-following behaviour.
const server = spawn('node', ['server.js', ...(process.env.PRCODER_PR ? [process.env.PRCODER_PR] : [])], {
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
const forced = { chromium, firefox }[process.env.PRCODER_BROWSER];
const engine = forced ?? (existsSync(firefox.executablePath()) ? firefox : chromium);
console.log('engine: ', engine.name());
// Which of the server's two ways of finding a pull request this run is about to
// exercise. Worth saying out loud: pinning one is the only way to drive the
// panes from a feature branch, and it is also the way to run the whole file and
// never touch the path every real user is on. A run from `initial-implementation`
// with PRCODER_PR unset is what covers that path, and this line is how a reader
// knows which of the two they just did.
console.log('pr:     ', process.env.PRCODER_PR
  ? `pinned to #${process.env.PRCODER_PR} (branch-following not exercised)`
  : "following the current branch");
// existsSync above says the build was downloaded, not that it starts, and on
// macOS 27 Firefox does not -- see tools/firefox-runner. So the fallback has to
// survive a launch that fails as well as one that was never installed, or the
// default run waits out Playwright's 180s timeout and dies with no browser at
// all. The wait is 45s here because this is the unattended path and a browser
// that has not started by then is not starting; a forced engine keeps the full
// timeout and is left to fail, since falling back is the wrong answer to
// someone who asked for Firefox by name.
const browser = await (async () => {
  try {
    return await engine.launch(forced ? {} : { timeout: 45_000 });
  } catch (err) {
    if (forced || engine === chromium) throw err;
    console.log(`engine:  ${engine.name()} would not start, falling back to chromium`);
    console.log('        ', String(err).split('\n')[0]);
    return chromium.launch();
  }
})();
// The PR pane opens at 375px at any window width, so 1440 is simply a
// common laptop size with room for all three panes.
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

// The issue lists' titles. Where the lists sit and how a row is shaped is
// test/browser.test.js's now, against a fixture -- what a fixture cannot say is
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
  ' (want names without the directory above them)');
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

await page.locator('.file .path').first().click();   // opens the diff pane (Files tab)
await page.waitForSelector('main.diff-open');
// The title says whether the pane holds a change or a whole file; every file in
// PR #1 is one the PR adds, so it should read NEW there and DIFF nowhere.
await page.waitForFunction(() => document.querySelectorAll('#diff-body .dl').length > 0);
console.log('diff title:', await page.locator('#diff h1').innerText(), ' (want NEW: every file in PR #1 is added)');
console.log('outline:', await page.locator('#diff-outline').evaluate((n) => `${n.children.length} rows, ${getComputedStyle(n).display}`),
  ' (want 0 rows, none: a whole file has no hunks to list)');

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
  await page.locator('.file .path').first().click();
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
// The route takes `{items}` and replaces the list wholesale -- one queue for the
// repo, whatever is checked out.
const putQueue = (items) => page.evaluate((body) => fetch('/api/queue', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()), { items });
await putQueue([...queue,
  { text: 'driver scratch item, put back at the end of the run' },
  { text: 'driver scratch item two' }]);
// finally, because everything between here and the restore drives a browser: a
// reload that hangs or a locator that times out would otherwise leave the
// scratch item sitting in the live .prcoder/queue.json, and this driver is run
// against a queue somebody is using.
try {
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
