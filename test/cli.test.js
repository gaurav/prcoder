import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs } from '../server.js';

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
