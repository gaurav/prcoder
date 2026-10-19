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
import { existsSync, readFileSync } from 'node:fs';
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
// One line far wider than any pane, in a file no grammar claims, so the Wrap
// test is about layout alone. Not in `added`: several tests read the Files
// count as 2, so the page that wants it asks for it (`withLong` below).
const LONG = 'A line that goes on ' + 'and on '.repeat(80) + 'to the end.\nShort.';
const added = { 'evil.js': SOURCE, 'app.tsx': TSX };
const sources = { ...added, 'long.txt': LONG };
const fileRow = (p, i) => ({
  path: p, group: bucket(p), additions: sources[p].split('\n').length, deletions: 0, viewed: false,
  url: `${REPO}/pull/12/files#diff-${i}`, blob: `${REPO}/blob/aaaa/${p}`,
  blame: `${REPO}/blame/aaaa/${p}`, history: `${REPO}/commits/aaaa/${p}`,
});
const files = Object.keys(added).map(fileRow);
const pr = {
  number: 12, title: 'A fixture pull request', body: BODY, url: `${REPO}/pull/12`,
  state: 'OPEN', isDraft: false, headRefName: 'topic', baseRefName: 'main',
  additions: 1, deletions: 0, changedFiles: files.length, files,
  headRefOid: 'a'.repeat(40), updatedAt: '2026-09-19T00:00:00Z', isCrossRepository: false,
  headRepo: 'heal-data-stewards/heal-vlmd-AI-pipeline', headOwner: 'heal-data-stewards',
  reviewDecision: '', nodeId: 'PR_fixture',
  checks: rollup([]), counts: { comments: 0, reviews: 0 },
  issues: [{ number: 7, url: `${REPO}/issues/7`, closes: false, title: 'Per-route locking' }],
};
const status = {
  branch: 'topic', head: 'b'.repeat(40), detached: false, dirtyFiles: [], sync: 'synced', ahead: 0,
  defaultBranch: 'main', nameWithOwner: 'heal-data-stewards/heal-vlmd-AI-pipeline',
  scope: 'current', mirrorFailed: false,
  // Where the branch's pull request was looked for, and what was found: the
  // one repository, with the fixture PR in it (branchPrs in github.js).
  repos: ['heal-data-stewards/heal-vlmd-AI-pipeline'], remotes: { 'heal-data-stewards/heal-vlmd-AI-pipeline': 'origin' },
  branchPrs: [{ number: 12, title: pr.title, url: pr.url, state: 'OPEN', isDraft: false, headRefName: 'topic', baseRefName: 'main',
    repo: 'heal-data-stewards/heal-vlmd-AI-pipeline', headRepo: 'heal-data-stewards/heal-vlmd-AI-pipeline', headOwner: 'heal-data-stewards', isCrossRepository: false }],
  pr, queue: [],
};
/** The status with `long.txt` as a third added file, for a page about long lines. */
const withLong = (st) => ({ ...st, pr: { ...st.pr, files: [...files, fileRow('long.txt', files.length)] } });

// What /api/issues answers for a repository with nothing: the Issues tab is
// always there, so every page gets this unless a test routes its own.
const EMPTY_ISSUES = { milestones: [], issues: [], total: 0, listed: 0, repo: 'heal-data-stewards/heal-vlmd-AI-pipeline', mentions: [] };
// And /api/pulls, which the Pull requests tab asks twice on opening: once for
// the last listing, once for a fresh one. `read` is when, in ms.
const EMPTY_PULLS = { milestones: [], pulls: [], total: 0, listed: 0, read: 0 };

let browser;
let page;
const posted = [];

// A page with every route answered, so a test that needs a module map of its
// own -- Prism loads once per page -- can open a second one. `prs` is the
// switcher's list, empty unless a test is about it, and null for a fetch that
// fails; `st` and `ready` are for a page with no pull request, which has no
// title to wait on. `below` is git's answer for a branch with no PR, and none
// unless a test is about it, since the real one would ask this clone's git.
// `pty` is the mock socket's handler, for a test that needs the agent to do
// something. A regex, not `**/pty`: a glob has to match the whole URL, so the
// exit bar's `/pty?model=...` slipped past it to the real server. `whoami` is
// the model and effort prcoder's command line started the agent with, which
// the exit bar is filled with -- or a function given the route, for a test
// that answers it late. `folds` serves index.html with that list in place of
// its `data-folds`, which is how a pane's fold is switched on, and `init` runs
// in the page before its own scripts, for a stub of a browser API. `clock`
// installs Playwright's, for a test that moves time on with `p.clock`.
async function newPage({ prs = [], st = status, ready = '#pr-head .pr-title', below = null, pty = () => {},
  whoami = { model: '', effort: '' }, folds = null, init = null, clock = false } = {}) {
  const p = await browser.newPage();
  if (init) await p.addInitScript(init);
  if (clock) await p.clock.install();
  if (folds) {
    await p.route((u) => u.pathname === '/', async (r) => {
      const res = await r.fetch();
      const html = await res.text();
      const body = html.replace('data-folds="diff term"', `data-folds="${folds}"`);
      assert.notEqual(body, html, 'the switch is where index.html says');
      return r.fulfill({ response: res, body });
    });
  }
  await p.routeWebSocket(/\/pty(\?|$)/, pty);
  await p.route('**/api/whoami', (r) => (typeof whoami === 'function'
    ? whoami(r) : r.fulfill({ json: { started: whoami, version: '0.0.0-test' } })));
  await p.route('**/api/status', (r) => r.fulfill({ json: st }));
  await p.route('**/api/prs', (r) => (prs ? r.fulfill({ json: prs }) : r.abort()));
  await p.route('**/api/below', (r) => {
    p.belowAsked = r.request().postDataJSON();
    return below ? r.fulfill({ json: below }) : r.abort();
  });
  await p.route('**/api/queue', (r) => r.fulfill({ json: [] }));
  await p.route('**/api/issues', (r) => r.fulfill({ json: EMPTY_ISSUES }));
  await p.route('**/api/pulls', (r) => r.fulfill({ json: EMPTY_PULLS }));
  await p.route('**/api/pr/viewed', (r) => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    const lines = sources[path].split('\n');
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

/** Opens `path` from the Files tab, and waits for the diff pane to show it. */
async function openFile(p, path = 'evil.js') {
  await p.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await p.locator(`.file[data-path="${path}"] .path`).click();
  await p.waitForFunction((path) => document.getElementById('diff-path').textContent === path
    && document.querySelectorAll('#diff-body .dl').length > 0, path);
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

// A bare #N is an issue or a pull request, and the list says which, as the
// queue's tag does. An unknown kind -- the title lookup failed -- is a number.
test('a mention that is a pull request is numbered PR #N', { skip }, async () => {
  const issues = [
    { number: 7, url: `${REPO}/issues/7`, closes: false, title: 'Per-route locking', kind: 'issue' },
    { number: 27, url: `${REPO}/pull/27`, closes: false, title: 'Queue tabs', kind: 'pull' },
    { number: 30, url: `${REPO}/issues/30`, closes: false, title: null, kind: null }];
  const fresh = await newPage({ st: { ...status, pr: { ...pr, issues } } });
  assert.deepEqual(await fresh.locator('.issues .num').allTextContents(), ['#7', 'PR #27', '#30']);
  await fresh.close();
});

// Its own page: the shared one has had a box ticked above.
test('the tab carries the task count', { skip }, async () => {
  const fresh = await newPage();
  const tabs = await fresh.locator('#pr-head .tab').allTextContents();
  assert.ok(tabs.includes('Detail (1/3)'), JSON.stringify(tabs));
  // Stack's count is pull requests, not work left, so it has nothing to fill.
  assert.equal(await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).locator('.mark').count(), 0);
  await fresh.close();
});

// A finished count keeps its numbers and its mark turns into the green ✓
// circle; the ✓ glyph alone, in the tab's dim grey, was too faint to see. Read
// off the computed ::after, since the class only promises the stylesheet draws
// it, and the name is asserted exactly so the ✓ is not read out beside `(2/2)`.
// A Checks tab where everything passed is the same circle as any other. The
// mark leads the tab, on every tab, so it is the button's first child.
test('a tab with nothing left keeps its count and leads with a green ✓ circle', { skip }, async () => {
  const p = await newPage({ st: { ...status, pr: { ...pr,
    files: files.map((f) => ({ ...f, viewed: true })),
    checks: rollup([{ workflowName: 'CI', name: 'test', conclusion: 'SUCCESS' }]) } } });
  const circle = (name) => p.locator('#pr-head .tab', { hasText: name }).evaluate((el) => {
    const m = el.querySelector('.mark');
    const s = m && getComputedStyle(m);
    return { text: el.textContent, mark: m?.className ?? null, first: el.firstChild === m,
      glyph: !!m && /✓/.test(getComputedStyle(m, '::after').content),
      filled: !!m && s.backgroundColor !== 'rgba(0, 0, 0, 0)', round: !!m && parseFloat(s.borderTopLeftRadius) > 0 };
  });
  const done = { mark: 'mark full', first: true, glyph: true, filled: true, round: true };
  assert.deepEqual(await circle('Files'), { text: 'Files (2/2)', ...done });
  assert.deepEqual(await circle('Checks'), { text: 'Checks (1/1)', ...done });
  // Detail's mark is a pie like Files', filling by boxes ticked.
  const detail = await circle('Detail');
  assert.deepEqual([detail.mark, detail.first, detail.glyph], ['mark', true, false], 'Detail (1/3) is a pie, not done');
  assert.equal(await p.locator('#pr-head .tab', { hasText: 'Detail' }).locator('.mark').evaluate((m) => m.style.getPropertyValue('--p')),
    String(1 / 3));
  assert.equal(await p.getByRole('button', { name: 'Files (2/2)', exact: true }).count(), 1);
  assert.equal(await p.getByRole('button', { name: 'Checks (1/1)', exact: true }).count(), 1);
  // A row too narrow for its tabs wraps whole tabs, never a label inside one
  // (`#pr-head .tab` says why). Squeezed rather than measured at the default
  // width, where whether it fits is a pixel or two that differs by font.
  const rows = await p.$eval('#pr-head .tabs', (row) => {
    row.style.width = '200px';
    const tabs = [...row.querySelectorAll('.tab')];
    return { heights: new Set(tabs.map((t) => t.offsetHeight)).size, lines: new Set(tabs.map((t) => t.offsetTop)).size };
  });
  assert.equal(rows.heights, 1, 'every tab is one line tall');
  assert.ok(rows.lines > 1, 'and the row wrapped between them');
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
  assert.equal(await tab.locator('.mark').getAttribute('class'), 'mark fail', 'a failure beats a pending check');
  await tab.click();
  assert.deepEqual(await p.locator('#pr-body .check-name').allTextContents(), ['CI / test', 'deploy', 'lint']);
  assert.deepEqual(await p.locator('#pr-body .check-state').allTextContents(), ['pending', 'failed'],
    'a word beside every check that did not pass');
  assert.deepEqual(await p.locator('#pr-body .check').evaluateAll((rs) => rs.map((r) => r.querySelector('.mark').getAttribute('aria-label'))),
    ['passed', null, null], 'and a passed one is named by its mark, so a screen reader hears it passed');
  assert.deepEqual(await p.$$eval('#pr-body .check a', (as) => as.map((a) => a.getAttribute('href'))),
    [`${REPO}/actions/runs/1`], 'only the http(s) link is a link');
  // Shape, not only colour: read off the computed ::before, since the class is
  // only a promise that the stylesheet draws something different for it.
  const marks = await p.$$eval('#pr-body .check .mark', (ms) => ms.map((m) => {
    const s = getComputedStyle(m);
    return { filled: s.backgroundImage === 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)',
      ring: s.boxShadow !== 'none', glyph: getComputedStyle(m, '::after').content.match(/[✓✕]/)?.[0] ?? null };
  }));
  assert.deepEqual(marks, [
    { filled: true, ring: false, glyph: '✓' },
    { filled: false, ring: true, glyph: null },
    { filled: true, ring: false, glyph: '✕' },
  ], 'a ✓ disc passed, a ring is pending, a ✕ disc failed');

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
  // The diff is 1fr now, so a drag of the line under it would set a height
  // nothing reads. A separate hide rule once lost to the show rule on order.
  assert.equal(await fresh.locator('#gut-diff').isVisible(), false, 'nothing to drag under a folded terminal');

  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  assert.equal(await fresh.locator('#term-host').isVisible(), false, 'folded after a reload');

  await fresh.click('#term > header h1');
  assert.equal(await fresh.locator('#term-host').isVisible(), true);
  assert.equal(await fresh.getAttribute('#term-fold', 'aria-expanded'), 'true');
  await fresh.close();
});

// Wrap is a class on the pane and a rule on the rows, so what has to hold is
// the layout: a long line is one row high and scrolls the body sideways until
// Wrap is pressed, then it is taller than a short one and nothing scrolls. Its
// own page, because the choice is stored and survives a reload.
test('Wrap folds a long line inside the pane, and stays pressed across a reload', { skip }, async () => {
  const fresh = await newPage({ st: withLong(status) });
  const openLong = async () => {
    await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
    await fresh.locator('.file[data-path="long.txt"] .path').click();
    await fresh.waitForSelector('#diff-body .dl');
  };
  const rows = () => fresh.$$eval('#diff-body .dl', (els) => els.map((el) => el.getBoundingClientRect().height));
  const sideways = () => fresh.$eval('#diff-body', (el) => el.scrollWidth > el.clientWidth);
  const pressed = () => fresh.getAttribute('#diff-wrap', 'aria-pressed');
  const height = () => fresh.$eval('#diff > header', (el) => el.getBoundingClientRect().height);

  await openLong();
  assert.equal(await pressed(), 'false', 'off until pressed, for every file');
  let [long, short] = await rows();
  assert.equal(long, short, 'unwrapped, the long line is one row');
  assert.ok(await sideways(), 'and the body scrolls sideways');
  const shown = await height();
  await fresh.$eval('#diff-wrap', (el) => { el.style.display = 'none'; });
  assert.equal(shown, await height(), 'the Wrap button should not make the header taller');
  await fresh.$eval('#diff-wrap', (el) => { el.style.display = ''; });

  await fresh.click('#diff-wrap');
  assert.equal(await pressed(), 'true');
  assert.equal(await fresh.getAttribute('#diff-wrap', 'title'), 'wrap long lines (Alt+W)',
    'the state is aria-pressed alone, not a title flipped to "unwrap" as well');
  [long, short] = await rows();
  assert.ok(long > short, `wrapped, the long row (${long}px) should be taller than the short one (${short}px)`);
  assert.equal(await sideways(), false, 'and nothing scrolls sideways');

  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  await openLong();
  assert.equal(await pressed(), 'true', 'still pressed after a reload');
  [long, short] = await rows();
  assert.ok(long > short, 'and still wrapped');

  await fresh.click('#diff-wrap');
  assert.equal(await pressed(), 'false');
  [long, short] = await rows();
  assert.equal(long, short, 'pressed again, the long line is one row');

  // Alt+W is the button from the keyboard -- unless a key is being typed, in
  // which case it is a character: the queue's input stands in for the terminal
  // and the editable items, which keys.js guards by the same rule. The body is
  // clicked only to take focus off the input; the bar would fold the pane.
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await pressed(), 'true', 'Alt+W presses Wrap');
  await fresh.locator('#queue-input').focus();
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await pressed(), 'true', 'but not while typing');
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await pressed(), 'false', 'and presses it again');
  // A clicked checkbox keeps focus, and nothing is typed into one: ticking
  // *viewed* and reading on is the usual order, so Alt+W has to work from it.
  await fresh.locator('#diff-viewed').focus();
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'diff-viewed');
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await pressed(), 'true', 'and works from a checkbox');
  await fresh.close();
});

// Safari's private mode throws on every write, and setPref says a refused
// write holds for the session -- so Wrap has to toggle both ways, and Wrap and
// a hidden outline stay as set from one file to the next, without storage ever
// taking the choice.
test('Wrap and the outline hold across files when storage refuses writes', { skip }, async () => {
  const fresh = await newPage({ st: withLong(status) });
  await fresh.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('refused', 'QuotaExceededError'); };
  });
  // Two hunks, so evil.js has an outline to hide.
  await fresh.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    if (path !== 'evil.js') return r.fallback();
    return r.fulfill({ json: { path, patch: '@@ -1,1 +1,1 @@ first\n-a\n+b\n@@ -9,1 +9,1 @@ second\n-c\n+d' } });
  });
  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  const open = async (path) => {
    await fresh.locator('.file[data-path="' + path + '"] .path').click();
    await fresh.waitForSelector('#diff-body .dl');
  };
  const pressed = () => fresh.getAttribute('#diff-wrap', 'aria-pressed');

  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await open('long.txt');
  await fresh.click('#diff-wrap');
  assert.equal(await pressed(), 'true', 'pressed');
  await open('evil.js');
  assert.equal(await pressed(), 'true', 'still pressed on the next file');
  await fresh.click('#diff-wrap');
  assert.equal(await pressed(), 'false', 'and unpressed by a second click');
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await pressed(), 'true', 'and Alt+W flips it too');

  // The outline is stored the same way, and a hidden one must stay hidden.
  const hidden = () => fresh.$eval('#diff', (el) => el.classList.contains('outline-off'));
  await fresh.waitForSelector('#diff-outline button');
  await fresh.click('#diff-outline-hide');
  assert.equal(await hidden(), true, 'the outline hides');
  await open('long.txt');
  await open('evil.js');
  assert.equal(await hidden(), true, 'and stays hidden on the next file');
  await fresh.close();
});

// The ⟳ is drawn larger than the header's text, because at the same size this
// font makes it a speck -- and a glyph at a bigger size is how a header grows.
// So the header has to be the height it is with the ⟳ at the header's own
// size. Not the height without the button: in Firefox the button at any size
// is what sets the header's height, where in Chromium the dropdown does
// (37px and 36px on 2026-10-11, measured in each engine). The corner menu's
// test below measures the same way.
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

// The corner of the page is prcoder's, not the pull request pane's: the tab's
// tile and the name, as a menu. It sits in the header at the header's own
// height -- a taller summary would move every pane's top edge -- and closes
// the ways a menu does, which a <details> does not do on its own: a click
// elsewhere, Escape, a pick.
test('the corner is prcoder\'s menu, at the header\'s height, and closes like one', { skip }, async () => {
  const height = () => page.$eval('#pr > header', (el) => el.getBoundingClientRect().height);
  const whole = await height();
  await page.$eval('#menu', (el) => { el.style.display = 'none'; });
  const without = await height();
  await page.$eval('#menu', (el) => { el.style.display = ''; });
  assert.equal(whole, without, 'the menu should not make the header taller');
  assert.equal(await page.textContent('#pr > header h1'), 'prcoder');
  assert.equal(await page.getAttribute('#logo', 'src'),
    await page.getAttribute('link[rel=icon]', 'href'), 'the tile is the tab\'s icon');
  const open = () => page.$eval('#menu', (el) => el.open);
  assert.equal(await open(), false);
  await page.click('#menu > summary');
  assert.equal(await open(), true);
  // The hint is spelled for the keyboard the page is on, as the sheet's are:
  // the same text as the sheet's last row, Alt+/ itself.
  const slash = await page.$eval('#keys-list tr:last-child kbd', (el) => el.textContent);
  assert.match(slash, /\/$/);
  assert.deepEqual(await page.$$eval('#menu-list > :is(a, button, span)', (els) => els.map((el) => el.textContent.trim())),
    [`Keyboard shortcuts ${slash}`, 'Documentation', 'Report an issue', 'Repository', 'Quit prcoder…', 'prcoder 0.0.0-test']);
  for (const id of ['menu-docs', 'menu-issue', 'menu-repo']) {
    assert.match(await page.getAttribute(`#${id}`, 'href'), /^https:\/\/github\.com\/gaurav\/prcoder/);
    assert.equal(await page.getAttribute(`#${id}`, 'target'), '_blank');
  }
  await page.click('#pr-body');
  assert.equal(await open(), false, 'a click elsewhere closes it');
  await page.click('#menu > summary');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false, 'so does Escape');
  // From an item, too, and the focus goes back to the menu rather than
  // staying on an item the close has just hidden.
  await page.click('#menu > summary');
  await page.focus('#menu-docs');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false, 'Escape from an item closes it');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#menu > summary')), true,
    'and the focus is on the menu');
  await page.click('#menu > summary');
  await page.click('#menu-keys');
  assert.equal(await open(), false, 'and a pick');
  assert.equal(await page.$eval('#keys', (d) => d.open), true, 'which opened the sheet');
  // The pick it was opened from is hidden in the closed menu, so the focus
  // goes back to the menu itself rather than falling out of the page.
  // Waited for: the close event is a task of its own, which Chromium runs
  // after a click has returned.
  const onMenu = () => page.waitForFunction(() => document.activeElement === document.querySelector('#menu > summary'),
    null, { timeout: 2000 }).then(() => true, () => false);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#keys', (d) => d.open), false);
  assert.equal(await onMenu(), true, 'Escape hands the focus to the menu');
  await page.click('#menu > summary');
  await page.click('#menu-keys');
  await page.click('#keys-close');
  assert.equal(await page.$eval('#keys', (d) => d.open), false);
  assert.equal(await onMenu(), true, 'so does the ✕');
  // Alt+/ from an item opens the sheet over the open menu. Escape closes the
  // sheet and only the sheet: the item it hands the focus back to is still
  // showing, rather than hidden in a menu closed behind the sheet.
  await page.click('#menu > summary');
  await page.focus('#menu-docs');
  await page.keyboard.press('Alt+Slash');
  assert.equal(await page.$eval('#keys', (d) => d.open), true, 'Alt+/ from an item');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#keys', (d) => d.open), false);
  assert.equal(await open(), true, 'the menu behind the sheet stays open');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'menu-docs', 'with the focus on its item');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false);
  // Nor does a click in the sheet close the menu behind it: on its padding,
  // or on the ✕, which closes the sheet and hands the focus to the item.
  await page.click('#menu > summary');
  await page.focus('#menu-docs');
  await page.keyboard.press('Alt+Slash');
  const edge = await page.$eval('#keys', (d) => { const r = d.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
  await page.mouse.click(edge.x, edge.y);
  assert.equal(await open(), true, 'a click on the sheet leaves the menu open');
  await page.click('#keys-close');
  assert.equal(await open(), true, 'and so does its ✕');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'menu-docs', 'with the focus on its item');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false);
  // A click on the sheet's padding has the dialog as its target, as a click
  // on the backdrop does; only the backdrop closes it.
  await page.keyboard.press('Alt+Slash');
  const box = await page.$eval('#keys', (d) => { const r = d.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height }; });
  await page.mouse.click(box.x + 4, box.y + box.h / 2);
  assert.equal(await page.$eval('#keys', (d) => d.open), true, 'a click on the sheet\'s edge leaves it open');
  await page.mouse.click(4, 4);
  assert.equal(await page.$eval('#keys', (d) => d.open), false, 'a click on the backdrop closes it');
});

// The sheet is built from the bindKeys table, so its keys are the table's, and
// they have to be the ones docs/Panes.md lists, in the same order: a key added
// to one and not the other fails here.
// Alt+/ opens it from the terminal, a glance, and Escape hands the focus
// back there; the agent sees none of it.
test('Alt+/ shows every shortcut, from the terminal too, and Escape puts the focus back', { skip }, async () => {
  const { fresh, typed } = await agentPage();
  const shown = () => fresh.$eval('#keys', (d) => d.open);
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+Slash');
  await fresh.waitForFunction(() => document.getElementById('keys').open);
  // agentPage is on Linux (onLinux, below), so the sheet spells Alt+V as the
  // table does, on a Mac too; keyLabel's ⌥V is the unit test's.
  const documented = readFileSync(new URL('../../docs/Panes.md', import.meta.url), 'utf8')
    .split('\n').map((l) => l.match(/^\| (Alt\+\S+) /)?.[1]).filter(Boolean);
  assert.ok(documented.includes('Alt+/'), 'the table in Panes.md is where this reads it');
  assert.deepEqual(await fresh.$$eval('#keys-list kbd', (els) => els.map((el) => el.textContent)), documented);
  assert.match(await fresh.textContent('#keys-note'), /from the coding agent's terminal too/);
  assert.match(await fresh.textContent('#keys-note'), /as on a US keyboard/, 'a binding is a place, not a character');
  await fresh.keyboard.press('Escape');
  await fresh.waitForFunction(() => !document.getElementById('keys').open);
  assert.equal(await fresh.evaluate(() => !!document.activeElement?.closest('#term-host')), true, 'focus back in the terminal');
  await settle(fresh);
  assert.equal(typed().length, 0, 'the agent saw neither key');
  // From the page, the same key both ways.
  await fresh.locator('#diff-fold').focus();
  await fresh.keyboard.press('Alt+Slash');
  assert.equal(await shown(), true);
  // The page behind a modal is inert, and so are its keys: a key tried out
  // while reading the sheet does nothing to the panes behind it.
  const before = await openPath(fresh);
  for (const key of ['Alt+KeyJ', 'Alt+KeyX', 'Alt+KeyG']) await fresh.keyboard.press(key);
  await settle(fresh);
  assert.equal(await openPath(fresh), before, 'no file opened behind the sheet');
  assert.equal(await fresh.$eval('main', (el) => el.classList.contains('term-off')), false, 'nor the agent pane folded');
  await fresh.keyboard.press('Alt+Slash');
  assert.equal(await shown(), false, 'pressed again, it closes');
  await fresh.close();
});

// Quit from the menu is the exit bar's quit: the same question, and the same
// line in the bar afterwards -- plus a toast, since the bar may be off screen.
// The PTY dies with prcoder, so its socket closes after the bar is filled:
// that close must leave the bar saying so, and not throw on the way.
test('Quit in the menu asks what the exit bar asks, and says when it has quit', { skip }, async () => {
  let sock;
  const fresh = await newPage({ pty: (ws) => { sock = ws; } });
  const errors = [];
  fresh.on('pageerror', (e) => errors.push(e.message));
  const asked = [];
  await fresh.route('**/api/quit', (r) => {
    const body = r.request().postDataJSON();
    asked.push(body);
    return r.fulfill({ json: body.force ? { quit: true } : { risk: ['2 uncommitted files'] } });
  });
  fresh.once('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await fresh.click('#menu > summary');
  await fresh.click('#menu-quit');
  await fresh.waitForSelector('#toast:not([hidden])');
  assert.match(await fresh.textContent('#toast'), /prcoder has quit/);
  assert.equal(await fresh.$eval('#toast', (el) => el.classList.contains('sticky')), true);
  await fresh.locator('#term-exit').getByText('prcoder has quit').waitFor();
  assert.deepEqual(asked, [{}, 'Quit prcoder? 2 uncommitted files.', { force: true }]);
  await sock.close();
  await settle(fresh);
  assert.deepEqual(errors, []);
  assert.match(await fresh.textContent('#term-exit'), /prcoder has quit/);
  // Nothing is left to quit, so the menu's Quit can't be picked again and
  // put a network error over the toast that says the quit worked.
  assert.equal(await fresh.$eval('#menu-quit', (b) => b.disabled), true, 'the menu\'s Quit is off');
  await fresh.close();
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

// Folding the diff is for talking to the agent with the file still named on
// the bar, so the terminal is what takes the room. The bar is busy with
// controls, each of which keeps its own click; the rest of it, ▼ included, is
// the fold. Not stored (nothing is open after a reload), so no reload here.
test('the diff folds to its header, the terminal takes the room, and the two never fold together', { skip }, async () => {
  const fresh = await newPage();
  const height = (sel) => fresh.$eval(sel, (el) => el.getBoundingClientRect().height);
  const shown = () => fresh.locator('#diff-main').isVisible();
  const open = (path) => openFile(fresh, path);
  await open('evil.js');
  const bar = await height('#diff > header');
  const term = await height('#term');

  await fresh.click('#diff > header h1');
  assert.equal(await shown(), false, 'the title folds it');
  assert.equal(await height('#diff'), bar, 'folded, the pane is its header');
  assert.ok(await height('#term') > term, `terminal was ${term}px, is ${await height('#term')}px`);
  assert.equal(await fresh.getAttribute('#diff-fold', 'aria-expanded'), 'false');
  assert.equal(await fresh.locator('#gut-diff').isVisible(), false, 'nothing to drag');
  assert.equal(await fresh.locator('#diff-wrap').isVisible(), false, 'Wrap acts on a body that is not shown');
  await fresh.locator('#diff-fold').focus();   // off the queue input, or Alt+W is typing
  await fresh.keyboard.press('Alt+KeyW');
  assert.equal(await fresh.getAttribute('#diff-wrap', 'aria-pressed'), 'false', 'so Alt+W presses nothing');
  await fresh.locator('#diff-viewed-label').click();   // the label's text, which ticks the box
  assert.equal(await fresh.locator('#diff-viewed').isChecked(), true, 'the controls keep their clicks');
  assert.equal(await shown(), false, 'and do not fold');

  await fresh.click('#diff-fold');
  assert.equal(await shown(), true, 'the ▼ toggles once, not for itself and again for the bar');
  assert.equal(await height('#diff > header'), bar, 'the header keeps its height either way');
  await fresh.click('#diff-path');
  assert.equal(await shown(), false, 'the path folds it');
  await open('app.tsx');
  assert.equal(await shown(), true, 'opening a file unfolds it');
  await fresh.click('#diff-path');
  await open('app.tsx');
  assert.equal(await shown(), true, 'the open one included');

  await fresh.click('#term-fold');
  assert.equal(await fresh.locator('#term-host').isVisible(), false);
  await fresh.click('#diff > header h1');
  assert.equal(await shown(), false);
  assert.equal(await fresh.locator('#term-host').isVisible(), true, 'folding the diff unfolds the terminal');
  assert.equal(await fresh.getAttribute('#term-fold', 'aria-expanded'), 'true');
  await fresh.click('#term-fold');
  assert.equal(await shown(), true, 'and folding the terminal unfolds the diff');
  assert.equal(await fresh.getAttribute('#diff-fold', 'aria-expanded'), 'true');
  await fresh.click('#term-fold');

  await fresh.click('#diff > header h1');
  await fresh.click('#diff-close');
  assert.equal(await fresh.$eval('main', (m) => m.classList.contains('diff-off')), false, 'closing forgets the fold');
  await open('evil.js');
  assert.equal(await shown(), true, 'so the next open is unfolded');
  await fresh.close();
});

// The queue's fold is built and switched off in index.html (Panes.md says
// why), so the shipped page shows no ▼ there and its bar is plain; the page is
// then served with `queue` in the list, which is what turning it on is. Its own
// page: the fold is stored, and the never-last rule needs a folded terminal
// with no diff.
test('the queue folds only when data-folds says so, and never as the last pane open', { skip }, async () => {
  const off = await newPage();
  assert.equal(await off.locator('#queue-fold').isVisible(), false, 'off, there is no ▼');
  await off.click('#queue > header h1');
  assert.equal(await off.locator('#queue-body').isVisible(), true, 'and the bar is not a toggle');
  await off.close();

  // Turned on the way it would be: the page served with `queue` in the list.
  const fresh = await newPage({ folds: 'diff term queue' });
  const shown = () => fresh.locator('#queue-body').isVisible();
  const height = (sel) => fresh.$eval(sel, (el) => el.getBoundingClientRect().height);
  assert.equal(await fresh.locator('#queue-fold').isVisible(), true);
  const bar = await height('#queue > header');
  const term = await height('#term');
  await fresh.click('#queue > header h1');
  assert.equal(await shown(), false, 'on, the title folds it');
  assert.equal(await height('#queue'), bar, 'to its bar');
  assert.ok(await height('#term') > term, `terminal was ${term}px, is ${await height('#term')}px`);
  assert.equal(await fresh.locator('#gut-queue').isVisible(), false, 'nothing to drag');
  await fresh.locator('#queue-input').click();
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'queue-input', 'the input keeps its click');
  assert.equal(await shown(), false);

  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  assert.equal(await shown(), false, 'stored, like the terminal\'s');
  await fresh.click('#queue-fold');
  assert.equal(await shown(), true);

  await fresh.click('#term-fold');
  assert.equal(await fresh.locator('#term-host').isVisible(), false);
  await fresh.click('#queue > header h1');
  assert.equal(await shown(), false);
  assert.equal(await fresh.locator('#term-host').isVisible(), true, 'the last pane open cannot fold away: the terminal comes back');
  await fresh.close();
});

// The never-last rule holds on every way to the all-folded state, not only a
// fold of the queue: folding the terminal with the queue folded, folds stored
// that way and restored on a reload, and a closed diff that was holding the
// room between them. Its own page, for the queue switch and the stored folds.
test('no way in folds every pane: the terminal\'s fold, a reload, a closed diff', { skip }, async () => {
  const fresh = await newPage({ folds: 'diff term queue' });
  const termShown = () => fresh.locator('#term-host').isVisible();
  const queueShown = () => fresh.locator('#queue-body').isVisible();
  const height = (sel) => fresh.$eval(sel, (el) => el.getBoundingClientRect().height);

  await fresh.click('#queue-fold');
  await fresh.click('#term-fold');
  assert.equal(await termShown(), false, 'the fold asked for is the one that holds');
  assert.equal(await queueShown(), true, 'and the queue comes back to take the room');

  await fresh.evaluate(() => { localStorage.setItem('prcoder:term', 'off'); localStorage.setItem('prcoder:queue', 'off'); });
  await fresh.reload();
  await fresh.waitForSelector('#pr-head .pr-title');
  assert.equal(await termShown(), true, 'both stored folded, the terminal comes back on a reload');
  assert.equal(await queueShown(), false, 'and the queue keeps its fold');
  assert.equal(await fresh.evaluate(() => localStorage.getItem('prcoder:term')), 'on', 'stored, so the next reload agrees');

  // With a diff open both may fold, and closing it is what would empty the column.
  await openFile(fresh);
  await fresh.click('#term-fold');
  assert.equal(await termShown(), false);
  assert.equal(await queueShown(), false);
  await fresh.click('#diff-close');
  assert.equal(await termShown(), true, 'closing the diff brings the terminal back');
  assert.equal(await queueShown(), false);

  // Should the rules ever slip, a folded queue is still a bar: style.css's
  // queue-off has to beat the term-off rules that give the queue the room.
  const bar = await height('#queue > header');
  await fresh.evaluate(() => document.querySelector('main').classList.add('term-off'));
  assert.equal(await height('#queue'), bar, 'a folded queue under a folded terminal is its bar');
  await fresh.close();
});

// The bar's path cannot be selected (app.js says why), so ⧉ copies it: from
// the repository root, open or folded, without folding, and a refusal says so.
// The clipboard is a stub: Firefox gives a page no way to read it back, and
// Chromium only with a permission. The real writeText on localhost was
// checked by hand in both engines (2026-10-09). An init, so it runs in the
// page: what it wrote is window.copiedText, and window.refuseClipboard makes
// the next write throw the way a browser's refusal does.
const stubClipboard = () => {
  window.copiedText = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => {
    if (window.refuseClipboard) throw new DOMException('refused', 'NotAllowedError');
    window.copiedText.push(t);
  } } });
};
test('⧉ copies the open file\'s path, folded or not, and says when it cannot', { skip }, async () => {
  const fresh = await newPage({ init: stubClipboard });
  const copied = () => fresh.evaluate(() => window.copiedText);
  await openFile(fresh);
  await fresh.click('#diff-copy');
  assert.deepEqual(await copied(), ['evil.js']);
  assert.equal(await fresh.textContent('#diff-copy'), '✓', 'and says it went');
  assert.equal(await fresh.locator('#diff-main').isVisible(), true, 'a control, not the fold');
  await fresh.waitForFunction(() => document.getElementById('diff-copy').textContent === '⧉');
  await fresh.click('#diff > header h1');
  await fresh.click('#diff-copy');
  assert.deepEqual(await copied(), ['evil.js', 'evil.js'], 'folded too');
  await fresh.evaluate(() => { window.refuseClipboard = true; });
  await fresh.click('#diff-copy');
  await fresh.waitForSelector('#toast:not([hidden])');
  assert.match(await fresh.textContent('#toast'), /not copied/);
  await fresh.close();
});

// A fold hides its pane's body, and the focus with it if it was in there, so
// the ▼ takes it: the key that brings the rest back. dispatchEvent, because a
// real click on the bar would move the focus to <body> itself first.
test('folding a pane with the focus inside hands the focus to its ▼', { skip }, async () => {
  const fresh = await newPage();
  const focused = () => fresh.evaluate(() => document.activeElement.id);
  await openFile(fresh);
  await fresh.locator('#diff-wrap').focus();
  await fresh.dispatchEvent('#diff > header h1', 'click');
  assert.equal(await fresh.locator('#diff-main').isVisible(), false);
  assert.equal(await focused(), 'diff-fold', 'Wrap went with the body');
  await fresh.dispatchEvent('#diff > header h1', 'click');
  await fresh.locator('#diff-viewed').focus();
  await fresh.dispatchEvent('#diff > header h1', 'click');
  assert.equal(await focused(), 'diff-viewed', 'focus on the bar stays where it was');
  await fresh.click('#term-host');
  assert.equal(await fresh.evaluate(() => document.getElementById('term-host').contains(document.activeElement)), true);
  await fresh.dispatchEvent('#term > header h1', 'click');
  assert.equal(await fresh.locator('#term-host').isVisible(), false);
  assert.equal(await focused(), 'term-fold', 'the terminal\'s focus goes to its ▼ too');
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
      const { toast } = await import('/ui.js');
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
  const pie = (sel) => fresh.locator(`${sel} > summary .mark`).evaluate((el) => ({
    label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
    p: el.style.getPropertyValue('--p'), full: el.classList.contains('full'),
    tick: /✓/.test(getComputedStyle(el, '::after').content),
  }));

  // The description's section holding the queue's unticked line.
  assert.deepEqual(await pie('.md-section:has(h3:text-is("Before merging"))'),
    { label: '0 of 1 done', role: 'img', p: '0', full: false, tick: false });

  // The Files tab's own, by changed lines rather than files: two of the five
  // are viewed, and they are two of the four big ones. The figure is the tab's
  // name and tooltip, not the mark's, which is hidden: the label beside it
  // already says what a name on it would. Once every file is viewed it is the
  // ✓ circle instead -- the tab-done test pins that name exactly.
  const n = files[0].additions;
  const tab = await fresh.locator('#pr-head .tab', { hasText: 'Files' }).evaluate((el) => ({
    name: el.getAttribute('aria-label'), title: el.title,
    p: el.querySelector('.mark').style.getPropertyValue('--p'),
    hidden: el.querySelector('.mark').getAttribute('aria-hidden'),
  }));
  const name = `Files (2/5): ${2 * n} of ${4 * n + 1} changed lines viewed`;
  assert.deepEqual(tab, { name, title: name, p: String(2 * n / (4 * n + 1)), hidden: 'true' });

  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  // By changed lines, as the tab's is; src/'s two files are the same size.
  assert.deepEqual(await pie('.dir[data-dir="src/"]'),
    { label: `1 of 2 files, ${n} of ${2 * n} changed lines viewed`, role: 'img', p: '0.5', full: false, tick: false });
  // And a full one is the ✓ circle a finished tab leads with.
  assert.deepEqual(await pie('.dir[data-dir="src/sub/"]'),
    { label: `1 of 1 files, ${n} of ${n} changed lines viewed`, role: 'img', p: '1', full: true, tick: true });
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
  let puts = 0;
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, queue } }));
  await fresh.route('**/api/queue', (r) => (r.request().method() === 'PUT'
    ? (puts++, r.fulfill({ status: 500, json: { error: 'disk full' } }))
    : r.fulfill({ json: queue })));
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .item');
  // click(), not check(): check() reads the box again after clicking, and when
  // the refusal has already repainted the row that box is detached -- so it
  // retries on the new, unticked one and ticks it a second time. That second
  // save was still in flight when the first one's toast came up, and the
  // assertions below saw a ticked box (CI only: there the PUT wins the race).
  await fresh.locator('#queue-body .item input[type=checkbox]').click();
  // For this text, not any toast: the reload raises its own restart notice.
  await fresh.waitForFunction(() => document.getElementById('toast').textContent === 'disk full');
  assert.equal(puts, 1, 'ticked once');
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

// A reference typed into the queue is looked up before it is added. This is
// the pane's half: what it does with the route's answer, which is mocked here
// with the shape POST /api/queue/ref gives (github.test.js has the lookup).
async function refPage(answer, queue = []) {
  const fresh = await newPage();
  const typed = [];
  await fresh.routeWebSocket('**/pty', (ws) => ws.onMessage((m) => {
    const msg = JSON.parse(m);
    if (msg.type === 'input') typed.push(msg.data);
  }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, nameWithOwner: 'gaurav/prcoder', queue } }));
  // The server's decorate(), as far as these tests need it.
  const url = (i) => (i.issue ? `https://github.com/${i.repo ?? 'gaurav/prcoder'}/${i.kind === 'pull' ? 'pull' : 'issues'}/${i.issue}` : null);
  await fresh.route('**/api/queue', (r) => {
    if (r.request().method() === 'PUT') queue = r.request().postDataJSON().items.map((i) => ({ ...i, issueUrl: url(i) }));
    return r.fulfill({ json: queue });
  });
  await fresh.route('**/api/queue/ref', (r) => r.fulfill(answer(r.request().postDataJSON().text)));
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .tab[data-tab="local"]');
  const add = async (text) => {
    await fresh.locator('#queue-input').fill(text);
    await fresh.locator('#queue-input').press('Enter');
  };
  return { fresh, add, typed, rows: () => fresh.locator('#queue-body .item') };
}

test('a reference on its own is added as the issue\'s title, tagged, and ▶ carries the link', { skip }, async () => {
  const { fresh, add, typed, rows } = await refPage(() => ({ json: { ref: {
    whole: true, issue: 91, repo: null, kind: 'pull', title: 'Make the queue read references' } } }));
  await add('https://github.com/gaurav/prcoder/pull/91');
  // A pull request, so its tag says so, and is not an issue's.
  await fresh.waitForSelector('#queue-body .item .tag.pull');
  assert.deepEqual(await rows().locator('.text').allTextContents(), ['Make the queue read references']);
  assert.equal(await rows().locator('.tag.issue').count(), 0);
  const tag = rows().locator('.tag.pull');
  assert.equal(await tag.textContent(), 'PR #91');
  assert.equal(await tag.getAttribute('href'), 'https://github.com/gaurav/prcoder/pull/91');
  // Already an issue here, so there is nothing for ◎ to file.
  assert.equal(await rows().locator('button[title="move into a new issue"]').count(), 0);
  assert.equal(await fresh.locator('#queue-input').inputValue(), '');
  // The same reference again is refused, and stays in the input.
  await add('#91');
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('PR #91 is already in your queue'));
  assert.equal(await rows().count(), 1);
  assert.equal(await fresh.locator('#queue-input').inputValue(), '#91');
  await rows().locator('button[title^="type into Claude"]').click();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab.on')?.textContent.startsWith('Local (0)'));
  assert.deepEqual(typed, ['Make the queue read references (https://github.com/gaurav/prcoder/pull/91)']);
  await fresh.close();
});

test('a reference inside other text keeps the text, and the tag is another repo\'s', { skip }, async () => {
  const { fresh, add, typed, rows } = await refPage(() => ({ json: { ref: {
    whole: false, issue: 123, repo: 'cli/cli', kind: 'issue', title: 'not used' } } }));
  await add('Work around cli/cli#123');
  await fresh.waitForSelector('#queue-body .item .tag.issue');
  assert.deepEqual(await rows().locator('.text').allTextContents(), ['Work around cli/cli#123']);
  assert.equal(await rows().locator('.tag.issue').textContent(), 'cli/cli#123');
  // Another repo's issue can still be filed here, as a new one.
  assert.equal(await rows().locator('button[title="move into a new issue"]').count(), 1);
  // The text already says which issue, so ▶ adds nothing to it.
  await rows().locator('button[title^="type into Claude"]').click();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab.on')?.textContent.startsWith('Local (0)'));
  assert.deepEqual(typed, ['Work around cli/cli#123']);
  await fresh.close();
});

test('a reference GitHub does not know says why and stays in the input', { skip }, async () => {
  const reason = 'gaurav/prcoder#99999: Could not resolve to an issue or pull request with the number of 99999.';
  const { fresh, add, rows } = await refPage(() => ({ status: 500, json: { error: reason } }));
  await add('#99999');
  await fresh.waitForFunction((r) => document.getElementById('toast').textContent === r, reason);
  assert.equal(await rows().count(), 0);
  assert.equal(await fresh.locator('#queue-input').inputValue(), '#99999');
  await fresh.close();
});

// Before the queue read references it worked without GitHub, and it still
// does: a lookup that got no answer adds the text as it is, untagged.
test('a reference GitHub could not be asked about is added as plain text', { skip }, async () => {
  const { fresh, add, rows } = await refPage(() => ({ json: { ref: null, unchecked: 'gaurav/prcoder#93: error connecting to api.github.com' } }));
  await add('Fix #93 later');
  await fresh.waitForSelector('#queue-body .item');
  assert.deepEqual(await rows().locator('.text').allTextContents(), ['Fix #93 later']);
  assert.equal(await rows().locator('.tag').count(), 0);
  assert.equal(await fresh.locator('#queue-input').inputValue(), '');
  assert.match(await fresh.locator('#toast').textContent(), /plain text.*error connecting/);
  await fresh.close();
});

// refPage's PR is in heal-data-stewards/... while prcoder is in gaurav/prcoder,
// so the fixture's #7 is another repo's: stored as this one's, its tag would
// link to gaurav/prcoder#7 and ◎ would be hidden.
test('↓ on the Issues tab keeps the repo the mention is in', { skip }, async () => {
  const { fresh, rows } = await refPage(() => ({ json: { ref: null } }));
  await fresh.route('**/api/issues', (r) => r.fulfill({ json: { ...EMPTY_ISSUES, mentions: [
    { number: 7, url: `${REPO}/issues/7`, title: 'Per-route locking', kind: 'issue', state: 'OPEN', updatedAt: '2026-09-01T00:00:00Z' }] } }));
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  await fresh.locator('#queue-body [data-group="mentioned"] button[title="copy into your queue"]').click();
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  await fresh.waitForSelector('#queue-body .item .tag.issue');
  const tag = rows().locator('.tag.issue');
  assert.equal(await tag.textContent(), 'heal-data-stewards/heal-vlmd-AI-pipeline#7');
  assert.equal(await tag.getAttribute('href'), `${REPO}/issues/7`);
  assert.equal(await rows().locator('button[title="move into a new issue"]').count(), 1);
  await fresh.close();
});

// The Issues tab reads the repository: its open issues by milestone, in the
// owner's order, searchable, each row openable to the issue's body. The
// fixture is a repository on gaurav/prcoder's shape: two releases, two
// buckets, one of them empty, and issues on some.
const ISSUES = {
  milestones: [
    { number: 3, title: 'Not urgent', dueOn: null, description: 'Worth doing eventually.' },
    { number: 1, title: 'v1.0', dueOn: '2026-10-14T00:00:00Z', description: '' },
    { number: 4, title: 'Needed soon', dueOn: null, description: '' },
    { number: 2, title: 'v0.1', dueOn: '2026-10-02T00:00:00Z', description: '' },
  ],
  issues: [
    { number: 58, title: 'Decide what the Issues tab shows', url: 'https://github.com/gaurav/prcoder/issues/58', updatedAt: '2026-10-10T00:00:00Z',
      body: 'Focus on an **upcoming** milestone. See #5 and <img src=x onerror=alert(1)>.\n\n- [ ] a box', milestone: 1, labels: ['enhancement'] },
    { number: 66, title: 'Show whether each linked issue is still open', url: 'https://github.com/gaurav/prcoder/issues/66', updatedAt: '2026-10-09T00:00:00Z',
      body: 'State is the one that changes how a row is read.', milestone: 2, labels: [] },
    { number: 90, title: 'Something for later', url: 'https://github.com/gaurav/prcoder/issues/90', updatedAt: '2026-10-08T00:00:00Z',
      body: '', milestone: 3, labels: ['bug', 'help wanted'] },
    { number: 149, title: 'Add a PRs pane', url: 'https://github.com/gaurav/prcoder/issues/149', updatedAt: '2026-10-07T00:00:00Z',
      body: '', milestone: null, labels: [] },
  ],
  total: 4, listed: 4, repo: 'gaurav/prcoder', mentions: [],
};
const groupsOf = (p) => p.$$eval('#queue-body .fold.milestone', (gs) => gs.map((g) =>
  `${g.dataset.group}|${g.querySelector('h3').textContent.replace(/\s+/g, ' ').trim()}|${g.open ? 'open' : 'closed'}|${g.querySelectorAll('.item').length}`));

// The fixture pull request mentions #7 without closing it, so every page has
// a Mentioned group ahead of the milestones; `prIssues` replaces that list.
async function issuesPage(listing = ISSUES, prIssues = null, nameWithOwner = 'gaurav/prcoder') {
  const { fresh, typed, rows } = await refPage(() => ({ json: { ref: null } }));
  if (prIssues) {
    await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, nameWithOwner, pr: { ...pr, issues: prIssues } } }));
    const polled = fresh.waitForResponse('**/api/status');
    await fresh.click('#pr-refresh');
    await polled;
  }
  await fresh.route('**/api/issues', (r) => r.fulfill({ json: listing }));
  const landed = fresh.waitForResponse('**/api/issues');
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  await landed;
  await fresh.waitForSelector('#queue-body .fold.milestone');
  return { fresh, typed, rows };
}

test('the Issues tab groups the repository\'s open issues by milestone in rank order, the first with issues open', { skip }, async () => {
  const { fresh } = await issuesPage();
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="issues"]').textContent(), 'Issues (4)');
  // Releases soonest first, then the buckets in order, then no milestone;
  // only the first with an issue starts open, and an empty bucket is drawn.
  assert.deepEqual(await groupsOf(fresh), [
    'mentioned|Mentioned by PR #12 1|open|1',
    'm:2|v0.1 2026-10-02 1|open|1', 'm:1|v1.0 2026-10-14 1|closed|1', 'm:4|Needed soon 0|closed|0',
    'm:3|Not urgent 1|closed|1', 'm:none|No milestone 1|closed|1']);
  // The mention is not in the listing's answer, so it says so, dimmed.
  assert.equal(await fresh.locator('[data-group="mentioned"] .item.closed .text').textContent(), 'not found on GitHub');
  assert.equal(await fresh.locator('[data-group="m:4"] .empty').textContent(), 'no open issues');
  assert.equal(await fresh.locator('[data-group="m:3"] summary a').getAttribute('href'), 'https://github.com/gaurav/prcoder/milestone/3');
  assert.equal(await fresh.locator('[data-group="m:3"] summary a').getAttribute('title'), 'Worth doing eventually.');
  // A row: the number as a link, the title, the labels as plain chips.
  const row = fresh.locator('[data-group="m:3"] .item');
  assert.equal(await row.locator('.tag.issue').getAttribute('href'), 'https://github.com/gaurav/prcoder/issues/90');
  assert.equal(await row.locator('.text').textContent(), 'Something for later');
  assert.deepEqual(await row.locator('.tag.label').allTextContents(), ['bug', 'help wanted']);
  // A group closed or opened by hand stays so through a repaint: leaving the
  // tab and coming back rebuilds it from a fresh listing. A milestone that
  // listing has and the first did not (m:10) starts closed with the rest.
  await fresh.locator('[data-group="m:2"] summary .count').click();
  await fresh.locator('[data-group="m:1"] summary .count').click();
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  await fresh.route('**/api/issues', (r) => r.fulfill({ json: { ...ISSUES,
    milestones: [...ISSUES.milestones, { number: 10, title: 'v2.0', dueOn: '2026-12-01T00:00:00Z', description: '' }] } }));
  const again = fresh.waitForResponse('**/api/issues');
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  await again;
  await fresh.waitForSelector('[data-group="m:10"]');
  assert.deepEqual((await groupsOf(fresh)).map((g) => g.split('|').slice(0, 3).join(' ')), [
    'mentioned Mentioned by PR #12 1 open', 'm:2 v0.1 2026-10-02 1 closed', 'm:1 v1.0 2026-10-14 1 open',
    'm:10 v2.0 2026-12-01 0 closed', 'm:4 Needed soon 0 closed', 'm:3 Not urgent 1 closed', 'm:none No milestone 1 closed']);
  await fresh.close();
});

// An open issue on a closed milestone is drawn in that milestone's group,
// which says it is closed: it is counted on the tab, so it has to be somewhere.
test('an open issue on a closed milestone has a group of its own, marked closed', { skip }, async () => {
  const { fresh } = await issuesPage({ ...ISSUES,
    milestones: [...ISSUES.milestones, { number: 9, title: 'v0.0', dueOn: '2026-09-01T00:00:00Z', description: '', closed: true }],
    issues: [...ISSUES.issues, { number: 30, title: 'Left over', url: 'https://github.com/gaurav/prcoder/issues/30', updatedAt: '2026-10-01T00:00:00Z',
      body: '', milestone: 9, labels: [] }],
    total: 5, listed: 5 });
  assert.equal((await groupsOf(fresh))[1], 'm:9|v0.0 2026-09-01 closed 1|open|1');
  assert.equal(await fresh.locator('[data-group="m:9"] .item .text').textContent(), 'Left over');
  await fresh.close();
});

test('searching the issues narrows the rows, opens the groups with a match, and counts them on the tab', { skip }, async () => {
  const { fresh } = await issuesPage();
  const search = fresh.locator('#queue-search');
  await search.fill('row is read');
  // A mention with nothing matching drops out of the tab altogether.
  assert.deepEqual(await groupsOf(fresh), [
    'm:2|v0.1 2026-10-02 1|open|1', 'm:1|v1.0 2026-10-14 0|closed|0', 'm:4|Needed soon 0|closed|0',
    'm:3|Not urgent 0|closed|0', 'm:none|No milestone 0|closed|0']);
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="issues"]').textContent(), 'Issues (1)');
  await search.fill('#149');
  assert.deepEqual((await groupsOf(fresh)).filter((g) => g.endsWith('|1')), ['m:none|No milestone 1|open|1']);
  // A poll that brings news holds off while the search box has focus, so
  // its text and caret survive; the news lands with the next repaint.
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'queue-search');
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, nameWithOwner: 'gaurav/prcoder',
    queue: [{ text: 'news', done: false, issue: null, deleted: false }] } }));
  const polled = fresh.waitForResponse('**/api/status');
  await fresh.evaluate(() => document.getElementById('pr-refresh').click());
  await polled;
  await fresh.waitForTimeout(200);
  assert.equal(await search.inputValue(), '#149');
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'queue-search');
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="local"]').textContent(), 'Local (0)', 'held back');
  // Cleared, the groups go back to what was chosen.
  await search.fill('');
  assert.deepEqual((await groupsOf(fresh)).map((g) => g.split('|')[2]), ['open', 'open', 'closed', 'closed', 'closed', 'closed']);
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="issues"]').textContent(), 'Issues (4)');
  await fresh.close();
});

// The search box is drawn before the listing lands, so a query can be half
// typed when it does; the listing goes into the groups and leaves the box be.
test('the listing landing keeps the search box\'s focus and what is typed in it', { skip }, async () => {
  const { fresh } = await refPage(() => ({ json: { ref: null } }));
  let release;
  const held = new Promise((r) => { release = r; });
  await fresh.route('**/api/issues', async (r) => { await held; return r.fulfill({ json: ISSUES }); });
  const landed = fresh.waitForResponse('**/api/issues');
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  const search = fresh.locator('#queue-search');
  await search.pressSequentially('row');
  release();
  await landed;
  await fresh.waitForSelector('#queue-body .fold.milestone');
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'queue-search');
  await fresh.keyboard.type(' is');
  assert.equal(await search.inputValue(), 'row is');
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="issues"]').textContent(), 'Issues (1)');
  await fresh.close();
});

// What starts open is chosen from every issue, not from what a query typed
// before the listing came lets through: #90 is on Not urgent, but v0.1 is
// still the milestone to focus on once the search is cleared.
test('a query typed before the listing lands does not choose which group starts open', { skip }, async () => {
  const { fresh } = await refPage(() => ({ json: { ref: null } }));
  let release;
  const held = new Promise((r) => { release = r; });
  await fresh.route('**/api/issues', async (r) => { await held; return r.fulfill({ json: ISSUES }); });
  const landed = fresh.waitForResponse('**/api/issues');
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  await fresh.locator('#queue-search').fill('#90');
  release();
  await landed;
  await fresh.waitForSelector('#queue-body .fold.milestone');
  await fresh.locator('#queue-search').fill('');
  assert.deepEqual((await groupsOf(fresh)).map((g) => `${g.split('|')[0]} ${g.split('|')[2]}`), [
    'mentioned open', 'm:2 open', 'm:1 closed', 'm:4 closed', 'm:3 closed', 'm:none closed']);
  await fresh.close();
});

test('an issue row opens to its body through the description renderer, with Open on GitHub under it', { skip }, async () => {
  const { fresh, typed } = await issuesPage();
  await fresh.locator('[data-group="m:1"] summary .count').click();
  const row = fresh.locator('[data-group="m:1"] .item');
  assert.equal(await row.locator('.disclose').getAttribute('aria-expanded'), 'false');
  await row.locator('.disclose').click();
  const body = fresh.locator('[data-group="m:1"] .issue-body');
  assert.equal(await body.locator('p').first().textContent(), 'Focus on an upcoming milestone. See #5 and <img src=x onerror=alert(1)>.');
  assert.equal(await body.locator('strong').textContent(), 'upcoming');
  assert.equal(await body.locator('img').count(), 0, 'markup in an issue is text');
  assert.equal(await body.locator('a', { hasText: '#5' }).getAttribute('href'), 'https://github.com/gaurav/prcoder/issues/5');
  assert.equal(await body.locator('.task input').isDisabled(), true, 'an issue\'s box is GitHub\'s to tick');
  assert.equal(await body.locator('.task').getAttribute('title'), 'tick this on GitHub itself', 'said on the row, where a hover shows it');
  const out = body.locator('.open-issue');
  assert.equal(await out.textContent(), 'Open on GitHub');
  assert.equal(await out.getAttribute('href'), 'https://github.com/gaurav/prcoder/issues/58');
  assert.equal(await out.getAttribute('target'), '_blank');
  assert.equal(await fresh.locator('[data-group="m:1"] .disclose').getAttribute('aria-expanded'), 'true');
  assert.equal(await fresh.locator('[data-group="m:1"] summary .count').textContent(), '1', 'an open row is still one issue');
  // ▶ types the title with its link, unsent, and the queue is untouched.
  await row.locator('button[title^="type into the coding agent"]').click();
  assert.deepEqual(typed, ['Decide what the Issues tab shows (https://github.com/gaurav/prcoder/issues/58)']);
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="local"]').textContent(), 'Local (0)');
  // ↓ copies it into Local, tagged.
  await row.locator('button[title="copy into your queue"]').click();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab[data-tab="local"]')?.textContent === 'Local (1)');
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  assert.equal(await fresh.locator('#queue-body .item .tag.issue').textContent(), '#58');
  // Closed again from the row, the body goes.
  await fresh.locator('#queue-body .tab[data-tab="issues"]').click();
  await fresh.waitForSelector('[data-group="m:1"] .issue-body');
  await fresh.locator('[data-group="m:1"] .disclose').click();
  assert.equal(await fresh.locator('[data-group="m:1"] .issue-body').count(), 0);
  await fresh.close();
});

// The one write the Issues tab makes: a row dragged onto a group, or its
// milestone picked in the opened row, which is the half a test can drive --
// Playwright cannot start a native drag. The route is mocked; the move is the
// POST it gets and the listing being read again after.
test('picking a milestone in an opened row posts the move and reads the listing again', { skip }, async () => {
  const { fresh } = await issuesPage();
  const moves = [];
  await fresh.route('**/api/issue/milestone', (r) => { moves.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
  await fresh.locator('[data-group="m:1"] summary .count').click();
  await fresh.locator('[data-group="m:1"] .item .disclose').click();
  const pick = fresh.locator('[data-group="m:1"] .issue-body select.milestone');
  assert.deepEqual(await pick.locator('option').allTextContents(), ['No milestone', 'v0.1', 'v1.0', 'Needed soon', 'Not urgent']);
  assert.equal(await pick.inputValue(), 'v1.0');
  let again = fresh.waitForResponse('**/api/issues');
  await pick.selectOption('Needed soon');
  await again;
  assert.deepEqual(moves, [{ number: 58, milestone: 'Needed soon' }]);
  // The rows are draggable; the groups' summaries, not the mentions', are where they go.
  assert.equal(await fresh.locator('[data-group="m:1"] .item').getAttribute('draggable'), 'true');
  assert.equal(await fresh.locator('[data-group="mentioned"] .item').getAttribute('draggable'), 'false');
  // The row is still open after the listing came back; off a milestone altogether is null.
  again = fresh.waitForResponse('**/api/issues');
  await fresh.locator('[data-group="m:1"] .issue-body select.milestone').selectOption('');
  await again;
  assert.deepEqual(moves.at(-1), { number: 58, milestone: null });
  // A refusal is a toast, and nothing is read again.
  await fresh.route('**/api/issue/milestone', (r) => r.fulfill({ status: 500, json: { error: '"x" is not an open milestone the Issues tab listed' } }));
  await fresh.locator('[data-group="m:1"] .issue-body select.milestone').selectOption('Not urgent');
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('not an open milestone'));
  await fresh.close();
});

// With a pull request on screen its mentions lead the tab, and one that is an
// open issue here is the listing's own row, body and all.
test('the Issues tab leads with what the PR mentions, and a mention that is listed opens like any row', { skip }, async () => {
  const { fresh } = await issuesPage({ ...ISSUES, mentions: [
    { number: 66, url: 'https://github.com/gaurav/prcoder/issues/66', title: 'Show whether each linked issue is still open', kind: 'issue', state: 'OPEN', updatedAt: '2026-10-09T00:00:00Z' },
    { number: 7, url: `${REPO}/issues/7`, title: 'Per-route locking', kind: 'pull', state: 'MERGED', updatedAt: '2026-09-01T00:00:00Z' },
    { number: 8, url: `${REPO}/pull/8`, title: 'Still in review', kind: 'pull', state: 'OPEN', updatedAt: '2026-08-01T00:00:00Z' }] },
  [{ number: 7, url: `${REPO}/issues/7`, closes: false, title: 'Per-route locking' },
    { number: 8, url: `${REPO}/pull/8`, closes: false, title: 'Still in review' },
    { number: 66, url: 'https://github.com/gaurav/prcoder/issues/66', closes: false, title: 'Show whether each linked issue is still open' }]);
  const [first] = await groupsOf(fresh);
  assert.equal(first, 'mentioned|Mentioned by PR #12 3|open|3');
  const rows = fresh.locator('[data-group="mentioned"] .item');
  // The tag says which is a pull request, so the text needs only its state --
  // and an open one, like an open issue, is not dimmed and needs none.
  assert.deepEqual(await rows.locator('.text').allTextContents(), ['Show whether each linked issue is still open', 'Per-route locking · merged', 'Still in review']);
  assert.deepEqual(await rows.locator('.tag:not(.label)').allTextContents(), ['#66', 'PR #7', 'PR #8']);
  assert.equal(await rows.locator('.tag.pull').count(), 2);
  assert.deepEqual(await rows.evaluateAll((ls) => ls.map((l) => l.classList.contains('closed'))), [false, true, false]);
  assert.equal(await rows.nth(0).locator('button.disclose').count(), 1);
  assert.equal(await rows.nth(1).locator('button.disclose').count(), 0, 'a mention with no body has nothing to open');
  await fresh.close();
});

// A mention is the pull request's repository's, and the listing is the one
// prcoder is in; with the two different, upstream's #66 is not the listing's
// #66 -- including before the page knows its own repository's name.
test('a mention from another repository is not drawn as the listed issue of the same number', { skip }, async () => {
  const url = 'https://github.com/upstream/prcoder/issues/66';
  const { fresh } = await issuesPage({ ...ISSUES, mentions: [
    { number: 66, url, title: 'Upstream\'s sixty-six', kind: 'issue', state: 'OPEN', updatedAt: '2026-10-09T00:00:00Z' }] },
  [{ number: 66, url, closes: false }], null);
  const row = fresh.locator('[data-group="mentioned"] .item');
  assert.equal(await row.locator('.text').textContent(), 'Upstream\'s sixty-six');
  assert.equal(await row.locator('.tag.issue').getAttribute('href'), url);
  assert.equal(await row.locator('button.disclose').count(), 0, 'no body: it is not the listed #66');
  await fresh.close();
});

// The Pull requests tab: the repository's open pull requests, grouped by
// milestone as the issues are, each row carrying what picking the next one
// turns on. The listing is the fixture repository's, with the pull request on
// screen (#12) among them; dates are read against the page's clock, which
// `clock` holds at a fixed day so the ages and `new` are what the test says.
const NOW = Date.parse('2026-10-19T12:00:00Z');
const pullOf = (over) => ({
  isDraft: false, isCrossRepository: false, baseRefName: 'main', author: 'gaurav', labels: [], reviewDecision: null,
  viewed: { p: 0, full: false, label: '0 of 2 files, 0 of 20 changed lines viewed' }, closes: [], lead: '', body: '', ...over,
});
const PULLS = {
  milestones: [
    { number: 1, title: 'v1.0', dueOn: '2026-10-14T00:00:00Z', description: '', closed: false },
    { number: 4, title: 'Needed soon', dueOn: null, description: 'Work that should land soon.', closed: false },
    { number: 3, title: 'Not urgent', dueOn: null, description: '', closed: false },
  ],
  pulls: [
    pullOf({ number: 12, title: pr.title, url: pr.url, headRefName: 'topic', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-18T12:00:00Z',
      additions: 300, deletions: 20, changedFiles: 6, lines: 320, merge: 'ready', milestone: 1, labels: ['enhancement'],
      viewed: { p: 0.5, full: false, label: '3 of 6 files, 160 of 320 changed lines viewed' }, lead: 'The first paragraph of twelve.', body: 'The first paragraph of twelve.\n\n- [ ] a box' }),
    pullOf({ number: 20, title: 'A small fix', url: `${REPO}/pull/20`, headRefName: 'fix', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
      additions: 4, deletions: 1, changedFiles: 1, lines: 5, merge: 'conflicts', reviewDecision: 'APPROVED', milestone: 1, author: 'copilot' }),
    pullOf({ number: 30, title: 'An old draft', url: `${REPO}/pull/30`, headRefName: 'old', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
      additions: 1500, deletions: 10, changedFiles: 40, lines: 1510, merge: 'draft', isDraft: true, milestone: null,
      closes: [{ number: 5, url: `${REPO}/issues/5`, title: 'The old thing', milestone: 'Not urgent' }], lead: 'Still being written.' }),
  ],
  total: 3, listed: 3, read: NOW - 3_600_000,
};
const pullGroupsOf = (p) => p.$$eval('#queue-body .fold.milestone', (gs) => gs.map((g) =>
  `${g.dataset.group}|${g.querySelector('h3').textContent.replace(/\s+/g, ' ').trim()}|${g.open ? 'open' : 'closed'}|${[...g.querySelectorAll('.item')].map((i) => i.dataset.pull).join(',')}`));

/** A page on the Pull requests tab with `listing` answered, counting what the route was asked. */
async function pullsPage(listing = PULLS, { stale = true } = {}) {
  const fresh = await newPage({ clock: true });
  await fresh.clock.setFixedTime(NOW);
  const typed = [];
  await fresh.routeWebSocket('**/pty', (ws) => ws.onMessage((m) => {
    const msg = JSON.parse(m);
    if (msg.type === 'input') typed.push(msg.data);
  }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, nameWithOwner: 'gaurav/prcoder', queue: [] } }));
  let queue = [];
  await fresh.route('**/api/queue', (r) => {
    if (r.request().method() === 'PUT') queue = r.request().postDataJSON().items.map((i) => ({ ...i, issueUrl: i.issue ? `https://github.com/gaurav/prcoder/pull/${i.issue}` : null }));
    return r.fulfill({ json: queue });
  });
  const asked = [];
  await fresh.route('**/api/pulls', (r) => {
    asked.push(r.request().postDataJSON().fresh);
    return r.fulfill({ json: stale ? listing : { ...listing, read: NOW } });
  });
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .tab[data-tab="local"]');
  await fresh.locator('#queue-body .tab[data-tab="pulls"]').click();
  await fresh.waitForSelector('#queue-body .pull-note');
  return { fresh, typed, asked };
}

test('the Pull requests tab groups the open pull requests by milestone, smallest first, with the facts a choice turns on', { skip }, async () => {
  const { fresh, asked } = await pullsPage();
  // The last listing, then a fresh one behind it, since the last was an hour old.
  await fresh.waitForFunction(() => document.querySelector('#queue-body .pull-note')?.textContent === 'Read 1 hour ago');
  assert.deepEqual(asked, [false, true]);
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="pulls"]').textContent(), 'Pull requests (3)');
  // Releases first, then the buckets, then none; only the first with a pull
  // request starts open; smallest first within a group; an empty one is drawn.
  assert.deepEqual(await pullGroupsOf(fresh), [
    'p:1|v1.0 2026-10-14 2|open|20,12', 'p:4|Needed soon 0|closed|', 'p:3|Not urgent 0|closed|', 'p:none|No milestone 1|closed|30']);
  assert.equal(await fresh.locator('[data-group="p:4"] summary a').getAttribute('title'), 'Work that should land soon.');
  // A row: the tinted PR chip, the title, the size as GitHub bands it with
  // the counts on hover, the merge word, the review, the author, labels,
  // the pie, and the two ages; the one on screen is marked and has no Switch.
  const twelve = fresh.locator('.item[data-pull="12"]');
  assert.equal(await twelve.locator('.tag.pull').textContent(), 'PR #12');
  assert.equal(await twelve.locator('.tag.pull').getAttribute('href'), pr.url);
  assert.equal(await twelve.locator('.text').textContent(), pr.title);
  assert.equal(await twelve.locator('.size').textContent(), 'L');
  assert.equal(await twelve.locator('.size').getAttribute('title'), '+300 −20 · 6 files');
  assert.equal(await twelve.locator('.pr-merge').textContent(), 'ready');
  assert.equal(await twelve.locator('.who').textContent(), 'gaurav');
  assert.deepEqual(await twelve.locator('.tag.label').allTextContents(), ['enhancement']);
  assert.equal(await twelve.locator('.mark').getAttribute('aria-label'), '3 of 6 files, 160 of 320 changed lines viewed');
  assert.deepEqual(await twelve.locator('.age').allTextContents(), ['opened 18 days ago', 'updated 1 day ago']);
  assert.equal(await twelve.locator('.pr-lead').textContent(), 'The first paragraph of twelve.');
  assert.equal(await twelve.locator('.tag.here').count(), 1);
  assert.equal(await twelve.locator('.pr-go').count(), 0, 'the one on screen is not offered a Switch');
  assert.equal(await twelve.getAttribute('aria-current'), 'true');
  const twenty = fresh.locator('.item[data-pull="20"]');
  assert.deepEqual(await twenty.locator('.size, .pr-merge, .pr-review, .who, .tag.new').allTextContents(), ['XS', 'conflicts', 'approved', 'copilot', 'new']);
  assert.equal(await twenty.locator('.pr-go').textContent(), 'Switch');
  assert.equal(await twenty.locator('.pr-go').isDisabled(), false);
  // An old draft on no milestone: dimmed, with the milestone of the issue it closes as a hint.
  const thirty = fresh.locator('.item[data-pull="30"]');
  assert.ok(await thirty.evaluate((el) => el.classList.contains('stale')));
  assert.deepEqual(await thirty.locator('.size, .pr-merge').allTextContents(), ['XXL', 'draft']);
  assert.equal(await thirty.locator('.tag.hint').textContent(), 'closes #5 · Not urgent');
  // The order and the grouping are the two selects, remembered across a reload.
  await fresh.locator('#queue-body select.pull-sort').selectOption('largest');
  assert.deepEqual((await pullGroupsOf(fresh))[0], 'p:1|v1.0 2026-10-14 2|open|12,20');
  await fresh.locator('#queue-body select.pull-group').selectOption('none');
  assert.equal(await fresh.locator('#queue-body .fold.milestone').count(), 0);
  assert.deepEqual(await fresh.locator('#queue-body .item.pull').evaluateAll((ls) => ls.map((l) => l.dataset.pull)), ['30', '12', '20']);
  await fresh.reload();
  await fresh.waitForSelector('#queue-body .tab[data-tab="local"]');
  await fresh.locator('#queue-body .tab[data-tab="pulls"]').click();
  await fresh.waitForSelector('#queue-body .item.pull');
  assert.equal(await fresh.locator('#queue-body select.pull-sort').inputValue(), 'largest');
  assert.equal(await fresh.locator('#queue-body select.pull-group').inputValue(), 'none');
  await fresh.close();
});

test('a fresh listing is not read again within a minute, and ⟳ reads one whatever its age', { skip }, async () => {
  const { fresh, asked } = await pullsPage(PULLS, { stale: false });
  await fresh.waitForTimeout(200);
  assert.deepEqual(asked, [false], 'read just now: nothing to ask again');
  assert.equal(await fresh.locator('#queue-body .pull-note').textContent(), 'Read just now');
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  await fresh.locator('#queue-body .tab[data-tab="pulls"]').click();
  await fresh.waitForSelector('#queue-body .pull-note');
  assert.deepEqual(asked, [false], 'and not on a second visit either');
  const again = fresh.waitForResponse('**/api/pulls');
  await fresh.locator('#queue-body .pull-reload').click();
  await again;
  assert.deepEqual(asked, [false, true]);
  await fresh.close();
});

test('searching the pull requests narrows the rows and counts them, and a row opens to its description with Switch and the milestone', { skip }, async () => {
  const { fresh, typed } = await pullsPage();
  const search = fresh.locator('#queue-pull-search');
  await search.fill('copilot');
  assert.deepEqual(await pullGroupsOf(fresh), ['p:1|v1.0 2026-10-14 1|open|20', 'p:4|Needed soon 0|closed|', 'p:3|Not urgent 0|closed|', 'p:none|No milestone 0|closed|']);
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="pulls"]').textContent(), 'Pull requests (1)');
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'queue-pull-search', 'the box keeps its focus');
  await search.fill('');
  assert.equal(await fresh.locator('#queue-body .tab[data-tab="pulls"]').textContent(), 'Pull requests (3)');
  // ▸ opens the description through the description renderer, with the
  // milestone select, Switch and Open on GitHub under it.
  const twelve = fresh.locator('.item[data-pull="12"]');
  await twelve.locator('.disclose').click();
  const body = fresh.locator('[data-group="p:1"] .issue-body');
  assert.equal(await body.locator('p').first().textContent(), 'The first paragraph of twelve.');
  assert.equal(await body.locator('.task input').isDisabled(), true);
  assert.deepEqual(await body.locator('select.milestone option').allTextContents(), ['No milestone', 'v1.0', 'Needed soon', 'Not urgent']);
  assert.equal(await body.locator('select.milestone').inputValue(), 'v1.0');
  assert.equal(await body.locator('.pr-go').count(), 0, 'on screen: no Switch here either');
  assert.equal(await body.locator('.open-issue').getAttribute('href'), pr.url);
  // ▶ types the title with its link, unsent; ↓ copies it into Local as a pull request.
  await twelve.locator('button[title^="type into the coding agent"]').click();
  assert.deepEqual(typed, [`${pr.title} (${pr.url})`]);
  await twelve.locator('button[title="copy into your queue"]').click();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab[data-tab="local"]')?.textContent === 'Local (1)');
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  assert.equal(await fresh.locator('#queue-body .item .tag.issue').textContent(), '#12');
  await fresh.close();
});

test('picking a milestone in an opened pull request row posts the move and reads the listing again; Switch is the PR pane\'s', { skip }, async () => {
  const { fresh, asked } = await pullsPage();
  const moves = [];
  await fresh.route('**/api/pull/milestone', (r) => { moves.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
  await fresh.locator('[data-group="p:none"] summary .count').click();
  await fresh.locator('.item[data-pull="30"] .disclose').click();
  const pick = fresh.locator('[data-group="p:none"] .issue-body select.milestone');
  assert.equal(await pick.inputValue(), '');
  const before = asked.length;
  await pick.selectOption('Needed soon');
  await fresh.waitForFunction((n) => document.querySelectorAll('#queue-body .item.pull').length && n, before);
  await fresh.waitForTimeout(200);
  assert.deepEqual(moves, [{ number: 30, milestone: 'Needed soon' }]);
  assert.deepEqual(asked.slice(before), [true], 'read fresh once GitHub has it');
  assert.equal(await fresh.locator('.item[data-pull="30"]').getAttribute('draggable'), 'true');
  // A refusal is a toast, and nothing is read again.
  await fresh.route('**/api/pull/milestone', (r) => r.fulfill({ status: 500, json: { error: '"x" is not an open milestone the Pull requests tab listed' } }));
  await fresh.locator('[data-group="p:none"] .issue-body select.milestone').selectOption('Not urgent');
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('not an open milestone'));
  assert.equal(asked.length, before + 1);
  // Switch goes through the PR pane's own route, and is disabled on a dirty tree.
  const switched = [];
  await fresh.route('**/api/pr/switch', (r) => { switched.push(r.request().postDataJSON()); return r.fulfill({ json: { ...status, nameWithOwner: 'gaurav/prcoder', queue: [] } }); });
  await fresh.locator('.item[data-pull="30"] .pr-go').click();
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('Switched to'));
  assert.deepEqual(switched, [{ url: `${REPO}/pull/30` }]);
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...status, nameWithOwner: 'gaurav/prcoder', queue: [], dirtyFiles: ['a.js'] } }));
  const polled = fresh.waitForResponse('**/api/status');
  await fresh.evaluate(() => document.getElementById('pr-refresh').click());
  await polled;
  await fresh.locator('#queue-body .tab[data-tab="local"]').click();
  await fresh.locator('#queue-body .tab[data-tab="pulls"]').click();
  await fresh.waitForSelector('.item[data-pull="30"] .pr-go');
  assert.equal(await fresh.locator('.item[data-pull="30"] .pr-go').isDisabled(), true);
  assert.equal(await fresh.locator('.item[data-pull="30"] .pr-go').getAttribute('title'), 'Commit or stash your changes first');
  await fresh.close();
});

// An item's text need not have come through the input: a hand-edited queue
// file can hold anything, and a \r in it would submit the turn unclicked.
test('▶ types an item\'s control characters as spaces', { skip }, async () => {
  const { fresh, typed, rows } = await refPage(() => ({ json: { ref: null } }),
    [{ text: 'do this\rand\u001b[2Jthat', done: false, issue: null, deleted: false }]);
  await fresh.waitForSelector('#queue-body .item');
  await rows().locator('button[title^="type into Claude"]').click();
  await fresh.waitForFunction(() => document.querySelector('#queue-body .tab.on')?.textContent.startsWith('Local (0)'));
  assert.deepEqual(typed, ['do this and [2Jthat']);
  await fresh.close();
});

// Text with nothing that looks like a reference never asks GitHub at all.
test('text with no reference is added without a lookup', { skip }, async () => {
  let asked = 0;
  const { fresh, add, rows } = await refPage(() => { asked++; return { json: { ref: null } }; });
  await add('just a reminder');
  await fresh.waitForSelector('#queue-body .item');
  assert.deepEqual(await rows().locator('.text').allTextContents(), ['just a reminder']);
  assert.equal(await rows().locator('.tag').count(), 0);
  assert.equal(asked, 0);
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

// Until it is dragged, the outline is one width for every file: it used to be
// as wide as its longest label, so the diff beside it changed width from one
// file to the next.
test('the outline opens at the same width whatever its labels', { skip }, async () => {
  const fresh = await newPage();
  const long = 'function aNameLongEnoughToHaveSetTheOutlineWidthOnItsOwn(withSomeArguments, andMore)';
  await fresh.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    const [one, two] = path === 'evil.js' ? ['a', 'b'] : [long, long];
    return r.fulfill({ json: { path, patch: `@@ -1,1 +1,1 @@ ${one}\n-a\n+b\n@@ -9,1 +9,1 @@ ${two}\n-c\n+d` } });
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  const width = async (path, label) => {
    await fresh.locator('.file[data-path="' + path + '"] .path').click();
    await fresh.waitForSelector(`#diff-outline button >> text=${label}`);
    return fresh.evaluate(() => ({
      side: document.getElementById('diff-side').getBoundingClientRect().width,
      main: document.getElementById('diff-main').getBoundingClientRect().width,
      em: parseFloat(getComputedStyle(document.getElementById('diff-side')).fontSize),
    }));
  };
  const short = await width('evil.js', 'a');
  const wide = await width('app.tsx', long.slice(0, 20));
  assert.equal(short.side, wide.side, 'the same width for short labels and long ones');
  // Which side of the min() is in force, first: past it, both files would
  // measure half the pane and pass without the 26.5em in the stylesheet.
  // 26.5 * 14 is a whole pixel, so the comparison after it can be exact.
  assert.ok(26.5 * short.em < 0.5 * short.main, `a pane wide enough for 26.5em: ${short.main}px`);
  assert.equal(short.side, 26.5 * short.em, 'the default in the stylesheet');
  await fresh.close();
});

// In a pane too narrow for it, 26.5em would leave the diff 40% of the pane
// even for one-letter labels, so the outline opens at half the pane instead.
test('the outline opens at half a narrow pane', { skip }, async () => {
  const fresh = await newPage();
  await fresh.setViewportSize({ width: 900, height: 720 });
  await fresh.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    return r.fulfill({ json: { path, patch: '@@ -1,1 +1,1 @@ a\n-a\n+b\n@@ -9,1 +9,1 @@ b\n-c\n+d' } });
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-outline button >> text=a');
  const { side, main, em } = await fresh.evaluate(() => ({
    side: document.getElementById('diff-side').getBoundingClientRect().width,
    main: document.getElementById('diff-main').getBoundingClientRect().width,
    em: parseFloat(getComputedStyle(document.getElementById('diff-side')).fontSize),
  }));
  assert.ok(0.5 * main < 26.5 * em, `a pane too narrow for 26.5em: ${main}px`);
  // Layout rounds widths to a fraction of a pixel, which half of one need not be.
  assert.ok(Math.abs(side - 0.5 * main) < 0.1, `half of ${main}px, not ${side}px`);
  await fresh.close();
});

// The diff header's @ types the open file's mention into the agent's prompt
// and stops there: no Enter, so the sentence about the file goes on around it,
// and the focus is in the terminal to carry on typing it.
test('@ types the open file\'s mention, spaced and unsent, and leaves the focus in the terminal', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  const at = fresh.locator('#diff-mention');
  assert.match(await at.getAttribute('title'), /@evil\.js/);
  await at.click();
  for (let i = 0; !frames.some((f) => f.type === 'input') && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(frames.filter((f) => f.type === 'input'), [{ type: 'input', data: ' @evil.js ' }]);
  assert.equal(await fresh.evaluate(() => document.activeElement.closest('#term-host') != null), true);
  await fresh.close();
});

// Folding the diff is for talking to the agent with the file still named on
// the bar, which is when the @ is wanted: it stays there, keeps its own click
// rather than being part of the bar's toggle, and Alt+M works as well.
test('@ and Alt+M type the mention from a folded diff and leave it folded', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  const typed = () => frames.filter((f) => f.type === 'input');
  const folded = () => fresh.$eval('main', (m) => m.classList.contains('diff-off'));
  await openFile(fresh);
  await fresh.click('#diff > header h1');
  assert.equal(await folded(), true);
  await fresh.locator('#diff-mention').click();
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(typed(), [{ type: 'input', data: ' @evil.js ' }]);
  assert.equal(await folded(), true, 'the @ is not the bar');
  await fresh.locator('#diff-fold').focus();   // out of the terminal the click left it in
  await fresh.keyboard.press('Alt+KeyM');
  for (let i = 0; typed().length < 2 && i < 100; i++) await fresh.waitForTimeout(50);
  assert.equal(typed().length, 2, 'Alt+M typed it again');
  assert.equal(await folded(), true);
  await fresh.close();
});

// What xterm sends for Alt+M depends on the platform it reads: on a Mac it
// leaves the key to the browser, which under Playwright types nothing, so a
// test there could not tell a key the agent got from one it lost. On Linux it
// sends ESC m on the keydown, so the Alt+M tests pretend to be on Linux.
const onLinux = () => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' });

// The keyboard's way to the same button -- and, unlike every other shortcut,
// from inside the terminal too, which is where a request about the file is
// being typed.
test('Alt+M types the mention from the diff and from the terminal', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ init: onLinux, pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  const typed = () => frames.filter((f) => f.type === 'input');
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="app.tsx"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyM');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(typed(), [{ type: 'input', data: ' @app.tsx ' }]);
  // The press above left the focus in the terminal, and this one types it
  // again -- and nothing else: not the µ or ESC m the key would send.
  assert.ok(await fresh.evaluate(() => !!document.activeElement?.closest('#term-host')), 'focus in the terminal');
  await fresh.keyboard.press('Alt+KeyM');
  for (let i = 0; typed().length < 2 && i < 100; i++) await fresh.waitForTimeout(50);
  await fresh.waitForTimeout(200);
  assert.deepEqual(typed(), [{ type: 'input', data: ' @app.tsx ' }, { type: 'input', data: ' @app.tsx ' }]);
  await fresh.close();
});

// Held a moment too long, Alt+M still types the mention once: its repeats
// are dropped, rather than each typing it again or sending ESC m.
test('Alt+M held down in the terminal types the mention once', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ init: onLinux, pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  const typed = () => frames.filter((f) => f.type === 'input');
  await openFile(fresh, 'app.tsx');
  await fresh.locator('#term-host').click();
  await fresh.keyboard.down('Alt');
  for (let i = 0; i < 3; i++) await fresh.keyboard.down('KeyM');   // the second and third are repeats
  await fresh.keyboard.up('KeyM');
  await fresh.keyboard.up('Alt');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  await fresh.waitForTimeout(200);
  assert.deepEqual(typed(), [{ type: 'input', data: ' @app.tsx ' }]);
  await fresh.close();
});

// In the middle of an IME composition the key is xterm's, so the mention does
// not go out ahead of the text still being composed. Playwright has no IME,
// so the keydown is dispatched with isComposing set.
test('Alt+M during a composition in the terminal is left to xterm', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ init: onLinux, pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  const typed = () => frames.filter((f) => f.type === 'input');
  await openFile(fresh, 'app.tsx');
  await fresh.locator('#term-host').click();
  const press = (isComposing) => fresh.evaluate((isComposing) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
    { code: 'KeyM', key: 'm', keyCode: 77, altKey: true, isComposing, bubbles: true, cancelable: true })), isComposing);
  await press(true);
  await fresh.waitForTimeout(300);
  assert.equal(typed().filter((f) => f.data.includes('@')).length, 0, 'no mention mid-composition');
  await press(false);   // the same event out of a composition is the shortcut's, so the one above was a fair test
  for (let i = 0; !typed().some((f) => f.data.includes('@')) && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(typed().filter((f) => f.data.includes('@')), [{ type: 'input', data: ' @app.tsx ' }]);
  await fresh.close();
});

// With no file open there is nothing to name, so the terminal leaves Alt+M
// to the agent, as it did before Alt+M fired there at all.
test('Alt+M in the terminal with no file open goes to the agent', { skip }, async () => {
  const frames = [];
  const fresh = await newPage({ init: onLinux, pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))) });
  const typed = () => frames.filter((f) => f.type === 'input');
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyM');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  await fresh.waitForTimeout(200);
  assert.deepEqual(typed(), [{ type: 'input', data: '\x1bm' }]);
  await fresh.close();
});

// The review loop's keys. Each fires from the terminal while it has something
// to do, and otherwise the agent gets the key; onLinux above says why the
// terminal tests pretend to be on Linux. `typed` is what reached the agent.
const agentPage = async (opts = {}) => {
  const frames = [];
  const fresh = await newPage({ init: onLinux, pty: (ws) => ws.onMessage((m) => frames.push(JSON.parse(m))), ...opts });
  return { fresh, typed: () => frames.filter((f) => f.type === 'input') };
};
const openPath = (p) => p.evaluate(() => document.getElementById('diff-path').textContent);
const filesTab = (p) => p.locator('#pr-head .tab', { hasText: 'Files' }).textContent();
const settle = (p) => p.waitForTimeout(200);

// Alt+R types the pull request's URL, unsent, for a command that wants a
// target, and copies it; from the terminal too. With no pull request the
// agent gets the key and nothing is copied. Both inits run in the page, so
// they go in as one script.
const onLinuxWithClipboard = `(${onLinux})(); (${stubClipboard})();`;
const copiedText = (p) => p.evaluate(() => window.copiedText);
test('Alt+R types and copies the pull request\'s URL, and goes to the agent with none', { skip }, async () => {
  const { fresh, typed } = await agentPage({ init: onLinuxWithClipboard });
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyR');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  await settle(fresh);
  assert.deepEqual(typed(), [{ type: 'input', data: ` ${REPO}/pull/12 ` }], 'typed, unsent, and not ESC r');
  assert.deepEqual(await copiedText(fresh), [`${REPO}/pull/12`]);
  await fresh.close();

  const { fresh: bare, typed: bareTyped } = await agentPage({ init: onLinuxWithClipboard,
    st: { ...status, pr: null }, ready: '#pr-head .pr-branch-name' });
  await bare.locator('#term-host').click();
  await bare.keyboard.press('Alt+KeyR');
  for (let i = 0; !bareTyped().length && i < 100; i++) await bare.waitForTimeout(50);
  await settle(bare);
  assert.deepEqual(bareTyped(), [{ type: 'input', data: '\x1br' }]);
  assert.deepEqual(await copiedText(bare), [], 'and nothing copied');
  await bare.close();
});

// With the agent gone the URL is still copied, and the one toast says so; with
// the clipboard refused as well it says neither happened. One toast each,
// because toast has one slot and a second would hide the first.
test('Alt+R says in one toast which half failed', { skip }, async () => {
  const fresh = await newPage({ init: stubClipboard, pty: (ws) => ws.close() });
  await fresh.waitForFunction(() => document.getElementById('term-host').textContent.includes('coding agent exited'));
  await fresh.keyboard.press('Alt+KeyR');
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('on the clipboard'));
  assert.deepEqual(await copiedText(fresh), [`${REPO}/pull/12`]);
  await fresh.evaluate(() => { window.refuseClipboard = true; });
  await fresh.keyboard.press('Alt+KeyR');
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('neither typed nor copied'));
  await fresh.close();
});

// Alt+V is the diff pane's box pressed, so everything the box moves follows:
// the row, the tab's count, and the box itself -- both ways. From the
// terminal too, where the agent does not get it while a file is open and does
// with none, as the key was before it was bound.
test('Alt+V ticks and unticks the open file, from the page and from the terminal', { skip }, async () => {
  const { fresh, typed } = await agentPage();
  assert.match(await fresh.getAttribute('#diff-viewed', 'title'), /\(Alt\+V\)$/, 'the box says its key');
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyV');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(typed(), [{ type: 'input', data: '\x1bv' }], 'no file open: the agent gets the key');
  await openFile(fresh);
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyV');
  await fresh.waitForFunction(() => document.querySelectorAll('.file.viewed').length === 1);
  assert.equal(await fresh.locator('#diff-viewed').isChecked(), true);
  assert.equal(await filesTab(fresh), 'Files (1/2)');
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyV');
  await fresh.waitForFunction(() => document.querySelectorAll('.file.viewed').length === 0);
  assert.equal(await fresh.locator('#diff-viewed').isChecked(), false, 'and unticks from the terminal');
  await settle(fresh);
  assert.equal(typed().length, 1, 'which the agent did not see');
  // A second press while GitHub has not answered the first: the box is
  // disabled, so it presses nothing -- and the file is still open, so the
  // agent does not get the key either.
  let answer;
  const held = new Promise((res) => { answer = res; });
  await fresh.route('**/api/pr/viewed', async (r) => { await held; await r.fulfill({ json: { ok: true } }); });
  await fresh.keyboard.press('Alt+KeyV');
  await fresh.waitForFunction(() => document.getElementById('diff-viewed').disabled);
  await fresh.keyboard.press('Alt+KeyV');
  await settle(fresh);
  assert.equal(typed().length, 1, 'a press during the tick is not typed into the agent');
  answer();
  await fresh.waitForFunction(() => !document.getElementById('diff-viewed').disabled);
  assert.equal(await fresh.locator('#diff-viewed').isChecked(), true, 'and the first tick stands');
  await fresh.close();
});

// GitHub can count more files than it will list. prFiles reads to the end of
// the list, so that is GitHub's limit, and the tab says so above the groups
// rather than show a count of only what came back. A full list says nothing.
test('a pull request GitHub would not list in full says how many it left out', { skip }, async () => {
  const note = async (st) => {
    const p = await newPage({ st });
    await p.locator('#pr-head .tab', { hasText: 'Files' }).click();
    const notes = await p.locator('#pr-body > .pr-note').evaluateAll((ns) =>
      ns.map((n) => [n.textContent, n.querySelector('a')?.getAttribute('href')]));
    await p.close();
    return notes;
  };
  assert.deepEqual(await note({ ...status, pr: { ...pr, changedFiles: 3412 } }),
    [['GitHub listed 2 of the 3412 changed files. The rest are on GitHub.', `${pr.url}/files`]]);
  assert.deepEqual(await note(status), []);
});

// Alt+J and Alt+K walk the Files tab's order -- Config & docs ahead of Code,
// the biggest change first -- from whichever tab is open and from the
// terminal, stop at the ends, and leave the tab alone: the diff pane's bar
// names the file. Nothing happens from the queue's input, as for every key.
test('Alt+J and Alt+K step through the files in the list\'s order, and stop at its ends', { skip }, async () => {
  const { fresh, typed } = await agentPage({ st: withLong(status) });
  const on = () => fresh.locator('#pr-head .tab.on').textContent();
  assert.match(await on(), /^Detail/);
  // From the page with no file open: forward is the first file.
  await fresh.keyboard.press('Alt+KeyJ');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'long.txt');
  assert.match(await on(), /^Detail/, 'the tab is left where it was');
  // From the terminal, across the group boundary, and off the end.
  await fresh.locator('#term-host').click();
  for (const next of ['evil.js', 'app.tsx', 'app.tsx']) {
    await fresh.keyboard.press('Alt+KeyJ');
    await settle(fresh);
    assert.equal(await openPath(fresh), next);
  }
  await fresh.keyboard.press('Alt+KeyK');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'evil.js');
  assert.equal(typed().length, 0, 'the agent saw none of it');
  // Typing: the queue's input stands in for every text field.
  await fresh.locator('#queue-input').focus();
  await fresh.keyboard.press('Alt+KeyK');
  await settle(fresh);
  assert.equal(await openPath(fresh), 'evil.js', 'not while typing');
  // The Files tab shows the walk: the open row is selected and on screen.
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyK');
  await fresh.waitForFunction(() => document.querySelector('.file.sel')?.dataset.path === 'long.txt');
  assert.equal(await fresh.locator('.file.sel').isVisible(), true);
  await fresh.keyboard.press('Alt+KeyK');
  await settle(fresh);
  assert.equal(await openPath(fresh), 'long.txt', 'nothing before the first');
  await fresh.close();
});

// A tab switch redraws the rows without a poll, and the open file's row has to
// come back marked: opened with a click, then away to Detail and back.
test('the open file\'s row is still selected after a trip to another tab', { skip }, async () => {
  const fresh = await newPage();
  await openFile(fresh, 'app.tsx');
  await fresh.locator('#pr-head .tab', { hasText: 'Detail' }).click();
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  assert.equal(await fresh.evaluate(() => document.querySelector('.file.sel')?.dataset.path), 'app.tsx');
  await fresh.close();
});

// A group closed to get it out of the way still holds files the keys walk
// into, and a selected row inside a closed fold is one nobody can see: the
// key opens the fold. From Detail too, so the Files tab draws it open later.
test('a key that opens a file inside a closed group opens the group', { skip }, async () => {
  const { fresh } = await agentPage({ st: withLong(status) });
  const docs = '.group[data-group="Config & docs"]';
  const isOpen = () => fresh.evaluate((sel) => document.querySelector(sel).open, docs);
  await openFile(fresh, 'evil.js');
  await fresh.locator(`${docs} > summary`).click();
  assert.equal(await isOpen(), false);
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyK');
  await fresh.waitForFunction(() => document.querySelector('.file.sel')?.dataset.path === 'long.txt');
  assert.equal(await isOpen(), true, 'the group opens');
  assert.equal(await fresh.locator('.file.sel').isVisible(), true, 'and the row shows');
  // Closed again, then walked into from Detail, where no rows are drawn.
  await fresh.locator(`${docs} > summary`).click();
  await fresh.locator('#pr-head .tab', { hasText: 'Detail' }).click();
  await fresh.locator('#diff-body').click();
  await fresh.keyboard.press('Alt+KeyJ');
  await fresh.keyboard.press('Alt+KeyK');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'long.txt');
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  assert.equal(await isOpen(), true, 'the Files tab draws it open');
  assert.equal(await fresh.locator('.file.sel').isVisible(), true);
  await fresh.close();
});

// Alt+X is the loop: tick, and on to the next unviewed file, round to the top
// past the end, until none is left -- which it says, staying put. With no
// file open it opens the first unviewed file and ticks nothing.
test('Alt+X ticks the open file and opens the next unviewed, round the top, until none is left', { skip }, async () => {
  const { fresh, typed } = await agentPage({ st: withLong(status) });
  await fresh.keyboard.press('Alt+KeyX');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'long.txt');
  assert.equal(await filesTab(fresh), 'Files (0/3)', 'opening the first ticks nothing');
  await openFile(fresh, 'evil.js');
  await fresh.locator('#term-host').click();
  for (const [next, count] of [['app.tsx', 1], ['long.txt', 2]]) {
    await fresh.keyboard.press('Alt+KeyX');
    await fresh.waitForFunction((next) => document.getElementById('diff-path').textContent === next, next);
    assert.equal(await filesTab(fresh), `Files (${count}/3)`);
  }
  await fresh.keyboard.press('Alt+KeyX');
  await fresh.waitForSelector('#toast:not([hidden])');
  assert.match(await fresh.textContent('#toast'), /Every file is viewed/);
  assert.equal(await filesTab(fresh), 'Files (3/3)');
  assert.equal(await openPath(fresh), 'long.txt', 'and stays on the last one');
  assert.equal(typed().length, 0);
  // A tick GitHub refused: said, and not moved on from.
  await fresh.locator('#diff-viewed').uncheck();
  await fresh.waitForFunction(() => document.querySelectorAll('.file.viewed').length === 2);
  await fresh.route('**/api/pr/viewed', (r) => r.fulfill({ status: 500, json: { error: 'gh: no' } }));
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyX');
  await fresh.waitForFunction(() => /Not marked viewed: gh: no/.test(document.getElementById('toast').textContent));
  assert.equal(await openPath(fresh), 'long.txt');
  assert.equal(await filesTab(fresh), 'Files (2/3)');
  await fresh.close();
});

// A click on the box that GitHub has not answered yet leaves `viewed` as it
// was. Alt+X waits for it: an untick in flight is ticked again once it lands,
// rather than skipped as already viewed, and a tick in flight is not sent a
// second time.
test('Alt+X waits for a tick or untick still in flight on the open file', { skip }, async () => {
  const { fresh } = await agentPage({ st: withLong(status) });
  const puts = [];
  let answer = () => {};
  await fresh.route('**/api/pr/viewed', async (r) => {
    puts.push(r.request().postDataJSON());
    if (puts.length === 2 || puts.length === 4) await new Promise((res) => { answer = res; });
    await r.fulfill({ json: { ok: true } });
  });
  await openFile(fresh, 'long.txt');
  await fresh.locator('#diff-viewed').check();
  await fresh.waitForFunction(() => document.querySelectorAll('.file.viewed').length === 1);
  await fresh.locator('#diff-viewed').uncheck();   // the second PUT: held
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyX');
  await settle(fresh);
  assert.equal(await openPath(fresh), 'long.txt', 'nothing moves while the untick is unanswered');
  answer();
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'evil.js');
  assert.deepEqual(puts.map((p) => p.viewed), [true, false, true], 'the untick lands, then Alt+X ticks again');
  assert.equal(await filesTab(fresh), 'Files (1/3)');
  // And a tick in flight is waited for, not sent again.
  await fresh.locator('#diff-viewed').check();   // the fourth PUT: held
  await fresh.keyboard.press('Alt+KeyX');
  await settle(fresh);
  assert.equal(await openPath(fresh), 'evil.js', 'nothing moves while the tick is unanswered');
  answer();
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'app.tsx');
  assert.deepEqual(puts.map((p) => p.viewed), [true, false, true, true]);
  await fresh.close();
});

// Alt+G is the coding agent pane's ▼: from inside the terminal it folds the
// pane and the focus lands on the ▼, from where the same key unfolds it and
// puts the focus back. The agent never sees it.
test('Alt+G folds the coding agent pane from the terminal and unfolds it from its ▼', { skip }, async () => {
  const { fresh, typed } = await agentPage();
  const focused = () => fresh.evaluate(() => document.activeElement.id);
  assert.equal(await fresh.getAttribute('#term-fold', 'title'), 'collapse the coding agent pane (Alt+G)');
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyG');
  await fresh.waitForFunction(() => document.querySelector('main').classList.contains('term-off'));
  assert.equal(await focused(), 'term-fold');
  assert.equal(await fresh.getAttribute('#term-fold', 'title'), 'expand the coding agent pane (Alt+G)');
  await fresh.keyboard.press('Alt+KeyG');
  await fresh.waitForFunction(() => !document.querySelector('main').classList.contains('term-off'));
  assert.equal(await fresh.evaluate(() => document.getElementById('term-host').contains(document.activeElement)), true);
  await settle(fresh);
  assert.equal(typed().length, 0);
  await fresh.close();
});

// Alt+W from the terminal, by the same rule: Wrap is pressed while there is a
// Wrap to press, and with no file open the agent gets the key.
test('Alt+W presses Wrap from the terminal while a file is open', { skip }, async () => {
  const { fresh, typed } = await agentPage();
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyW');
  for (let i = 0; !typed().length && i < 100; i++) await fresh.waitForTimeout(50);
  assert.deepEqual(typed(), [{ type: 'input', data: '\x1bw' }]);
  await openFile(fresh);
  await fresh.locator('#term-host').click();
  await fresh.keyboard.press('Alt+KeyW');
  await fresh.waitForFunction(() => document.getElementById('diff-wrap').getAttribute('aria-pressed') === 'true');
  await settle(fresh);
  assert.equal(typed().length, 1);
  await fresh.keyboard.press('Alt+KeyW');   // and back, so the stored choice does not leak into later pages
  await fresh.waitForFunction(() => document.getElementById('diff-wrap').getAttribute('aria-pressed') === 'false');
  await fresh.close();
});

// Right after the name, not across the header beside *viewed*: the path is as
// wide as its text, and the auto margin is on what comes after the @. Only
// there -- a second one on Wrap left *viewed* to History mid-header. The copy
// button comes first, against the name it copies, and the @ after it.
test('copy and @ sit against the end of the filename, and the rest stays packed at the right', { skip }, async () => {
  const fresh = await newPage();
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  const gap = (a, b) => fresh.evaluate(([a, b]) => document.querySelector(b).getBoundingClientRect().left
    - document.querySelector(a).getBoundingClientRect().right, [a, b]);
  const copy = await gap('#diff-path bdi', '#diff-copy');
  assert.ok(copy >= 0 && copy < 12, `copy is ${copy}px from the filename`);
  const at = await gap('#diff-copy', '#diff-mention');
  assert.ok(at >= 0 && at < 12, `@ is ${at}px from copy`);
  const before = await fresh.evaluate(() => document.getElementById('diff-wrap').getBoundingClientRect().left
    - document.getElementById('diff-out').getBoundingClientRect().right);
  assert.ok(before < 12, `Wrap is ${before}px after History`);
  await fresh.close();
});

// A deleted file leaves nothing in the working tree for a mention to attach,
// so its @ hides once the patch says so -- and the next file brings it back.
test('a deleted file has no @, and the next file has it back', { skip }, async () => {
  const fresh = await newPage();
  await fresh.route('**/api/diff', (r) => {
    const { path } = r.request().postDataJSON();
    return r.fulfill({ json: { path, patch: path === 'evil.js' ? '@@ -1,1 +0,0 @@\n-gone' : '@@ -0,0 +1,1 @@\n+here' } });
  });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff h1.del');
  assert.equal(await fresh.locator('#diff-mention').isHidden(), true);
  await fresh.locator('.file[data-path="app.tsx"] .path').click();
  await fresh.waitForSelector('#diff h1.add');
  assert.equal(await fresh.locator('#diff-mention').isVisible(), true);
  await fresh.close();
});

// A deleted binary has no patch for the title to read DELETED from, so only
// GitHub's `deleted` says so -- and until /api/diff answers nothing does, so
// the @ waits for it rather than naming a file that may be gone.
test('a deleted file with no patch has no @, nor one while it loads', { skip }, async () => {
  const fresh = await newPage();
  let answer;
  await fresh.route('**/api/diff', (r) => { answer = () => r.fulfill({ json: { path: 'evil.js', patch: null, deleted: true } }); });
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .empty');
  for (let i = 0; !answer && i < 100; i++) await fresh.waitForTimeout(50);
  assert.equal(await fresh.locator('#diff-mention').isHidden(), true);
  answer();
  await fresh.waitForFunction(() => document.querySelector('#diff-body .empty')?.textContent.includes('No diff'));
  assert.equal(await fresh.locator('#diff-mention').isHidden(), true);
  await fresh.close();
});

test('@ with the agent disconnected types nothing and says so', { skip }, async () => {
  const fresh = await newPage({ pty: (ws) => ws.close() });
  await fresh.waitForFunction(() => document.getElementById('term-host').textContent.includes('coding agent exited'));
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="evil.js"] .path').click();
  await fresh.waitForSelector('#diff-body .dl');
  await fresh.locator('#diff-mention').click();
  await fresh.waitForFunction(() => document.getElementById('toast').textContent.includes('not connected'));
  // Not moved to a terminal nothing reads, where Alt+W is off.
  assert.equal(await fresh.evaluate(() => document.activeElement.closest('#term-host') == null), true);
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
// as the tab icon -- so it appears on Enter and goes after 5s of quiet, and the
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
  await fresh.waitForFunction(() => document.getElementById('term-busy').hidden, null, { timeout: 10000 });
  assert.equal(await busy(), false, 'gone when the turn ends');
  await fresh.close();
});

// The busy icon is written out in index.html (`data-busy`) and its red again in
// style.css (`--busy`), for the folded header's octagon. Nothing else would
// notice the attribute going missing -- the icon would turn into a fetch of
// /undefined while #term-busy above stayed right -- or the two reds parting.
test('a turn swaps the tab icon for the busy one, in the folded header\'s red', { skip }, async () => {
  const fresh = await newPage();
  const icon = () => fresh.evaluate(() => {
    const link = document.querySelector('link[rel=icon]');
    return { href: link.getAttribute('href'), busy: link.dataset.busy };
  });
  const idle = await icon();
  assert.match(idle.busy ?? '', /^data:image\/svg\+xml,/, 'data-busy is on the icon link');
  assert.notEqual(idle.href, idle.busy);
  await fresh.click('#term-host');
  await fresh.keyboard.press('Enter');
  assert.equal((await icon()).href, idle.busy, 'busy while the turn runs');
  const logo = () => fresh.getAttribute('#logo', 'src');
  assert.equal(await logo(), idle.busy, 'and so is the tile in the corner');
  const fill = decodeURIComponent(idle.busy).match(/fill='(#\w{6})'/)?.[1];
  const token = await fresh.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--busy').trim());
  assert.equal(fill?.toLowerCase(), token.toLowerCase(), 'data-busy and --busy are one red');
  await fresh.waitForFunction((busy) => document.querySelector('link[rel=icon]').getAttribute('href') !== busy,
    idle.busy, { timeout: 10000 });
  assert.equal((await icon()).href, idle.href, 'idle again once the turn ends');
  assert.equal(await logo(), idle.href, 'the tile too');
  await fresh.close();
});

// A viewed tick changes every place that shows it: the row, its group's pie,
// the Files tab's count, and the diff pane's own box when that file is open --
// not the one box that was clicked, with the rest a poll behind.
test('marking a file viewed moves the tab count and the open diff\'s box with it', { skip }, async () => {
  const fresh = await newPage();
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
test('a poll that moves the head re-opens the open file without an error, and keeps its fold', { skip }, async () => {
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
  // Folded first: the refresh goes through openDiff, not the row click's
  // openFile, so a push from the agent does not undo a fold made to talk to it.
  await fresh.click('#diff > header h1');
  await fresh.click('#pr-refresh');
  await fresh.waitForFunction(() => document.getElementById('diff-path').textContent === 'evil.js');
  await fresh.waitForTimeout(300);
  assert.deepEqual(errors, []);
  assert.equal(diffs, 2, 'the open file was fetched again');
  assert.equal(await fresh.locator('#diff-main').isVisible(), false, 'and the fold held');
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
    switched.push(r.request().postDataJSON().url);
    return r.fulfill({ json: status });
  });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  assert.deepEqual(await fresh.$$eval('#pr-switch option', (os) => os.map((o) => o.textContent.replaceAll('\u00a0', ' '))), [
    'no pull request',
    '#12 A fixture pull request',
    '  └ #13 (draft) Built on the fixture',
    '    └ #14 Built on that',
  ]);

  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  assert.equal(await tab.textContent(), 'Stack (↑2)');
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
  assert.deepEqual(switched, [`${REPO}/pull/14`]);
  await fresh.close();
});

// A branch with a pull request into its fork's main and another into the
// parent: the switcher leads with both in a group of their own, the parent's
// named by its repository, with the stack under the one here; picking one of
// them shows it and checks nothing out, where every other option is still the
// checkout. With one pull request on the branch there is no group.
test('a branch with two pull requests gets an "On this branch" group, and a pick there is a choose', { skip }, async () => {
  const theirs = { number: 12, title: 'Into the parent', url: 'https://github.com/upstream/heal-vlmd-AI-pipeline/pull/12', state: 'OPEN',
    isDraft: true, headRefName: 'topic', baseRefName: 'main', repo: 'upstream/heal-vlmd-AI-pipeline',
    headRepo: 'heal-data-stewards/heal-vlmd-AI-pipeline', headOwner: 'heal-data-stewards', isCrossRepository: true };
  const two = { ...status, repos: [...status.repos, 'upstream/heal-vlmd-AI-pipeline'], branchPrs: [...status.branchPrs, theirs] };
  const fresh = await newPage({ prs: STACK, st: two });
  await fresh.waitForSelector(`#pr-switch optgroup option[value="${theirs.url}"]`, { state: 'attached' });
  assert.deepEqual(await fresh.$$eval('#pr-switch optgroup', (gs) => gs.map((g) => g.label)), ['On this branch']);
  assert.deepEqual(await fresh.$$eval('#pr-switch optgroup option', (os) => os.map((o) => [o.textContent.replaceAll('\u00a0', ' '), !!o.dataset.choose])), [
    ['#12 A fixture pull request', true],
    ['  └ #13 (draft) Built on the fixture', false],
    ['    └ #14 Built on that', false],
    ['upstream/heal-vlmd-AI-pipeline#12 (draft) Into the parent', true],
  ]);
  // The rest of the list, without the ones the group took.
  assert.deepEqual(await fresh.$$eval('#pr-switch > option', (os) => os.map((o) => o.textContent)), ['no pull request']);
  assert.equal(await fresh.inputValue('#pr-switch'), pr.url);

  const chosen = [];
  const switched = [];
  await fresh.route('**/api/pr/switch', (r) => { switched.push(r.request().postDataJSON().url); return r.fulfill({ json: two }); });
  await fresh.route('**/api/pr/choose', (r) => {
    chosen.push(r.request().postDataJSON().url);
    return r.fulfill({ json: { ...two, pr: { ...pr, ...theirs, files: pr.files } } });
  });
  // A file open in the diff pane: the two share a head, not a base, so the
  // pick is a new patch for it even though headRefOid has not moved.
  await fresh.locator('#pr-head .tab', { hasText: 'Files' }).click();
  await fresh.locator('.file[data-path="app.tsx"] .path').click();
  await fresh.waitForSelector('#diff h1');
  const repatched = fresh.waitForRequest('**/api/diff');
  const sent = fresh.waitForResponse('**/api/pr/choose');
  await fresh.selectOption('#pr-switch', theirs.url);
  await sent;
  assert.equal((await repatched).postDataJSON().path, 'app.tsx');
  assert.deepEqual(chosen, [theirs.url]);
  assert.deepEqual(switched, []);
  await fresh.waitForSelector('#toast:not([hidden])');
  assert.match(await fresh.textContent('#toast'), /^Showing upstream\/heal-vlmd-AI-pipeline#12 for topic\./);
  // The pane followed: the parent's pull request, its head labelled as from here.
  assert.equal(await fresh.locator('#pr-head .pr-title').textContent(), 'Into the parent');
  assert.equal(await fresh.locator('#pr-head .pr-state span:not(.badge)').first().textContent(), 'topic → upstream:main');
  // A stacked one is still the checkout.
  const go = fresh.waitForResponse('**/api/pr/switch');
  await fresh.selectOption('#pr-switch', `${REPO}/pull/14`);
  await go;
  assert.deepEqual(switched, [`${REPO}/pull/14`]);
  await fresh.close();

  // One pull request on the branch: the list as it always was.
  const one = await newPage({ prs: STACK });
  await one.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  assert.equal(await one.locator('#pr-switch optgroup').count(), 0);
  // Nothing but options in the select: no group was once a "null" text node.
  assert.deepEqual(await one.$$eval('#pr-switch', ([s]) => [...s.childNodes].filter((n) => n.nodeType !== 1).map((n) => n.textContent)), []);
  await one.close();

  // And none, with more than one repository looked in: the note says where.
  const none = await newPage({ prs: STACK, st: { ...two, pr: null, branchPrs: [] }, ready: '#pr-head .pr-branch-name' });
  assert.equal(await none.locator('#pr-head .pr-note').textContent(),
    'No pull request for topic in heal-data-stewards/heal-vlmd-AI-pipeline or upstream/heal-vlmd-AI-pipeline yet.');
  await none.close();

  // The one picked gone by the time the server looks: no pull request in the
  // answer, which the toast says rather than throwing on.
  const gone = await newPage({ prs: STACK, st: two });
  await gone.waitForSelector(`#pr-switch optgroup option[value="${theirs.url}"]`, { state: 'attached' });
  await gone.route('**/api/pr/choose', (r) => r.fulfill({ json: { ...two, pr: null, branchPrs: [] } }));
  await gone.selectOption('#pr-switch', theirs.url);
  await gone.waitForSelector('#toast:not([hidden])');
  assert.equal(await gone.textContent('#toast'), 'That pull request is gone; topic has none to show.');
  await gone.close();
});

// A pick in the group needs no checkout, so a dirty tree leaves the switcher
// up beside Commit, the group's own enabled and everything else disabled.
// Without a group the Commit button replaces it, as it always did.
test('a dirty tree keeps a switcher that has the group, with only its own picks enabled', { skip }, async () => {
  const theirs = { number: 12, title: 'Into the parent', url: 'https://github.com/upstream/heal-vlmd-AI-pipeline/pull/12', state: 'OPEN',
    isDraft: false, headRefName: 'topic', baseRefName: 'main', repo: 'upstream/heal-vlmd-AI-pipeline',
    headRepo: 'heal-data-stewards/heal-vlmd-AI-pipeline', headOwner: 'heal-data-stewards', isCrossRepository: true };
  const dirty = { ...status, dirtyFiles: ['README.md'], branchPrs: [...status.branchPrs, theirs] };
  const fresh = await newPage({ prs: STACK, st: dirty });
  await fresh.waitForSelector(`#pr-switch optgroup option[value="${theirs.url}"]`, { state: 'attached' });
  assert.equal(await fresh.$eval('#pr-switch', (s) => s.hidden), false);
  assert.equal(await fresh.$eval('#pr-commit', (b) => b.hidden), false);
  assert.deepEqual(await fresh.$$eval('#pr-switch option', (os) => os.map((o) => [o.value.replace(/.*\//, ''), o.disabled])), [
    ['', false], ['12', false], ['13', true], ['14', true], ['12', false],
  ]);
  const chosen = [];
  await fresh.route('**/api/pr/choose', (r) => { chosen.push(r.request().postDataJSON().url); return r.fulfill({ json: dirty }); });
  const sent = fresh.waitForResponse('**/api/pr/choose');
  await fresh.selectOption('#pr-switch', theirs.url);
  await sent;
  assert.deepEqual(chosen, [theirs.url]);
  // Clean again on the next poll: every option back.
  await fresh.route('**/api/status', (r) => r.fulfill({ json: { ...dirty, dirtyFiles: [] } }));
  await fresh.click('#pr-refresh');
  await fresh.waitForFunction(() => document.getElementById('pr-commit').hidden);
  assert.deepEqual(await fresh.$$eval('#pr-switch option', (os) => os.map((o) => o.disabled)), [false, false, false, false, false]);
  await fresh.close();

  const plain = await newPage({ prs: STACK, st: { ...status, dirtyFiles: ['README.md'] } });
  await plain.waitForFunction(() => !document.getElementById('pr-commit').hidden);
  assert.equal(await plain.$eval('#pr-switch', (s) => s.hidden), true);
  await plain.close();
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
  assert.equal(await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).textContent(), 'Stack (↑2)');
  await fresh.close();
});

// The list once #12 has merged: GitHub retargets #13 at main, so it is no
// longer nested under #12 in the switcher.
const MERGED = [{ ...STACK[1], baseRefName: 'main' }, STACK[2]];
const merged = { ...status, pr: { ...pr, state: 'MERGED' } };
const switcherLabels = (p) => p.$$eval('#pr-switch option', (os) => os.map((o) => o.textContent.replaceAll('\u00a0', ' ')));

// A list landing while the switcher's dropdown is open replaced the options
// under it, which closed it or moved the pick. Focus is the page's one sign
// that it may be open, so the options wait for the switcher to lose it.
test('the switcher keeps its options while it has focus, and takes the new list as it loses it', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  const before = await switcherLabels(fresh);
  await fresh.focus('#pr-switch');
  await fresh.route('**/api/prs', (r) => r.fulfill({ json: MERGED }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: merged }));
  // Clicked from script, so focus stays on the switcher.
  const landed = fresh.waitForResponse('**/api/prs');
  await fresh.evaluate(() => document.getElementById('pr-refresh').click());
  await landed;
  await fresh.waitForTimeout(200);
  assert.deepEqual(await switcherLabels(fresh), before, 'held while focused');
  assert.equal(await fresh.inputValue('#pr-switch'), pr.url);
  await fresh.evaluate(() => document.activeElement.blur());
  assert.deepEqual(await switcherLabels(fresh), [
    'no pull request',
    '#12 A fixture pull request',
    '#13 (draft) Built on the fixture',
    '  └ #14 Built on that',
  ]);
  await fresh.close();
});

// Fetched on mousedown, the list landed with the dropdown already open. The
// pointer reaching the switcher is a head start; the click that follows it,
// within ten seconds of a list landing, asks for nothing more.
test('reaching for the switcher fetches the PR list, and a click right after does not', { skip }, async () => {
  const fresh = await newPage({ prs: STACK, clock: true });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  let lists = 0;
  fresh.on('request', (q) => { if (q.url().endsWith('/api/prs')) lists++; });
  await fresh.hover('#pr-switch');
  await fresh.waitForTimeout(200);
  assert.equal(lists, 0, 'the page load\'s list is fresh');
  await fresh.mouse.move(0, 0);
  await fresh.clock.fastForward(11_000);
  const landed = fresh.waitForResponse('**/api/prs');
  await fresh.hover('#pr-switch');
  await landed;
  assert.equal(lists, 1, 'hovering fetched it');
  await fresh.focus('#pr-switch');
  await fresh.waitForTimeout(200);
  assert.equal(lists, 1, 'focusing it just after did not');
  await fresh.close();
});

// A fetch that starts as you reach for the switcher can land after its
// dropdown is open, so the pick after a merge came from the list as it was
// before (#131). The poll
// that sees the PR on screen change fetches it instead -- a merge, a close, or
// another PR in its place -- and one that sees nothing new does not.
const pollCounting = async (p) => {
  let lists = 0;
  p.on('request', (q) => { if (q.url().endsWith('/api/prs')) lists++; });
  const poll = async (st) => {
    if (st) await p.route('**/api/status', (r) => r.fulfill({ json: st }));
    const polled = p.waitForResponse('**/api/status');
    await p.click('#pr-refresh');
    await polled;
    await p.waitForTimeout(300);
    return lists;
  };
  return poll;
};

test('a poll that finds the PR on screen merged fetches the PR list, and no other poll does', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  const poll = await pollCounting(fresh);
  assert.equal(await poll(), 0, 'nothing changed, so no fetch');
  await fresh.route('**/api/prs', (r) => r.fulfill({ json: MERGED }));
  assert.equal(await poll(merged), 1, 'the merge fetched the list');
  // #12 stays, as the PR on screen, but #13 is no longer built on it.
  assert.deepEqual(await switcherLabels(fresh), [
    'no pull request',
    '#12 A fixture pull request',
    '#13 (draft) Built on the fixture',
    '  └ #14 Built on that',
  ]);
  assert.equal(await poll(), 1, 'still merged is not a change');
  await fresh.close();
});

test('a poll that finds the PR on screen closed, or another PR in its place, fetches the PR list', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  const poll = await pollCounting(fresh);
  assert.equal(await poll({ ...status, pr: { ...pr, state: 'CLOSED' } }), 1, 'closed');
  assert.equal(await poll({ ...status, pr: { ...pr, state: 'OPEN' } }), 2, 'reopened');
  // Closed and replaced from the terminal: same branch, a new number.
  assert.equal(await poll({ ...status, pr: { ...pr, number: 15, url: `${REPO}/pull/15` } }), 3, 'a new PR on the branch');
  await fresh.close();

  // A PR opened on a branch that had none.
  const bare = await newPage({ prs: STACK, st: { ...status, pr: null }, ready: '#pr-head .pr-branch-name' });
  const pollBare = await pollCounting(bare);
  assert.equal(await pollBare(), 0, 'still no PR is not a change');
  assert.equal(await pollBare(status), 1, 'a PR opened on the branch');
  await bare.close();
});

// `gh pr list` can take seconds. A fetch from before the merge that lands after
// the one the merge asked for would put the old nesting back, and nothing
// would fetch the list again.
test('a PR list that lands after a later fetch was asked for is dropped', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  let held;
  await fresh.route('**/api/prs', (r) => { held = r; });
  const asked = fresh.waitForRequest('**/api/prs');
  await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).click();
  await asked;
  await fresh.route('**/api/prs', (r) => r.fulfill({ json: MERGED }));
  await fresh.route('**/api/status', (r) => r.fulfill({ json: merged }));
  await fresh.click('#pr-refresh');
  await fresh.waitForFunction((u) => !document.querySelector(`#pr-switch option[value="${u}"]`)?.textContent.includes('└'), `${REPO}/pull/13`);
  const late = fresh.waitForResponse('**/api/prs');
  await held.fulfill({ json: STACK });
  await late;
  await fresh.waitForTimeout(200);
  assert.deepEqual(await switcherLabels(fresh), [
    'no pull request',
    '#12 A fixture pull request',
    '#13 (draft) Built on the fixture',
    '  └ #14 Built on that',
  ]);
  await fresh.close();
});

// Coming back to the tab within ten seconds of a poll skipped the poll, so a
// merge made in another tab in that time waited for the minute's poll. It is
// put off to the ten-second mark instead; later than that, it runs at once.
test('coming back to the tab polls, ten seconds after the last poll at the soonest', { skip }, async () => {
  const fresh = await newPage({ clock: true, init: () => {
    Object.defineProperty(document, 'visibilityState', { get: () => (window.hidden_ ? 'hidden' : 'visible') });
  } });
  let polls = 0;
  fresh.on('request', (q) => { if (q.url().endsWith('/api/status')) polls++; });
  const away = (hidden) => fresh.evaluate((h) => {
    window.hidden_ = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await away(true);
  await away(false);
  await fresh.waitForTimeout(200);
  assert.equal(polls, 0, 'not straight after the page load\'s poll');
  const polled = fresh.waitForResponse('**/api/status');
  await fresh.clock.fastForward(10_000);
  await polled;
  assert.equal(polls, 1, 'but at the ten-second mark');
  await fresh.clock.fastForward(11_000);
  await away(true);
  const again = fresh.waitForResponse('**/api/status');
  await away(false);
  await again;
  assert.equal(polls, 2, 'and at once when the last poll is older than that');
  await fresh.close();
});

// The switcher's console lines are for chasing a failure that leaves nothing
// on screen, and cost a join over every open PR on each fetch, so they are
// written only with the preference on.
test('the console lines are off unless prcoder:debug is on', { skip }, async () => {
  const lines = async (init) => {
    const p = await newPage({ prs: STACK, init });
    const seen = [];
    p.on('console', (m) => { if (m.text().startsWith('[prcoder]')) seen.push(m.text()); });
    await p.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
    const fetched = p.waitForResponse('**/api/prs');
    await p.locator('#pr-head .tab', { hasText: 'Stack' }).click();
    await fetched;
    await p.waitForTimeout(100);
    await p.close();
    return seen;
  };
  assert.deepEqual(await lines(null), []);
  const on = await lines(() => localStorage.setItem('prcoder:debug', 'on'));
  assert.ok(on.includes('[prcoder] PR list landed: 12,13,14 '), on.join('\n'));
});

// A merge seen by a poll and the Stack tab opened a moment later were two whole
// `gh pr list` calls, one behind the other on the server's lock. The tab joins
// the fetch in flight; only a trigger that knows the list changed starts one.
test('opening the Stack tab while a PR list fetch is out joins it', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  let lists = 0;
  fresh.on('request', (q) => { if (q.url().endsWith('/api/prs')) lists++; });
  let held;
  await fresh.route('**/api/prs', (r) => { held = r; });
  await fresh.route('**/api/status', (r) => r.fulfill({ json: merged }));
  const asked = fresh.waitForRequest('**/api/prs');
  await fresh.click('#pr-refresh');
  await asked;
  await fresh.locator('#pr-head .tab', { hasText: 'Stack' }).click();
  await fresh.waitForTimeout(300);
  assert.equal(lists, 1, 'the tab joined the fetch the merge asked for');
  await held.fulfill({ json: MERGED });
  await fresh.waitForFunction((u) => !document.querySelector(`#pr-switch option[value="${u}"]`)?.textContent.includes('└'), `${REPO}/pull/13`);
  assert.deepEqual(await fresh.locator('#pr-body .pr-into .pr-num').allTextContents(), [], 'nothing is built on #12 now');
  await fresh.close();
});

// Opening the tab fetches the list, and gh can fail. The list it had is still
// the best it knows; an empty one in its place said "Nothing is stacked" over
// the rows it had just shown.
test('a failed fetch on opening the Stack tab keeps the rows it had', { skip }, async () => {
  const fresh = await newPage({ prs: STACK });
  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  await fresh.route('**/api/prs', (r) => r.abort());
  const failed = fresh.waitForEvent('requestfailed', (q) => q.url().endsWith('/api/prs'));
  await tab.click();
  await failed;
  await fresh.waitForTimeout(100);
  assert.deepEqual(await fresh.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#13']);
  assert.equal(await tab.textContent(), 'Stack (↑2)');
  assert.equal(await fresh.locator('#pr-switch option').count(), 4, 'the switcher kept its options');
  await fresh.close();
});

// A pull request whose head is in a fork no remote names says so in its state
// row, the way GitHub writes it, and the base stays bare in origin's own
// repository; one from a remote this clone names carries the remote's name.
test('the state row labels a side that is in another repository', { skip }, async () => {
  const forked = { ...status, pr: { ...pr, isCrossRepository: true, headRepo: 'someone/heal-vlmd-AI-pipeline', headOwner: 'someone' } };
  const p = await newPage({ st: forked });
  const arrow = (pg) => pg.locator('#pr-head .pr-state span:not(.badge)').first().textContent();
  assert.equal(await arrow(p), 'someone:topic → main');
  await p.close();
  const named = { ...forked, remotes: { ...status.remotes, 'someone/heal-vlmd-AI-pipeline': 'theirs' } };
  const q = await newPage({ st: named });
  assert.equal(await arrow(q), 'theirs:topic → main');
  await q.close();
  // Within origin's repository, as it always read.
  const r = await newPage();
  assert.equal(await arrow(r), 'topic → main');
  await r.close();
});

// #93: the Stack tab of a pull request that is itself stacked shows what it is
// built on too, with this one marked and nothing to switch to where you are.
test('a stacked PR shows the stack under it in its Stack tab and its head', { skip }, async () => {
  const on13 = { ...status, branch: 'topic-2', pr: { ...pr, number: 13, title: STACK[1].title, headRefName: 'topic-2', baseRefName: 'topic', url: STACK[1].url } };
  const fresh = await newPage({ prs: STACK, st: on13 });
  await fresh.waitForSelector(`#pr-switch option[value="${REPO}/pull/14"]`, { state: 'attached' });
  const tab = fresh.locator('#pr-head .tab', { hasText: 'Stack' });
  assert.equal(await tab.textContent(), 'Stack (↓1 ↑1)');
  assert.equal(await fresh.locator('#pr-head .pr-state a').textContent(), '#12');
  assert.equal(await fresh.locator('#pr-head .pr-state a').getAttribute('href'), pr.url);
  await tab.click();
  assert.equal(await fresh.locator('#pr-body .pr-into-label').textContent(),
    'The stack PR #13 (branch topic-2) is in, from main.');
  assert.deepEqual(await fresh.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#12']);
  assert.deepEqual(await fresh.locator('#pr-body .pr-row.here .pr-num').allTextContents(), ['#13']);
  assert.deepEqual(await fresh.locator('#pr-body li[aria-current="true"] > .pr-row .pr-num').allTextContents(), ['#13']);
  assert.equal(await fresh.locator('#pr-body .pr-row.here .pr-go').count(), 0);
  assert.deepEqual(await fresh.locator('#pr-body .pr-into ul ul ul .pr-num').allTextContents(), ['#14']);
  await fresh.close();
});

// A branch with no PR has no base on GitHub, so the pane asks git -- sending
// the list's head/base pairs, which is how git tells a parent from a child.
test('with no PR, the pane shows what git says the branch is built on, above what is built on it', { skip }, async () => {
  const onMine = [...STACK, { number: 15, title: 'On mine', headRefName: 'on-mine', baseRefName: 'mine', isDraft: false, url: `${REPO}/pull/15` }];
  const st = { ...status, branch: 'mine', pr: null };
  const p = await newPage({ prs: onMine, st, ready: '#pr-body .pr-row.here',
    below: { branch: 'mine', names: ['topic-2'], toDefault: false } });
  assert.equal(await p.locator('#pr-body .pr-into-label').textContent(), 'The stack branch mine is in, from main.');
  assert.deepEqual(await p.locator('#pr-body .pr-into > ul > li > .pr-row .pr-num').allTextContents(), ['#12']);
  assert.equal(await p.locator('#pr-body .pr-row.here code.branch').textContent(), 'mine');
  assert.equal(await p.locator('#pr-body li[aria-current="true"] > .pr-row code.branch').textContent(), 'mine');
  assert.deepEqual(await p.locator('#pr-body .pr-row.here + ul .pr-num').allTextContents(), ['#15']);
  assert.equal(p.belowAsked.branch, 'mine');
  assert.deepEqual(p.belowAsked.prs.at(-1), { headRefName: 'on-mine', baseRefName: 'mine' });
  await p.close();

  // Cut straight from main: no chain, but still what it is built on.
  const onMain = await newPage({ prs: onMine, st, ready: '#pr-body .pr-row.here',
    below: { branch: 'mine', names: [], toDefault: true } });
  assert.equal(await onMain.locator('#pr-body .pr-into-label').textContent(), 'The stack branch mine is in, from main.');
  assert.deepEqual(await onMain.locator('#pr-body .pr-row.here + ul .pr-num').allTextContents(), ['#15']);
  await onMain.close();
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
    switched.push(r.request().postDataJSON().url);
    return r.fulfill({ json: status });
  });
  const sent = clean.waitForResponse('**/api/pr/switch');
  await clean.locator('#pr-body .pr-row', { hasText: '#13' }).locator('.pr-go').click();
  await sent;
  assert.deepEqual(switched, [`${REPO}/pull/13`]);
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
  // Quit is first in the bar and red; Start is the filled one and holds focus,
  // so Enter starts again rather than asking about quitting (2026-10-07).
  assert.equal(await p.getAttribute('#term-quit', 'class'), 'danger');
  assert.equal(await p.getAttribute('#term-start', 'class'), 'primary');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'term-start');
  // Filled with what the command line started it with, not left blank -- by a
  // fetch that can land after the bar shows, so waited on.
  await p.waitForFunction(() => document.querySelector('#term-exit [name=model]').value === 'sonnet');
  assert.equal(await p.inputValue('#term-exit [name=effort]'), 'low');
  await p.fill('#term-exit [name=model]', 'opus');
  await p.selectOption('#term-exit [name=effort]', 'high');
  assert.equal(await p.isChecked('#term-exit [name=continue]'), false, 'continue ticked by default');
  await p.check('#term-exit [name=continue]');
  await p.click('#term-start');
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

// The fill is a fetch, so it can land after you have typed into the bar; it
// must not take that back. And an effort the select has no option for still
// shows, rather than reading "as started".
test('the exit bar\'s late fill keeps what was typed, and shows an effort it has no option for', { skip }, async () => {
  let answer;
  const late = new Promise((resolve) => { answer = resolve; });
  const p = await newPage({
    whoami: async (r) => { await late; return r.fulfill({ json: { started: { model: 'sonnet', effort: 'extreme' } } }); },
    pty: (ws) => ws.close(),
  });
  await p.locator('#term-exit').waitFor({ state: 'visible' });
  await p.fill('#term-exit [name=model]', 'opus');
  answer();
  await p.waitForFunction(() => document.querySelector('#term-exit [name=effort]').value === 'extreme');
  assert.equal(await p.inputValue('#term-exit [name=model]'), 'opus');
  await p.close();
});
