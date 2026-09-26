// One checkbox flipped in a PR description: the only edit prcoder makes to one,
// and only when you tick a box in the PR pane.
//
// The queue itself lives in .prcoder/queue.json (see store.js) and an item is
// { text, done, doneAt, issue, deleted }. It is yours and it stays local:
// nothing here reads a description into the queue or writes the queue into a
// description. `issue` links an item to a GitHub issue filed from it, and
// `deleted` is a tombstone, so nothing typed disappears without somewhere to
// get it back.

import { TASK, taskLines, hideComments } from './public/tasks.js';

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
