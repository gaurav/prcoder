// Ask this machine whether anything can drive Firefox, in about two minutes.
//
//   node tools/firefox-runner/probe.mjs
//
// README.md next to this file is the whole story: what fails, why, and what
// would have to change for a line below to say OK. Read that before adding a
// case here, so a hypothesis already eliminated does not come back as a new
// launch.
//
// Every launch runs twice, with and without MOZ_APP_DATA. The lines *with* it
// say whether the workaround tools/browser.mjs uses still works; the lines
// *without* it say whether the upstream fix has reached us, and are #80's check
// for when the workaround can go.
//
// The bare-binary lines are the ones that say whose bug a failure is. Playwright
// launching a browser is three moving parts; `firefox -screenshot` is one, so
// a failure there is Firefox's alone -- which is how the ad-hoc signature on
// Playwright's build was ruled out, the signed browser in /Applications
// failing identically.

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { firefox } from 'playwright';
import { firefoxEnv } from '../driver.mjs';

const run = promisify(execFile);
const stock = '/Applications/Firefox.app/Contents/MacOS/firefox';
const shot = new URL('../../data/firefox-probe.png', import.meta.url).pathname;
// The drivers' own, so the two cannot disagree.
const appEnv = firefoxEnv();
const envs = [['', process.env], [', MOZ_APP_DATA', { ...process.env, ...appEnv }]];

// Headed is worth the window it opens: the two engines fail differently, and a
// headless-only probe would have missed that the stock browser gets further.
const launches = [
  ["playwright's own build, headless", {}],
  ["playwright's own build, headed", { headless: false }],
  ['/Applications Firefox over BiDi, headless', { channel: 'moz-firefox' }],
  ['/Applications Firefox over BiDi, headed', { channel: 'moz-firefox', headless: false }],
];

const ok = { bare: false, env: false };

for (const [label, env] of envs) {
  for (const [what, opts] of launches) {
    const started = Date.now();
    try {
      const browser = await firefox.launch({ timeout: 45_000, env, ...opts });
      const page = await browser.newPage();
      await page.goto('https://example.com');
      const title = await page.title();
      await browser.close();
      ok[label ? 'env' : 'bare'] = true;
      console.log(`OK   ${what}${label} -- ${title}, ${browser.version()}, ${Date.now() - started}ms`);
    } catch (err) {
      console.log(`FAIL ${what}${label} -- ${why(err)} (${Date.now() - started}ms)`);
    }
  }

  // No Playwright in this one. A failure here is Firefox's own.
  if (!existsSync(stock)) {
    console.log(`SKIP ${stock} is not installed, so the bare-binary check proves nothing`);
    continue;
  }
  const started = Date.now();
  rmSync(shot, { force: true });
  try {
    // It hangs rather than exiting when it fails, so the timeout is the result.
    const { stderr } = await run(stock, ['-headless', '-screenshot', shot, 'https://example.com'], { timeout: 45_000, env });
    const shotOk = existsSync(shot);
    if (shotOk) ok[label ? 'env' : 'bare'] = true;
    console.log(`${shotOk ? 'OK  ' : 'FAIL'} bare ${stock}${label} -- ${shotOk ? shot : firstLine(stderr)} (${Date.now() - started}ms)`);
  } catch (err) {
    // execFile hands stderr to the callback rather than the error; see run() in github.js.
    console.log(`FAIL bare ${stock}${label} -- ${firstLine(err.stderr) || why(err)} (${Date.now() - started}ms)`);
  }
}

console.log(ok.bare
  ? '\nSomething starts without MOZ_APP_DATA. If it is Playwright\'s own build, the workaround is dead code: #80.'
  : ok.env
    ? '\nOnly MOZ_APP_DATA works: the workaround is still load-bearing, and the upstream fix has not reached us (#80).'
    : '\nNothing works, even with MOZ_APP_DATA. That is new: the README\'s account is out of date.');

// Playwright puts the browser's own complaint in the log rather than the message,
// and it is the only part that says anything about why.
function why(err) {
  const plain = String(err).replace(/\x1b?\[\d+m/g, '');
  const first = plain.split('\n')[0];
  const browser = plain.match(/\[err\] (.*)/)?.[1];
  return `${first}${browser ? ` :: ${browser}` : ''}`.slice(0, 220);
}

function firstLine(text) {
  return String(text ?? '').split('\n').filter(Boolean).at(-1)?.slice(0, 160) ?? '';
}
