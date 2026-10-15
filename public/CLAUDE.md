# public/ -- the page

## Three files here are the server's as well

`cli.js` imports `syncPhrase` from `pr.js` for the status block, and
`server.js` imports `grammars` from `diff.js` to build the Prism half of the
vendor map, so the list of grammars is written once, in the page that loads
them. `tasks.js` is
the description's grammar -- what a description shows (`withoutHtml`), its
checklist lines, its `#N` mentions, the URL helpers, `toggleTask`, which
flips one box in a body, and `blocks` and `sectionize`, which cut one into
the paragraphs, lists, tasks and sections the PR pane draws and the queue's
PR tab counts. `server.js`, `github.js`, `git.js` and `files.js` at
the root all import it, so the server and the pane read a description by the
same rules and cannot drift apart.

All three therefore have to load in Node, and so does everything they import
-- `ui.js` among them -- so none of them may touch the DOM at module scope. A `document.querySelector` beside the imports is ordinary in a
browser file, but here it stops the *server* from starting, with a stack trace
naming a file under `public/` and nothing about why the server was reading it.
Put DOM work inside a function, the way `el()` in `diff.js` does. A syntax
error in any of them breaks the server the same way; `node --check public/*.js`
catches it, and `test/api.test.js` imports all three by importing the server.

## The building blocks are in `ui.js`

`h`, `btn`, `ext`, `api`, `toast`, `debug`, `pref`, the mark and the fold:
every pane builds from these, so they live in `ui.js` and a pane imports them
from there. `pr.js` used to hold them, and the other panes imported the PR
pane to get a button.

## Keyboard shortcuts go through `keys.js`

`bindKeys` in `app.js` is the one table of shortcuts, and `keys.js` holds the
rules every binding gets for free: nothing fires while a key is being typed
into the queue's input or an editable item, a binding names a physical key
(`Alt+KeyW`), not the character it produces, a held key fires once, and
nothing fires behind a modal dialog such as the shortcut sheet. The
terminal is typing too, except that a binding's `terminal()` says when the
key would do something there -- a file open, files to step through -- and
then it fires from the terminal and the agent does not get the key; when it
says no, the agent does. Every binding in the table has one, and a new one
should: the loop the keys serve ends in the terminal. A keydown listener
beside the thing it drives would have to repeat all of this. Each binding
carries a `label`, which is its row on the shortcut sheet (Alt+/): the sheet
is built from the table, so a key is never listed that the page lacks, and
the browser suite reads the table in `docs/Panes.md` and fails unless the
sheet lists the same keys in the same order. Add a row there with the
binding, and argue the letter in the comment above the table (what each one steers round: browser tab switching, Firefox's menu
letters, a Mac's dead keys, Claude Code's own Alt bindings).

## The Claude pane is not prcoder's to draw on

`term.write()` in `app.js` puts bytes into xterm's buffer without them ever
reaching the PTY, which makes it look like the way to tell the user something
in the middle pane. It isn't, for two reasons.

Claude never sees it. The only path into the session is `{type:'input'}` ->
`pty.write` (`server.js`), which is what `sendToClaude` uses. So a notice
written this way and *addressed* to Claude ("re-read any open files" was one,
until 2026-09-05) is read by nobody. prcoder has no way to put anything into
Claude's context except a typed user turn; issue #21 lists the options.

And Claude Code owns that viewport. With `"tui": "fullscreen"` it is on the
alternate screen, repainting frames over whatever is there, so anything prcoder
writes survives only until the next frame. The exception is `ws.onclose`, which
writes `[coding agent exited]` because the PTY is dead and nothing will repaint.

Notices for the human go to `toast()`, which sits over the panes and has
nothing to do with the terminal. Pass `sticky` for a notice that stays true
until someone acts on it, rather than one reporting something already done:
a sticky toast waits for a click instead of timing out.

## The UI says "coding agent", not Claude

prcoder already runs agents other than Claude Code -- `PRCODER_AGENT_BIN` picks
the executable, and the drivers run a stub -- so any new text in the UI that
refers to the agent (page copy, toasts, tooltips, lines written to the terminal)
says "coding agent", or names the running agent once the page knows it. The docs
can keep saying Claude Code until a second agent is fully supported, and code
names like `sendToClaude` wait for that too (#30). The owner asked for this on
2026-09-23; the UI strings that still say Claude are listed in #76.

## Check a UI change in Firefox, not only Chromium

prcoder is used in Firefox, and one Firefox-only bug survived every Chromium
screenshot: a mousedown inside a `draggable` element goes to the drag
machinery, so clicking into a `contentEditable` child puts the caret at offset
0 instead of where you clicked. The comment above the `pointerdown` handler in
`queue.js` has the fix -- the grip -- and the fixes that do not work, so don't
retry those. The bug was still live on 2026-09-17;
`tools/firefox-runner/caret-repro.html` is the re-check.

`tools/browser.mjs` defaults to Firefox for this reason, and `test/browser/`
runs its suite in both engines: a header-height test written against Chromium
failed in Firefox (2026-09-26).

## Console lines go through `debug()`

`debug()` in `ui.js` is the page's one way to write to the browser console,
for a path that fails with nothing on screen. It writes only when the
`prcoder:debug` preference is `on` -- `localStorage['prcoder:debug'] = 'on'`
in the console, then reload -- so a line can be as chatty as it needs to be
without costing anything when it is off. An argument that takes work to build,
like a list of every open PR's number, goes in as a function; it is called only
when the line is written.
