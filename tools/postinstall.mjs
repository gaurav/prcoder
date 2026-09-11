// Make node-pty's prebuilt `spawn-helper` executable, which npm will not.
//
// npm blocks node-pty's own install script, and that script is what sets the
// bit. Without it every PTY spawn fails with a bare `posix_spawnp failed` -- no
// mention of permissions, and node-pty still imports fine, so it reads like a
// Node ABI problem when it is a file mode. `npm install-scripts approve
// node-pty` does *not* replace this: the approved script is `node-gyp rebuild`,
// and the prebuilt helper still lands non-executable. Tested 2026-08-23.
//
// Node rather than the `chmod ... 2>/dev/null || true` this used to be: under
// cmd.exe neither `chmod` nor the `true` it falls back to exists, so the whole
// `npm install` failed on Windows before any of server.js's win32 paths could
// run. Here every platform without the helper simply has nothing to do.
import { chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';

const prebuilds = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

let dirs = [];
try {
  dirs = readdirSync(prebuilds);
} catch {
  // No prebuilds at all: node-pty built from source, or is not installed yet.
}

for (const d of dirs) {
  try {
    chmodSync(path.join(prebuilds, d, 'spawn-helper'), 0o755);
  } catch {
    // This prebuild has no helper -- Windows ships none.
  }
}
