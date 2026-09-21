// The pull request pane in a real browser, as a test rather than a driver.
//
// The real page from the real server, started in-process the way api.test.js
// does. What the page asks the server for is answered by the browser instead:
// Playwright fulfils the API routes with a fixture and mocks the /pty socket, so
// the server only ever serves static files. No gh, no git, no claude, no PTY,
// no port to pin and nothing left running -- and no harness either. The path
// exercised is app.js -> renderPrTab -> description -> taskRow -> writeThrough,
// which is the pane, and it is the part test/pr.test.js cannot reach: it runs
// pr.js in Node with no DOM, and everything from parsed blocks to elements is
// unexported.
//
// What it asserts is what has shipped broken here believing the CSS (#6,
// docs/Verifying.md): raw markup showing as text, headings not rendering as
// headings, checkboxes that did not write back.
//
// The one thing it cannot see: the status fixture below is shaped by hand from
// what /api/status answers today. A field the server renames and the client
// follows would still pass here. The gh stub (the issue after #6) is what puts
// the server's own shaping in front of this test; until then, groups and checks
// at least come from the server's shapers.
//
// Two things about the shape of this file, both of which have cost a debugging
// session. The tests below share one page, so a tick in one is still ticked in
// the next -- assert a count against what the page shows rather than against a
// number written here, or the test that changes it breaks the test that reads
// it. And every `route` mock is this repo's own copy of a route's contract: the
// server can change its answer and nothing here will fail, because no test
// calls the real handler. When a route's response shape changes, the mock is
// not optional follow-up -- it is part of that change, and a merge that carries
// this file to a branch whose routes have moved on will pass its own diff and
// blank the pane at runtime. That happened merging into queue-tabs on
// 2026-09-19, where /api/pr/task answers with the new body and the old mock's
// `{queue: null}` assigned undefined over it.
//
// Chromium only, like tools/no-pr.mjs, and skipped rather than failed when
// Playwright or its browser is missing: `npm test` on a machine without either
// stays green with a note, and CI is where this is enforced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { server } from '../server.js';
import { groupFiles } from '../files.js';
import { rollup } from '../github.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const skip = !chromium ? 'playwright is not installed (npm ci without --omit=dev)'
  : !existsSync(chromium.executablePath()) ? 'chromium is not installed: npx playwright install chromium'
    : false;

// Each line here is a regression: `_for_` showed its underscores, the comment
// and prcoder's own markers showed as text, `##` rendered literally, and a
// <details> left a stray `</details>` behind. The quote is here because neither
// of this repo's own descriptions has one, so no driver run ever showed it. The
// tasks are in the lead, above the first `##`, because sections render folded
// and a click needs a visible box.
const BODY = [
  'Prose with _for_ in it, and a mention of #7.',
  '',
  '> A quoted line',
  '> that continues.',
  '',
  '<!-- a comment',
  'spanning two lines -->',
  '',
  '- [ ] first task',
  '- [x] second task',
  '',
  '## Notes on the change',
  '',
  '### A sub-heading',
  '',
  '<details><summary>Folded notes</summary>',
  '',
  'Inside the fold.',
  '',
  '</details>',
  '',
  '## Before merging',
  '',
  '<!-- prcoder:todo -->',
  '- [ ] a queue item',
  '<!-- /prcoder:todo -->',
].join('\n');

// A long slug on purpose: the head's repository line is built to be clipped,
// and `example/repo` fits any pane this ever opens at. This one is real.
const REPO = 'https://github.com/heal-data-stewards/heal-non-data-dictionaries';
// One added file, with markup in it: the diff pane highlights a NEW file from
// Prism's tokens, and this is the source that shows if any of it is ever built
// as HTML rather than text.
const SOURCE = 'const s = "<script>alert(1)</script>"; // <img src=x onerror=alert(2)>\n\nf(1)';
// The one extension whose grammar is not built on core alone: prism-tsx needs
// the jsx and typescript grammars under it, and without them the markup below
// tokenizes as operators and bare text rather than tags and attributes.
const TSX = 'const B = ({ n }: { n: number }) => <div className="b">{n}</div>;';
const added = { 'evil.js': SOURCE, 'app.tsx': TSX };
const files = Object.keys(added).map((p, i) => ({
  path: p, additions: added[p].split('\n').length, deletions: 0, viewed: false,
  url: `${REPO}/pull/12/files#diff-${i}`, blob: `${REPO}/blob/aaaa/${p}`,
  blame: `${REPO}/blame/aaaa/${p}`, history: `${REPO}/commits/aaaa/${p}`,
}));
const pr = {
  number: 12, title: 'A fixture pull request', body: BODY, url: `${REPO}/pull/12`,
  state: 'OPEN', isDraft: false, headRefName: 'topic', baseRefName: 'main',
  additions: 1, deletions: 0, changedFiles: 1, files,
  headRefOid: 'a'.repeat(40), updatedAt: '2026-09-19T00:00:00Z', isCrossRepository: false,
  reviewDecision: '', nodeId: 'PR_fixture',
  checks: rollup([]), counts: { comments: 0, reviews: 0 },
  issues: [{ number: 7, url: `${REPO}/issues/7`, closes: false, title: 'Per-route locking' }],
  groups: groupFiles(files),
};
const status = {
  branch: 'topic', head: 'b'.repeat(40), detached: false, dirtyFiles: [], sync: 'synced', ahead: 0,
  defaultBranch: 'main', nameWithOwner: 'heal-data-stewards/heal-non-data-dictionaries',
  scope: 'current', mirrorFailed: false,
  pr, queue: [],
};

let browser;
let page;
const posted = [];

// A page with every route answered, so a test that needs a module map of its
// own -- Prism loads once per page -- can open a second one.
async function newPage() {
  const p = await browser.newPage();
  await p.routeWebSocket('**/pty', () => {});
  await p.route('**/api/status', (r) => r.fulfill({ json: status }));
  await p.route('**/api/prs', (r) => r.fulfill({ json: [] }));
  await p.route('**/api/queue', (r) => r.fulfill({ json: [] }));
  await p.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    const lines = added[path].split('\n');
    return r.fulfill({ json: {
      path, patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n'),
    } });
  });
  // Answered in the shape the route uses on `queue-tabs` -- the body GitHub now
  // holds -- rather than this branch's `{queue}`, because both are right here
  // and only one is right there. toggleTask reads `queue` off the response and
  // finds none, which is what `{queue: null}` said; the branch that reads
  // `body` repaints its checkboxes from it. A mock written for one branch is
  // the trap at the head of this file: it merges without a murmur and blanks
  // the pane at runtime.
  await p.route('**/api/pr/task', (r) => {
    const task = r.request().postDataJSON();
    posted.push(task);
    const box = task.done ? '- [x] ' : '- [ ] ';
    return r.fulfill({ json: { body: BODY.replace(`- [${task.done ? ' ' : 'x'}] ${task.text}`, box + task.text) } });
  });
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.waitForSelector('#pr-head .pr-title');
  return p;
}

before(async () => {
  if (skip) return;
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  browser = await chromium.launch();
  page = await newPage();
});

// Without both, `node --test` never exits.
after(async () => {
  await browser?.close();
  if (server.listening) await new Promise((res) => server.close(res));
});

test('raw markup does not reach the page as text', { skip }, async () => {
  // textContent, not innerText: the folded sections are hidden, and a stray
  // `</details>` inside one is exactly what this is for.
  const text = await page.$eval('#pr-body .md', (el) => el.textContent);
  for (const raw of ['<!--', '-->', '##', '</details>', '<summary>', '_for_', '> ']) {
    assert.ok(!text.includes(raw), `${JSON.stringify(raw)} rendered as text in: ${text}`);
  }
  assert.ok(text.includes('Prose with for in it'), text);
});

test('a > run is one quote, its lines kept as lines', { skip }, async () => {
  const quotes = page.locator('#pr-body .md blockquote');
  assert.equal(await quotes.count(), 1);
  // innerText, so the <br> the renderer puts between the lines reads as one.
  assert.equal(await quotes.first().evaluate((el) => el.innerText), 'A quoted line\nthat continues.');
});

test('a ## starts a folded section, and deeper headings keep their depth', { skip }, async () => {
  assert.deepEqual(await page.locator('.md-section > summary h3').allTextContents(),
    ['Notes on the change', 'Before merging']);
  assert.equal(await page.locator('.md-section[open]').count(), 0, 'sections open by default');
  // Two levels down from the section heading, so ### is h5 and the <summary>
  // promoted to #### is h6.
  assert.deepEqual(await page.locator('.md-section h5').allTextContents(), ['A sub-heading']);
  assert.deepEqual(await page.locator('.md-section h6').allTextContents(), ['Folded notes']);
});

test('checkboxes render with their state, and a tick posts through', { skip }, async () => {
  const boxes = page.locator('.task input[type=checkbox]');
  assert.equal(await boxes.count(), 3);
  assert.deepEqual(await boxes.evaluateAll((list) => list.map((b) => b.checked)), [false, true, false]);
  assert.equal(await page.locator('.task.done').count(), 1);

  await boxes.first().click();
  await page.waitForFunction(() => document.querySelectorAll('.task.done').length === 2);
  assert.deepEqual(posted, [{ index: 0, done: true, text: 'first task' }]);
});

test('the issues the description mentions are listed below it, titled', { skip }, async () => {
  assert.deepEqual(await page.locator('.issues-label').allTextContents(), ['Mentions']);
  const row = page.locator('.issues a').first();
  assert.equal(await row.textContent(), '#7 Per-route locking');
  assert.equal(await row.getAttribute('href'), `${REPO}/issues/7`);
});

test('the tab carries the task count', { skip }, async () => {
  const tabs = await page.locator('#pr-head .tab').allTextContents();
  assert.ok(tabs.includes('Detail (1/3)'), JSON.stringify(tabs));
});

// The repository is the one link in the head with no bound on its width, which
// is why it is no longer in the row: it wrapped the row and moved the three
// lists around with it. Asserted as a place in the DOM rather than as a
// rendered width, because that is what the truncation below hangs off.
test('the repository is a line of its own, not a link in the row', { skip }, async () => {
  assert.deepEqual(await page.locator('#pr-head .pr-links a').allTextContents(),
    ['PR #12', 'issues', 'pulls', 'milestones']);
  const repo = page.locator('#pr-head .pr-repo a');
  assert.equal(await repo.textContent(), 'heal-data-stewards/heal-non-data-dictionaries');
  assert.equal(await repo.getAttribute('href'), REPO);
  assert.equal(await repo.getAttribute('title'), 'heal-data-stewards/heal-non-data-dictionaries');
});

// The point of the two spans, and the one thing here no unit test can see:
// which half of the slug survives a pane too narrow for it. The owner clips and
// the name does not, so what is left says which checkout this is -- the owner
// is the same all day.
//
// Narrowed by writing `--w-pr` on <main>, which is exactly what dragging the
// gutter writes (see panes.js): 200px is a pane someone has pulled in to give
// the terminal the window, and the stylesheet's clamp floor is 180px, so this
// is a width the app really reaches. The default 375px is checked first, both
// as the control and because a line that clips when it did not need to would
// pass every assertion below.
test('a slug wider than the pane clips the owner and keeps the name whole', { skip }, async () => {
  const fresh = await newPage();
  const box = (sel) => fresh.$eval(sel, (el) =>
    ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right }));
  const whole = await box('#pr-head .pr-repo a');
  assert.equal(whole.scroll, whole.client, `the pane opens wide enough for the slug, ${JSON.stringify(whole)}`);

  await fresh.evaluate(() => document.querySelector('main').style.setProperty('--w-pr', '200px'));
  const owner = await box('#pr-head .pr-repo .owner');
  const name = await box('#pr-head .pr-repo .name');
  assert.ok(owner.scroll > owner.client, `the owner should be clipped, ${JSON.stringify(owner)}`);
  assert.equal(name.scroll, name.client, `the name should be whole, ${JSON.stringify(name)}`);
  // And the clipped line stays inside the pane rather than merely wearing an
  // ellipsis: a flex item that refuses to shrink overflows with one on.
  const edge = () => fresh.$eval('#pr-head', (el) =>
    el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
  assert.ok(name.right <= Math.ceil(await edge()), `line ends at ${name.right}, head content edge ${await edge()}`);

  // At the stylesheet's 180px floor the name is still the last thing to go:
  // the owner has nothing left to shrink into and the name is whole anyway.
  await fresh.evaluate(() => document.querySelector('main').style.setProperty('--w-pr', '180px'));
  const floor = await box('#pr-head .pr-repo .name');
  assert.equal(floor.scroll, floor.client, `the name should survive the floor, ${JSON.stringify(floor)}`);
  assert.ok(floor.right <= Math.ceil(await edge()), `line ends at ${floor.right}, head content edge ${await edge()}`);
  await fresh.close();
});

// The tokenizer runs in the page over whatever a pull request adds, so the file
// is markup-shaped on purpose: it has to come out as the same characters in
// coloured spans, never as elements. A switch to innerHTML, Prism's HTML
// output or a theme's markup would fail here.
test('a NEW file is highlighted as text, and its markup never becomes elements', { skip }, async () => {
  await page.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await page.locator('.file[data-path="evil.js"] .path').click();
  await page.waitForSelector('#diff-body .tok-string');
  assert.equal(await page.$eval('#diff h1', (el) => el.textContent), 'New');
  assert.deepEqual(await page.$$eval('#diff-body .dl', (els) => els.map((el) => el.textContent)), SOURCE.split('\n'));
  assert.equal(await page.locator('#diff-body script, #diff-body img').count(), 0);
  assert.ok(await page.locator('#diff-body .tok-comment').count(), 'the comment is a token');
  // The blank line is a row with nothing in it, which used to lay out at 0px.
  const heights = await page.$$eval('#diff-body .dl', (els) => els.map((el) => el.getBoundingClientRect().height));
  assert.equal(heights.length, 3);
  assert.ok(heights[1] > 0 && heights[1] === heights[0], `row heights ${heights}`);
});

// Retrying a failed load is a claim about the browser's module map, not about
// prcoder's cache: a module whose fetch failed is cached under its specifier
// too, so importing the same URL again rejects without a request ever going
// out. Clearing `loaded` alone left every NEW file of the session plain until a
// reload, which is what the query string in `grammar` is for -- and the second
// URL here is the only thing that proves it is doing anything. Its own page,
// because the one above has already loaded Prism successfully.
test('a NEW file is highlighted after a failed Prism load', { skip }, async () => {
  const fresh = await newPage();
  let fail = true;
  const asked = [];
  await fresh.route('**/vendor/prism.js*', (r) => {
    asked.push(new URL(r.request().url()).search);
    return fail ? r.abort() : r.continue();
  });
  const open = async () => {
    await fresh.locator('.file[data-path="evil.js"] .path').click();
    await fresh.waitForSelector('#diff-body .dl');
  };
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await open();
  assert.equal(await fresh.locator('#diff-body .tok-string').count(), 0, 'plain while the load fails');

  fail = false;
  await open();
  await fresh.waitForSelector('#diff-body .tok-string');
  assert.deepEqual(await fresh.$$eval('#diff-body .dl', (els) => els.map((el) => el.textContent)), SOURCE.split('\n'));
  assert.deepEqual(asked, ['', '?retry=1'], `prism.js was asked for as ${JSON.stringify(asked)}`);
  await fresh.close();
});

// A grammar that extends others is the one case the loader cannot treat as one
// file: prism-tsx registers nothing unless jsx and typescript are already in
// Prism.languages, and a .tsx file would open with its markup coloured as
// operators -- which is what `tsx: 'typescript'` used to do. Both halves are
// asserted, because the file highlights either way and only the token names
// say which grammar ran.
test('a .tsx file loads the grammars tsx extends, in order, before tsx', { skip }, async () => {
  const fresh = await newPage();
  const asked = [];
  fresh.on('request', (r) => {
    const m = new URL(r.url()).pathname.match(/^\/vendor\/prism\/(.+)\.js$/);
    if (m) asked.push(m[1]);
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="app.tsx"] .path').click();
  await fresh.waitForSelector('#diff-body .tok-tag');
  assert.deepEqual(asked, ['jsx', 'typescript', 'tsx'], `asked for ${JSON.stringify(asked)}`);
  assert.equal(await fresh.$eval('#diff-body .tok-tag', (el) => el.textContent), 'div');
  assert.equal(await fresh.locator('#diff-body .tok-attr-name').count(), 1, 'className is an attribute');
  assert.deepEqual(await fresh.$$eval('#diff-body .dl', (els) => els.map((el) => el.textContent)), [TSX]);
  await fresh.close();
});
