// A `gh` on PATH for the tests that assert what reaches gh, or what the code
// does with a given answer. Imported by test files; never a test itself (see
// CLAUDE.md here). Unix only: the stub is an sh script, which is what the
// `unix` skip reason is for.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const unix = process.platform === 'win32' ? 'the gh stub is a sh script' : false;

/**
 * Runs `fn` with a `gh` whose body is `script(dir)` first on PATH. The script
 * gets the stub's own directory, for writing what it was asked.
 */
export const withGh = async (script, fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-gh-stub-'));
  await fs.writeFile(path.join(dir, 'gh'), `#!/bin/sh\n${script(dir)}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try {
    return await fn(dir);
  } finally {
    process.env.PATH = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
};

/** The last call's arguments, one per line, from a gh that answers `[]`. */
export const ghArgs = (fn) => withGh((dir) => `printf '%s\\n' "$@" > "${dir}/args"\necho '[]'`, async (dir) => {
  await fn();
  return (await fs.readFile(path.join(dir, 'args'), 'utf8')).trimEnd().split('\n');
});

/**
 * Every call, each as its own argv, where ghArgs keeps only the last: the
 * branch lookup is one `gh pr list` per repository, run together, so each
 * call writes a file of its own and the calls come back in no fixed order.
 * `script` is what the stub answers with, after recording the call.
 */
export const ghCalls = (script, fn) => withGh((dir) => `printf '%s\\n' "$@" > "$(mktemp "${dir}/call.XXXXXX")"\n${script}`,
  async (dir) => {
    const out = await fn();
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('call.'));
    const calls = await Promise.all(files.map(async (f) =>
      (await fs.readFile(path.join(dir, f), 'utf8')).trimEnd().split('\n')));
    return { out, calls };
  });
