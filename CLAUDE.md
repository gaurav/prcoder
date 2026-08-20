# prcoder

A local server + browser UI wrapping a real `claude` PTY. See README.md for what
it does and how to run it.

## Two traps

**Don't delete the `postinstall` chmod in package.json.** It looks like dead
setup. npm blocks node-pty's own install script, which is what makes
`prebuilds/*/spawn-helper` executable. Without it every PTY spawn fails with a
bare `posix_spawnp failed` — no mention of permissions, and node-pty still
imports fine, so it reads like a Node ABI problem when it isn't.

**Run tests with bare `node --test`, not `node --test test/`.** On Node 26 a
directory argument is resolved as a module and dies with `Cannot find module`.

## Verifying against GitHub

Prefer checking GitHub's real behaviour over trusting its docs — the diff-anchor
scheme in `files.js` was confirmed by grepping the rendered HTML of a public PR,
and that assertion is pinned in `test/files.test.js` with the date.

Test writes against this repo's own PRs. Never against a repo you don't own.
