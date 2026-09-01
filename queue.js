// The PR description's half of the queue: the `<!-- prcoder:todo -->` block,
// and the markdown checklist grammar it shares with FUTURE.md.
//
// The queue itself lives in .prcoder/queue.json (see store.js) and an item is
// { text, done, inPr, issue, deleted, branch }. `inPr` mirrors it into the PR
// description; `issue` links it to a GitHub issue. An item can be both, in
// which case the PR line becomes a bare #N reference — that is the "converting
// to an issue replaces the PR line" rule. `deleted` is a tombstone: deleting an
// item here or on github.com keeps the record, so nothing the user typed
// disappears without somewhere to get it back.
//
// parseFuture is the one thing here that still reads FUTURE.md, for the
// one-time import in server.js. Nothing writes that file.

const HEADING = '## Queue';
const OPEN = '<!-- prcoder:todo -->';
const CLOSE = '<!-- /prcoder:todo -->';

const ITEM = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/;

// Anchored, so the first token it cannot match ends the marker run and
// everything from there -- including any later markers -- becomes visible task
// text. It fails quietly rather than throwing, and it has caught two things:
// a new marker has to be added to this alternation before it can be read, and
// a malformed value like `@issue#NaN` does not match `@issue#\d+` and so turns
// into part of the item's text. Anything written into a marker must be a value
// this pattern accepts; see issueNumber() in github.js.
const MARKERS = /^((?:@pr\b|@deleted\b|@issue#\d+\b|\s)*)/;

function parseItem(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const done = m[1].toLowerCase() === 'x';
  const rest = m[2].trim();

  const markers = MARKERS.exec(rest)[1];
  const text = rest.slice(markers.length).trim();
  const issue = /@issue#(\d+)/.exec(markers);

  // A PR-body line for an item that became an issue is just "#42".
  const bare = /^#(\d+)$/.exec(text);
  if (bare) return { text: '', done, inPr: true, issue: Number(bare[1]), deleted: false };

  return {
    text, done,
    inPr: /@pr\b/.test(markers),
    issue: issue ? Number(issue[1]) : null,
    deleted: /@deleted\b/.test(markers),
  };
}

/**
 * One line of the PR description's block. Markers (`@pr`, `@issue#42`) are only
 * ever read now, never written: they were how FUTURE.md encoded the fields the
 * store keeps as fields, and the block itself has never carried them.
 */
function renderItem(item) {
  return `- [${item.done ? 'x' : ' '}] ${item.issue ? `#${item.issue}` : item.text}`;
}

/**
 * Items out of FUTURE.md, for the one-time import into the store. Anything
 * outside the `## Queue` section is ignored, and the file is never written.
 */
export function parseFuture(text) {
  const items = [];
  let inSection = false;
  for (const line of (text ?? '').split('\n')) {
    if (/^##\s/.test(line)) { inSection = line.trim() === HEADING; continue; }
    if (!inSection) continue;
    const item = parseItem(line);
    if (item && (item.text || item.issue)) items.push(item);
  }
  return items;
}

/**
 * Replace the prcoder block in a PR body. Items live there when `inPr`; an
 * item that is also an issue renders as a bare `#N` so GitHub links it.
 */
export function renderPrBlock(items, body = '') {
  const mine = items.filter((i) => i.inPr && !i.deleted);
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
 * checklist lines and then checked against the text the client saw: the client
 * counts those lines with its own copy of this pattern, so a body that moved
 * on -- or a renderer that has drifted from this one -- fails loudly instead of
 * ticking the line next door. (A `- [ ]` inside a fenced code block counts as a
 * checkbox to both of them, which is wrong in the same way on both sides.)
 *
 * `inBlock` says whether the line is one of ours: those are a projection of
 * FUTURE.md and the tick has to be folded back into it, and the caller is the
 * only one that can write files.
 */
export function toggleTask(body, index, done, expected) {
  const lines = (body ?? '').split('\n');
  const at = lines.reduce((acc, l, i) => (ITEM.test(l) ? [...acc, i] : acc), [])[index];
  if (at === undefined) throw new Error('that checkbox is no longer in the description -- refresh');

  const text = ITEM.exec(lines[at])[2].trim();
  if (text !== (expected ?? '').trim()) {
    throw new Error(`the description changed under that checkbox (now "${text}") -- refresh`);
  }
  // ITEM anchors the box at the start of the line, so the first [ ] is it.
  lines[at] = lines[at].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');

  const open = lines.findIndex((l) => l.includes(OPEN));
  const close = lines.findIndex((l) => l.includes(CLOSE));
  return {
    body: lines.join('\n'),
    inBlock: open !== -1 && at > open && (close === -1 || at < close),
  };
}

/**
 * indexOf, so the *first* marker wins. That makes a literal `<!-- prcoder:todo
 * -->` written into the description's prose — a sentence about how prcoder
 * works — read as the start of the block, and the next write replaces
 * everything from there to the real closing marker. See CLAUDE.md; anchoring
 * these to their own line would close it, at the cost of a migration for every
 * body already written with the markers where they are.
 */
function splitPrBlock(body = '') {
  const start = body.indexOf(OPEN);
  if (start === -1) return { before: body, after: '', found: false };
  const end = body.indexOf(CLOSE, start);
  return {
    before: body.slice(0, start),
    after: end === -1 ? '' : body.slice(end + CLOSE.length),
    found: true,
  };
}

/**
 * Fold edits made to the PR description on github.com back into the queue, so
 * ticking a box or adding a line from another machine survives.
 *
 * ponytail: last-write-wins, no conflict detection. Single user, single PR —
 * add real merging only if simultaneous edits actually bite.
 */
export function syncFromPrBlock(items, body = '') {
  const { before, after, found } = splitPrBlock(body);
  if (!found) return items;

  const block = body.slice(before.length, body.length - after.length);
  const fromPr = block.split('\n').map(parseItem).filter((i) => i && (i.text || i.issue));

  const merged = items.map((i) => ({ ...i }));
  const matched = new Set();

  const same = (line) => (m) => (line.issue ? m.issue === line.issue : m.text === line.text);
  const pick = (pred) => merged.findIndex((m, idx) => !matched.has(idx) && pred(m));

  for (const line of fromPr) {
    // A line in the body describes an item that is in the body, so an item
    // already flagged inPr wins over a same-text one that is not — otherwise
    // the local-only twin absorbs the match and the real item gets buried.
    const is = same(line);
    let i = pick((m) => is(m) && m.inPr);
    if (i === -1) i = pick(is);
    if (i === -1) merged.push({ ...line, inPr: true });
    // Re-adding a line on github.com is how an item comes back from the dead.
    else { matched.add(i); merged[i].done = line.done; merged[i].inPr = true; merged[i].deleted = false; }
  }

  // An item we put in the PR body that is no longer there was deleted on
  // GitHub. An empty block means the whole section went, not that every item
  // was struck out one by one, so it is not evidence of anything.
  if (fromPr.length) {
    for (const [idx, m] of merged.entries()) {
      if (m.inPr && !matched.has(idx) && idx < items.length) { m.inPr = false; m.deleted = true; }
    }
  }
  return merged;
}
