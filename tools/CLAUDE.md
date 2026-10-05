# tools/ -- the drivers

This also applies to a one-off Playwright script under `data/`. Start any new
driver from `driver.mjs`. It has the port check, the stubbed server
environment, kill-on-exit, `firefoxEnv()` and `launchBrowser()`, and every one
of them fixes a bug that cost a run. `docs/Verifying.md` covers what each driver reaches.

## Launching browsers

Launch with `launchBrowser()`, which picks the engine, falls back to Chromium,
and passes `firefoxEnv()` to every Firefox launch. Without that, macOS 27 stops a
terminal-launched Firefox from starting at all, and the launch hangs until the
timeout with nothing in the output to say why. `existsSync(executablePath())`
is true throughout, so "installed" does not mean "starts". This is a temporary
workaround: #80 says when it comes out, and `firefox-runner/` has the whole
story. `PRCODER_PLAYWRIGHT=chromium` is the way past it for work that is not about
Firefox.

Chromium's build is in two halves. Playwright runs a headless launch from
`chromium_headless_shell-<build>` and a headed one from `chromium-<build>`,
which are separate downloads, and a machine can have one without the other.
`Executable doesn't exist at .../chromium-<build>/...` on a headed run looks
like a broken Playwright install, but it is only the missing half:
`npx playwright install chromium` fetches it.

## Running `browser.mjs`

A run takes minutes and looks like a hung server. `node tools/browser.mjs |
tail` shows nothing until the very end, because `tail` buffers the whole
stream, so redirect the output to a file and watch that instead.

The caret check prints `caret: 12 of 34`, an offset into the first Local row's
text and that text's length, and passes only strictly between the two. `0 of n`
is the Firefox drag bug; `n of n` means the click missed the glyphs. The comment
on the check says why it aims at the text node rather than the box.

What the driver waits on and clicks assumes what each pane shows first. It
waited on `.file` to decide the panes had loaded, which held until the pull
request pane gained tabs and opened on the description; after that `.file`
does not exist until something clicks Files. Later it opened "the first file"
expecting a highlighted `.js`, which held until Config & docs became the first
group and the first row was `.gitignore`. Both failed as a 30-second timeout
that looks like a hung server, not a stale selector. So a change to what the
panes show first -- the default tab, the order of the file groups -- needs a
driver run in the same commit, not the next one.

## A stub that only echoes is not a session

A real Claude session asks the terminal for the cursor position every ~200ms,
forever, and xterm answers every time, so the PTY is never quiet. `/bin/cat`
never asks, which let the tab icon's idle check pass for as long as it was
broken. `claude-stub.mjs` echoes *and* probes; its header says why it needs
raw mode and has to swallow the answers. Anything that depends on the PTY's
timing has to be driven against that stub, not cat. cat is fine for
`cli.mjs`, which only needs the terminal half.

## Playwright traps

- **Don't wrap `window.WebSocket` in an init script** unless the wrapper copies
  `CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`. Without them, `send` in
  `public/app.js` silently stops sending (the comment there says how). Three
  driver runs investigating an always-busy tab icon came back green because
  the instrumentation had switched off the traffic causing it. Listen without
  wrapping, or, to keep the page from opening a PTY at all, use
  `page.routeWebSocket(/\/pty(\?|$)/, () => {})` as `test/browser/suite.js` does.
- **Match `/pty` with a regex, not `'**/pty'`.** A glob has to match the whole
  URL, so it misses the exit bar's `/pty?model=...`, which then reaches the
  in-process server and spawns a real `claude --continue` in this repo
  (2026-09-23). `test/browser/suite.js` also sets `PRCODER_AGENT_BIN=/usr/bin/false`
  so a socket that slips past spawns nothing.
- **Tick a box that its own save redraws with `click()`, not `check()` or
  `uncheck()`.** Those two read the box again after clicking, and a detached
  box makes them retry on whatever the locator now finds -- so a refused queue
  tick was ticked twice, and an untick that moves the row off its tab waits
  30s for a box that is gone. It failed only on CI, where the stubbed save
  answers before Playwright's re-read (2026-10-02). This goes for
  `test/browser/suite.js` too.
- **Install `MutationObserver`s after `goto`, not in `addInitScript`.** At
  init time there is no `document.head` to observe, and the throw takes the
  rest of the init script with it.
