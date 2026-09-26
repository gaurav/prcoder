# What prcoder is exposed to

The page prcoder serves holds a live `claude` PTY in your repo, approvals included. So anything that
can reach that PTY's socket, or run script in that page, can type a turn into Claude — and Claude
can edit files, run commands and push. That is the thing being protected. Every section below is a
way in, with the check that closes it and where that check is argued in full.

The server listens on `127.0.0.1` only, so nothing else on the network reaches it directly. What
follows is what still can.

## Other pages in your browser

Listening on loopback is not the boundary it looks like. A page on the web cannot read localhost's
answers, but it can send a request that takes effect on the way out — switching branches, rewriting
the PR description, filing an issue — and WebSockets are not subject to the same-origin policy at
all, so that page could open `/pty`, get a `claude` PTY in this repo, read what it printed and type
at it.

Every route and the socket refuse an `Origin` that is not the server's own. A request that states
none is allowed through: a browser always states one on an upgrade or a `fetch`, so nothing with an
origin to give is being waved past, while `curl`, the drivers and prcoder's own busy-port probe keep
working. That comparison is only worth anything if `Host` is really this machine: DNS rebinding
points an attacker's own name at 127.0.0.1 after its page has loaded, and from then on its `Origin`
and `Host` agree. So a `Host` that is not `localhost`, `127.0.0.1` or `[::1]` is refused first.
`sameOrigin` in [`server.js`](../server.js) carries the rest, including why it compares against
`Host` rather than a computed URL. `test/api.test.js` pins both refusals.

**A frame is not a foreign origin.** A page on the web can load prcoder in an `<iframe>`, and the
framed page's own requests are same-origin, so they pass. The outer page cannot type into the
terminal, but it can lay something over the frame and turn a click on its own content into a click
on ▶, Commit, Create PR or a checkbox — and the origin check never sees that click, because there is
nothing foreign about it. What refuses the frame is `frame-ancestors 'none'`, in the
Content-Security-Policy `serveFile` sends with every static response. `test/api.test.js` pins it.

That header is also the second line of defence for the section below. `script-src 'self'` allows
only prcoder's own files, so script that reaches the page some other way does not run, and
`object-src 'none'` and `base-uri 'none'` close the two ways round it. `style-src` keeps
`'unsafe-inline'` — xterm injects its own `<style>` — and `img-src` is left unset so the `data:`
favicon still loads; both are deliberate, and neither runs script.

## Other programs on this machine

Both checks only mean something against a browser, which cannot lie about `Origin` or `Host`.
Anything else can: `curl` sends whatever headers it likes, and a request with no `Origin` is let
through on purpose. So any program that can connect to the port gets the PTY. Your own programs
could run `claude` themselves anyway; the ones that matter are other accounts, since every user on
a machine shares loopback. On a single-user laptop that is nobody. A per-run token would close it,
at a cost to every client that is not the page — [#59](https://github.com/gaurav/prcoder/issues/59).

## The pull request description

A description is text someone else may have written — a collaborator on your own PR, or anyone at
all on a PR opened with `prcoder <pr-url>` — and the description pane renders it with `innerHTML`, in
the same page that holds the socket. Script that runs there is a typed turn into Claude.

Two functions in [`public/pr.js`](../public/pr.js) keep it out. `escape()` escapes quotes as well as
angle brackets, because a link's URL is interpolated into `href="..."` and a raw `"` closes the
attribute and opens an event handler, which `innerHTML` does fire. `target()` lets through only
`http(s)` and repository-relative links, so `javascript:` and `data:` hrefs stay as their own source.
`test/pr.test.js` pins both, and the CSP stands behind them rather than instead of them: a hole in
either loads no script under `script-src 'self'`, but the two functions are still what keeps the
markup honest in the first place. [#49](https://github.com/gaurav/prcoder/issues/49) holds the rest
of what is open around the renderer.

This is also why the renderer is an allowlist ([Design.md](Design.md) argues the scope side of
that): every construct it learns is new markup built from untrusted text, and has to go through
`inline()` rather than beside it.

## Text that becomes a turn

Some text reaches Claude as a turn without any script involved, because a person clicked. A queue
item's ▶ sends its text verbatim, and an item can arrive from a line added to the description's
prcoder block (`syncFromPrBlock` in [`queue.js`](../queue.js)) — so whoever can edit that
description can write the words. Commit sends a message built from the names of the working tree's uncommitted files.

The guard here is the click, and the text being visible before it. There is no filter on what the
words say, and there should not be one pretending to be a guard. A feature that sends GitHub text
to Claude *without* a click removes the only check there is.

## Static files

Everything outside `/api/` and the `vendor` paths — xterm's four files, Prism's core and one file
per grammar — is served from `public/`, and a path that resolves outside it is a 403 (`server.js`,
beside `serveFile`). `new URL` has already collapsed `..` by then, so the check is a backstop, and
nothing tests it.

## A file the pull request adds

The diff pane highlights a **NEW** file, and the highlighter is a third piece of untrusted text
handled in the page: the whole of a file someone else committed, run through Prism's grammars.
What keeps it in the same shape as the renderer above is in `highlightLines` in
[`public/diff.js`](../public/diff.js). Prism is asked for its *tokens*, never its HTML, and each token
becomes a `<span>` through `h()` with the file's text as a text node — the same rule as every other
string from GitHub, and `test/browser.test.js` opens a file made of `<script>` and `<img onerror>` to
pin that it comes out as characters. The language is chosen from the extension alone: auto-detection
would run every grammar over the file, and `grammars` in `diff.js` — that extension map plus what
those grammars are built on — is the list the vendor map in `server.js` is built from, so the
server serves what the page can ask for and nothing else, and `test/api.test.js` fetches every one
of them. What is left is a grammar's regular expressions
backtracking on a crafted file, which no escaping helps with. It is bounded by GitHub, which sends no
`patch` for a large diff, and by `PATCH_LIMIT` in `git.js` for the patch local git makes when GitHub
sent none -- a path the page sends there is diffed only if the pull request has that file, and as a
literal pathspec. It is the reason the tokenizer runs in the page and not in `/api/diff`:
a stall there freezes one browser tab, a stall in the server freezes the process that owns the PTY.
A modified file's diff is not highlighted at all, and
[#68](https://github.com/gaurav/prcoder/issues/68) has what changes before it can be.

## Checking new work

- **A new route** goes under `/api/` and through `handleApi`, which is where `sameOrigin` runs. A
  handler registered anywhere else gets no origin check.
- **A new WebSocket path** calls `sameOrigin` before it does anything, the way `/pty` refuses before
  the spawn rather than after.
- **Text from GitHub** — descriptions, titles, issue bodies, file names — is built into the page with
  `h()` and text nodes. `innerHTML` only through `inline()`, and a new kind of link only through
  `target()`.
- **Nothing sends to Claude without a click** on text the user can see.
- **A new kind of asset** — a font, an image, a worker, anything loaded rather than inlined — has to
  be allowed by the CSP beside `serveFile`, which is otherwise silent about what it blocks. The
  Prism grammars under `/vendor/prism/` are same-origin script, which `script-src 'self'` already
  allows; a highlighter loaded from a CDN would not be.
