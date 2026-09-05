// The markdown checklist grammar, shared by the pane that renders a PR
// description and the server that writes back to it.
//
// It lives in one file because a tick is sent as a *position* in the body's
// list of checklist lines. If the two sides disagree about which lines count,
// every index past the first difference addresses the wrong line -- and they
// did disagree, for as long as each walked the body with its own fence rule.

/** The same checklist line GitHub renders as a checkbox. */
export const TASK = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/;

/**
 * The body cut into fenced blocks and the text between them, in order. Fences
 * come out before paragraphs are split on blank lines, because a fence is
 * allowed to contain them.
 *
 * A fence is a *pair*. An opener with no closer is a stray backtick, not a
 * block that swallows everything after it: a description is prose someone is
 * still editing, and blanking the rest of the pane over one typo is worse than
 * rendering a line of it as prose.
 */
export function fences(body) {
  const out = [];
  const re = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push({ text: body.slice(last, m.index) });
    out.push({ code: m[1].replace(/\n$/, '') });
    last = re.lastIndex;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/**
 * The indices of the body's checklist lines, in the order a tick counts them.
 *
 * Fenced lines are skipped: a `- [ ]` in a fence is a sample, not a task, and
 * this repo's own README and description each contain one. The pair rule above
 * is the whole reason this is derived from fences() rather than walked
 * separately -- a second walk toggling on every ``` counts the lines after an
 * unterminated one as code, where the pane counts them as prose, and the two
 * lists then disagree from that point on.
 */
export function taskLines(body = '') {
  const fenced = new Set();
  const lineAt = (index) => body.slice(0, index).split('\n').length - 1;
  // The same expression fences() matches with, so the two agree by
  // construction rather than by being read side by side.
  const re = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (let i = lineAt(m.index); i <= lineAt(re.lastIndex - 1); i++) fenced.add(i);
  }
  return body.split('\n').flatMap((line, i) => (!fenced.has(i) && TASK.test(line) ? [i] : []));
}
