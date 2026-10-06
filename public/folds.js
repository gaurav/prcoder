// Folding a pane to its header line. One mechanism for every pane in the
// right-hand column: a class `<pane>-off` on <main> that style.css lays out
// around, and a ▼/▶ button before the pane's title that says which way it is.
//
// Which panes fold is `data-folds` on <main> in index.html, a space-separated
// list read on every call rather than once, so a test can flip one on with a
// single attribute write. The rules for what a fold does to the other panes
// are in app.js, which owns all the listeners; this file only paints.
//
// diff.js imports this and the server imports diff.js, so nothing here may
// touch the DOM at module scope (public/CLAUDE.md).

const NAME = { diff: 'diff', term: 'coding agent', queue: 'queue' };

const main = () => document.querySelector('main');

/** Whether this pane's fold is switched on in index.html. */
export const canFold = (pane) => (main().dataset.folds ?? '').split(/\s+/).includes(pane);

export const folded = (pane) => main().classList.contains(`${pane}-off`);

/** Fold the pane to its bar, or unfold it; the layout is style.css's. */
export function fold(pane, off) {
  main().classList.toggle(`${pane}-off`, off);
  const b = document.getElementById(`${pane}-fold`);
  b.setAttribute('aria-expanded', String(!off));
  b.textContent = off ? '▶︎' : '▼';   // FE0E: text, never macOS's emoji ▶
  b.title = `${off ? 'expand' : 'collapse'} the ${NAME[pane]} pane`;
  b.setAttribute('aria-label', b.title);   // a glyph is no name, as in queue.js
}
