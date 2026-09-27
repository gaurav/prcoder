# tools/ -- the drivers

This also applies to a one-off Playwright script under `data/`. Start any new
driver from `driver.mjs`. It has the port check, the stubbed server
environment, kill-on-exit and `firefoxEnv()`, and every one of them fixes a
bug that cost a run. `docs/Verifying.md` covers what each driver reaches.

## Launching Firefox

Every Firefox launch passes `firefoxEnv()`. Without it, macOS 27 stops a
terminal-launched Firefox from starting at all, and the launch hangs until the
timeout with nothing in the output to say why. `existsSync(executablePath())`
is true throughout, so "installed" does not mean "starts". This is a temporary
workaround: #80 says when it comes out, and `firefox-runner/` has the whole
story. `PRCODER_BROWSER=chromium` is the way past it for work that is not about
Firefox.

## Running `browser.mjs`

A run takes minutes and looks like a hung server. `node tools/browser.mjs |
tail` shows nothing until the very end, because `tail` buffers the whole
stream, so redirect the output to a file and watch that instead.

The caret offset it prints is not evidence. The assertion is `caret > 0` and
nothing finer ("What the caret assertion actually proves" in
`docs/Verifying.md`).

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
  `page.routeWebSocket('**/pty', () => {})` as `test/browser/suite.js` does.
- **Install `MutationObserver`s after `goto`, not in `addInitScript`.** At
  init time there is no `document.head` to observe, and the throw takes the
  rest of the init script with it.
