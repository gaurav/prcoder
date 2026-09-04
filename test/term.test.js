import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sink, status, log, paint } from '../term.js';

/** A stand-in for process.stdout, so the tty path can be exercised anywhere. */
function fake(isTTY, columns = 40, rows = 24) {
  const out = { isTTY, columns, rows, text: '', write(s) { this.text += s; return true; } };
  sink(out);
  return out;
}

// The bookkeeping that actually breaks: `painted` has to match the rows the
// block occupies, or the erase walks up the wrong number of lines and either
// eats a log line or leaves half a block behind.
test('a log line erases exactly the block it is written above', () => {
  const out = fake(true);
  status(['a', 'b']);
  out.text = '';
  log('x');
  // Two status lines plus the rule; erased, the line written, the block redrawn.
  assert.match(out.text, /^\x1b\[3F\x1b\[0Jx\n/);
  assert.equal(out.text.split('a').length - 1, 1, 'block redrawn exactly once');
});

// CSI 0 F is coerced to 1 by most terminals, so an erase with nothing painted
// would walk up into the scrollback and delete a line of it every time.
test('nothing painted means no cursor movement at all', () => {
  const out = fake(true);
  log('first');   // before any status(): no block yet, so nothing to erase
  assert.equal(out.text, 'first\n');
});

// The whole non-tty contract: the shot driver and any pipe get plain lines.
test('without a tty there are no escape sequences and no block', () => {
  const out = fake(false);
  status(['a', 'b']);
  log('x');
  paint();
  assert.equal(out.text, 'x\n');
});

// A footer line that wraps makes `painted` a lie for every erase after it.
test('block lines are cut to the width, so one line stays one row', () => {
  const out = fake(true, 20);
  status(['x'.repeat(80)]);
  for (const line of out.text.split('\n')) {
    assert.ok(line.replaceAll(/\x1b\[[\d?]*[A-Za-z]/g, '').length < 20, line.length);
  }
});
