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
// follows would still pass here. A stub gh (#54) is what puts the server's own
// shaping in front of this test; until then, groups and checks
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
// One suite, run once per engine: chromium.test.js and firefox.test.js beside
// this file each set PRCODER_TEST_BROWSER and import it, and `node --test` runs
// each in a process of its own. Not itself a .test.js, so the glob in `npm test`
// never runs it bare. Both engines, because a test written against one engine's
// layout has been wrong in the other. Skipped rather than failed when
// Playwright or the engine is missing: `npm test` on a machine without either
// stays green with a note, and CI, which installs both, is where this is
// enforced.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { server } from '../../server.js';
import { bucket } from '../../files.js';
import { rollup } from '../../github.js';
import { firefoxEnv } from '../../tools/driver.mjs';

// If a socket ever gets past the mock, the in-process server spawns this (read
// at connect time) rather than a real `claude` in this repo -- which is what the
// first draft of the exit bar's test did, over a glob that missed a query
// string (2026-09-23).
process.env.PRCODER_AGENT_BIN = '/usr/bin/false';

const engineName = process.env.PRCODER_TEST_BROWSER;
let engine;
try { engine = (await import('playwright'))[engineName]; } catch { /* not installed */ }
const skip = !engine ? 'playwright is not installed (npm ci without --omit=dev)'
  : !existsSync(engine.executablePath()) ? `${engineName} is not installed: npx playwright install ${engineName}`
    : false;
// Each run's names carry its engine, so a CI log says which one broke.
const test = (name, ...rest) => nodeTest(`${name} [${engineName}]`, ...rest);

// Each line here is a regression: `_for_` showed its underscores, HTML
// comments showed as text, `##` rendered literally, and a
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
  '<!-- begin checklist -->',
  '- [ ] a task between comments',
  '<!-- end checklist -->',
].join('\n');

// A long slug on purpose: the head's repository line is built to be clipped,
// and `example/repo` fits any pane this ever opens at. This one is real.
const REPO = 'https://github.com/heal-data-stewards/heal-vlmd-AI-pipeline';
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
  path: p, group: bucket(p), additions: added[p].split('\n').length, deletions: 0, viewed: false,
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
};
const status = {
  branch: 'topic', head: 'b'.repeat(40), detached: false, dirtyFiles: [], sync: 'synced', ahead: 0,
  defaultBranch: 'main', nameWithOwner: 'heal-data-stewards/heal-vlmd-AI-pipeline',
  scope: 'current', mirrorFailed: false,
  pr, queue: [],
};

let browser;
let page;
const posted = [];

// A page with every route answered, so a test that needs a module map of its
// own -- Prism loads once per page -- can open a second one. `prs` is the
// switcher's list, empty unless a test is about it, and null for a fetch that
// fails; `st` and `ready` are for a page with no pull request, which has no
// title to wait on. `pty` is the mock socket's handler, for a test that needs
// the agent to do something. A regex, not `**/pty`: a glob has to match the
// whole URL, so the exit bar's `/pty?model=...` slipped past it to the real
// server. `whoami` is the model and effort prcoder's command line started the
// agent with, which the exit bar is filled with.
async function newPage({ prs = [], st = status, ready = '#pr-head .pr-title', pty = () => {},
  whoami = { model: '', effort: '' } } = {}) {
  const p = await browser.newPage();
  await p.routeWebSocket(/\/pty(\?|$)/, pty);
  await p.route('**/api/whoami', (r) => r.fulfill({ json: { started: whoami } }));
  await p.route('**/api/status', (r) => r.fulfill({ json: st }));
  await p.route('**/api/prs', (r) => (prs ? r.fulfill({ json: prs }) : r.abort()));
  await p.route('**/api/queue', (r) => r.fulfill({ json: [] }));
  await p.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    const lines = added[path].split('\n');
    return r.fulfill({ json: {
      path, patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n'),
    } });
  });
  // The route answers with the body GitHub now holds, and the client paints
  // both sets of checkboxes from it -- so a mock that returns anything else
  // blanks the description on the first tick, and every later assertion about
  // this page is against an empty pane.
  await p.route('**/api/pr/task', (r) => {
    const task = r.request().postDataJSON();
    posted.push(task);
    const box = task.done ? '- [x] ' : '- [ ] ';
    return r.fulfill({ json: { body: BODY.replace(`- [${task.done ? ' ' : 'x'}] ${task.text}`, box + task.text) } });
  });
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.waitForSelector(ready);
  return p;
}

before(async () => {
  if (skip) return;
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  // The drivers' way round macOS 27 keeping a terminal-launched Firefox out of
  // its own app data (tools/driver.mjs); #80 is when it comes out.
  browser = await engine.launch(engineName === 'firefox' ? { env: { ...process.env, ...firefoxEnv() } } : {});
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
  // The count moves with the box, from the body the route answered, rather
  // than a poll up to a minute later.
  assert.ok((await page.locator('#pr-head .tab').allTextContents()).includes('Detail (2/3)'));
});

test('the issues the description mentions are listed below it, titled', { skip }, async () => {
  assert.deepEqual(await page.locator('.issues-label').allTextContents(), ['Mentions']);
  const row = page.locator('.issues a').first();
  assert.equal(await row.textContent(), '#7 Per-route locking');
  assert.equal(await row.getAttribute('href'), `${REPO}/issues/7`);
});

// Its own page: the shared one has had a box ticked above.
test('the tab carries the task count', { skip }, async () => {
  const fresh = await newPage();
  const tabs = await fresh.locator('#pr-head .tab').allTextContents();
  assert.ok(tabs.includes('Detail (1/3)'), JSON.stringify(tabs));
  await fresh.close();
});

// A finished count keeps its numbers and gains the green circle after them;
// the ✓ glyph alone, in the tab's dim grey, was too faint to see. Read off the
// computed ::after, since the class only promises the stylesheet draws it, and
// the name is asserted exactly so the ✓ is not read out beside `(2/2)`. A
// Checks tab where everything passed is the same circle, not a dot as well.
test('a tab with nothing left keeps its count and ends in a green ✓ circle', { skip }, async () => {
  const p = await newPage({ st: { ...status, pr: { ...pr,
    files: files.map((f) => ({ ...f, viewed: true })),
    checks: rollup([{ workflowName: 'CI', name: 'test', conclusion: 'SUCCESS' }]) } } });
  const circle = (name) => p.locator('#pr-head .tab', { hasText: name }).evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return { cls: el.className, text: el.textContent, glyph: /✓/.test(s.content),
      filled: s.backgroundColor !== 'rgba(0, 0, 0, 0)', round: parseFloat(s.borderTopLeftRadius) > 0 };
  });
  assert.deepEqual(await circle('Files'), { cls: 'tab done', text: 'Files (2/2)', glyph: true, filled: true, round: true });
  assert.deepEqual(await circle('Checks'), { cls: 'tab done', text: 'Checks (1/1)', glyph: true, filled: true, round: true });
  assert.equal((await circle('Detail')).glyph, false, 'Detail (1/3) is not done');
  assert.equal(await p.getByRole('button', { name: 'Files (2/2)', exact: true }).count(), 1);
  await p.close();
});

// The shared fixture has no checks, and a PR with none draws no Checks tab --
// which is the first thing asserted -- so the tab needs a page of its own.
// One check per state, and one per kind of link: a run's own, none at all, and
// a `javascript:` one that rollup() drops (docs/Security.md). The last step is
// the poll that empties the list while you are on the tab, which has to put
// you back on Detail rather than on a tab that is no longer drawn.
test('the Checks tab lists each check, and a poll that empties it moves you to Detail', { skip }, async () => {
  assert.equal(await page.locator('#pr-head .tab', { hasText: 'Checks' }).count(), 0, 'no checks, no tab');
  const checks = rollup([
    { workflowName: 'CI', name: 'test', conclusion: 'SUCCESS', detailsUrl: `${REPO}/actions/runs/1` },
    { context: 'deploy', state: 'PENDING' },
    { context: 'lint', state: 'FAILURE', targetUrl: 'javascript:alert(1)' },
  ]);
  const withChecks = { ...status, pr: { ...pr, checks } };
  const p = await newPage({ st: withChecks });
  const tab = p.locator('#pr-head .tab', { hasText: 'Checks' });
  assert.equal(await tab.textContent(), 'Checks (1/3)');
  assert.equal(await p.getByRole('button', { name: 'Checks (1/3): 1 failed, 1 pending', exact: true }).count(), 1,
    'the name says in words what the mark says in shape');
  assert.match(await tab.getAttribute('class'), /\bdot fail\b/, 'a failure beats a pending check');
  await tab.click();
  assert.deepEqual(await p.locator('#pr-body .check-name').allTextContents(), ['CI / test', 'deploy', 'lint']);
  assert.deepEqual(await p.locator('#pr-body .check-state').allTextContents(), ['pending', 'failed'],
    'a word beside every check that did not pass');
  assert.deepEqual(await p.$$eval('#pr-body .check a', (as) => as.map((a) => a.getAttribute('href'))),
    [`${REPO}/actions/runs/1`], 'only the http(s) link is a link');
  // Shape, not only colour: read off the computed ::before, since the class is
  // only a promise that the stylesheet draws something different for it.
  const marks = await p.$$eval('#pr-body .check .dot', (ds) => ds.map((d) => {
    const s = getComputedStyle(d, '::before');
    return { filled: s.backgroundColor !== 'rgba(0, 0, 0, 0)', ring: parseFloat(s.borderTopWidth) > 0,
      glyph: /✕/.test(s.content) };
  }));
  assert.deepEqual(marks, [
    { filled: true, ring: false, glyph: false },
    { filled: false, ring: true, glyph: false },
    { filled: false, ring: false, glyph: true },
  ], 'a dot passed, a ring is pending, a ✕ failed');

  await p.route('**/api/status', (r) => r.fulfill({ json: { ...withChecks, pr: { ...pr, checks: rollup([]) } } }));
  const polled = p.waitForResponse('**/api/status');
  await p.click('#pr-refresh');
  await polled;
  await p.locator('#pr-head .tab.on', { hasText: 'Detail' }).waitFor();
  assert.equal(await tab.count(), 0);
  assert.equal(await p.locator('#pr-body .md').count(), 1, 'the description is back');
  await p.close();
});

// The repository is the one link in the head with no bound on its width, which
// is why it is last in the row: in the middle it wrapped the row and moved the
// three lists around with it, and at the end there is nothing after it to move.
// Asserted as a place in the DOM, and then as where it lands: this fixture's
// 44-character slug does not fit beside the four at the default width, so it
// wraps -- whole, onto a line of its own, which is where it may clip.
test('the repository ends the row, and a long one wraps whole under it', { skip }, async () => {
  assert.deepEqual(await page.locator('#pr-head .pr-links > a').allTextContents(),
    ['PR #12', 'issues', 'pulls', 'milestones', 'heal-data-stewards/heal-vlmd-AI-pipeline']);
  const repo = page.locator('#pr-head .pr-links > a:last-child');
  assert.equal(await repo.getAttribute('class'), 'pr-repo');
  assert.equal(await repo.getAttribute('href'), REPO);
  assert.equal(await repo.getAttribute('title'), 'heal-data-stewards/heal-vlmd-AI-pipeline');
  const top = (sel) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().top));
  assert.ok(await top('#pr-head .pr-repo') > await top('#pr-head .pr-links .primary'), 'a long slug should wrap');
  const chip = await page.$eval('#pr-head .pr-repo', (el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.equal(chip.scroll, chip.client, `wrapped, it has the line to itself and is whole, ${JSON.stringify(chip)}`);
});

// And the reason it moved into the row: a slug that fits shares the line with
// the four rather than costing the head a line of its own. `o/r` is the short
// end, and `gaurav/prcoder` behaves the same at the default width.
test('a short repository shares the row with the four links', { skip }, async () => {
  const short = 'https://github.com/o/r';
  const p = await newPage({ st: { ...status, nameWithOwner: 'o/r', pr: { ...pr, url: `${short}/pull/12` } } });
  // Centres, not tops: the chip's border and padding make it a few pixels
  // taller than a plain link, and the row centres them on one line.
  const mid = (sel) => p.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return Math.round(b.top + b.height / 2); });
  assert.equal(await p.locator('#pr-head .pr-repo').textContent(), 'o/r');
  assert.equal(await mid('#pr-head .pr-repo'), await mid('#pr-head .pr-links a:not(.primary)'));
  await p.close();
});

// A line of its own said where the repository was, not that it was anything
// but a fifth link -- same size, same accent, same underline as the four above
// it. The chip is what tells them apart, so what is asserted is the contrast
// and not the pill: a border where the row has none, and no underline where
// the row keeps one. Read off computed style because that is the whole change;
// there is no markup here to assert against.
test('the repository is drawn as a chip, not as a fifth link', { skip }, async () => {
  const styles = (sel) => page.$eval(sel, (el) => {
    const s = getComputedStyle(el);
    return { border: parseFloat(s.borderTopWidth), line: s.textDecorationLine };
  });
  const repo = await styles('#pr-head .pr-repo');
  const way = await styles('#pr-head .pr-links a:not(.primary, .pr-repo)');
  assert.ok(repo.border > 0, `the chip should have a border, ${JSON.stringify(repo)}`);
  assert.equal(repo.line, 'none', `the chip should not be underlined, ${JSON.stringify(repo)}`);
  assert.equal(way.border, 0, `the row's links should stay plain, ${JSON.stringify(way)}`);
  assert.equal(way.line, 'underline', `the row's links should stay underlined, ${JSON.stringify(way)}`);
});

// The pull request is the link in the head that gets clicked, so it is the one
// drawn as a filled button, and its row comes straight after the title -- ahead
// of the state and the branches. Order is asserted by position in the DOM,
// which is HEAD_ORDER in pr.js; change the two together.
test('the pull request is a filled button on the row under the title', { skip }, async () => {
  const pr = page.locator('#pr-head .pr-links a.primary');
  assert.equal(await pr.textContent(), 'PR #12');
  const s = await pr.evaluate((el) => {
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, line: c.textDecorationLine };
  });
  assert.notEqual(s.bg, 'rgba(0, 0, 0, 0)', `the button should be filled, ${JSON.stringify(s)}`);
  assert.equal(s.line, 'none');
  const order = await page.$$eval('#pr-head > *', (els) => els.map((e) => e.className));
  const at = (cls) => order.findIndex((c) => c.split(' ').includes(cls));
  assert.ok(at('pr-title') < at('pr-links') && at('pr-links') < at('pr-state'), order.join(' | '));
  // No dot hangs off the button or the repository chip: the first separator
  // follows `issues`, and the last precedes `milestones`.
  assert.equal(await page.locator('#pr-head .pr-links .sep').count(), 2);
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
  const whole = await box('#pr-head .pr-repo');
  assert.equal(whole.scroll, whole.client, `the pane opens wide enough for the slug, ${JSON.stringify(whole)}`);

  await fresh.evaluate(() => document.querySelector('main').style.setProperty('--w-pr', '200px'));
  const owner = await box('#pr-head .pr-repo .owner');
  const name = await box('#pr-head .pr-repo .name');
  assert.ok(owner.scroll > owner.client, `the owner should be clipped, ${JSON.stringify(owner)}`);
  assert.equal(name.scroll, name.client, `the name should be whole, ${JSON.stringify(name)}`);
  // And the clipped line stays inside the pane rather than merely wearing an
  // ellipsis: a flex item that refuses to shrink overflows with one on.
  //
  // Measured on the chip rather than on the name inside it. The slug is drawn
  // in a bordered pill, so the edge that can cross the pane's is the border --
  // a name that ends 1px inside the padding with the border already outside
  // would pass this read off the span and be wrong on screen.
  const edge = () => fresh.$eval('#pr-head', (el) =>
    el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
  const chip = await box('#pr-head .pr-repo');
  assert.ok(chip.right <= Math.ceil(await edge()), `chip ends at ${chip.right}, head content edge ${await edge()}`);

  // At the stylesheet's 180px floor the ordering still holds: the owner has
  // given up everything before the name gives up anything.
  //
  // What this does *not* assert is that the name survives whole, which is how
  // it was written first and how it went red on CI. The name is 156px in this
  // machine's 12px system font and 162px in the runner's, against 160px of
  // content at the floor -- so the same page clips on Linux and does not on
  // macOS, and the assertion was really about a font. Anything here that
  // compares a text width against a pane width has that problem; compare the
  // two spans with each other instead, which is the claim anyway.
  await fresh.evaluate(() => document.querySelector('main').style.setProperty('--w-pr', '180px'));
  const [lastOwner, lastName] = [await box('#pr-head .pr-repo .owner'), await box('#pr-head .pr-repo .name')];
  assert.ok(lastOwner.client < lastName.client,
    `the owner should yield first, ${JSON.stringify({ lastOwner, lastName })}`);
  const lastChip = await box('#pr-head .pr-repo');
  assert.ok(lastChip.right <= Math.ceil(await edge()), `chip ends at ${lastChip.right}, head content edge ${await edge()}`);
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

// Folding the terminal is for reading a diff, so the diff is what has to take
// the room -- a fold that only hid the terminal's body would leave a blank pane
// where it was. Its own page, because a fold is stored and survives a reload.
test('the terminal folds to its header, the diff takes the room, and it stays folded', { skip }, async () => {
  const fresh = await newPage();
  const height = (sel) => fresh.$eval(sel, (el) => el.getBoundingClientRect().height);
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  const open = await height('#diff');

  await fresh.click('#term-fold');
  assert.equal(await fresh.locator('#term-host').isVisible(), false);
  assert.equal(await height('#term'), await height('#term > header'));
  assert.ok(await height('#diff') > open, `diff was ${open}px, is ${await height('#diff')}px`);
  assert.equal(await fresh.getAttribute('#term-fold', 'aria-expanded'), 'false');

  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  assert.equal(await fresh.locator('#term-host').isVisible(), false, 'folded after a reload');

  await fresh.click('#term > header h1');
  assert.equal(await fresh.locator('#term-host').isVisible(), true);
  assert.equal(await fresh.getAttribute('#term-fold', 'aria-expanded'), 'true');
  await fresh.close();
});

// The ⟳ is drawn larger than the header's text, because at the same size this
// font makes it a speck -- and a glyph at a bigger size is how a header grows.
// So the header has to be the height it is with the ⟳ at the header's own
// size. Not the height without the button: in Firefox the button at any size
// is what sets the header's 36px (34 without it), where in Chromium the
// dropdown does.
test('the ⟳ is drawn large without making the pull request header taller', { skip }, async () => {
  const height = () => page.$eval('#pr > header', (el) => el.getBoundingClientRect().height);
  const px = (sel, prop) => page.$eval(sel, (el, p) => parseFloat(getComputedStyle(el)[p]), prop);
  assert.ok(await px('#pr-refresh', 'fontSize') > await px('#pr > header', 'fontSize'), 'the ⟳ should be larger than the header text');
  const large = await height();
  await page.$eval('#pr-refresh', (el) => { el.style.fontSize = 'inherit'; el.style.lineHeight = 'inherit'; });
  const plain = await height();
  await page.$eval('#pr-refresh', (el) => { el.style.fontSize = ''; el.style.lineHeight = ''; });
  assert.equal(large, plain, 'the ⟳ should not make the header taller than it is at the header\'s size');
});

// A button drawn as a glyph -- ✕, ⟳, ▼ -- is read out by a screen reader as
// that glyph, which names no action. Every button on the page, as it first
// renders, has words to be read by: its text, or an aria-label.
test('no button is named by a glyph alone', { skip }, async () => {
  const bare = await page.$$eval('button', (els) => els
    .filter((b) => !b.getAttribute('aria-label') && !/[\p{L}\p{N}]/u.test(b.textContent))
    .map((b) => b.id || b.outerHTML.slice(0, 80)));
  assert.deepEqual(bare, []);
});

// The whole header is the fold, and the ▼ is part of it: a click anywhere on
// the bar toggles it, and a click on the ▼ toggles it once, not once for the
// button and again for the bar. There is no second button at the far end any
// more -- the far end is bar too. Its own page for the same reason as the test
// above.
test('a click anywhere on the terminal\'s header folds and unfolds it, the ▼ included', { skip }, async () => {
  const fresh = await newPage();
  const shown = () => fresh.locator('#term-host').isVisible();
  // A header that changes height as it folds jumps the whole layout.
  const height = () => fresh.$eval('#term > header', (el) => el.getBoundingClientRect().height);
  const open = await height();
  assert.equal(await fresh.locator('#term-min').count(), 0, 'the bar is the button now');

  await fresh.click('#term > header h1');
  assert.equal(await shown(), false, 'the title folds it');
  assert.equal(await height(), open, 'the header should keep its height when folded');
  assert.equal(await fresh.getAttribute('#term-fold', 'aria-expanded'), 'false');
  await fresh.click('#term > header h1');
  assert.equal(await shown(), true, 'and unfolds it');

  const box = await fresh.locator('#term > header').boundingBox();
  await fresh.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
  assert.equal(await shown(), false, 'the far end folds it');
  await fresh.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
  assert.equal(await shown(), true);

  await fresh.click('#term-fold');
  assert.equal(await shown(), false, 'the ▼ toggles once, not once for itself and again for the bar');
  await fresh.click('#term-fold');
  assert.equal(await shown(), true);
  await fresh.close();
});

// Every toast closes on a click, so every one has a ✕, where a close button is
// looked for: the top right corner. After the text, it ended whichever line the
// text wrapped to. It is a pseudo-element, which has no box to measure, so this
// reads the rule -- and that the text is padded clear of it -- for each kind.
test('every toast has its ✕ in the top right corner, clear of the text', { skip }, async () => {
  const fresh = await newPage();
  for (const [bad, sticky] of [[false, false], [true, false], [false, true]]) {
    const x = await fresh.evaluate(async ([b, s]) => {
      const { toast } = await import('/pr.js');
      toast('Switched to add-retries (#123). Claude still has the old branch\'s files in mind '
        + '— tell it to re-read anything it had open.', b, s);
      const el = document.getElementById('toast');
      const after = getComputedStyle(el, '::after');
      return { content: after.content, position: after.position, top: parseFloat(after.top),
        right: parseFloat(after.right), pad: parseFloat(getComputedStyle(el).paddingTop),
        padRight: parseFloat(getComputedStyle(el).paddingRight), fontSize: parseFloat(after.fontSize) };
    }, [bad, sticky]);
    const kind = `bad ${bad}, sticky ${sticky}`;
    assert.equal(x.content, '"✕"', kind);
    assert.equal(x.position, 'absolute', kind);
    assert.equal(x.top, x.pad, `level with the first line (${kind})`);
    assert.ok(x.padRight >= x.right + x.fontSize, `text padded ${x.padRight}px, ✕ needs ${x.right + x.fontSize}px (${kind})`);
  }
  await fresh.close();
});

// A tab that had a PTY and loads again has a new session, and the toast says
// which kind of load it was (ws.onopen in app.js). The link to keeping tab
// unloaders off prcoder is the part that matters: a reload never gets it, and a
// load that may be the browser's restore always does. Each new page reaches the
// mock socket, which is what opens it and runs onopen.
test('a page loaded again says why the session is new, and links to the fix unless it was a reload', { skip }, async () => {
  const p = await newPage();
  const notice = async (label) => {
    await p.waitForFunction(() => !document.getElementById('toast').hidden, null, { timeout: 5000 })
      .catch(() => assert.fail(`no toast after ${label}`));
    return p.$eval('#toast', (el) => ({ text: el.textContent,
      sticky: el.classList.contains('sticky'), href: el.querySelector('a')?.href ?? null }));
  };
  const ports = 'https://github.com/gaurav/prcoder/blob/main/docs/Ports.md#finding-it-again';

  await p.waitForFunction(() => sessionStorage.getItem('prcoder:pty'));
  assert.equal(await p.locator('#toast').isHidden(), true, 'a first open has nothing to say');

  await p.reload();
  let n = await notice('a reload');
  assert.match(n.text, /^Claude was restarted/);
  assert.deepEqual([n.sticky, n.href], [false, null], 'a reload is not sticky and has no link');

  // Back to a tab you left, and a fresh navigation to it: neither is a reload,
  // and outside Chrome either may be a restored tab.
  await p.goto(`http://127.0.0.1:${server.address().port}/api/whoami`);
  await p.goBack();
  n = await notice('Back');
  assert.match(n.text, /^This page was loaded again/);
  assert.deepEqual([n.sticky, n.href], [true, ports], 'Back');
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  n = await notice('a navigation');
  assert.match(n.text, /^This page was loaded again/);
  assert.deepEqual([n.sticky, n.href], [true, ports], 'a navigation');

  // Chrome's own word for it wins over the load being a reload.
  await p.addInitScript(() => Object.defineProperty(document, 'wasDiscarded', { value: true }));
  await p.reload();
  n = await notice('a discard');
  assert.match(n.text, /^The browser unloaded this tab/);
  assert.deepEqual([n.sticky, n.href], [true, ports], 'a discard');
  await p.close();
});

// A fold's progress is a pie, not `3/5`: one size at any count, and full is a
// disc. The figure it gives up is its accessible name. A directory is needed
// for a directory's pie, and the fixture has none, so this page adds two: one
// half viewed, one all viewed.
test('folds show progress as a pie named by its figure', { skip }, async () => {
  const fresh = await newPage();
  const extra = [['src/a.js', true], ['src/b.js', false], ['src/sub/c.js', true]]
    .map(([path, viewed]) => ({ ...files[0], path, viewed }));
  const all = [...files, ...extra];
  await fresh.route('**/api/status', (r) => r.fulfill({ json: {
    ...status, pr: { ...pr, files: all },
  } }));
  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  const pie = (sel) => fresh.locator(`${sel} > summary .pie`).evaluate((el) => ({
    label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
    p: el.style.getPropertyValue('--p'), full: el.classList.contains('full'),
  }));

  // The description's section holding the queue's unticked line.
  assert.deepEqual(await pie('.md-section:has(h3:text-is("Before merging"))'),
    { label: '0 of 1 done', role: 'img', p: '0', full: false });

  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  assert.deepEqual(await pie('.dir[data-dir="src/"]'), { label: '1 of 2 viewed', role: 'img', p: '0.5', full: false });
  assert.deepEqual(await pie('.dir[data-dir="src/sub/"]'), { label: '1 of 1 viewed', role: 'img', p: '1', full: true });
  assert.equal(await fresh.locator('#pr-body .count').count(), 0, 'no fraction left beside a fold');
  await fresh.close();
});

// Deleted is newest first too, so a delete you did not mean is at the top to be
// restored. Its own page: the queue here is one with tombstones in it.
test('Deleted lists the most recently deleted first', { skip }, async () => {
  const fresh = await newPage();
  const gone = (text, deletedAt) => ({ text, done: false, issue: null, deleted: true, deletedAt });
  const queue = [gone('never stamped', null), gone('deleted first', 1000), gone('deleted last', 3000),
    { text: 'still here', done: false, issue: null, deleted: false }];
  await fresh.route('**/api/queue', (r) => r.fulfill({ json: queue }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  await fresh.locator('#queue-body .tab', { hasText: 'Deleted' }).click();
  assert.deepEqual(await fresh.locator('#queue-body .item .text').allTextContents(),
    ['deleted last', 'deleted first', 'never stamped']);
  await fresh.close();
});

// Completed is sorted by when each item was finished, so the one just ticked by
// mistake is on top to be unticked -- whatever order the queue holds them in.
// One the store has not stamped yet goes last. With the order not the user's to
// set, the tab has no grip and no drag; Active keeps both.
test('Completed lists the most recently finished first, and cannot be reordered', { skip }, async () => {
  const fresh = await newPage();
  const it = (text, over) => ({ text, done: true, inPr: false, pr: null, issue: null, deleted: false, ...over });
  const queue = [
    it('never stamped', { doneAt: null }),
    it('finished first', { doneAt: 1000 }),
    it('still to do', { done: false, doneAt: null }),
    it('finished last', { doneAt: 3000 }),
  ];
  // Both: the pane loads from /api/queue and every status poll replaces it.
  await fresh.route('**/api/queue', (r) => r.fulfill({ json: queue }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  assert.equal(await fresh.locator('#queue-body .item .grip').count(), 1, 'Active reorders');
  await fresh.locator('#queue-body .tab', { hasText: 'Completed' }).click();
  assert.deepEqual(await fresh.locator('#queue-body .item .text').allTextContents(),
    ['finished last', 'finished first', 'never stamped']);
  assert.equal(await fresh.locator('#queue-body .item .grip').count(), 0, 'no grip on Completed');
  assert.equal(await fresh.locator('#queue-body .item[draggable="true"]').count(), 0, 'and no drag');
  await fresh.close();
});

// Every queue action changes the list in place and then saves. A refused save
// used to leave the change on screen as if it had landed, and the next save
// that did succeed sent it along with its own -- persisting what the toast had
// just said was not saved.
test('a queue change the server refuses is taken back off the screen', { skip }, async () => {
  const fresh = await newPage();
  const queue = [{ text: 'refused tick', done: false, issue: null, deleted: false }];
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.route('**/api/queue', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 500, json: { error: 'disk full' } })
    : r.fulfill({ json: queue })));
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  await fresh.locator('#queue-body .item input[type=checkbox]').check();
  // For this text, not any toast: the reload raises its own restart notice.
  await fresh.waitForFunction(() => document.getElementById('toast').textContent === 'disk full');
  // Back in Active and unticked, as the server has it.
  assert.deepEqual(await fresh.locator('#queue-body .item .text').allTextContents(), ['refused tick']);
  assert.equal(await fresh.locator('#queue-body .item input[type=checkbox]').isChecked(), false);
  await fresh.close();
});

// Adding used to switch to Local, which threw away whatever tab you were
// reading. It stays put now, and the Local tab flashes to say where it went.
test('adding from another tab stays on it and flashes Local', { skip }, async () => {
  const fresh = await newPage();
  let queue = [{ text: 'already done', done: true, issue: null, deleted: false, doneAt: 1000 }];
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.route('**/api/queue', (r) => {
    if (r.request().method() === 'PUT') queue = r.request().postDataJSON().items;
    return r.fulfill({ json: queue });
  });
  await fresh.reload();
  await fresh.locator('#queue-body .tab', { hasText: 'Completed' }).click();
  await fresh.locator('#queue-input').fill('new from Completed');
  await fresh.locator('#queue-input').press('Enter');
  await fresh.waitForSelector('#queue-body .tab.flash[data-tab="local"]');
  assert.match(await fresh.locator('#queue-body .tab.on').textContent(), /^Completed/);
  assert.deepEqual(await fresh.locator('#queue-body .item .text').allTextContents(), ['already done']);
  assert.match(await fresh.locator('#queue-body .tab[data-tab="local"]').textContent(), /\(1\)/);
  assert.equal(await fresh.locator('#queue-input').inputValue(), '');
  await fresh.close();
});

// With the socket closed nothing is typed, so ▶ must not mark it done: done
// moves it out of Active, and the item would be gone from view unsent.
test('▶ with Claude disconnected types nothing and leaves the item active', { skip }, async () => {
  const fresh = await newPage();
  const queue = [{ text: 'send me', done: false, issue: null, deleted: false }];
  const puts = [];
  await fresh.routeWebSocket(/\/pty(\?|$)/, (ws) => ws.close());
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.route('**/api/queue', (r) => {
    if (r.request().method() === 'PUT') puts.push(r.request().postDataJSON());
    return r.fulfill({ json: queue });
  });
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  await fresh.waitForFunction(() => document.getElementById('term-host').textContent.includes('coding agent exited'));
  await fresh.locator('#queue-body .item button[title^="type into Claude"]').click();
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('not connected'));
  assert.deepEqual(puts, []);
  assert.deepEqual(await fresh.locator('#queue-body .item .text').allTextContents(), ['send me']);
  await fresh.close();
});

// A second click while the first issue was still being filed filed a second
// issue for the same item, and only one of them left the queue behind it.
test('◎ files one issue however quickly it is clicked twice', { skip }, async () => {
  const fresh = await newPage();
  const queue = [{ text: 'file me', done: false, issue: null, deleted: false }];
  let filed = 0;
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.route('**/api/queue', (r) => r.fulfill({ json: queue }));
  // A move: the issue is filed and the item comes back off the list.
  await fresh.route('**/api/queue/to-issue', async (r) => {
    filed++;
    await new Promise((res) => setTimeout(res, 300));
    return r.fulfill({ json: [] });
  });
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  const issue = fresh.locator('#queue-body .item button[title="move into a new issue"]');
  await issue.click();
  await issue.click({ force: true, timeout: 1000 }).catch(() => {});
  await fresh.waitForFunction(() => !document.querySelector('#queue-body .item'));
  assert.equal(filed, 1);
  await fresh.close();
});

// A file with no patch returns before the outline is rebuilt, so opening one
// after a file with several hunks left that file's hunks there to jump to.
test('a file with no diff does not keep the last file\'s outline', { skip }, async () => {
  const fresh = await newPage();
  await fresh.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    return r.fulfill({ json: path === 'evil.js'
      ? { path, patch: '@@ -1,1 +1,1 @@ first\n-a\n+b\n@@ -9,1 +9,1 @@ second\n-c\n+d' }
      : { path, patch: null } });
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-outline button');
  assert.equal(await fresh.locator('#diff-outline button').count(), 2);
  await fresh.locator('.file[data-path="app.tsx"] .path').click();
  await fresh.waitForSelector('#diff-body .empty >> text=No diff to show');
  assert.equal(await fresh.locator('#diff-outline button').count(), 0);
  await fresh.close();
});

// A separator moves on one axis, and says which with aria-orientation. Up and
// Down used to resize the vertical ones too.
test('a separator moves only on the arrows along its own axis', { skip }, async () => {
  const fresh = await newPage();
  const size = () => fresh.$eval('main', (m) => m.style.getPropertyValue('--w-pr'));
  await fresh.locator('#gut-pr').focus();
  await fresh.keyboard.press('ArrowDown');
  assert.equal(await size(), '', 'Down leaves a vertical separator where it was');
  await fresh.keyboard.press('ArrowRight');
  assert.notEqual(await size(), '', 'Right moves it');
  await fresh.close();
});

// A folded pane still says when Claude is working, from the same bracketed turn
// as the tab icon -- so it appears on Enter and goes after 2s of quiet, and the
// mocked /pty here sends nothing to hold the turn open. Only folded: open, the
// terminal shows the turn itself.
test('a folded terminal says it is working while a turn runs, and not after', { skip }, async () => {
  const fresh = await newPage();
  const busy = () => fresh.locator('#term-busy').isVisible();
  await fresh.click('#term-host');
  await fresh.keyboard.press('Enter');
  assert.equal(await busy(), false, 'not shown while the pane is open');
  await fresh.click('#term-fold');
  assert.equal(await busy(), true, 'shown once folded mid-turn');
  assert.equal(await fresh.locator('#term-busy').textContent(), 'working');
  // Folding must not make the header a different height from the open one.
  assert.equal(await fresh.$eval('#term', (el) => el.getBoundingClientRect().height),
    await fresh.$eval('#term > header', (el) => el.getBoundingClientRect().height));
  await fresh.waitForFunction(() => document.getElementById('term-busy').hidden, null, { timeout: 5000 });
  assert.equal(await busy(), false, 'gone when the turn ends');
  await fresh.close();
});

// A viewed tick changes every place that shows it: the row, its group's pie,
// the Files tab's count, and the diff pane's own box when that file is open --
// not the one box that was clicked, with the rest a poll behind.
test('marking a file viewed moves the tab count and the open diff\'s box with it', { skip }, async () => {
  const fresh = await newPage();
  await fresh.route('**/api/pr/viewed', (r) => r.fulfill({ json: { ok: true } }));
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  await fresh.locator('.file[data-path="evil.js"] input[type=checkbox]').check();
  await fresh.waitForFunction(() => [...document.querySelectorAll('#pr-head .tab')]
    .some((t) => t.textContent === 'Files (1/2)'));
  assert.equal(await fresh.locator('#diff-viewed').isChecked(), true);
  assert.equal(await fresh.locator('.file.viewed').count(), 1);
  // And the other way: the diff pane's box moves the row.
  await fresh.locator('#diff-viewed').uncheck();
  await fresh.waitForFunction(() => document.querySelectorAll('.file.viewed').length === 0);
  assert.ok((await fresh.locator('#pr-head .tab').allTextContents()).includes('Files (0/2)'));
  await fresh.close();
});

// A push while a file is open re-opens it, so it shows the pushed version. The
// path through paint() that does it runs only when the head moves, which no
// other test here makes happen -- and it once called a helper a local variable
// had shadowed, which would have thrown on every such poll.
test('a poll that moves the head re-opens the open file without an error', { skip }, async () => {
  const fresh = await newPage();
  const errors = [];
  fresh.on('pageerror', (e) => errors.push(e.message));
  let diffs = 0;
  await fresh.route('**/api/diff', (r) => {
    diffs++;
    return r.fulfill({ json: { path: 'evil.js', patch: '@@ -0,0 +1 @@\n+x' } });
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  await fresh.route('**/api/status', (r) => r.fulfill({ json: {
    ...status, pr: { ...pr, headRefOid: 'c'.repeat(40) },
  } }));
  await fresh.click('#pr-refresh');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'evil.js');
  await fresh.waitForTimeout(300);
  assert.deepEqual(errors, []);
  assert.equal(diffs, 2, 'the open file was fetched again');
  await fresh.close();
});

// A status read before a save lands carries the list as it was before the
// change -- the server answers them in order -- and painting it took the change
// back off the screen until the save's own answer put it back.
test('a poll that lands while a save is in flight does not undo it on screen', { skip }, async () => {
  const fresh = await newPage();
  const before = [{ text: 'tick me', done: false, issue: null, deleted: false }];
  let release;
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue: before } }));
  await fresh.route('**/api/queue', async (r) => {
    if (r.request().method() !== 'PUT') return r.fulfill({ json: before });
    await new Promise((res) => { release = res; });
    return r.fulfill({ json: r.request().postDataJSON().items });
  });
  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  await fresh.waitForSelector('#queue-body .item');
  const box = fresh.locator('#queue-body .item input[type=checkbox]');
  await box.check();
  await fresh.click('#pr-refresh');
  await fresh.waitForTimeout(300);
  assert.equal(await box.isChecked(), true, 'the poll did not untick it');
  release();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab')?.textContent === 'Local (0)');
  await fresh.close();
});

// Most polls find nothing new. Rebuilding the panes anyway cost every row and
// listener, and put scroll, focus and folds back by hand every minute.
test('a poll that brings nothing new leaves the panes as they were', { skip }, async () => {
  const fresh = await newPage();
  await fresh.evaluate(() => {
    document.querySelector('#pr-body > *').dataset.mark = 'kept';
    document.querySelector('#queue-body > *').dataset.mark = 'kept';
  });
  await fresh.click('#pr-refresh');
  await fresh.waitForTimeout(300);
  assert.equal(await fresh.locator('#pr-body > [data-mark=kept]').count(), 1, 'PR pane not rebuilt');
  assert.equal(await fresh.locator('#queue-body > [data-mark=kept]').count(), 1, 'queue not rebuilt');
  await fresh.close();
});

// The fixture PR, one built on its branch, and one built on that. The switcher
// and the Stack tab both have to show the chain as a chain, and a row's #N has
// to be a link out while its Switch is the checkout -- one control each.
const STACK = [
  { number: 12, title: pr.title, headRefName: 'topic', baseRefName: 'main', isDraft: false, url: pr.url },
  { number: 13, title: 'Built on the fixture', headRefName: 'topic-2', baseRefName: 'topic', isDraft: true, url: `${REPO}/pull/13` },
  { number: 14, title: 'Built on that', headRefName: 'topic-3', baseRefName: 'topic-2', isDraft: false, url: `${REPO}/pull/14` },
];

test('stacked PRs nest in the switcher and the Stack tab, each linked and switchable', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  const switched = [];
  await fresh.route('**/api/pr/switch', (r) => {
    switched.push(r.request().postDataJSON().number);
    return r.fulfill({ json: status });
  });
  await fresh.waitForSelector('#pr-switch option[value="14"]', { state: 'attached' });
  assert.deepEqual(await fresh.$$eval('#pr-switch option', (os) => os.map((o) => o.textContent.replaceAll('\u00a0', ' '))), [
    'no pull request',
    '#12 A fixture pull request',
    '  └ #13 (draft) Built on the fixture',
    '    └ #14 Built on that',
  ]);

  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  assert.equal(await tab.textContent(), 'Stack (2)');
  await tab.click();
  // The tab is read on its own, so it names the PR as well as the branch, and
  // the branch in the code face.
  assert.equal(await fresh.locator('#pr-body .pr-into-label').textContent(), 'Pull requests built on PR #12 (branch topic)');
  assert.equal(await fresh.locator('#pr-body .pr-into-label code.branch').textContent(), 'topic');
  assert.deepEqual(await fresh.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#13']);
  assert.deepEqual(await fresh.locator('#pr-body .pr-into ul ul .pr-num').allTextContents(), ['#14']);
  const link = fresh.locator('#pr-body .pr-num', { hasText: '#14' });
  assert.equal(await link.getAttribute('href'), `${REPO}/pull/14`);
  assert.equal(await link.getAttribute('target'), '_blank');

  const sent = fresh.waitForResponse('**/api/pr/switch');
  await fresh.locator('#pr-body .pr-row', { hasText: '#14' }).locator('.pr-go').click();
  await sent;
  assert.deepEqual(switched, [14]);
  await fresh.close();
});

// The list behind the tab is not polled, and a PR stacked from the terminal
// after the page loaded would leave the tab saying nothing is stacked here.
// Opening the tab fetches it again; a route added later answers first.
test('opening the Stack tab picks up a PR stacked since the page loaded', { skip }, async () => {
  const fresh = await newPage({ prs: STACK.slice(0, 1) });
  await fresh.route('**/api/prs', (r) => r.fulfill({ json: STACK }));
  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  assert.equal(await tab.textContent(), 'Stack');
  const fetched = fresh.waitForResponse('**/api/prs');
  await tab.click();
  await fetched;
  await fresh.waitForSelector('#pr-body .pr-into .pr-num');
  assert.deepEqual(await fresh.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#13']);
  assert.equal(await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).textContent(), 'Stack (2)');
  await fresh.close();
});

// Opening the tab fetches the list, and gh can fail. The list it had is still
// the best it knows; an empty one in its place said "Nothing is stacked" over
// the rows it had just shown.
test('a failed fetch on opening the Stack tab keeps the rows it had', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  await fresh.waitForSelector('#pr-switch option[value="14"]', { state: 'attached' });
  await fresh.route('**/api/prs', (r) => r.abort());
  const failed = fresh.waitForEvent('requestfailed', (q) => q.url().endsWith('/api/prs'));
  await tab.click();
  await failed;
  await fresh.waitForTimeout(100);
  assert.deepEqual(await fresh.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#13']);
  assert.equal(await tab.textContent(), 'Stack (2)');
  assert.equal(await fresh.locator('#pr-switch option').count(), 4, 'the switcher kept its options');
  await fresh.close();
});

// With no list at all -- the first fetch still out, or every one failed -- the
// tab and the branch-only pane say so, rather than that the list is empty.
test('with no list of pull requests, the panes say there is none yet', { skip }, async () => {
  const fresh = await newPage({ prs: null });
  await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).click();
  assert.equal(await fresh.locator('#pr-body .empty').textContent(), 'No list of open pull requests yet.');
  await fresh.close();

  const alone = await newPage({ prs: null, st: { ...status, branch: 'topic-x', pr: null }, ready: '#pr-head .pr-branch-name' });
  assert.equal(await alone.locator('#pr-body .empty').textContent(), 'No list of open pull requests yet.');
  // And the switcher above it agrees, rather than saying no PRs are open.
  assert.deepEqual(await alone.locator('#pr-switch option').allTextContents(), ['no list of pull requests yet']);
  await alone.close();
});

// The pane with no pull request, on the branch the fixture PR merges into.
// tools/no-pr.mjs drives this against the real remote; this is the part of it
// that needs no clone, so it runs on every `npm test`.
const onMain = { ...status, branch: 'main', pr: null };

test('with no PR, the PRs into this branch nest their stacks, and a dirty tree blocks only Switch', { skip }, async () => {
  const clean = await newPage({ prs: STACK, st: onMain, ready: '#pr-body .pr-into .pr-go' });
  assert.equal(await clean.locator('#pr-body .pr-into-label').textContent(), 'Pull requests into branch main');
  assert.equal(await clean.locator('#pr-body .pr-into-label code.branch').textContent(), 'main');
  assert.deepEqual(await clean.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#12']);
  assert.deepEqual(await clean.locator('#pr-body .pr-into ul ul .pr-num').allTextContents(), ['#13', '#14']);
  assert.equal(await clean.locator('#pr-body .pr-num', { hasText: '#12' }).getAttribute('href'), pr.url);
  const switched = [];
  await clean.route('**/api/pr/switch', (r) => {
    switched.push(r.request().postDataJSON().number);
    return r.fulfill({ json: status });
  });
  const sent = clean.waitForResponse('**/api/pr/switch');
  await clean.locator('#pr-body .pr-row', { hasText: '#13' }).locator('.pr-go').click();
  await sent;
  assert.deepEqual(switched, [13]);
  await clean.close();

  const dirty = await newPage({ prs: STACK, st: { ...onMain, dirtyFiles: ['README.md'] }, ready: '#pr-body .pr-into .pr-go' });
  const go = await dirty.$$eval('#pr-body .pr-go', (bs) => bs.map((b) => [b.disabled, b.title]));
  assert.deepEqual(go, Array(3).fill([true, 'Commit or stash your changes first']));
  assert.deepEqual(await dirty.$$eval('#pr-body .pr-num', (as) => as.map((a) => a.getAttribute('href'))),
    STACK.map((p) => p.url));
  await dirty.close();
});

// On main the issues and milestones are how you pick what to work on next, and
// in the body they sat under the whole list of PRs, off the bottom with a dozen
// open. The head does not scroll, and it is the pull request head's own rows,
// in HEAD_ORDER, with the branch where the title goes.
test('with no PR, the head names the branch and carries the way out', { skip }, async () => {
  const p = await newPage({ prs: STACK, st: onMain, ready: '#pr-head .pr-branch-name' });
  assert.equal(await p.locator('#pr-head .pr-branch-name').textContent(), 'main');
  assert.equal(await p.locator('#pr-head .pr-title').count(), 0, 'the drivers read .pr-title as a PR on screen');
  assert.match(await p.locator('#pr-head .pr-note').textContent(), /^Default branch/);
  assert.deepEqual(await p.locator('#pr-head .pr-links a').allTextContents(),
    ['issues', 'pulls', 'milestones', 'heal-data-stewards/heal-vlmd-AI-pipeline']);
  assert.equal(await p.locator('#pr-head .pr-links .primary').count(), 0, 'no Create PR on the default branch');
  assert.equal(await p.locator('#pr-head .pr-links > .pr-repo').count(), 1);
  assert.equal(await p.locator('#pr-body .pr-ways, #pr-body .pr-repo').count(), 0);
  const order = await p.$$eval('#pr-head > *', (els) => els.map((e) => e.className.split(' ')[0]));
  assert.deepEqual(order, ['pr-branch-name', 'pr-note', 'meta'], order.join(' | '));
  await p.close();

  // A branch nothing merges into says so, rather than leaving the body blank.
  // And one that can have a PR gets Create PR where a PR's head has its own
  // filled button, with no dot beside it.
  // Waited for, not read: until the list lands the pane says it has none.
  const alone = await newPage({ st: { ...status, branch: 'topic-x', pr: null }, ready: '#pr-head .pr-branch-name' });
  await alone.locator('#pr-body .empty', { hasText: 'No pull requests into branch topic-x.' }).waitFor();
  assert.deepEqual(await alone.$$eval('#pr-head .pr-links > :not(.sep, .pr-repo)', (els) => els.map((e) => `${e.tagName} ${e.textContent}`)),
    ['BUTTON Create PR', 'A issues', 'A pulls', 'A milestones']);
  assert.equal(await alone.locator('#pr-head .pr-links .sep').count(), 2);
  await alone.route('**/api/pr/create', (r) => r.fulfill({ json: { url: 'about:blank', pushed: false } }));
  const created = alone.waitForRequest('**/api/pr/create');
  await alone.locator('#pr-head .pr-links button.primary').click();
  await created;
  await alone.close();
});

// The pane with no PR is redrawn on every poll, and a push can take longer than
// one. The button used to be disabled only where it was clicked, so the redraw
// put an enabled one back, and a second click pushed and opened a second tab.
test('Create PR stays disabled through a poll while the first click is pushing', { skip }, async () => {
  const p = await newPage({ st: { ...status, branch: 'topic-x', pr: null }, ready: '#pr-head .pr-branch-name' });
  let release;
  const held = new Promise((res) => { release = res; });
  let asked = 0;
  await p.route('**/api/pr/create', async (r) => {
    asked += 1;
    await held;
    await r.fulfill({ json: { url: 'about:blank', pushed: true } });
  });
  const button = p.locator('#pr-head .pr-links button.primary');
  const first = p.waitForRequest('**/api/pr/create');
  await button.click();
  await first;
  const polled = p.waitForResponse('**/api/status');
  await p.click('#pr-refresh');
  await polled;
  assert.equal(await button.isDisabled(), true, 'a poll put an enabled Create PR back');
  await button.click({ force: true });
  release();
  await p.locator('#pr-head .pr-links button.primary:not([disabled])').waitFor();
  assert.equal(asked, 1);
  await p.close();
});

// A setting sessionArgs will not take closes the socket before any spawn, so the
// terminal has to say that rather than that an agent exited.
test('a refused start says why', { skip }, async () => {
  const p = await newPage({ pty: (ws) => ws.close({ code: 1008, reason: 'bad session settings' }) });
  await p.locator('#term-exit').waitFor({ state: 'visible' });
  await p.locator('#term-host .xterm-rows', { hasText: '[refused: bad session settings]' }).waitFor();
  await p.close();
});

// The bar is the one way back once the agent is gone, so what it sends is what
// matters: starting the agent again is a new socket carrying the settings
// (sessionArgs in server.js turns them into flags), and Quit asks before a quit
// that costs something. The mock closes each socket the way an exiting agent
// does.
test('when the agent exits, starting it again reconnects with the chosen settings, and Quit asks first', { skip }, async () => {
  const urls = [];
  let second;
  const p = await newPage({ whoami: { model: 'sonnet', effort: 'low' }, pty: (ws) => {
    urls.push(new URL(ws.url()).search);
    if (urls.length === 1) ws.close();
    else second = ws;
  } });
  const bar = p.locator('#term-exit');
  await bar.waitFor({ state: 'visible' });
  // Filled with what the command line started it with, not left blank -- by a
  // fetch that can land after the bar shows, so waited on.
  await p.waitForFunction(() => document.querySelector('#term-exit [name=model]').value === 'sonnet');
  assert.equal(await p.inputValue('#term-exit [name=effort]'), 'low');
  await p.fill('#term-exit [name=model]', 'opus');
  await p.selectOption('#term-exit [name=effort]', 'high');
  assert.equal(await p.isChecked('#term-exit [name=continue]'), false, 'continue ticked by default');
  await p.check('#term-exit [name=continue]');
  await p.click('#term-exit button:not([type])');
  // Hidden on the click, before the new socket reaches the mock -- so wait on the socket.
  for (let i = 0; urls.length < 2 && i < 100; i++) await p.waitForTimeout(50);
  assert.equal(await bar.isHidden(), true);
  assert.deepEqual(urls, ['', '?model=opus&effort=high&continue=on']);

  second.close();
  await bar.waitFor({ state: 'visible' });
  // That start counts as one: the next exit offers what it chose.
  assert.equal(await p.inputValue('#term-exit [name=model]'), 'opus');
  assert.equal(await p.inputValue('#term-exit [name=effort]'), 'high');
  const asked = [];
  await p.route('**/api/quit', (r) => {
    const body = r.request().postDataJSON();
    asked.push(body);
    return r.fulfill({ json: body.force ? { quit: true } : { risk: ['2 uncommitted files'] } });
  });
  p.once('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await p.click('#term-quit');
  await bar.getByText('prcoder has quit').waitFor();
  assert.deepEqual(asked, [{}, 'Quit prcoder? 2 uncommitted files.', { force: true }]);
  await p.close();
});
