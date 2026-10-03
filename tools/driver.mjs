// What every driver needs before it drives anything: a port nobody else holds,
// a server that dies with the driver, a page that has loaded, and -- for
// Firefox -- somewhere to keep its app data. One copy each, so a fix to any of
// them is made once and a new driver gets it by importing rather than by
// remembering. test/browser/suite.js and tools/firefox-runner/probe.mjs import
// firefoxEnv from here too.

import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Resolves if `port` is free, rejects saying so if not.
 *
 * server.js falls back to a free port when the one it is given is taken, and
 * says so only on a stdout a driver usually ignores -- so a driver whose port
 * is already held would sail past it and drive whatever *is* on that port. That
 * was not hypothetical: a leaked server from an earlier run held one, and the
 * next run screenshotted yesterday's state. Fail here instead, where the
 * message can say which port and why.
 */
export const free = (port) => new Promise((res, rej) => {
  const probe = createServer();
  probe.once('error', () => rej(new Error(`port ${port} is taken -- something else would be driven instead of this run's server. Stop it, or set PRCODER_PORT.`)));
  probe.once('listening', () => probe.close(res));
  probe.listen(port, '127.0.0.1');
});

/**
 * The server's environment for a driver: its port, no browser of its own, and
 * PRCODER_AGENT_BIN stubbed -- every page load opens a websocket and spawns it in a
 * PTY, and unstubbed each run starts a real Claude session and leaves it
 * running. The stub is `tools/claude-stub.mjs` rather than /bin/cat: it echoes
 * as cat does, and it also sends the cursor-position probe a real session sends
 * between turns, which is the half the tab icon's idle check needs (tools/CLAUDE.md).
 */
export const serverEnv = (port, extra = {}) => ({
  ...process.env,
  PRCODER_PORT: String(port),
  PRCODER_NO_OPEN: '1',
  PRCODER_AGENT_BIN: path.join(repo, 'tools', 'claude-stub.mjs'),
  ...extra,
});

/**
 * Kill `child` however the driver ends. Load-bearing twice over: a live child
 * handle keeps the event loop open, so without a kill a driver never exits on
 * its own -- and a kill at the end of the file only runs if the file reaches
 * the end. A throw in between (a missing browser download is the easy one)
 * left the server up polling gh every 60s, and a kill of a run that hung left
 * another; eight accumulated in one afternoon. `exit` covers the throw, and the
 * signals are wired to exit because their default action would skip the
 * handler. Same three as term.js.
 */
export function killOnExit(child) {
  process.on('exit', () => child.kill());
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(130));
}

/**
 * A page at the server's root, retried while the server is still starting.
 * 1440x900 is a common laptop size with room for all three panes.
 *
 * Only a `pageerror` is reported. A Content-Security-Policy that blocks a
 * script, a stylesheet or a font is a console message, not a page exception,
 * so it shows only as whichever later check needed what did not load (#62).
 */
export async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
  for (let i = 0; i < 30; i++) {
    try { await page.goto(`http://localhost:${port}/`); break; } catch { await page.waitForTimeout(500); }
  }
  return page;
}

/**
 * The browser a driver runs in, with its engine logged.
 *
 * Firefox by default, because that is what prcoder is used in and it is where
 * the selection and drag bugs live. Playwright drives its own patched build,
 * never the Firefox in /Applications, so this asks whether
 * `npx playwright install firefox` has been run -- not whether the machine has
 * Firefox. Chromium is the fallback, and PRCODER_PLAYWRIGHT=chromium|firefox is
 * the override; which one ran matters for reading the output, so it is logged.
 *
 * existsSync says the build was downloaded, not that it starts -- which
 * firefoxEnv() is only the latest answer to (#80). So the fallback has to
 * survive a launch that fails as well as one that was never installed, or the
 * default run waits out Playwright's 180s timeout and dies with no browser at
 * all. The wait is 45s here because this is the unattended path and a browser
 * that has not started by then is not starting; a forced engine keeps the full
 * timeout and is left to fail, since falling back is the wrong answer to
 * someone who asked for Firefox by name.
 *
 * Playwright is imported here rather than at the top, because
 * test/browser/suite.js imports this module for firefoxEnv() and has to be able
 * to skip, not crash, where Playwright is not installed.
 */
export async function launchBrowser() {
  const { chromium, firefox } = await import('playwright');
  // This was PRCODER_BROWSER, which is now the browser prcoder opens, so an old
  // `PRCODER_BROWSER=chromium` would quietly drive Firefox; say so instead.
  if (['chromium', 'firefox'].includes(process.env.PRCODER_BROWSER) && !process.env.PRCODER_PLAYWRIGHT) {
    throw new Error(`PRCODER_BROWSER picks prcoder's own browser now; use PRCODER_PLAYWRIGHT=${process.env.PRCODER_BROWSER}`);
  }
  const forced = { chromium, firefox }[process.env.PRCODER_PLAYWRIGHT];
  const engine = forced ?? (existsSync(firefox.executablePath()) ? firefox : chromium);
  console.log('engine: ', engine.name());
  try {
    const env = engine === firefox ? { env: { ...process.env, ...firefoxEnv() } } : {};
    return await engine.launch({ ...env, ...(forced ? {} : { timeout: 45_000 }) });
  } catch (err) {
    if (forced || engine === chromium) throw err;
    console.log(`engine:  ${engine.name()} would not start, falling back to chromium`);
    console.log('        ', String(err).split('\n')[0]);
    return chromium.launch();
  }
}

/**
 * The environment every Firefox launch needs on this machine, directories made.
 *
 * macOS 27 denies a Firefox launched from a terminal its own
 * ~/Library/Application Support/Firefox. Firefox reads that directory even
 * when -profile points elsewhere, so without somewhere else to keep its app
 * data it hangs until the timeout, with nothing in the output to say why
 * (tools/firefox-runner). Harmless elsewhere. Firefox 158 fixes this upstream;
 * #80 is when to take this out, and this is the one place it lives.
 */
export function firefoxEnv() {
  const appData = path.join(repo, 'data', 'firefox-appdata');
  const env = { MOZ_APP_DATA: path.join(appData, 'roaming'), MOZ_LOCAL_APP_DATA: path.join(appData, 'local') };
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
  return env;
}
