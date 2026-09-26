// The PR description's half of the queue: the `<!-- prcoder:todo -->` block,
// and one checkbox flipped in a description.
//
// The queue itself lives in .prcoder/queue.json (see store.js) and an item is
// { text, done, doneAt, inPr, pr, issue, deleted }. `inPr` mirrors it into a PR
// description and `pr` is which one; `issue` links it to a GitHub issue. An item can be both, in
// which case the PR line becomes a bare #N reference — that is the "converting
// to an issue replaces the PR line" rule. `deleted` is a tombstone: deleting an
// item here or on github.com keeps the record, so nothing the user typed
// disappears without somewhere to get it back.

import { TASK, taskLines, hideComments, fencedLines } from './public/tasks.js';

const OPEN = '<!-- prcoder:todo -->';
const CLOSE = '<!-- /prcoder:todo -->';


/**
 * An item's text as one line of the block. A checklist line cannot hold a
 * newline, and the queue input takes one on Shift-Enter -- rendered raw, the
 * rest of the item became lines of prose, and the item's own line never matched
 * its text again, so the next sync buried it. Matching compares both sides in
 * this form.
 */
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/** One line of the PR description's block: the item's text, or `#N` for an issue. */
function renderItem(item) {
  return `- [${item.done ? 'x' : ' '}] ${item.issue ? `#${item.issue}` : oneLine(item.text)}`;
}

/**
 * One line of the block, read back as written: text is text, so an item whose
 * text starts with `@pr` or `@deleted` keeps it. A bare `#N` is an issue,
 * because that is how renderItem writes one.
 */
function parseBlockLine(line) {
  const m = TASK.exec(line);
  if (!m) return null;
  const text = oneLine(m[2]);
  const bare = /^#(\d+)$/.exec(text);
  return {
    text: bare ? '' : text,
    done: m[1].toLowerCase() === 'x',
    inPr: true,
    issue: bare ? Number(bare[1]) : null,
    deleted: false,
  };
}

/**
 * Whether an item is PR `number`'s to show and to bury. The queue is one list for
 * the repo while each block is one PR's, so an item mirrored into another PR is
 * neither written into this block nor read as deleted for being absent from it
 * -- which it was, every time a switch put a PR with an older block on screen.
 *
 * An item with no `pr` is anybody's: not mirrored at all, or mirrored before
 * items recorded where. The first PR it is written into or matched in claims it.
 */
const belongs = (item, number) => !item.inPr || item.pr == null || item.pr === number;

/**
 * Replace the prcoder block in PR `number`'s body. Items live there when `inPr`
 * and it is theirs; an item that is also an issue renders as a bare `#N` so
 * GitHub links it.
 */
export function renderPrBlock(items, body = '', number) {
  const mine = items.filter((i) => i.inPr && !i.deleted && belongs(i, number));
  const block = mine.length
    ? [OPEN, '## TODO', '', ...mine.map((i) => renderItem(i)), CLOSE].join('\n')
    : '';

  const { before, after, found } = splitPrBlock(body);
  if (!found) return block ? `${before.trimEnd()}\n\n${block}\n`.trimStart() : before;
  const joined = `${before.trimEnd()}\n\n${block}\n${after.trimStart()}`;
  return (block ? joined : `${before.trimEnd()}\n${after.trimStart()}`).trim() + '\n';
}

/**
 * Flip one checkbox in a PR description, so the boxes rendered in the PR pane
 * are the real ones. The line is found by its position among the body's
 * checklist lines -- counted by the same taskLines() the pane counts with --
 * and then checked against the text the client saw, so a body that moved on
 * fails loudly instead of ticking the line next door.
 *
 * `inBlock` says whether the line is one of ours: those are a projection of the
 * queue and the tick has to be folded back into it, and the caller is the only
 * one that can write the store.
 */
export function toggleTask(body, index, done, expected) {
  const lines = (body ?? '').split('\n');
  const at = taskLines(body ?? '')[index];
  if (at === undefined) throw new Error('that checkbox is no longer in the description -- refresh');

  // Read through the same comment blanking the pane rendered from: its text for
  // `- [ ] fix <!-- note -->` is `fix`, and the raw line's never would be.
  const visible = hideComments(body ?? '', ' ').split('\n')[at];
  const text = TASK.exec(visible)[2].trim();
  if (text !== (expected ?? '').trim()) {
    throw new Error(`the description changed under that checkbox (now "${text}") -- refresh`);
  }
  // TASK anchors the box at the start of the line, so the first [ ] outside a
  // comment is it -- found in the blanked copy, whose offsets are the raw line's.
  const box = visible.search(/\[( |x|X)\]/);
  lines[at] = `${lines[at].slice(0, box)}${done ? '[x]' : '[ ]'}${lines[at].slice(box + 3)}`;

  const { found, open, close } = splitPrBlock(body ?? '');
  return { body: lines.join('\n'), inBlock: found && at > open && at < close };
}

/**
 * The block, found by markers that are each alone on a line and outside any
 * fence -- the only way renderPrBlock writes them. `open` and `close` are those
 * lines' numbers.
 *
 * It used to be the first occurrence anywhere, so a description that quoted
 * the marker in a sentence about how prcoder works had that sentence read as
 * the start of the block, and the next write replaced everything from there to
 * the real closing marker (#9). A marker placed by hand mid-line, or indented,
 * is no longer a block either: the next write appends a fresh one below it,
 * which leaves a duplicate for someone to delete rather than deleting prose.
 */
function splitPrBlock(body = '') {
  const lines = body.split('\n');
  const fenced = fencedLines(body);
  const find = (marker, from) => lines.findIndex((l, i) => i >= from && l === marker && !fenced.has(i));
  const open = find(OPEN, 0);
  const close = open === -1 ? -1 : find(CLOSE, open + 1);
  const offset = (line) => lines.slice(0, line).join('\n').length + (line ? 1 : 0);
  const start = open === -1 ? -1 : offset(open);
  const end = close === -1 ? -1 : offset(close);
  // Both markers or none. A half-open block used to report found with an empty
  // `after`, so the next write closed it where the body happened to end and
  // took everything past the last item with it -- one hand-edit on github.com
  // that drops the closing comment, and the bottom of the description is gone
  // on the next poll. Unfound means the block is appended afresh instead, which
  // leaves the stray marker in the prose where someone can see it.
  if (start === -1 || end === -1) return { before: body, after: '', found: false };
  return {
    before: body.slice(0, start),
    after: body.slice(end + CLOSE.length),
    found: true,
    open,
    close,
  };
}

/**
 * Fold edits made to the PR description on github.com back into the queue, so
 * ticking a box or adding a line from another machine survives.
 *
 * ponytail: last-write-wins, no conflict detection. Single user, single PR —
 * add real merging only if simultaneous edits actually bite.
 */
export function syncFromPrBlock(items, body = '', number) {
  const { before, after, found } = splitPrBlock(body);
  if (!found) return items;

  const block = body.slice(before.length, body.length - after.length);
  const fromPr = block.split('\n').map(parseBlockLine).filter((i) => i && (i.text || i.issue));

  const merged = items.map((i) => ({ ...i }));
  const matched = new Set();

  // A bare `#42` is an issue's line -- or the line of an item whose text is
  // `#42`, which renders identically and has no issue to match on.
  const same = (line) => (m) => (line.issue
    ? m.issue === line.issue || (m.issue == null && oneLine(m.text) === `#${line.issue}`)
    : oneLine(m.text) === line.text);
  const pick = (pred) => merged.findIndex((m, idx) => !matched.has(idx) && belongs(m, number) && pred(m));
  const claim = number == null ? {} : { pr: number };

  for (const line of fromPr) {
    // A line in the body describes an item that is in the body, so an item
    // already flagged inPr wins over a same-text one that is not — otherwise
    // the local-only twin absorbs the match and the real item gets buried.
    const is = same(line);
    let i = pick((m) => is(m) && m.inPr);
    if (i === -1) i = pick(is);
    if (i === -1) merged.push({ ...line, inPr: true, ...claim });
    // Re-adding a line on github.com is how an item comes back from the dead.
    else {
      matched.add(i);
      Object.assign(merged[i], { done: line.done, inPr: true, deleted: false, ...claim });
    }
  }

  // An item we put in the PR body that is no longer there was deleted on
  // GitHub. An empty block means the whole section went, not that every item
  // was struck out one by one, so it is not evidence of anything.
  if (fromPr.length) {
    for (const [idx, m] of merged.entries()) {
      if (m.inPr && !matched.has(idx) && idx < items.length && belongs(m, number)) {
        m.inPr = false;
        m.deleted = true;
      }
    }
  }
  return merged;
}
