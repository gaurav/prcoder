# What prcoder is exposed to

The page prcoder serves holds a live `claude` PTY in your repo, approvals included. So anything that
can reach that PTY's socket, or run script in that page, can type a turn into Claude — and Claude
can edit files, run commands and push. That is the thing being protected. Every section below is a
way in, with the check that closes it and where that check is argued in full.

The server listens on `127.0.0.1` only, so nothing else on the network reaches it directly. What
follows is what still can.

## Other pages in your browser

Listening on loopback is not the boundary it looks like. A page on the web cannot read localhost's
answers, but it can send a request that takes effect on the way out — switching branches, ticking
a box in the PR description, filing an issue — and WebSockets are not subject to the same-origin policy at
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
A bare `#N` takes its URL and title from GitHub's answer about that number, which is no safer than
the description, so `mentionLink()` sends the URL through `target()` and both through `escape()`.
And `inline()` builds a link out of finished HTML: it holds code spans, markdown links, bare URLs and
mentions aside as `\u0000N\u0000` and `\u0001N\u0001` placeholders while the later rules run, emphasis
and strikethrough among them, and puts them back after, so no rule can write into an href another
has built. A placeholder that ends up inside
an attribute brings the held link's quotes with it, so the bare-URL rule may not run across one, and
a description's own placeholder characters are dropped before anything else.
A check's link is held to the same rule by `rollup()` in [`github.js`](../github.js): a status
context's `targetUrl` is whatever its poster said, so anything not `http(s)` is dropped and the
check's name stays plain text. `test/pr.test.js` pins both functions, `test/github.test.js` the
check links, and the CSP stands behind them rather than instead of them: a hole in
either loads no script under `script-src 'self'`, but the two functions are still what keeps the
markup honest in the first place. [#49](https://github.com/gaurav/prcoder/issues/49) holds the rest
of what is open around the renderer.

This is also why the renderer is an allowlist ([Design.md](Design.md) argues the scope side of
that): every construct it learns is new markup built from untrusted text, and has to go through
`inline()` rather than beside it.

## Text that becomes a turn

Some text reaches Claude as a turn without any script involved, because a person clicked. A queue
item's ▶ sends its text verbatim, and an item can arrive by ↓ from the PR #N tab, which copies a
checklist line of the description, or from the Issues tab, which copies an issue's title (`pull` in
[`public/queue.js`](../public/queue.js)); the Issues tab's own ▶ types an issue's title and link
straight in, unsent, and the PR #N tab's ▶ a checklist line — so whoever can edit that
description or that issue can write the words. The History tab's ▶ types a prompt back in, unsent, and its ↓ copies one into
Local: text the user already sent once, read from Claude Code's own record (below). Commit sends a
message built from the names of the working tree's uncommitted files.

The Issues tab also draws an issue's body, which is anyone's text, into the page with `innerHTML`,
and the PRs tab the first paragraph of a pull request's under its row:
through `blockNode` and `inline()` in [`public/pr.js`](../public/pr.js), the description's own
renderer, with the repository as what a relative link is written against — the same allowlist,
and no second path.

The guard here is the click, and the text being visible before it. There is no filter on what the
words say, and there should not be one pretending to be a guard. A feature that sends GitHub text
to Claude *without* a click removes the only check there is.

## The terminal prcoder runs in

The log and the status block print text prcoder did not write: queue items, which any tab can add
and anyone can edit into `queue.json`, PR titles, branch names, git's stderr. An ESC in any of them
is a sequence the terminal would run -- a colour that never resets, a cursor move that throws off
the block's erase, a window title set. `visible()` in [`term.js`](../term.js) shows every control
character as its Unicode picture instead (ESC as `␛`), and the C1 range as `�`. The one exception
is a log line's newline and tab, which `log()` keeps so a multi-line item still reads as lines; a
status row and the quit question keep neither, so a new caller that needs one row gets it from
`status()` or `confirm()`, not from `log()`. It runs inside
`log()`, `status()`, `confirm()` and `title()`, which are the only ways out: `init()` routes `console` through
`log()`. The two sequences prcoder does write on purpose -- a style on a segment of a status
row, and the window's title -- are applied after the text has been pictured, so neither can be
made from text. `test/term.test.js` pins it.

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
string from GitHub, and `test/browser/suite.js` opens a file made of `<script>` and `<img onerror>` to
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

## What prcoder reads outside the repository

One file, and one line of some others: Claude Code's `history.jsonl` in its config directory
(`~/.claude`, or `$CLAUDE_CONFIG_DIR`, the same variable the `claude` child honours, so the file
read is the file written), which records every prompt typed into any Claude Code session on the
machine, with its project directory; and, for a session's title, the `ai-title` line of its
transcript under `projects/`. That is every repository's prompts, so the reader keeps only the
ones whose project is this working copy, or a worktree under its `data/`, and drops the rest before
anything leaves the server (`whereIn` in [`history.js`](../history.js), `test/history.test.js`).
A prompt's pasted text is in the same file, under `pastedContents`; it is never read, since a paste
is where a secret lands, and the `[Pasted text #1 +N lines]` placeholder in the prompt is all the tab
shows. The session id names the transcript to open, so only a UUID is taken as one. Both files are
read and never written -- when the page opens, after each prompt sent from it, and on the tab's
⟳ -- and nothing read from them goes anywhere but this page, over the same origin as everything
else: the route is `POST /api/history`, under `handleApi` like the rest.
The prompts are drawn with `h()` and text nodes, and the one thing that acts on one -- the History
tab's ▶ on a row -- goes through `sendToClaude`, typed and not submitted. The file's
format is Claude Code's and undocumented, so each line is held to the shape observed before it
counts, and a line that does not fit is skipped. `--no-history` or `PRCODER_NO_HISTORY` turns the
read off, and `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, which stops Claude Code writing the file, turns it
off with it.

## Checking new work

- **A new route** goes under `/api/` and through `handleApi`, which is where `sameOrigin` runs. A
  handler registered anywhere else gets no origin check.
- **A new WebSocket path** calls `sameOrigin` before it does anything, the way `/pty` refuses before
  the spawn rather than after.
- **Anything the page sends that reaches a spawn's argv** is allowlisted, not passed through.
  The Claude pane's "Start coding agent" puts a model, an effort and `--continue` on the
  `/pty` query, and `sessionArgs` in `server.js` refuses the socket before the spawn for any other
  value -- a model has to be a name, so `--model --dangerously-skip-permissions` never becomes two
  flags. The one exception is a value equal to what prcoder's command line already gave, which is
  dropped as a repeat rather than checked: it came from whoever started prcoder, not the page.
  The milestone picker's number goes to `gh api -F`, which reads a value by its shape
  (`null`, `true`, a number, a leading `@` as a file to read), so `/api/pr/milestone` takes only a
  positive integer or null, before it looks at anything else. Then the number has to be one the
  picker was offered -- the server keeps the last list it read for each repository (`pickerMove`) --
  or the milestone the pull request is already on, as the Issues and Pull requests tabs' moves are
  held to their listings, so a closed milestone or one a stale tab sends never reaches GitHub.
  The switcher's `/api/pr/switch` hands a URL to `gh pr view` and then a checkout, so `wholePrRepo`
  in `git.js` takes only the whole of a `https://github.com/owner/repo/pull/N` -- anchored, so a
  flag in front of one or another host with that path behind it is refused -- and the route takes
  it only in one of `repos`, the repositories `repoInfo` says the branch's pull requests are looked
  for in. In place of a URL it takes a number, for a pull request the switcher's list does not
  have: `switchTarget` in `server.js` takes only a JSON number that is a positive integer -- never
  a string, which could be a flag or a branch's name once it is in gh's argv -- and gh reads a bare
  number in its base repository, whose URL is then held to `repos` like any other. Its
  sibling `/api/pr/choose` checks nothing out, and takes only a URL the last poll listed for the
  branch. `test/api.test.js` pins the refusals that need no `gh`. A URL prcoder reads back from
  its own files is held to the same rule, since anyone can edit them: each one `.prcoder/prs.json`
  remembers goes to `gh pr view`, so `readPrs` in `store.js` keeps only a whole pull request link
  in the repository written beside it, and `lookupPrs` in `github.js` reads only one whose URL is
  in `repos` -- the URL, not only that `repo`, since the URL is what gh is given. Both compare the
  repository case-blind, as GitHub does, since a remote may spell it in another case than the link
  (`test/store.test.js`, `test/github.test.js`).
  The Issues tab's one write, `/api/issue/milestone`, takes an issue number and a milestone title
  from the page and hands gh neither: `issueMove` in `server.js` looks both up in the listing the
  tab was last shown, and the listing's own numbers go to `gh api -F` (`setIssueMilestone` in
  `github.js`). `test/api.test.js` pins the refusals. The PRs tab's `/api/pull/milestone`
  is the same hold (`pullMove`), on the last listing the server read from GitHub -- never on
  `.prcoder/pulls.json`, which the tab may be showing, and where a pull request merged since the file
  was written is still open; a move made before that read waits for it. The file is still held
  before it is drawn: `readPulls` in `store.js` keeps a row only with an integer number and the
  whole of a pull request link in this repository, and a milestone only with an integer number and
  a string title (`test/store.test.js`). A row's other href, each issue it closes, is kept only as the whole of a
  GitHub issue link (`closesOf`), so a hand-edit cannot put a `javascript:` link in the tab.
- **Text from GitHub** — descriptions, titles, issue bodies, file names — is built into the page with
  `h()` and text nodes. `innerHTML` only through `inline()`, and a new kind of link only through
  `target()`.
- **Terminal output** goes through `term.js`, `console.log` included. A write straight to
  `process.stdout` skips `visible()`.
- **Nothing sends to Claude without a click** on text the user can see. A queue item's text can be
  an issue title from any repo or a line of a hand-edited queue file, and ▶ types it into the PTY,
  where a `\r` would submit the turn and an escape would start a sequence; so `sendToClaude` in
  `app.js` turns control characters into spaces (`printable` in `tasks.js`) whatever the text's
  source, and the link ▶ adds is built from the repo name and number the row's tag shows. New text
  from GitHub or a file goes to the agent through `sendToClaude`, not straight to `typeIntoAgent`.
  `linksFrom` in `github.js` cleans titles too, so they are stored and shown without them.
- **A route that reads outside the repository** reads only, keeps only what is this working copy's
  before answering, holds what it reads to a shape, and has a switch that turns it off; and the
  drivers point it at a fixture (`claudeConfig` in `tools/driver.mjs`), so no screenshot carries
  the owner's real files. `/api/history` is the one there is, and the section above is its
  argument. `/api/worktrees` reads outside this working copy but not outside the repository: the
  directories are the ones git lists as this repository's working copies, never one the page
  names, and what is read in each is prcoder's own running record, a pid and a port, which is then
  believed only if a prcoder answers on that port saying it runs in that directory. The page gets
  each one's path, branch and address; nothing it sends back reaches a path or an argv.
- **A new kind of asset** — a font, an image, a worker, anything loaded rather than inlined — has to
  be allowed by the CSP beside `serveFile`, which is otherwise silent about what it blocks. The
  Prism grammars under `/vendor/prism/` are same-origin script, which `script-src 'self'` already
  allows; a highlighter loaded from a CDN would not be.
