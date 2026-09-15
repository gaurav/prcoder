import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows } from '../public/diff.js';

test('diff lines are classified by their leading character', () => {
  const rows = diffRows('@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n\\ No newline at end of file');
  assert.deepEqual(rows.map((r) => r.cls), ['hunk', 'ctx', 'del', 'add', 'ctx']);
  assert.equal(rows[3].text, '+new');
});
