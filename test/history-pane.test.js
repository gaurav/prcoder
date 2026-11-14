// The History tab's vocabulary: how prompts are grouped by day and session,
// what a day is called, and what is marked as a command. The reading of the
// file itself is test/history.test.js; this is the page's half, pure in
// public/items.js so it runs here without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayLabel, timeLabel, byDay, commandOf, historyMatches } from '../public/items.js';

// Local times, built with the Date constructor so the test means the same
// in every zone: a Saturday noon, and prompts around it.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 7);   // Saturday

test('a day is Today, Yesterday, a weekday within the week, then a date', () => {
  assert.equal(dayLabel(at(2026, 11, 7, 0, 1), NOW), 'Today');
  assert.equal(dayLabel(at(2026, 11, 7, 23, 59), NOW), 'Today');
  assert.equal(dayLabel(at(2026, 11, 6, 23, 59), NOW), 'Yesterday');
  assert.equal(dayLabel(at(2026, 11, 6, 0, 0), NOW), 'Yesterday');
  assert.equal(dayLabel(at(2026, 11, 5), NOW), 'Thursday');
  assert.equal(dayLabel(at(2026, 11, 1), NOW), 'Sunday');
  // A week ago is the same weekday as today, so it is written as a date.
  assert.equal(dayLabel(at(2026, 10, 31), NOW), 'Sat, Oct 31');
  assert.equal(dayLabel(at(2026, 10, 28), NOW), 'Wed, Oct 28');
  assert.equal(dayLabel(at(2025, 12, 24), NOW), 'Wed, Dec 24, 2025');
  // A clock put back: not negative days, a date.
  assert.equal(dayLabel(at(2026, 11, 9), NOW), 'Mon, Nov 9');
});

test('the day key sorts as it reads, and the time is a 24-hour clock', () => {
  assert.equal(dayKey(at(2026, 11, 7, 0, 0)), '2026-11-07');
  assert.equal(dayKey(at(2026, 1, 9, 23, 59)), '2026-01-09');
  assert.equal(timeLabel(at(2026, 11, 7, 21, 14)), '21:14');
  assert.equal(timeLabel(at(2026, 11, 7, 0, 5)), '00:05');
  assert.equal(timeLabel(at(2026, 11, 7, 9, 0)), '09:00');
});

const S1 = 'session-one';
const S2 = 'session-two';
const p = (text, time, session = S1) => ({ at: time, text, session, where: '' });

test('byDay groups newest day first, then by session in the order of its newest prompt', () => {
  const prompts = [
    p('old', at(2026, 11, 5, 9)),
    p('late last night', at(2026, 11, 6, 23, 50), S2),
    p('after midnight', at(2026, 11, 7, 0, 10), S2),
    p('this morning', at(2026, 11, 7, 9, 0)),
    p('this afternoon', at(2026, 11, 7, 14, 0)),
    p('no session', at(2026, 11, 7, 10, 0), null),
  ];
  const days = byDay(prompts, NOW);
  assert.deepEqual(days.map((d) => [d.key, d.label]), [['2026-11-07', 'Today'], ['2026-11-06', 'Yesterday'], ['2026-11-05', 'Thursday']]);
  const today = days[0].sessions.map((s) => [s.id, s.rows.map((r) => r.text)]);
  assert.deepEqual(today, [
    [S1, ['this afternoon', 'this morning']],
    [null, ['no session']],
    [S2, ['after midnight']],
  ]);
  // The session that ran past midnight is under both days.
  assert.deepEqual(days[1].sessions.map((s) => [s.id, s.rows.map((r) => r.text)]), [[S2, ['late last night']]]);
  assert.deepEqual(byDay([], NOW), []);
  // The order of the input does not matter: the file's order is the server's business.
  assert.deepEqual(byDay([...prompts].reverse(), NOW).map((d) => d.key), days.map((d) => d.key));
});

test('a prompt that starts with a slash command is marked by that command', () => {
  assert.equal(commandOf('/code-review high'), '/code-review');
  assert.equal(commandOf('  /pr-update'), '/pr-update');
  assert.equal(commandOf('/wrap\nand then some'), '/wrap');
  assert.equal(commandOf('/plugin:skill args'), '/plugin:skill');
  assert.equal(commandOf('fix /tmp/thing'), null);
  assert.equal(commandOf('/ not a command'), null);
  assert.equal(commandOf('//comment'), null);
  assert.equal(commandOf(''), null);
  assert.equal(commandOf(undefined), null);
});

test('the search is case-blind over the text, and nothing matches everything', () => {
  const row = p('Fix the Thing', 1);
  assert.equal(historyMatches(row, 'thing'), true);
  assert.equal(historyMatches(row, 'THE t'), true);
  assert.equal(historyMatches(row, 'other'), false);
  assert.equal(historyMatches(row, '  '), true);
  assert.equal(historyMatches(row, undefined), true);
  assert.equal(historyMatches({ at: 1 }, 'x'), false);
});
