// The markdown checklist a queue item leaves for and the PR pane ticks: lines
// appended to a PR description, and one checkbox flipped in it.
//
// The queue itself lives in .prcoder/queue.json (see store.js) and an item is
// { text, done, issue, deleted }. It is yours and it stays local: moving an item
// to the PR description or an issue is one-way, written there and taken off the
// list (moveOut in server.js), and nothing here reads a description back into
// the queue. `deleted` is a tombstone, so nothing typed disappears without
// somewhere to get it back.

import { TASK, taskLines, hideComments } from './public/tasks.js';

/**
 * An item's text as one checklist line. A line cannot hold a newline, and the
 * queue input takes one on Shift-Enter -- written raw, the rest of the item would
 * become lines of prose under the checkbox.
 */
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * `texts` appended to a description as unticked checklist lines. Directly under
 * a checklist that already ends the body, so the two read as one list; after a
 * blank line otherwise, so a line of prose above does not swallow the first.
 */
export function appendTasks(body, texts) {
  const lines = texts.map((t) => `- [ ] ${oneLine(t)}`).join('\n');
  const trimmed = (body ?? '').trimEnd();
  if (!trimmed) return `${lines}\n`;
  return `${trimmed}${TASK.test(trimmed.split('\n').at(-1)) ? '\n' : '\n\n'}${lines}\n`;
}

/**
 * Flip one checkbox in a PR description, so the boxes rendered in the PR pane
 * are the real ones. The line is found by its position among the body's
 * checklist lines -- counted by the same taskLines() the pane counts with --
 * and then checked against the text the client saw, so a body that moved on
 * fails loudly instead of ticking the line next door. Answers the new body.
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
  return lines.join('\n');
}
