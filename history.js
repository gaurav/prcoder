// What you have sent the coding agent, with when: read from where Claude Code
// keeps it, never captured by prcoder itself.
//
// Claude Code appends every typed prompt to `history.jsonl` in its config
// directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR`), which is what its up-arrow
// and Ctrl+R read (https://code.claude.com/docs/en/claude-directory.md). One
// JSON object per line, observed 2026-11-07 over 1,545 lines with exactly five
// keys: `display` (the prompt as typed, a paste shown as its `[Pasted text #1
// +N lines]` placeholder), `pastedContents`, `timestamp` (ms since the epoch),
// `project` (the absolute cwd the session ran in) and `sessionId` (the UUID
// its transcript is named by). The file's purpose is documented; its fields
// are not, so every one is checked before a line counts, and a line that does
// not fit is skipped rather than trusted (parseHistory).
//
// Reading the file is the whole design (docs/Design.md, "What prcoder reads"):
// a hook passed through `--settings` would capture the same prompts, and it is
// the one thing prcoder does not do -- pass flags of its own to `claude` (#21).
// It would also know only the prompts sent after it was installed. The file
// already holds every one.
//
// A session's title comes from one line of its transcript,
// `projects/<slug>/<sessionId>.jsonl`, whose format is documented as internal
// (https://code.claude.com/docs/en/sessions.md): `{"type":"ai-title",
// "aiTitle":…}`, written once Claude Code has named the session. Nothing else
// in the transcript is read, and a transcript without that line, or without
// a transcript at all (cleanupPeriodDays prunes them; the history file is not
// pruned), is a session with no title.
//
// `pastedContents` is never read. A paste is where a secret lands, and the
// placeholder in `display` already says a paste was there.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

/** Claude Code's config directory: the variable it honours, or its default. */
export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export const historyFile = (dir) => path.join(dir, 'history.jsonl');

/** How Claude Code names a project's directory under `projects/`: every character that is not a letter or a digit becomes `-`. */
export const projectSlug = (project) => project.replace(/[^A-Za-z0-9]/g, '-');

export const transcriptFile = (dir, project, sessionId) =>
  path.join(dir, 'projects', projectSlug(project), `${sessionId}.jsonl`);

// The shape a session id has to have before it is put in a file name.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const trimSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

/**
 * Where a prompt's `project` is relative to this working copy: '' for the
 * working copy itself, `data/wt-87` for a session run in a worktree under its
 * `data/` (where tools/driver.mjs puts one to drive another pull request), and
 * null for anywhere else, which is another repository's history. `roots` are
 * the paths this working copy goes by -- as prcoder was started, and resolved,
 * since a session started through a symlink records the path it was given.
 */
export function whereIn(project, roots) {
  if (typeof project !== 'string') return null;
  const p = trimSlash(project);
  for (const root of roots) {
    const r = trimSlash(root);
    if (p === r) return '';
    const data = `${r}${path.sep}data${path.sep}`;
    if (p.startsWith(data) && p.length > data.length) return path.relative(r, p);
  }
  return null;
}

/**
 * The prompts in `text` that were sent from this working copy, newest first,
 * at most `limit` of them: `{ at, text, session, where, project }`, `at` in ms.
 * A line that is not JSON, or whose fields are not the five above in the shapes
 * above, is counted in `skipped` and left out -- the file is Claude Code's to
 * write and anyone's to edit. A session id that is not a UUID becomes null
 * rather than a file name.
 */
export function parseHistory(text, roots, { limit = 1000 } = {}) {
  const prompts = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { skipped++; continue; }
    if (!o || typeof o !== 'object' || typeof o.display !== 'string' || !o.display.trim()
      || !Number.isFinite(o.timestamp)) { skipped++; continue; }
    const where = whereIn(o.project, roots);
    if (where === null) continue;
    prompts.push({
      at: o.timestamp,
      text: o.display,
      session: typeof o.sessionId === 'string' && UUID.test(o.sessionId) ? o.sessionId.toLowerCase() : null,
      where,
      project: o.project,
    });
  }
  // Appended in order, so a sort is only for a file that was edited; stable,
  // so prompts in one millisecond keep the file's order.
  prompts.sort((a, b) => b.at - a.at);
  return { prompts: prompts.slice(0, limit), skipped };
}

// A transcript's title, remembered against the file's size and mtime, so a
// refresh re-reads only a transcript that has grown -- a session still running
// has, and may have been named since.
const titles = new Map();

/**
 * The `aiTitle` of one transcript, or null: the file is read a line at a time
 * and left as soon as the title line is found, since a transcript is every
 * turn and tool result of a session and can run to megabytes.
 */
async function titleOf(file) {
  let stat;
  try { stat = await fs.stat(file); } catch { return null; }
  const held = titles.get(file);
  if (held && held.size === stat.size && held.mtimeMs === stat.mtimeMs) return held.title;
  let title = null;
  const stream = createReadStream(file, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('"ai-title"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        title = o.aiTitle.trim();
        break;
      }
    }
  } catch {
    // Unreadable partway: no title, and nothing cached, so the next read tries again.
    return null;
  } finally {
    stream.destroy();
  }
  titles.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, title });
  return title;
}

/**
 * The titles of the sessions `prompts` came from, `{ [sessionId]: { title } }`,
 * only for those that have one. A few transcripts are read at a time: the
 * first visit after a long absence can have dozens to open.
 */
async function sessionTitles(dir, prompts) {
  const files = new Map();
  for (const p of prompts) if (p.session && !files.has(p.session)) files.set(p.session, transcriptFile(dir, p.project, p.session));
  const out = {};
  const queue = [...files];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [id, file] = next;
      const title = await titleOf(file);
      if (title) out[id] = { title };
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

/**
 * The working copy's prompt history: `{ prompts, sessions, skipped, read,
 * file }`, prompts as parseHistory gives them without `project`, `read` in
 * ms. No file is an empty history, not an error: a fresh install, or
 * CLAUDE_CODE_SKIP_PROMPT_HISTORY set in the shell `claude` runs from, has
 * none. Any other failure to read it is thrown, so the route says why.
 */
export async function readHistory(repo, { env = process.env, limit = 1000, now = Date.now() } = {}) {
  const dir = configDir(env);
  const file = historyFile(dir);
  let real = repo;
  try { real = await fs.realpath(repo); } catch { /* as given */ }
  const roots = [...new Set([repo, real])];
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { prompts: [], sessions: {}, skipped: 0, read: now, file };
    throw e;
  }
  const { prompts, skipped } = parseHistory(text, roots, { limit });
  const sessions = await sessionTitles(dir, prompts);
  return {
    prompts: prompts.map(({ project, ...p }) => p),
    sessions,
    skipped,
    read: now,
    file,
  };
}
