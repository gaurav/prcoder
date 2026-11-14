// What every driver needs before it drives anything: a port nobody else holds,
// a server that dies with the driver, a page that has loaded, and -- for
// Firefox -- somewhere to keep its app data. One copy each, so a fix to any of
// them is made once and a new driver gets it by importing rather than by
// remembering. test/browser/suite.js and tools/firefox-runner/probe.mjs import
// firefoxEnv from here too.

import { createServer } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * The server's environment for a driver: its port, no browser of its own,
 * PRCODER_AGENT_BIN stubbed -- every page load opens a websocket and spawns it in a
 * PTY, and unstubbed each run starts a real Claude session and leaves it
 * running -- and CLAUDE_CONFIG_DIR pointed at a fixture (claudeConfig), so the
 * History tab and the last-prompt notice show made-up prompts rather than the
 * owner's real ones, which they would otherwise read from ~/.claude and put in
 * every screenshot. The stub is `tools/claude-stub.mjs` rather than /bin/cat:
 * it echoes as cat does, and it also sends the cursor-position probe a real
 * session sends between turns, which is the half the tab icon's idle check
 * needs (tools/CLAUDE.md). `cwd` is where the server runs, since the fixture's
 * prompts are filed under it: a run from a worktree (onPullRequest) passes
 * that.
 */
export const serverEnv = (port, extra = {}, cwd = repo) => ({
  ...process.env,
  PRCODER_PORT: String(port),
  PRCODER_NO_OPEN: '1',
  PRCODER_AGENT_BIN: path.join(repo, 'tools', 'claude-stub.mjs'),
  CLAUDE_CONFIG_DIR: claudeConfig(cwd),
  ...extra,
});

// Every server killOnExit has been handed, for onPullRequest's exit handler to
// wait on before it removes the directory they run in.
const killed = new Set();

/**
 * A Claude Code config directory under data/ holding a history of prompts
 * sent from `cwd` (history.js at the root says what the real one holds):
 * three sessions over three days, one titled, one in a worktree, one slash
 * command, one paste placeholder, one line that is not a prompt. Written
 * afresh each call, relative to now, so the days read Today and Yesterday.
 */
export function claudeConfig(cwd) {
  const dir = path.join(repo, 'data', 'claude-config');
  const titled = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
  const untitled = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const earlier = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
  const now = Date.now();
  const hour = 3600_000;
  const day = 24 * hour;
  const line = (display, timestamp, sessionId, project = cwd) =>
    JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });
  const prompts = [
    line('Look at the diff pane\'s wrap button: it folds a long line but the outline stays put', now - 3 * day, earlier),
    line('/simplify', now - 3 * day + hour, earlier),
    line('Add a History tab to the queue, grouped by day and by session, with the time each prompt was sent', now - day - 2 * hour, titled),
    line('Mark a slash command by its word, and give every row a copy button [Pasted text #1 +12 lines]', now - day - hour, titled),
    line('/code-review high', now - 3 * hour, titled),
    line('Fix the two findings, then run the browser suite in both engines.\nThe second finding is the one about the clamp: a click that selected text toggled the row.', now - 2 * hour, titled),
    line('Check that the pull request\'s milestone line says when it is due', now - 50 * 60_000, untitled, path.join(cwd, 'data', 'wt-1')),
    '{"not": "a prompt"}',
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'history.jsonl'), prompts.join('\n') + '\n');
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(path.join(dir, 'projects', slug), { recursive: true });
  writeFileSync(path.join(dir, 'projects', slug, `${titled}.jsonl`),
    JSON.stringify({ type: 'ai-title', aiTitle: 'History tab for the queue pane', sessionId: titled }) + '\n');
  writeFileSync(path.join(dir, 'projects', slug, `${earlier}.jsonl`), JSON.stringify({ type: 'user' }) + '\n');
  return dir;
}

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
  // Ahead of every other exit handler: onPullRequest's removes the worktree
  // the server is running in, and waits for the server to be gone first.
  killed.add(child);
  process.prependListener('exit', () => child.kill());
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
  // `PRCODER_BROWSER=chromium` would quietly drive Firefox; say so. Said, not
  // thrown: `PRCODER_BROWSER=firefox` in a Linux profile is a correct setting
  // for prcoder, and the drivers run it with PRCODER_NO_OPEN, so it is no reason
  // to refuse to run.
  const old = process.env.PRCODER_BROWSER;
  if (['chromium', 'firefox'].includes(old) && !process.env.PRCODER_PLAYWRIGHT) {
    console.log(`engine:  PRCODER_BROWSER=${old} is prcoder's browser, not the driver's; PRCODER_PLAYWRIGHT=${old} picks this one`);
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

/**
 * Where to run the server to drive this repository's pull request `number`:
 * a worktree that already has the pull request's branch checked out -- this
 * tree, or another -- and otherwise a worktree on that branch under data/,
 * removed again on exit with any local branch made for it. Spawn `server.js`
 * from this tree with `cwd` set to the answer, and pass it no pull request.
 *
 * Never `server.js <n>` in this tree: prcoder checks out the pull request it
 * is started on (startOnPr in git.js), and this tree is often the owner's own
 * working copy (tools/CLAUDE.md).
 *
 * A branch checked out in another worktree is driven there, since git will
 * not check it out twice; a server with no pull request named checks nothing
 * out, so that is as safe as driving this tree on its own branch. A local
 * branch that is not checked out anywhere is brought up to origin's (or, for
 * a merged pull request whose branch is gone, to GitHub's refs/pull/<n>/head)
 * when it is behind, so the run drives the pull request as it is, not a
 * commit some earlier run left; one with commits of its own is driven as it
 * is, and said so on stderr, since a reset would lose them.
 */
export function onPullRequest(number) {
  const made = path.join(repo, 'data', `wt-${number}.branch`);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const ok = (...args) => spawnSync('git', args, { cwd: repo }).status === 0;
  const { headRefName: branch, isCrossRepository } = JSON.parse(execFileSync('gh',
    ['pr', 'view', String(number), '--json', 'headRefName,isCrossRepository'], { cwd: repo, encoding: 'utf8' }));
  if (isCrossRepository) throw new Error(`#${number} is from another repository's branch; drive one of this repository's own`);
  if (git('branch', '--show-current') === branch) return repo;
  const dir = path.join(repo, 'data', `wt-${number}`);
  // Before anything is removed: the worktree below may be a live run's.
  const release = holdPullRequest(number);
  // What a killed run left -- its worktree, and the branch it made, named in
  // `made` beside it -- is removed first, so that the branch is made again
  // from origin and nothing is driven on a commit that run had. Used as it
  // was, the worktree was removed this time but the branch never was: only
  // the run that made a branch knew it had, and nothing else deleted it.
  cleanUp(dir, made);
  const there = worktreeOn(branch);
  if (there) {
    process.on('exit', release);
    return there;
  }
  // From origin's branch where it still has one, so the sync light has
  // something to compare against. A merged pull request's branch is usually
  // deleted -- PR #1's, which browser.mjs is written against, is -- and
  // GitHub's refs/pull/<n>/head outlives it.
  const fetched = ok('fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  // Into a ref of its own, not FETCH_HEAD, which every fetch writes -- the
  // owner's prcoder and its agent fetch in this clone too (checkoutGone in
  // git.js says the same). Deleted once read.
  const pull = `refs/prcoder/pull/${number}`;
  if (!fetched) git('fetch', '-q', '--no-write-fetch-head', 'origin', `+refs/pull/${number}/head:${pull}`);
  const tip = git('rev-parse', fetched ? `refs/remotes/origin/${branch}` : pull);
  if (!fetched) git('update-ref', '-d', pull);
  if (!ok('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) {
    // Named before it is made, so a run killed straight after still leaves
    // it named for the next one to delete.
    writeFileSync(made, `${branch}\n`);
    if (fetched) git('branch', '-q', '--track', branch, `origin/${branch}`);
    else git('branch', '-q', branch, tip);
  } else {
    const local = git('rev-parse', `refs/heads/${branch}`);
    // Checked out nowhere (worktreeOn), so moving it moves no one's files;
    // update-ref with the old value, so a branch moved meanwhile is left be.
    if (local !== tip && ok('merge-base', '--is-ancestor', local, tip)) git('update-ref', `refs/heads/${branch}`, tip, local);
    else if (local !== tip && !ok('merge-base', '--is-ancestor', tip, local)) {
      console.error(`driving ${branch} as it is here: it and ${fetched ? `origin/${branch}` : `#${number}'s head`} have each moved on`);
    }
  }
  git('worktree', 'add', '-q', dir, branch);
  process.on('exit', () => {
    // The server runs in `dir`, and its PTY's agent too: killOnExit's handler,
    // which runs first, only signals it, so the removal waits for it to go.
    for (const child of killed) waitGone(child);
    cleanUp(dir, made);
    // Last, so a run that starts now finds nothing of this one left to remove.
    release();
  });
  return dir;
}

/**
 * `data/wt-<n>.pid`, this run's claim on pull request `number`'s worktree,
 * taken before onPullRequest removes anything, and the function that lets
 * it go. Without it, a second driver on the same pull request -- browser.mjs
 * with PRCODER_PR=87 while diff-views.mjs drives #87 -- force-removed the
 * first's worktree and deleted its branch under its live server and agent,
 * and the first failed partway with errors that named neither.
 *
 * `wx`, so one of two at once takes it. A claim whose process has gone (a
 * run killed with SIGKILL, which skips the release) is taken over.
 */
function holdPullRequest(number) {
  const held = path.join(repo, 'data', `wt-${number}.pid`);
  for (let tries = 0; ; tries++) {
    try {
      writeFileSync(held, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || tries > 1) throw e;
    }
    const holder = Number(readFileSync(held, 'utf8').trim());
    if (holder > 0 && holder !== process.pid && running(holder)) {
      throw new Error(`another driver (pid ${holder}) is driving #${number} in data/wt-${number}; wait for it to finish, or kill it`);
    }
    rmSync(held, { force: true });
  }
  return () => {
    try {
      if (Number(readFileSync(held, 'utf8').trim()) === process.pid) rmSync(held, { force: true });
    } catch { /* already gone */ }
  };
}

/** Whether process `pid` is there; EPERM is someone else's, and there. */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * The worktree `branch` is checked out in, this tree's included, or null.
 * From `git worktree list --porcelain`: a `worktree <path>` line, then a
 * `branch refs/heads/<name>` line for one on a branch.
 */
function worktreeOn(branch) {
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  for (const block of list.split('\n\n')) {
    const at = /^worktree (.+)$/m.exec(block)?.[1];
    if (at && block.split('\n').includes(`branch refs/heads/${branch}`)) return at;
  }
  return null;
}

/**
 * Blocks until `child` has exited, SIGKILLing it after a few seconds. For an
 * exit handler, which runs only synchronous code -- so the child is not reaped
 * meanwhile, and `process.kill(pid, 0)` would go on answering for its zombie.
 * `ps` says Z for that, or nothing once it is reaped.
 */
function waitGone(child, ms = 3000) {
  const alive = () => {
    const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' });
    return ps.status === 0 && !ps.stdout.trim().startsWith('Z');
  };
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + ms;
  while (alive()) {
    if (Date.now() > until) {
      child.kill('SIGKILL');
      break;
    }
    Atomics.wait(tick, 0, 0, 50);
  }
}

/**
 * Removes onPullRequest's worktree `dir`, and the branch it made, which `made`
 * names when it made one. Either may be missing: on a first run nothing is
 * there yet.
 */
function cleanUp(dir, made) {
  if (existsSync(dir)) spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo });
  // A worktree whose directory was deleted by hand is still registered, and
  // `git worktree add` refuses its path until it is pruned.
  spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  if (!existsSync(made)) return;
  const branch = readFileSync(made, 'utf8').trim();
  if (branch) spawnSync('git', ['branch', '-q', '-D', branch], { cwd: repo });
  rmSync(made, { force: true });
}
