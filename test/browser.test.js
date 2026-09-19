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

const REPO = 'https://github.com/example/repo';
// One added file, with markup in it: the diff pane highlights a NEW file from
// Prism's tokens, and this is the source that shows if any of it is ever built
// as HTML rather than text.
const SOURCE = 'const s = "<script>alert(1)</script>"; // <img src=x onerror=alert(2)>\n\nf(1)';
const files = [{
  path: 'evil.js', additions: 3, deletions: 0, viewed: false,
  url: `${REPO}/pull/12/files#diff-0`, blob: `${REPO}/blob/aaaa/evil.js`,
  blame: `${REPO}/blame/aaaa/evil.js`, history: `${REPO}/commits/aaaa/evil.js`,
}];
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
  defaultBranch: 'main', nameWithOwner: 'example/repo', scope: 'current', mirrorFailed: false,
  pr, queue: [],
};

let browser;
let page;
const posted = [];

before(async () => {
  if (skip) return;
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.routeWebSocket('**/pty', () => {});
  await page.route('**/api/status', (r) => r.fulfill({ json: status }));
  await page.route('**/api/prs', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/queue', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/diff', (r) => r.fulfill({ json: {
    path: 'evil.js', patch: '@@ -0,0 +1,2 @@\n' + SOURCE.split('\n').map((l) => '+' + l).join('\n'),
  } }));
  await page.route('**/api/pr/task', (r) => {
    posted.push(r.request().postDataJSON());
    return r.fulfill({ json: { queue: null } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#pr-head .pr-title');
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
