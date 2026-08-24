// The queue lives in FUTURE.md as a plain markdown checklist, so it stays
// hand-editable and `git diff`-able. An item records where it lives:
//
//   { text, done, inPr, issue, deleted }
//
// `inPr` mirrors it into the PR description; `issue` links it to a GitHub
// issue. An item can be both, in which case the PR line becomes a bare #N
// reference — that is the "converting to an issue replaces the PR line" rule.
// `deleted` is a tombstone: deleting an item here or on github.com keeps the
// line, so nothing the user typed disappears without somewhere to get it back.

const HEADING = '## Queue';
const OPEN = '<!-- prcoder:todo -->';
const CLOSE = '<!-- /prcoder:todo -->';

const ITEM = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/;
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

function renderItem(item, { markers = true } = {}) {
  const box = item.done ? 'x' : ' ';
  if (!markers) return `- [${box}] ${item.issue ? `#${item.issue}` : item.text}`;
  const tags = [item.inPr && '@pr', item.deleted && '@deleted',
    item.issue && `@issue#${item.issue}`].filter(Boolean);
  return `- [${box}] ${[...tags, item.text].join(' ')}`.trimEnd();
}

/** Items from FUTURE.md. Anything outside the `## Queue` section is ignored here. */
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
 * Write items back into FUTURE.md, preserving every other section — the file
 * is often already in use for longhand notes.
 */
export function renderFuture(items, existing = '') {
  const section = [HEADING, '', ...items.map((i) => renderItem(i)), ''].join('\n');
  const lines = (existing ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === HEADING);
  if (start === -1) {
    const head = (existing ?? '').trim();
    return (head ? `${head}\n\n` : '') + section;
  }
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...section.split('\n'), ...lines.slice(end)].join('\n');
}

/**
 * Replace the prcoder block in a PR body. Items live there when `inPr`; an
 * item that is also an issue renders as a bare `#N` so GitHub links it.
 */
export function renderPrBlock(items, body = '') {
  const mine = items.filter((i) => i.inPr && !i.deleted);
  const block = mine.length
    ? [OPEN, '## TODO', '', ...mine.map((i) => renderItem(i, { markers: false })), CLOSE].join('\n')
    : '';

  const { before, after, found } = splitPrBlock(body);
  if (!found) return block ? `${before.trimEnd()}\n\n${block}\n`.trimStart() : before;
  const joined = `${before.trimEnd()}\n\n${block}\n${after.trimStart()}`;
  return (block ? joined : `${before.trimEnd()}\n${after.trimStart()}`).trim() + '\n';
}

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

  for (const line of fromPr) {
    const i = merged.findIndex((m, idx) => !matched.has(idx) &&
      (line.issue ? m.issue === line.issue : m.text === line.text));
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
