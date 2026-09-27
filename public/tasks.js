// The markdown grammar of a PR description -- checklists, fences, mentions --
// shared by the pane that renders one and the server that reads and writes it.
//
// It lives in one file because a tick is sent as a *position* in the body's
// list of checklist lines. If the two sides disagree about which lines count,
// every index past the first difference addresses the wrong line -- and they
// did disagree, for as long as each walked the body with its own fence rule.

/**
 * A bare `#N` mention: group 2 is the number. The server lists these in the
 * Mentions row and the pane links them in the text, so the two agree by
 * construction. A factory for the same lastIndex reason as fence() below.
 */
export const mention = () => /(^|[\s(])#(\d+)\b/g;

/** The repository a pull request's URL is under, on any host. */
export const repoUrl = (prUrl) => prUrl.replace(/\/pull\/\d+$/, '');

/** The same checklist line GitHub renders as a checkbox. */
export const TASK = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/;

// A factory rather than a constant: a /g regex carries lastIndex between calls.
const fence = () => /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/**
 * HTML comments gone, and every line where it was. The pane renders from this
 * and the server counts and reads checklist lines from it, so a comment can
 * neither hide a task from one side nor change a task's text for one side.
 *
 * `fill` replaces each character of a comment that is not a newline. The pane
 * wants nothing there; the server passes a space so a character offset in the
 * result is still the same offset in the raw line it has to edit.
 */
export const hideComments = (body, fill = '') =>
  body.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, fill));

/**
 * A `<details>` block's `<summary>`, whose first group is its content. GitHub
 * renders that content as the disclosure's label -- inline text, so a `- [ ]`
 * written inside one is no checkbox. The pane turns it into one heading line
 * and the server blanks it, and both have to agree that nothing in it counts.
 */
export const summary = () => /<summary[^>]*>([\s\S]*?)<\/summary>/g;

/**
 * The three pieces of raw HTML a PR description actually contains, dealt with
 * before anything is escaped. Everything else stays escaped and shows as text:
 * this is an allowlist of three, not the beginning of an HTML renderer.
 *
 * Comments go because GitHub hides them and prcoder's own block markers are
 * comments -- without this the pane shows a literal marker above the list it
 * delimits.
 *
 * `<details>` is unwrapped rather than reproduced. It used to be because the
 * pane merely scrolled and a collapsed half was usually history; now it is the
 * better reason: the pane folds its own sections, so an author's fold and
 * prcoder's are the same idea twice. Unwrapping it and promoting its summary to
 * a heading feeds it into that machinery instead of nesting inside it.
 *
 * One consequence, live in this repo: a <details> in a description shows up in
 * the pane as its summary promoted to a level-4 heading, which is deeper than
 * the level sections fold at -- so it renders *inside* whichever fold precedes
 * it rather than as one of its own. That is the intended trade (the alternative
 * is two kinds of fold competing), but it is why a collapsed block in this
 * repo's own pull request description reads differently here and on github.com.
 *
 * This is what the pane shows, and so what the server reads too: taskLines()
 * counts checklist lines in it, toggleTask() reads a box's text from it, and
 * mentions() looks for `#N` in it. A second rule on the server was how a comment
 * mid-line made a box untickable -- the pane sent `fix  the parser` with the
 * comment gone, the server read spaces where it had been, and no refresh could
 * make the two agree.
 *
 * Every substitution here must leave the body's *lines* where they are: a tick
 * is sent as a line's position among the checklist lines, and the server edits
 * the raw body at that line number. A `<details>` tag broken across lines
 * therefore keeps its newlines.
 */
export const withoutHtml = (text) => hideComments(text ?? '')
  .replace(/<\/?details[^>]*>/g, (t) => t.replace(/[^\n]/g, ''))
  // The heading is one line, and the summary's other lines stay behind it empty.
  .replace(summary(), (s, t) =>
    `#### ${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}${'\n'.repeat(s.split('\n').length - 1)}`);

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
  const re = fence();
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
 * The `#N` numbers the pane turns into links, in order: in the shown text, and
 * outside fences and code spans, which is everywhere inline() does not reach.
 * The Mentions row is built from this, so a `Fixes #123` inside a template's
 * comment no longer lists an issue the description never shows.
 */
export function mentions(body = '') {
  return fences(withoutHtml(body)).flatMap((chunk) => (chunk.code != null ? []
    : [...chunk.text.replace(/`[^`]+`/g, '').matchAll(mention())].map(([, , n]) => Number(n))));
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
 *
 * Counted in withoutHtml()'s output, the text the pane counts in, so a task in
 * an HTML comment or a <summary> is no task on either side. Counting the raw
 * body made every pane index one low after a commented-out template task, and
 * since toggleTask checks the text it found against the text the pane sent,
 * the tick did not go to the wrong line: no box in that description could be
 * ticked at all. withoutHtml() keeps every line where it was, so the indices
 * still address the raw body.
 */
export function taskLines(body = '') {
  const shown = withoutHtml(body);
  const fenced = fencedLines(shown);
  return shown.split('\n').flatMap((line, i) => (!fenced.has(i) && TASK.test(line) ? [i] : []));
}

/**
 * The numbers of the lines that sit inside a fence, fence lines included. Takes
 * withoutHtml()'s output, the order the pane uses, so a ``` inside a comment
 * opens nothing.
 */
function fencedLines(visible) {
  const fenced = new Set();
  const lineAt = (index) => visible.slice(0, index).split('\n').length - 1;
  // The same expression fences() matches with, so the two agree by
  // construction rather than by being read side by side.
  const re = fence();
  let m;
  while ((m = re.exec(visible)) !== null) {
    for (let i = lineAt(m.index); i <= lineAt(re.lastIndex - 1); i++) fenced.add(i);
  }
  return fenced;
}
