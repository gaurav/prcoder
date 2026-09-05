// Dragging the lines between the panes. Each gutter owns one CSS length that
// style.css reads out of <main>, so the whole feature is: write a number, let
// the grid do the layout.

const main = document.querySelector('main');
const KEY = 'prcoder:panes';

// The inline style *is* the state — nothing else writes to it, so persisting it
// whole needs no parallel copy and no parsing. A garbled stored value costs
// nothing either: the CSS parser drops declarations it cannot read. Both ends
// are wrapped because a browser can refuse the store outright (Safari's private
// mode throws on write), and a pane preference must not take the terminal with
// it — the import in app.js is what would fail.
let stored = null;
try { stored = localStorage.getItem(KEY); } catch { /* no store, no memory */ }
main.style.cssText = stored ?? '';
const save = () => {
  try { localStorage.setItem(KEY, main.style.cssText); } catch { /* as above */ }
};

/** Pointer position as a distance from the edge of <main> the pane grows from. */
const px = (r, from, e) => ({
  left: e.clientX - r.left,
  top: e.clientY - r.top,
  bottom: r.bottom - e.clientY,
}[from]);

for (const g of document.querySelectorAll('.gut')) {
  const { var: name, from } = g.dataset;

  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();   // or the drag selects text across the panes
    // <main> fills the window, so its box cannot move mid-drag.
    const r = main.getBoundingClientRect();
    const move = (m) => main.style.setProperty(name, `${Math.round(px(r, from, m))}px`);
    g.setPointerCapture(e.pointerId);
    g.addEventListener('pointermove', move);
    // Fires for a cancelled drag as well as a released one, so the move
    // listener is never left attached to a gutter nobody is holding.
    g.addEventListener('lostpointercapture', () => {
      g.removeEventListener('pointermove', move);
      save();
    }, { once: true });
  });

  // The way back out of a corner: drop to the template's own default.
  g.addEventListener('dblclick', () => {
    main.style.removeProperty(name);
    save();
  });
}
