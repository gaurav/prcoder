import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, portFor } from '../server.js';

test('a leading positional is our PR target, the rest is Claude\'s', () => {
  assert.deepEqual(splitArgs([]), { target: undefined, claudeArgs: [] });
  assert.deepEqual(splitArgs(['123']), { target: '123', claudeArgs: [] });
  assert.deepEqual(splitArgs(['123', '--model', 'opus']), { target: '123', claudeArgs: ['--model', 'opus'] });
});

// The one that matters: a flag's value must not be mistaken for a PR target.
test('flag values are never read as a PR target', () => {
  assert.deepEqual(splitArgs(['--effort', 'high', '--model', 'opus']),
    { target: undefined, claudeArgs: ['--effort', 'high', '--model', 'opus'] });
  assert.deepEqual(splitArgs(['-r']), { target: undefined, claudeArgs: ['-r'] });
});

// The URL has to be the same every run for a bookmark, a Dock app or an IDE
// pane to point at it; and two repos on one machine must not share it.
test('the port is a fixed function of the repo path', () => {
  const a = portFor('/Users/x/code/prcoder', {});
  assert.equal(a, portFor('/Users/x/code/prcoder', {}));
  assert.ok(a >= 1618 && a < 2618, `${a} out of range`);
  assert.notEqual(a, portFor('/Users/x/code/other', {}));
  assert.equal(portFor('/anything', { PRCODER_PORT: '4000' }), 4000);
});
