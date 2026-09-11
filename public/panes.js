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

/**
 * Where a gutter is sitting now, in the same measure a drag would write.
 *
 * Read off the element rather than out of the custom property, because the
 * property is unset until the first drag and the CSS default behind it is a
 * percentage inside a clamp() -- so there is nothing there to add ten pixels to
 * until someone has already dragged once.
 */
const at = (r, from, g) => {
  const b = g.getBoundingClientRect();
  return { left: b.left - r.left, top: b.top - r.top, bottom: r.bottom - b.bottom }[from];
};

for (const g of document.querySelectorAll('.gut')) {
  const { var: name, from } = g.dataset;
  const along = from === 'left' ? 'width' : 'height';

  // What a screen reader can say about a line that has no text: how far along
  // <main> it sits. The clamp() bounds are a percentage and two pixel values in
  // the stylesheet, so the honest pair to publish is 0 and 100 of the container
  // and let valuenow be the position within it.
  const report = () => {
    const r = main.getBoundingClientRect();
    g.setAttribute('aria-valuenow', String(Math.round((at(r, from, g) / r[along]) * 100)));
  };
  report();
  new ResizeObserver(report).observe(g);

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

  // These were pointer-only: role="separator" on something with nothing to
  // focus and no key that did anything, so a keyboard could not resize or reset
  // a pane at all. Arrows nudge, shift nudges further, Home is the double-click.
  //
  // `grows` is which way the pane's own edge runs: the queue grows *upward*
  // from the bottom of <main>, so pressing Down there has to make its number
  // smaller, or the separator would walk the wrong way from under the key.
  const grows = from === 'bottom' ? -1 : 1;
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Home') {
      e.preventDefault();
      main.style.removeProperty(name);
      return save();
    }
    const towards = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!towards) return;
    e.preventDefault();
    const r = main.getBoundingClientRect();
    const step = (e.shiftKey ? 50 : 10) * towards * grows;
    main.style.setProperty(name, `${Math.round(at(r, from, g) + step)}px`);
    save();
  });
}
