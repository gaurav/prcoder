// suite.js's guard on PRCODER_TEST_HALF: a value that is neither half would
// register no tests, and the file that set it would pass. Run in a child, since
// the guard throws at import, before any test exists to fail. No engine, so
// that without the guard the child skips its browser and exits 0 at once:
// with a real one it launches a browser that holds the child's pipes open, and
// spawnSync waits on it past its own timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suite = fileURLToPath(new URL('./suite.js', import.meta.url));

test('a PRCODER_TEST_HALF that is neither half stops the suite at import', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(suite)})`], {
    env: { ...process.env, PRCODER_TEST_BROWSER: 'none', PRCODER_TEST_HALF: '3' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, /PRCODER_TEST_HALF is "3": it has to be '1', '2' or unset/);
});
