// Where a driver's screenshots go: `data/shots/<label>/`, the label saying what
// the run was for -- `node tools/browser.mjs highlighting` while working on the
// diff pane's tokens. A directory of forty PNGs named after panes says nothing
// about which run took them or what anyone was looking at, and `data/shots`
// had accumulated three runs' worth across nine days before this existed.
//
// Two things keep it bounded, because a screenshot nobody can date is one
// nobody will delete either. A run replaces its own label rather than adding to
// it, so a shot the driver has stopped taking cannot linger beside the ones it
// still takes and pass for current. And the labels themselves are capped,
// oldest first, by directory mtime -- which is when a run last wrote into it.
//
// Nothing here deletes a directory it does not recognise. A label holding
// anything but `.png` files is left alone and said out loud instead: it is
// somebody's, the driver did not put it there, and being wrong costs work that
// cannot be got back. Same for loose PNGs directly under `data/shots`, which
// are what every run before labels wrote -- reported once, never removed,
// because this cannot tell them from something saved on purpose.

import fs from 'node:fs/promises';
import path from 'node:path';

/** One directory name, never a path: `label` is joined onto data/shots. */
export const LABEL = /^[a-z0-9][a-z0-9-]*$/;

export const KEEP = () => Number(process.env.PRCODER_KEEP) || 5;

export function labelPath(root, label) {
  if (!LABEL.test(label)) {
    throw new Error(`shots label ${JSON.stringify(label)}: lower-case letters, digits and dashes, `
      + 'starting with a letter or digit -- it names one directory under data/shots, not a path');
  }
  return path.join(root, label);
}

/**
 * null when it is not there, true when every entry is a `.png` file -- a
 * directory a driver wrote and may therefore replace -- and false for anything
 * else, including a subdirectory or a symlink, which is left alone.
 */
async function shotsOnly(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  });
  return entries && entries.every((e) => e.isFile() && e.name.endsWith('.png'));
}

/** The directory this run writes into, emptied first. */
export async function openShots(root, label) {
  const dir = labelPath(root, label);
  const ours = await shotsOnly(dir);
  if (ours === false) {
    throw new Error(`data/shots/${label} holds something that is not a screenshot -- `
      + 'pick another label rather than have this delete it');
  }
  if (ours) await fs.rm(dir, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Oldest labels removed until `keep` remain. Run at the end of a run, so the
 * label just written is the newest and is never a candidate for its own prune.
 */
export async function pruneShots(root, { keep = KEEP(), log = console.log } = {}) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const loose = entries.filter((e) => e.isFile() && e.name.endsWith('.png'));

  const dirs = [];
  for (const e of entries.filter((x) => x.isDirectory())) {
    const dir = path.join(root, e.name);
    dirs.push({ name: e.name, dir, at: (await fs.stat(dir)).mtimeMs, ours: await shotsOnly(dir) });
  }
  const ours = dirs.filter((d) => d.ours).sort((a, b) => b.at - a.at);
  const removed = ours.slice(keep);
  for (const d of removed) await fs.rm(d.dir, { recursive: true });

  const strangers = dirs.filter((d) => !d.ours).map((d) => d.name);
  if (removed.length) {
    log(`shots:   removed ${removed.map((d) => d.name).join(', ')}`,
      `-- keeping the ${keep} most recent (PRCODER_KEEP)`);
  }
  if (loose.length) log(`shots:   ${loose.length} loose PNGs in data/shots, left alone -- from before labels`);
  if (strangers.length) log(`shots:   left ${strangers.join(', ')} alone -- not only .png inside`);
  return { kept: ours.slice(0, keep).map((d) => d.name), removed: removed.map((d) => d.name), loose: loose.length, strangers };
}
