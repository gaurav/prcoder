// Keyboard shortcuts, in one place. Register a binding here, through bindKeys
// in app.js, rather than with a keydown listener beside the thing it drives,
// so the rules below hold for every shortcut the page ever gains:
//
// - Nothing fires while typing. The coding agent's terminal is an xterm
//   textarea and every key pressed in it belongs to the agent; the queue's
//   input is a textarea and its items are contentEditable. A shortcut that
//   fired in any of them would steal a character from what was being typed.
// - A binding names a physical key (`e.code`, Alt+KeyW), not what it types:
//   on macOS Option+W types ∑, and on other layouts Alt+letter types other
//   things again, while the key itself stays where it is.
// - Modifiers are spelled in a fixed order, Ctrl+Alt+Shift+Meta, so a binding
//   is a plain string with one spelling.
//
// This file loads only in the browser; nothing on the server imports it.

/** Whether a key pressed on `target` is text being typed, and so not ours. */
export const isTyping = (target) => target instanceof Element
  && (target.closest('input, textarea, select, [contenteditable]') != null);

/** The name a keydown event binds under: its modifiers, then its physical key. */
export const keyName = (e) => [
  e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code,
].filter(Boolean).join('+');

/**
 * Install the page's shortcuts: `{ 'Alt+KeyW': () => ... }`. A bound key that
 * is not being typed runs its handler and goes no further, so the browser does
 * not also act on it.
 */
export function bindKeys(map) {
  document.addEventListener('keydown', (e) => {
    const fn = map[keyName(e)];
    if (!fn || isTyping(e.target)) return;
    e.preventDefault();
    fn(e);
  });
}
