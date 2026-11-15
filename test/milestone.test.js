// The milestone viewer's rules: how a row's priority and effort are read from
// its labels, the order a milestone is worked in, how the pull request on
// screen stands to the milestone being looked at, and which kinds are listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_KINDS, labelValue, isValueLabel, effortGuess, sections, viewingFor, standing, kindsFrom, kindsText, flipKind, tally, tallyLabel, milestoneChoices } from '../public/milestone.js';

// LABELS.md in gaurav/milestones, as read on 2026-11-15 (d46781d): the two
// tables' values in their order. A change there is a change here, by hand.
test('the label table is LABELS.md\'s, most pressing and largest first', () => {
  assert.deepEqual(LABEL_KINDS.priority.options, ['Urgent', 'High', 'Medium', 'Low']);
  assert.deepEqual(LABEL_KINDS.effort.options, ['XL', 'L', 'M', 'S', 'XS']);
  for (const kind of Object.values(LABEL_KINDS)) {
    assert.deepEqual([...new Set(Object.values(kind.values))].sort(), [...kind.options].sort(), 'every spelling means one of the options');
  }
});

test('a priority or an effort is read from its label, the older spellings too', () => {
  assert.deepEqual(labelValue('priority', ['bug', 'Priority: High']), { label: 'Priority: High', value: 'High', old: false });
  assert.deepEqual(labelValue('effort', ['Effort: XS']), { label: 'Effort: XS', value: 'XS', old: false });
  assert.deepEqual(labelValue('priority', ['priority:high']), { label: 'priority:high', value: 'High', old: true }, 'not the standard spelling');
  // What LABELS.md says to read: Critical is Urgent, Size is Effort, and an
  // effort of High, Medium or Low is L, M or S.
  assert.equal(labelValue('priority', ['Priority: Critical']).value, 'Urgent');
  assert.deepEqual(labelValue('effort', ['Size: M']), { label: 'Size: M', value: 'M', old: true });
  assert.deepEqual(['High', 'Medium', 'Low', 'small', 'Large'].map((v) => labelValue('effort', [`Effort: ${v}`]).value), ['L', 'M', 'S', 'S', 'L']);
  assert.equal(labelValue('priority', ['Effort: High']), null, 'an effort says nothing about priority');
  assert.equal(labelValue('priority', []), null);
  assert.equal(labelValue('priority', undefined), null);
  assert.equal(labelValue('priority', ['Priority: whenever']), null, 'a value the table does not know is no value');
});

test('the standard label stands over an older one that disagrees', () => {
  assert.deepEqual(labelValue('effort', ['Size: L', 'Effort: S']), { label: 'Effort: S', value: 'S', old: false });
  assert.deepEqual(labelValue('priority', ['Priority: Critical', 'Priority: Low']), { label: 'Priority: Low', value: 'Low', old: false });
});

test('a label the headings already say is left off a row, and any other is not', () => {
  assert.deepEqual(['Priority: High', 'Size: M', 'effort: xl', 'bug', 'Priority: whenever', 'priority'].map(isValueLabel),
    [true, true, true, false, false, false]);
});

test('a pull request\'s effort is guessed from its size, in the size chip\'s bands', () => {
  assert.deepEqual([0, 49, 50, 150, 499, 999, 1000, 50000].map(effortGuess), ['XS', 'XS', 'S', 'M', 'L', 'XL', 'XL', 'XL']);
});

const row = (number, labels, updatedAt = '2026-11-01T00:00:00Z') => ({ number, labels, updatedAt });

test('a milestone is ordered by priority, then effort, the unjudged after the judged', () => {
  const got = sections([
    row(1, []),
    row(2, ['Priority: Low', 'Effort: XS']),
    row(3, ['Priority: High', 'Effort: S']),
    row(4, ['Priority: High', 'Effort: XL']),
    row(5, ['Priority: High']),
    row(6, ['Effort: M']),
    row(7, ['Priority: Urgent', 'Effort: M']),
    row(8, ['Priority: High', 'Size: S'], '2026-11-09T00:00:00Z'),
  ]);
  assert.deepEqual(got.map((s) => [s.parts.map((p) => p.text).join(' · '), s.items.map((i) => i.row.number)]), [
    ['Urgent · M', [7]],
    ['High · XL', [4]],
    // The more recently updated first within a group.
    ['High · S', [8, 3]],
    ['High · No effort', [5]],
    ['Low · XS', [2]],
    ['No priority · M', [6]],
    ['No priority · No effort', [1]],
  ]);
  // A part's level is its value's place in its scale, from 1; 0 is unset.
  assert.deepEqual(got.map((s) => s.parts.map((p) => p.level)), [[1, 3], [2, 1], [2, 4], [2, 0], [4, 5], [0, 3], [0, 0]]);
  assert.equal(got[2].items[0].effort.old, true, 'what was read comes with the row, for the row to say');
  assert.deepEqual(sections([]), []);
});

test('rows that tie on everything else are in number order', () => {
  assert.deepEqual(sections([row(9, []), row(3, []), row(5, [])])[0].items.map((i) => i.row.number), [3, 5, 9]);
});

test('the viewer shows what was picked, else the pull request\'s own, else the last looked at', () => {
  const on = { milestone: { number: 4 } };
  const off = { milestone: null };
  assert.equal(viewingFor(on, undefined, 7), 4, 'its own, whatever was looked at before');
  assert.equal(viewingFor(off, undefined, 7), 7, 'one on none goes back to where the last look was');
  assert.equal(viewingFor(off, undefined, undefined), null, 'or to what is on none');
  assert.equal(viewingFor(on, 7, undefined), 7);
  assert.equal(viewingFor(on, null, 7), null, 'none, picked, is a pick');
});

test('the status line says where the pull request is, and offers the move to where the viewer looks', () => {
  const pr = (milestone) => ({ number: 198, milestone });
  const v12 = { number: 1, title: 'v1.2', dueOn: '2026-11-18T00:00:00Z' };
  assert.deepEqual(standing(pr(v12), 1), { dot: 'on', text: '#198 is on this milestone', due: null, move: null });
  assert.deepEqual(standing(pr(v12), 4), { dot: 'other', text: '#198 is on v1.2', due: '2026-11-18T00:00:00Z', move: 'Move it here' });
  assert.deepEqual(standing(pr(v12), null), { dot: 'other', text: '#198 is on v1.2', due: '2026-11-18T00:00:00Z', move: 'Take it off v1.2' });
  assert.deepEqual(standing(pr(null), 4), { dot: 'none', text: '#198 is on no milestone', due: null, move: 'Add it here' });
  assert.deepEqual(standing(pr(null), null), { dot: 'none', text: '#198 is on no milestone', due: null, move: null });
});

test('the kinds listed are pull requests alone until asked, and never neither', () => {
  assert.deepEqual(kindsFrom(null), { pulls: true, issues: false });
  assert.deepEqual(kindsFrom('issues'), { pulls: false, issues: true });
  assert.deepEqual(kindsFrom('pulls issues'), { pulls: true, issues: true });
  assert.deepEqual(kindsFrom('nonsense'), { pulls: true, issues: false });
  assert.equal(kindsText({ pulls: true, issues: true }), 'pulls issues');
  assert.deepEqual(flipKind({ pulls: true, issues: false }, 'issues'), { pulls: true, issues: true });
  assert.deepEqual(flipKind({ pulls: true, issues: true }, 'pulls'), { pulls: false, issues: true });
  // Turning the last one off turns the other on.
  assert.deepEqual(flipKind({ pulls: true, issues: false }, 'pulls'), { pulls: false, issues: true });
  assert.deepEqual(flipKind({ pulls: false, issues: true }, 'issues'), { pulls: true, issues: false });
});

test('a milestone\'s pie is merged and closed over everything but what closed unmerged', () => {
  const t = tally({ pulls: { open: 1, merged: 2, closed: 5 }, issues: { open: 9, closed: 3 } });
  assert.deepEqual([t.done, t.total], [5, 15]);
  assert.equal(tallyLabel(t), '5 of 15 done: 2 pull requests merged, 3 issues closed');
  assert.equal(tally(null), null);
  assert.equal(tally({ pulls: { open: 0, merged: 0, closed: 0 }, issues: { open: 0, closed: 0 } }), null, 'one that has never held anything');
  assert.equal(tally({ pulls: { open: 1.5, merged: 0, closed: 0 }, issues: { open: 0, closed: 0 } }), null);
});

// The picker leads with none, then the open milestones in the Issues tab's
// order, and always has the pull request's own, even one the list lacks. A
// dated one says when it is due after its title, as the milestone line does.
test('the milestone picker offers none, the open milestones in rank, and the pull request\'s own', () => {
  const list = [{ number: 3, title: 'Not urgent', dueOn: null }, { number: 1, title: 'v1.0', dueOn: '2026-10-14T00:00:00Z' },
    { number: 4, title: 'Needed soon', dueOn: null }];
  // Noon on the 12th, local time, so the 14th is two days off in any zone.
  const now = new Date(2026, 9, 12, 12).getTime();
  const none = { key: '', text: 'No milestone', title: 'what is open on no milestone' };
  assert.deepEqual(milestoneChoices(null, list, now), [
    none,
    { key: '1', text: 'v1.0', detail: { text: 'due in 2 days', cls: 'due soon', title: 'Wednesday, October 14, 2026' } },
    { key: '4', text: 'Needed soon' },
    { key: '3', text: 'Not urgent' },
  ]);
  assert.equal(milestoneChoices(null, list, new Date(2026, 9, 20, 12).getTime())[1].detail.cls, 'due overdue');
  const closed = { number: 9, title: 'v0.1', dueOn: null };
  assert.deepEqual(milestoneChoices(closed, list).map((c) => c.key), ['', '1', '4', '3', '9']);
  assert.deepEqual(milestoneChoices(list[2], list).map((c) => c.key), ['', '1', '4', '3'], 'listed once');
  assert.deepEqual(milestoneChoices(closed, null), [none, { key: '9', text: 'v0.1' }], 'before the list lands');
});
