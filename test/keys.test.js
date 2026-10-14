import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLabel, keyName } from '../public/keys.js';

// The shortcut sheet shows a binding's name as the reader's keyboard has it:
// the key, not the code, and on a Mac the Option symbol, since that is what
// the key is called there (docs/Panes.md says Alt is Option).
test('a binding is shown as its key, with Alt on a PC and ⌥ on a Mac', () => {
  assert.equal(keyLabel('Alt+KeyV'), 'Alt+V');
  assert.equal(keyLabel('Alt+KeyV', true), '⌥V');
  assert.equal(keyLabel('Alt+Slash'), 'Alt+/');
  assert.equal(keyLabel('Alt+Slash', true), '⌥/');
  assert.equal(keyLabel('Ctrl+Alt+Shift+Digit2'), 'Ctrl+Alt+Shift+2');
  assert.equal(keyLabel('Ctrl+Alt+Shift+Digit2', true), '⌃⌥⇧2');
  assert.equal(keyLabel('Alt+ArrowDown'), 'Alt+↓');
  // A code with no spelling here is shown as the code, which is wrong enough to notice.
  assert.equal(keyLabel('Alt+Backquote'), 'Alt+Backquote');
});

test('a label round-trips the name a keydown binds under', () => {
  const e = { altKey: true, code: 'KeyX' };
  assert.equal(keyLabel(keyName(e)), 'Alt+X');
});
