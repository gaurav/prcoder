#!/usr/bin/env node
// The third driver, for the one pane the other two cannot reach: what prcoder
// shows on a branch with *no* pull request.
//
// tools/browser.mjs follows the branch it is run on, that branch has a pull
// request, and PRCODER_PR only pins a different one -- so this state has no way
// of being driven from this working copy at all. A clone does have one. It
// arrives on `main`, where the list of pull requests that merge into the branch
// is the whole point of the pane, and it is also somewhere a row's checkout can
// land without moving the branch under you.
//
// The clone is of the *remote*, but the code under test is this working tree's:
// `server.js` is run from here with the clone as its working directory, which is
// all `repo = process.cwd()` in it means. Nothing is installed in the clone --
// every import resolves from the directory server.js is in.
//
// Chromium, not Firefox: this pane is a sentence, a list of buttons and a link
// row, with none of the draggable text the engine split in browser.mjs is about.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clone = path.join(repo, 'data', 'main-clone');
const shots = path.resolve(process.argv[2] ?? path.join(repo, 'data', 'shots'));
const port = Number(process.env.PRCODER_PORT) || 17491;

// Same reason as the other two: server.js quietly takes a free port when its own
// is held, so a driver that did not check would drive whatever is already there.
const free = (p) => new Promise((res, rej) => {
  const probe = createServer();
  probe.once('error', () => rej(new Error(`port ${p} is taken -- something else would be driven instead of this run's server. Stop it, or set PRCODER_PORT.`)));
  probe.once('listening', () => probe.close(res));
  probe.listen(p, '127.0.0.1');
});
await free(port);
await fs.mkdir(shots, { recursive: true });

const git = (args, cwd = clone) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const url = git(['remote', 'get-url', 'origin'], repo).stdout.trim();
if (!existsSync(clone)) {
  console.log('clone:  ', `${url} -> data/main-clone`);
  const cloned = spawnSync('git', ['clone', '--quiet', url, clone], { encoding: 'utf8' });
  if (cloned.status !== 0) throw new Error(`clone failed: ${cloned.stderr.trim()}`);
} else {
  // A previous run left it on the branch it checked out, which is not the state
  // this drives. Kept rather than re-cloned: it is gitignored, the test glob no
  // longer reaches into data/, and a clone a run is a network round trip.
  git(['checkout', '--quiet', 'main']);
  git(['checkout', '--quiet', '--', '.']);
  git(['fetch', '--quiet', '--prune']);
}
console.log('on:     ', git(['branch', '--show-current']).stdout.trim(), ' (want main)');

const log = await fs.open(path.join(repo, 'data', 'no-pr-server.log'), 'w');
const server = spawn('node', [path.join(repo, 'server.js')], {
  cwd: clone,
  env: { ...process.env,
    PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', PRCODER_VERBOSE: '2',
    CLAUDE_BIN: path.join(repo, 'tools', 'claude-stub.mjs') },
  stdio: ['ignore', log.fd, log.fd],
});
// Load-bearing twice, as in browser.mjs: a live child keeps the event loop open,
// and a throw in between would otherwise leave a server polling gh every minute.
process.on('exit', () => server.kill());
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(130));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
for (let i = 0; i < 30; i++) {
  try { await page.goto(`http://localhost:${port}/`); break; } catch { await page.waitForTimeout(500); }
}
await page.waitForSelector('#pr-body .empty', { timeout: 60_000 });
await page.waitForSelector('#pr-body .pr-into button', { timeout: 60_000 });

const rows = () => page.$$eval('#pr-body .pr-into button', (bs) => bs.map((b) => b.textContent));
console.log('says:   ', await page.$eval('#pr-body .empty', (e) => e.textContent));
console.log('into:   ', (await rows()).join(' | '), ' (want every open PR whose base is main, titled)');
await page.locator('#pr').screenshot({ path: path.join(shots, 'no-pr.png') });

// A dirty tree would fail the checkout the rows perform, so they say so instead
// of failing -- the same rule that hides the switcher in the head. Untracked
// files are not dirt here (userDirt reads --untracked-files=no), so this has to
// be a tracked file to test anything.
await fs.appendFile(path.join(clone, 'README.md'), '\ndriver scratch\n');
await page.reload();
await page.waitForSelector('#pr-body .pr-into button');
console.log('dirty:  ', await page.$eval('#pr-body .pr-into button',
  (b) => `row disabled=${b.disabled} title="${b.title}"`),
'|', await page.$eval('#pr-commit', (b) => `commit hidden=${b.hidden}`),
'|', await page.$eval('#pr-switch', (s) => `switch hidden=${s.hidden}`),
' (want disabled with a reason, commit shown, switcher hidden)');
await page.locator('#pr').screenshot({ path: path.join(shots, 'no-pr-dirty.png') });

git(['checkout', '--quiet', '--', 'README.md']);
await page.reload();
await page.waitForSelector('#pr-body .pr-into button:not([disabled])');
const took = (await rows())[0];
await page.locator('#pr-body .pr-into button').first().click();
await page.waitForSelector('#pr-head .pr-title', { timeout: 120_000 });
console.log('clicked:', JSON.stringify(took?.slice(0, 40)));
console.log('landed: ', git(['branch', '--show-current']).stdout.trim(),
  '|', await page.$eval('#pr-head .meta', (e) => e.textContent.trim()),
  ' (want that PR\'s head branch checked out, and its head shown)');
console.log('toast:  ', await page.$eval('#toast', (e) => e.textContent).catch(() => '(none)'),
  ' (want the sticky notice that Claude has the old branch in mind)');
await page.locator('#pr').screenshot({ path: path.join(shots, 'no-pr-clicked.png') });

await browser.close();
await log.close();
server.kill();
console.log('shots:  ', shots);
console.log('clone:   left on', git(['branch', '--show-current']).stdout.trim(),
  '-- deleting data/main-clone is safe, the next run re-clones');
