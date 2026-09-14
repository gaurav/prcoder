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

## The pull request description

A description is text someone else may have written — a collaborator on your own PR, or anyone at
all on a PR opened with `prcoder <pr-url>` — and the description pane renders it with `innerHTML`, in
the same page that holds the socket. Script that runs there is a typed turn into Claude.

Two functions in [`public/pr.js`](../public/pr.js) keep it out. `escape()` escapes quotes as well as
angle brackets, because a link's URL is interpolated into `href="..."` and a raw `"` closes the
attribute and opens an event handler, which `innerHTML` does fire. `target()` lets through only
`http(s)` and repository-relative links, so `javascript:` and `data:` hrefs stay as their own source.
`test/pr.test.js` pins both.

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

Everything outside `/api/` and the four `vendor` paths is served from `public/`, and a path that
resolves outside it is a 403 (`server.js`, beside `serveFile`). `new URL` has already collapsed `..`
by then, so the check is a backstop, and nothing tests it.

## Checking new work

- **A new route** goes under `/api/` and through `handleApi`, which is where `sameOrigin` runs. A
  handler registered anywhere else gets no origin check.
- **A new WebSocket path** calls `sameOrigin` before it does anything, the way `/pty` refuses before
  the spawn rather than after.
- **Text from GitHub** — descriptions, titles, issue bodies, file names — is built into the page with
  `h()` and text nodes. `innerHTML` only through `inline()`, and a new kind of link only through
  `target()`.
- **Nothing sends to Claude without a click** on text the user can see.
