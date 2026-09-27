// What every driver needs before it drives anything: a port nobody else holds,
// a server that dies with the driver, a page that has loaded, and -- for
// Firefox -- somewhere to keep its app data. One copy each, so a fix to any of
// them is made once and a new driver gets it by importing rather than by
// remembering. test/browser/suite.js and tools/firefox-runner/probe.mjs import
// firefoxEnv from here too.

import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
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
 * CLAUDE_BIN stubbed -- every page load opens a websocket and spawns it in a
 * PTY, and unstubbed each run starts a real Claude session and leaves it
 * running. The stub is `tools/claude-stub.mjs` rather than /bin/cat: it echoes
 * as cat does, and it also sends the cursor-position probe a real session sends
 * between turns, which is the half the tab icon's idle check needs (tools/CLAUDE.md).
 */
export const serverEnv = (port, extra = {}) => ({
  ...process.env,
  PRCODER_PORT: String(port),
  PRCODER_NO_OPEN: '1',
  CLAUDE_BIN: path.join(repo, 'tools', 'claude-stub.mjs'),
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
