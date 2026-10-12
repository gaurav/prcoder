// Keyboard shortcuts, in one place. Register a binding here, through bindKeys
// in app.js, rather than with a keydown listener beside the thing it drives,
// so the rules below hold for every shortcut the page ever gains:
//
// - Nothing fires while typing. The coding agent's terminal is an xterm
//   textarea and every key pressed in it belongs to the agent; the queue's
//   input is a textarea and its items are contentEditable. A shortcut that
//   fired in any of them would steal a character from what was being typed.
//   An input that takes no text is not typing, though: a checkbox keeps focus
//   after it is clicked, so counting it would leave Alt+W dead after a tick
//   of *viewed*, which is the usual thing to do just before reading on.
//   The exception is the terminal: a binding written `{ fn, terminal }` fires
//   from there too while its `terminal()` says it has something to do
//   (bindKeys says how), since the loop the keys serve -- read a file, ask the
//   agent about it, next file -- ends in the terminal. Every binding in
//   app.js's table has one.
// - A binding names a physical key (`e.code`, Alt+KeyW), not what it types:
//   on macOS Option+W types ∑, and on other layouts Alt+letter types other
//   things again, while the key itself stays where it is.
// - A held key fires once. Its repeats are taken and dropped, so holding
//   Alt+M a moment too long does not type the mention over and over into the
//   agent's prompt, and holding Alt+W does not flicker the wrap.
// - Modifiers are spelled in a fixed order, Ctrl+Alt+Shift+Meta, so a binding
//   is a plain string with one spelling.
//
// This file loads only in the browser; nothing on the server imports it.

/** The inputs nothing is typed into, which a shortcut may fire from. */
const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range']
  .map((t) => `[type=${t}]`).join(', ');

/** Whether a key pressed on `target` is text being typed, and so not ours. */
export const isTyping = (target) => target instanceof Element
  && (target.closest(`input:not(${NOT_TEXT}), textarea, select, [contenteditable]`) != null);

/**
 * A binding's name as the shortcut sheet shows it: `Alt+KeyV` is `Alt+V`, or
 * `⌥V` on a Mac, where the key is Option and is drawn as its symbol. Only
 * the codes a binding here has ever used are spelled; any other is shown as
 * it is, which is wrong-looking enough to be fixed at once.
 */
const CODE = { Slash: '/', Comma: ',', Period: '.', Enter: '↩', Space: '␣', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const MOD = { Ctrl: ['Ctrl', '⌃'], Alt: ['Alt', '⌥'], Shift: ['Shift', '⇧'], Meta: ['Win', '⌘'] };
export function keyLabel(name, mac = false) {
  const parts = name.split('+');
  const code = parts.pop();
  const key = CODE[code] ?? code.replace(/^(Key|Digit)/, '');
  const mods = parts.map((m) => MOD[m]?.[mac ? 1 : 0] ?? m);
  return mac ? [...mods, key].join('') : [...mods, key].join('+');
}

/** The name a keydown event binds under: its modifiers, then its physical key. */
export const keyName = (e) => [
  e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code,
].filter(Boolean).join('+');

/**
 * Install the page's shortcuts: `{ 'Alt+KeyW': () => ... }`. A bound key that
 * is not being typed runs its handler and goes no further, so the browser does
 * not also act on it. A binding written `{ fn, terminal }` fires from `term`,
 * the agent's xterm, as well, whenever `terminal()` says it has something to
 * do. When it says no, the key goes to the agent as if it were not bound, so
 * the agent loses the key only while the shortcut would actually do something.
 */
export function bindKeys(map, term) {
  const fnOf = (binding) => (typeof binding === 'function' ? binding : binding?.fn);
  document.addEventListener('keydown', (e) => {
    const fn = fnOf(map[keyName(e)]);
    if (!fn || isTyping(e.target)) return;
    e.preventDefault();
    if (!e.repeat) fn(e);
  });
  // xterm reads a key before the page does, so a terminal binding is hooked
  // into xterm. Returning false there makes xterm leave the key alone: it
  // neither types it nor stops it, so the keydown still bubbles up to the
  // listener above. That listener ignores it only because its target is
  // xterm's textarea, which isTyping counts as typing. That is what keeps one
  // press from firing twice, so isTyping must keep counting the terminal.
  //
  // A key pressed in the middle of an IME composition is left to xterm, whose
  // composition helper runs after this hook: taken here, the mention would
  // reach the agent ahead of the text still being composed. So is every
  // keyup, which only resets xterm's own state (its cursor style, and whether
  // a keypress was handled), and which xterm skips entirely on a false.
  term.attachCustomKeyEventHandler((e) => {
    const binding = map[keyName(e)];
    if (e.type === 'keyup' || e.isComposing || !binding?.terminal?.()) return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      if (!e.repeat) binding.fn(e);
    }
    return false;
  });
}
