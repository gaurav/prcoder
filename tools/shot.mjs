// Screenshot the running UI. A client-side change is otherwise verified by
// reading the CSS, which is how three of them shipped unseen.
//
//   node tools/shot.mjs [outdir]        # default: ./shots (gitignored)
//
// Scratch driver, not a test: add clicks and locators for whatever you are
// looking at. Two rules for anything you add.
//
// CLAUDE_BIN is stubbed because every page load opens a websocket and spawns
// it in a PTY -- unstubbed, each run starts a real Claude session and leaves it
// running. And the UI's controls hit the live PR: ticking a description
// checkbox edits the description on GitHub, adding a queue item rewrites
// FUTURE.md. Undo what you write (`git checkout -- FUTURE.md`), or stay
// read-only as this does.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(repo, 'shots'));
const port = Number(process.env.PRCODER_PORT) || 7434;

await fs.mkdir(out, { recursive: true });
const server = spawn('node', ['server.js'], {
  cwd: repo,
  env: { ...process.env, PRCODER_PORT: String(port), PRCODER_NO_OPEN: '1', CLAUDE_BIN: '/bin/cat' },
  stdio: 'ignore',
});

const browser = await chromium.launch();
// 1440 is where the PR pane's 26% and its 375px floor cross, so this is the
// width at which the column is doing what it was sized to do.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

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

console.log('title: ', await page.title());
console.log('panes: ', await page.evaluate(() => getComputedStyle(document.querySelector('main')).gridTemplateColumns));
console.log('shots: ', out);

await browser.close();
server.kill();
