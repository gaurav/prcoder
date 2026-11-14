// The prompt history: Claude Code's own `history.jsonl`, read and never
// written, held to the shape observed on 2026-11-07 (history.js says which)
// and filtered to the working copy prcoder runs in. The file's fields are not
// documented, so these pin the guards: what a line has to carry to count, and
// that nothing from `pastedContents` leaves the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { whereIn, parseHistory, readHistory, configDir, historyFile, transcriptFile, projectSlug } from '../history.js';

const REPO = '/Users/someone/Developer/prcoder';
const SESSION = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const line = (over = {}) => JSON.stringify({
  display: 'fix the thing', pastedContents: {}, timestamp: 1_700_000_000_000, project: REPO, sessionId: SESSION, ...over,
});

// The working copy itself, a worktree under its data/ (tools/driver.mjs makes
// one per driven pull request), and nothing else: another repository's prompts
// are another repository's business, and so are a sibling's.
test('whereIn places a project against the working copy and its data/ worktrees', () => {
  assert.equal(whereIn(REPO, [REPO]), '');
  assert.equal(whereIn(`${REPO}/`, [REPO]), '');
  assert.equal(whereIn(`${REPO}/data/wt-87`, [REPO]), 'data/wt-87');
  assert.equal(whereIn(`${REPO}/data/`, [REPO]), null, 'data/ itself is no worktree');
  assert.equal(whereIn(`${REPO}-other`, [REPO]), null, 'a sibling that shares the prefix');
  assert.equal(whereIn(`${REPO}/src`, [REPO]), null, 'a subdirectory outside data/');
  assert.equal(whereIn('/elsewhere', [REPO]), null);
  assert.equal(whereIn(undefined, [REPO]), null);
  assert.equal(whereIn(42, [REPO]), null);
  // Started through a symlink, the session records the path it was given;
  // the resolved path is a second root.
  assert.equal(whereIn('/real/prcoder', ['/link/prcoder', '/real/prcoder']), '');
});

test('parseHistory keeps the working copy\'s prompts, newest first, without the pastes', () => {
  const text = [
    line({ display: 'first', timestamp: 1 }),
    line({ display: 'elsewhere', project: '/other/repo', timestamp: 2 }),
    line({ display: 'second [Pasted text #1 +12 lines]', timestamp: 3, pastedContents: { 1: { content: 'SECRET' } } }),
    line({ display: 'in a worktree', timestamp: 4, project: `${REPO}/data/wt-87`, sessionId: OTHER }),
  ].join('\n');
  const { prompts, skipped } = parseHistory(text, [REPO]);
  assert.equal(skipped, 0);
  assert.deepEqual(prompts, [
    { at: 4, text: 'in a worktree', session: OTHER, where: 'data/wt-87', project: `${REPO}/data/wt-87` },
    { at: 3, text: 'second [Pasted text #1 +12 lines]', session: SESSION, where: '', project: REPO },
    { at: 1, text: 'first', session: SESSION, where: '', project: REPO },
  ]);
  assert.ok(!JSON.stringify(prompts).includes('SECRET'));
});

// Anyone can edit the file, and a Claude Code that changes its fields must
// leave a tab with nothing in it rather than one that throws.
test('a line that is not a prompt in the shape observed is skipped, not trusted', () => {
  const text = [
    'not json',
    JSON.stringify({ display: 'no time', project: REPO }),
    JSON.stringify({ display: 42, timestamp: 1, project: REPO }),
    JSON.stringify({ display: '   ', timestamp: 1, project: REPO }),
    JSON.stringify(null),
    JSON.stringify('a string'),
    '',
    line({ display: 'kept', timestamp: 9 }),
  ].join('\n');
  const { prompts, skipped } = parseHistory(text, [REPO]);
  assert.equal(skipped, 6);
  assert.deepEqual(prompts.map((p) => p.text), ['kept']);
});

// The session id names a file to open, so only a UUID is one; anything else
// is a prompt with no session rather than a path.
test('a session id that is not a UUID is no session, and never a file name', () => {
  const text = [
    line({ sessionId: '../../etc/passwd', timestamp: 1 }),
    line({ sessionId: 7, timestamp: 2 }),
    line({ timestamp: 3, sessionId: SESSION.toUpperCase() }),
  ].join('\n');
  const { prompts } = parseHistory(text, [REPO]);
  assert.deepEqual(prompts.map((p) => p.session), [SESSION, null, null]);
});

test('parseHistory stops at the limit, keeping the newest', () => {
  const text = Array.from({ length: 5 }, (_, i) => line({ display: `p${i}`, timestamp: i })).join('\n');
  assert.deepEqual(parseHistory(text, [REPO], { limit: 2 }).prompts.map((p) => p.text), ['p4', 'p3']);
});

test('the files are where Claude Code keeps them, under the directory it honours', () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg');
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '' }), path.join(os.homedir(), '.claude'));
  assert.equal(configDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(historyFile('/cfg'), '/cfg/history.jsonl');
  // Verified against this repo's own directory on 2026-11-07.
  assert.equal(projectSlug('/Users/gaurav/Developer/prcoder'), '-Users-gaurav-Developer-prcoder');
  assert.equal(projectSlug('/a/b.c_d e'), '-a-b-c-d-e');
  assert.equal(transcriptFile('/cfg', '/Users/x/repo', SESSION), `/cfg/projects/-Users-x-repo/${SESSION}.jsonl`);
});

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), 'prcoder-history-'));

test('readHistory reads the file for this working copy and titles the sessions that have one', async () => {
  const cfg = await scratch();
  const repo = await scratch();
  const env = { CLAUDE_CONFIG_DIR: cfg };
  await fs.writeFile(historyFile(cfg), [
    line({ display: 'untitled session', timestamp: 1, project: repo, sessionId: OTHER }),
    line({ display: 'titled session', timestamp: 2, project: repo }),
    line({ display: 'elsewhere', timestamp: 3, project: '/other' }),
  ].join('\n') + '\n');
  const transcript = transcriptFile(cfg, repo, SESSION);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'titled session' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: '  Title the agent gave  ', sessionId: SESSION }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'a later one, not read' }),
  ].join('\n') + '\n');
  // OTHER's transcript has no title line at all.
  await fs.writeFile(transcriptFile(cfg, repo, OTHER), JSON.stringify({ type: 'user' }) + '\n');

  const h = await readHistory(repo, { env, now: 99 });
  assert.deepEqual(h.prompts, [
    { at: 2, text: 'titled session', session: SESSION, where: '' },
    { at: 1, text: 'untitled session', session: OTHER, where: '' },
  ]);
  assert.deepEqual(h.sessions, { [SESSION]: { title: 'Title the agent gave' } });
  assert.deepEqual([h.skipped, h.read, h.file], [0, 99, historyFile(cfg)]);

  // A title given since is seen on the next read: the cache is by size and mtime.
  await fs.appendFile(transcriptFile(cfg, repo, OTHER), JSON.stringify({ type: 'ai-title', aiTitle: 'Named now' }) + '\n');
  assert.equal((await readHistory(repo, { env })).sessions[OTHER].title, 'Named now');
});

// A fresh install, or CLAUDE_CODE_SKIP_PROMPT_HISTORY in the shell claude
// runs from, has no file; that is an empty tab, not a broken one. A
// transcript that is missing -- pruned by cleanupPeriodDays -- is a session
// with no title.
test('no history file is an empty history, and no transcript is no title', async () => {
  const cfg = await scratch();
  const repo = await scratch();
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.deepEqual((await readHistory(repo, { env, now: 5 })).prompts, []);
  await fs.writeFile(historyFile(cfg), line({ project: repo }) + '\n');
  const h = await readHistory(repo, { env });
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.sessions, {});
});

// A session started through a symlink to the working copy records the link's
// path, and one started in the resolved directory the real one; both are this
// working copy's.
test('readHistory counts the working copy under its resolved path as well', async () => {
  const cfg = await scratch();
  const real = await fs.realpath(await scratch());
  const link = path.join(await scratch(), 'link');
  await fs.symlink(real, link);
  await fs.writeFile(historyFile(cfg), [
    line({ display: 'via link', timestamp: 1, project: link }),
    line({ display: 'via real', timestamp: 2, project: real }),
  ].join('\n') + '\n');
  const h = await readHistory(link, { env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.deepEqual(h.prompts.map((p) => p.text), ['via real', 'via link']);
});
