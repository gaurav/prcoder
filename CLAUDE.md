# prcoder

A local server + browser UI wrapping a real `claude` PTY. See README.md for what
it does and how to run it, `docs/Panes.md`, `docs/Terminal.md` and
`docs/Ports.md` for how each part behaves in detail -- a change to a pane's
layout or ordering is a change to Panes.md, not the README --
`docs/Design.md` for why it works the way it does --
the guards, the non-goals -- `docs/Security.md` for what the server is exposed to
and the checks new work has to keep, and `docs/Verifying.md` for what this repo
checks and how. `.claude/skills/run-prcoder/SKILL.md` is the short form of the
last two for an agent about to run the thing: how to launch, what to stub, what
not to write. Keep all of them true when you change what they describe -- the
skill drifts first, because nothing else links to it. `public/`, `tools/` and
`test/` each have a CLAUDE.md for work inside them.

**The queue is yours, and prcoder writes no description but a box you tick.**
The queue lives only in `.prcoder/queue.json` (or the file `--queue` names): it
no longer mirrors into the PR description, nothing moves into one, and FUTURE.md
is gone. "The queue is yours" in `docs/Design.md` says what replaced them and
what is still to come. The mirror is parked in PR #82; don't bring a sync back
without reading both.
Descriptions an earlier prcoder wrote still carry the mirror's block between
HTML-comment markers. Nothing reads it any more, so leave it alone; it is an
ordinary checklist now, and editing it by hand is safe.

## Scratch work goes in `data/`

`data/` is gitignored and is where anything temporary belongs -- driver
screenshots, snapshots of a PR body taken before a write, intermediate output.
Its one tracked file, `data/.gitkeep` (added with `git add -f`), is there so
every clone has the directory: a driver writes into it without creating it
first, and a detached child that cannot write there fails without a word.
Not `/tmp`: reads outside this working directory are blocked, so a screenshot
written to `/tmp` is one nobody in this session can look at. A one-off
Playwright script has to live here too -- `import 'playwright'` resolves from
this repo's `node_modules`, and from a scratch directory it is `Cannot find
package 'playwright'`. Read `tools/CLAUDE.md` before writing one: it applies
there too, and `tools/driver.mjs` is what to build it on.

## Two traps

**Don't delete the `postinstall` script.** `tools/postinstall.mjs` looks like
dead setup, but without it every PTY spawn fails with a bare `posix_spawnp
failed`, which looks like a Node ABI problem and isn't. Its header says why,
and why `npm install-scripts approve node-pty` does not replace it.

**Don't simplify `npm test`.** It is `node --test "test/**/*.test.js"`, and the
double quotes, the glob and the absence of a directory argument each prevent a
different failure: a crash, a second copy of the suite, or a run that reports
one test and passes. `docs/Verifying.md` has all three.

## Subprocess errors are quieter than they look

A gh or git failure here is usually quiet, not loud: stderr missing from the
error, a full stdout behind a non-zero exit, or an exit code that means "no"
rather than "broke". Read the docstrings on `run` in `github.js` and `answer`
in `git.js` before adding a call, and check what the real tool does.

## Verifying against GitHub

Prefer checking GitHub's real behaviour over trusting its docs — the diff-anchor
scheme in `files.js` was confirmed by grepping the rendered HTML of a public PR,
and that assertion is pinned in `test/files.test.js` with the date.

Test writes against this repo's own PRs. Never against a repo you don't own.

## Green is not evidence that a rebuilt history is intact

Splitting work into a commit per finding means rebuilding files by hand, and
both `npm test` and the drivers run against the *working tree* — so they stay
green while a commit is missing half of what its message claims. It happened
here: the server half of one change was staged out of its own commit and
nothing went red.

The only check that sees it is `git diff <the tree you drove> HEAD` coming back
empty. Take that diff before trusting a reassembled series, not the test run.
