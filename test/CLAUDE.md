# test/

`npm test` runs every `*.test.js` under this directory, at any depth. Anything
else here runs only when a test file imports it, which is how
`browser/suite.js` runs once per engine and never on its own. That is also why
the drivers live in `tools/` and not here: none of them should be one rename
away from running on every `npm test`, spawning a server and driving a browser
or a PTY. `docs/Verifying.md` explains why the command is a quoted glob.

`node:test` is a preference, not a constraint. If it ever gets in the way --
maintainability, a matcher you keep hand-rolling, watch mode, anything -- the
owner is fine with switching to a real test framework (stated 2026-09-05).
