// One milestone's work, in the order to do it in: what the PR pane's milestone
// viewer and the queue's milestone lines share. The rules first, which run
// under node as well as in the page (pr.js imports this, and the server
// imports pr.js -- see CLAUDE.md here), and the drawing under them. Nothing
// here touches the DOM at module scope.

import { h, btn, ext, mark, fraction } from './ui.js';
import { picker } from './picker.js';
import { dueLabel, sizeChip, rankMilestones, age, forClaude, REVIEW_WORD } from './items.js';

// How priority and effort are written on an issue or a pull request, as
// LABELS.md in gaurav/milestones has it (read 2026-11-15, at d46781d): two
// labels, `Priority: High` and `Effort: M`. That file is the standard and
// prcoder one reader of it -- nothing here is the milestones board's code.
// `options` is each kind's order, the most pressing and the largest first,
// which is the order a milestone is worked in: by priority, then by effort.
// `prefix` is every label prefix that has carried the kind, and `values` what
// each spelling found under one means, the older ones included: `Priority:
// Critical` is Urgent, `Size: M` is M, and an effort of High, Medium or Low is
// L, M or S. A value the table does not know is no value: the label is left
// to be shown as any other, not guessed at.
export const LABEL_KINDS = {
  priority: {
    field: 'Priority', prefix: /^priority\s*:\s*(.+)$/i, none: 'No priority',
    options: ['Urgent', 'High', 'Medium', 'Low'],
    values: { critical: 'Urgent', urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' },
  },
  effort: {
    field: 'Effort', prefix: /^(?:size|effort)\s*:\s*(.+)$/i, none: 'No effort',
    options: ['XL', 'L', 'M', 'S', 'XS'],
    values: { xs: 'XS', s: 'S', small: 'S', low: 'S', m: 'M', medium: 'M', l: 'L', large: 'L', high: 'L', xl: 'XL' },
  },
};

/** What one label says about `kind`, as one of its options, or null for a label that is not about it. */
const optionOf = (kind, name) => {
  const said = LABEL_KINDS[kind].prefix.exec(String(name ?? '').trim())?.[1];
  return said ? LABEL_KINDS[kind].values[said.trim().toLowerCase()] ?? null : null;
};

/**
 * The priority or the effort a row's labels give it: `{ value, label, old }`,
 * or null when no label says. The label written the standard way stands over
 * any other, as LABELS.md has it; `old` is true for a value read from an
 * older spelling, which the viewer shows as such rather than as settled.
 */
export function labelValue(kind, labels = []) {
  const { field } = LABEL_KINDS[kind];
  const read = labels.map((label) => ({ label, value: optionOf(kind, label) })).filter((l) => l.value);
  const standard = read.find((l) => l.label.trim().toLowerCase() === `${field}: ${l.value}`.toLowerCase());
  const found = standard ?? read[0];
  return found ? { ...found, old: !standard } : null;
}

/** Whether a label is one the headings already say: a priority or an effort the table knows. */
export const isValueLabel = (name) => Object.keys(LABEL_KINDS).some((kind) => optionOf(kind, name));

/**
 * A pull request's effort guessed from its size, for one with none recorded:
 * the size chip's bands (sizeChip in items.js, which the milestones board
 * took from here so the two agree on what an M is), with XXL read as XL. Only
 * ever shown, as `~M`, and never used to place a row: a guess is not a
 * decision.
 */
export const effortGuess = (lines) => {
  const size = sizeChip(lines);
  return size === 'XXL' ? 'XL' : size;
};

/**
 * A milestone's rows in the order to work them, cut into the groups that
 * share a priority and an effort: `[{ key, parts, items }]`. Priority first,
 * then effort, each in its table's order, with the rows nobody has judged
 * after the judged ones of their group -- no label is not `Low` -- and the
 * most recently updated first within a group, the number settling a tie.
 *
 * `parts` is the heading, priority then effort: `{ text, level }`, where
 * `level` is the value's place in its scale from 1 (Urgent, XL) and 0 is
 * unset, which the page colours by. `items` is each row with what was read
 * for it: `{ row, priority, effort }`, labelValue's answers.
 */
export function sections(rows) {
  const kinds = Object.keys(LABEL_KINDS);
  const place = (kind, read) => (read ? LABEL_KINDS[kind].options.indexOf(read.value) : Number.MAX_SAFE_INTEGER);
  const items = rows.map((row) => {
    const read = Object.fromEntries(kinds.map((kind) => [kind, labelValue(kind, row.labels)]));
    return { row, ...read, at: kinds.map((kind) => place(kind, read[kind])) };
  });
  items.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]
    || String(b.row.updatedAt ?? '').localeCompare(String(a.row.updatedAt ?? '')) || a.row.number - b.row.number);
  const out = [];
  for (const { at, ...item } of items) {
    const key = kinds.map((kind) => item[kind]?.value ?? '').join('/');
    if (out.at(-1)?.key !== key) {
      out.push({
        key,
        parts: kinds.map((kind) => (item[kind]
          ? { text: item[kind].value, level: LABEL_KINDS[kind].options.indexOf(item[kind].value) + 1 }
          : { text: LABEL_KINDS[kind].none, level: 0 })),
        items: [],
      });
    }
    out.at(-1).items.push(item);
  }
  return out;
}

/**
 * Which milestone the viewer shows, as a number or null for what is on none.
 * What was picked for this pull request, while it is the one on screen; or
 * the pull request's own; or, for one on no milestone, the last one looked at
 * in this page, since a pull request that will never have a milestone is
 * still somewhere to look for the next thing from; or none.
 */
export const viewingFor = (pr, picked, last) => (picked !== undefined ? picked : pr?.milestone?.number ?? last ?? null);

/**
 * How the pull request on screen stands to the milestone being looked at
 * (`viewing`, a number or null for none): `{ dot, text, due, move }`. `dot` is
 * `on` where it is on that one, `other` where it is on another, `none` where
 * it is on none; `due` is the other milestone's date, for the line to say
 * beside it; and `move` is the button that would put it where the viewer is
 * looking -- its words, or null where it is already there.
 */
export function standing(pr, viewing) {
  const own = pr.milestone ?? null;
  const n = `#${pr.number}`;
  if (!own) return { dot: 'none', text: `${n} is on no milestone`, due: null, move: viewing == null ? null : 'Add it here' };
  if (own.number === viewing) return { dot: 'on', text: `${n} is on this milestone`, due: null, move: null };
  return { dot: 'other', text: `${n} is on ${own.title}`, due: own.dueOn ?? null, move: viewing == null ? `Take it off ${own.title}` : 'Move it here' };
}

// Which kinds the viewer lists, as the preference stores it: `pulls`,
// `issues` or `pulls issues`. Pull requests alone until someone asks for the
// issues, since a pull request is work already under way and the one to
// switch to.
export const KINDS_KEY = 'prcoder:milestone-kinds';
export const kindsFrom = (stored) => {
  const words = String(stored ?? '').split(/\s+/);
  const kinds = { pulls: words.includes('pulls'), issues: words.includes('issues') };
  return kinds.pulls || kinds.issues ? kinds : { pulls: true, issues: false };
};
export const kindsText = (kinds) => ['pulls', 'issues'].filter((k) => kinds[k]).join(' ');
/** `kinds` with `which` flipped; turning the last one off turns the other on, so the list is never of nothing. */
export const flipKind = (kinds, which) => {
  const next = { ...kinds, [which]: !kinds[which] };
  if (next.pulls || next.issues) return next;
  return which === 'pulls' ? { pulls: false, issues: true } : { pulls: true, issues: false };
};

/** `noun`, a plural, as one of them when `n` is 1: `issue`, `pull request`. */
export const several = (n, noun) => (n === 1 ? noun.replace(/s$/, '') : noun);

/**
 * A milestone's counts (`counts` from milestoneRow in github.js) as its pie
 * draws them, or null when there is nothing to draw: no counts -- a pulls.json
 * older than them -- counts that are not whole numbers, as in one damaged, or
 * a milestone that has never held anything. The pie is the whole milestone,
 * pull requests and issues together, so it is the same wherever it is drawn.
 * Done is what merged or closed; a pull request closed without merging is in
 * neither figure, since it is not done and not still to do (the owner's call,
 * 2026-10-24).
 */
export function tally(counts) {
  const { open, merged, closed } = counts?.pulls ?? {};
  const { open: issues, closed: shut } = counts?.issues ?? {};
  if (![open, merged, closed, issues, shut].every((n) => Number.isInteger(n) && n >= 0)) return null;
  const total = open + merged + issues + shut;
  return total ? { pulls: { open, merged, closed }, issues: { open: issues, closed: shut }, done: merged + shut, total } : null;
}

/** A tally as the pie's tooltip and name say it: `5 of 15 done: 2 pull requests merged, 3 issues closed`. */
export const tallyLabel = (t) => `${t.done} of ${t.total} done: ${t.pulls.merged} ${several(t.pulls.merged, 'pull requests')} merged, `
  + `${t.issues.closed} ${several(t.issues.closed, 'issues')} closed`;

/**
 * A milestone's pie, as the button that opens its breakdown. The figure is
 * its tooltip, as a mark's is, and its name, with what a press does.
 */
export function pieButton(m, t) {
  const label = tallyLabel(t);
  const b = h('button', { type: 'button', className: 'breakdown', title: label }, mark(fraction(t)));
  b.setAttribute('aria-label', `${label}; show the breakdown`);
  b.setAttribute('aria-haspopup', 'dialog');
  // A press while it is open for this pie closes it. The popover's light
  // dismiss has already hidden it by the click, on pointerdown, so that is
  // read there; a key press has no pointerdown and finds it still open.
  let wasOpen = false;
  b.onpointerdown = () => { wasOpen = popFor === b && pop.matches(':popover-open'); };
  b.onclick = () => {
    if (wasOpen || (popFor === b && pop.matches(':popover-open'))) { wasOpen = false; pop.hidePopover(); return; }
    showBreakdown(m, t, b);
  };
  return b;
}

/** The one breakdown popover, made on first use, and the pie it was opened from. */
let pop = null;
let popFor = null;

/**
 * Every figure the line draws a part of, as a table under the pie: pull
 * requests open, merged and closed without merging, and issues open and
 * closed, then the pie's figure, saying what it leaves out. A popover rather
 * than a longer line or a tooltip: the line is already as long as a narrow
 * pane allows, and a tooltip is one line of words, where this is a table to
 * read across. `auto`, so Escape and a click anywhere else close it. One on
 * <body> for every line, anchored by CSS to the pie it was opened from, which
 * alone carries the anchor's name (`.milestone-pop` in style.css); Firefox 153
 * and Chromium 151 both anchor (checked 2026-10-24). A button inside a
 * <summary> takes its own click and keys, so a press does not fold the group
 * (checked in both, the same day).
 */
function showBreakdown(m, t, at) {
  if (!pop) {
    pop = document.body.appendChild(h('div', { className: 'milestone-pop', popover: 'auto' }));
    pop.setAttribute('role', 'dialog');
  }
  const cells = (row, ...ns) => h('tr', {}, h('th', { scope: 'row' }, row), ...ns.map((n) => h('td', {}, n)));
  const { open, merged, closed } = t.pulls;
  pop.setAttribute('aria-label', `${m.title}: what it holds`);
  pop.replaceChildren(
    h('p', { className: 'head' }, m.title, m.dueOn ? ` · due ${dueLabel(m.dueOn).title}` : ''),
    h('table', {},
      h('thead', {}, h('tr', {}, h('td'), ...['open', 'merged', 'closed'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, cells('pull requests', String(open), String(merged), String(closed)),
        cells('issues', String(t.issues.open), '–', String(t.issues.closed)))),
    h('p', {}, `${t.done} of ${t.total} done`
      + (closed ? `, leaving out the ${closed} ${several(closed, 'pull requests')} closed without merging` : '')));
  popFor?.style.removeProperty('anchor-name');
  popFor = at;
  at.style.setProperty('anchor-name', '--milestone-pie');
  pop.showPopover();
}

/**
 * Close the breakdown when a repaint -- a poll, a search, a new listing -- has
 * taken away the pie it hangs from, which would leave it anchored to nothing.
 * Whatever redraws a pie calls this after it.
 */
export function staleBreakdown() {
  if (popFor && !popFor.isConnected && pop.matches(':popover-open')) pop.hidePopover();
}

/**
 * The milestone picker's rows: none first, then the repository's open
 * milestones in the order the Issues tab groups them (rankMilestones), so the
 * dated ones come soonest first. Each is its title, with when it is due after
 * it as the line says it (dueLabel: `due in 3 days`, coloured by how near, the
 * date on hover). The pull request's own milestone is always among them, last
 * when the list lacks it -- closed, past the pages read, or no list yet
 * (`list` is null until the page has one) -- so the viewer can show where the
 * pull request is whatever was read. Keyed by the milestone's number as a
 * string, and `''` for none.
 */
export const milestoneChoices = (current, list, now = Date.now()) => {
  const open = rankMilestones(list ?? []);
  const all = current && !open.some((m) => m.number === current.number) ? [...open, current] : open;
  const due = (m) => {
    if (!m.dueOn) return {};
    const { className, textContent, title } = dueLabel(m.dueOn, now);
    return { detail: { text: textContent, cls: className, title } };
  };
  return [
    { key: '', text: 'No milestone', title: 'what is open on no milestone' },
    ...all.map((m) => ({ key: String(m.number), text: m.title, ...due(m) })),
  ];
};

/** A row's labels that its heading does not already say, as chips. */
const otherLabels = (labels) => labels.filter((l) => !isValueLabel(l)).map((l) => h('span', { className: 'tag label' }, l));

/** A priority or an effort read from an older label, said on the row: the heading has the value, this where it came from. */
const oldLabels = (item) => Object.keys(LABEL_KINDS).map((kind) => (item[kind]?.old
  ? h('em', { className: 'ms-old', title: `read from this label, an older way of writing ${LABEL_KINDS[kind].field}: ${item[kind].value}` }, item[kind].label)
  : null));

/** When a row last moved, with the day on hover. */
const moved = (iso, now) => (iso ? h('span', { className: 'age', title: `updated ${new Date(iso).toLocaleString()}` }, age(iso, now)) : null);

/**
 * The end of a row's first line: what the row does -- Switch, `here`, ▶ --
 * over when it last moved. The age is here and not on the line of facts, so a
 * row with no facts to state, an unlabelled issue, is its title's two lines
 * and not a third for the age alone.
 */
const aside = (act, iso, now) => h('span', { className: 'ms-aside' }, act, moved(iso, now));

/**
 * One open pull request: the chip that is its link, its title, and Switch --
 * the checkout the Stack tab's rows have, under the same guard -- or `here`
 * on the one on screen. Under it, what the choice turns on: whether it can
 * merge in a word, the review decision when there is one, an effort guessed
 * from its size where none is recorded (`~M`), and its other labels. The word
 * is `wordOf`'s, which is pullWord in items.js over what the pane knows of the
 * stack: GitHub's `ready` on a pull request built on others is `stacked (N)`,
 * as the queue's Pull requests tab has it, since it is ready to merge into the
 * one under it and not into the default branch.
 */
function pullItem({ row: p, ...item }, { pr, blocked, now, wordOf = (q) => ({ word: q.merge, cls: '' }) }, { onSwitch }) {
  const here = p.url === pr.url;
  const review = REVIEW_WORD[p.reviewDecision];
  const { word, cls } = wordOf(p);
  return h('li', { className: here ? 'ms-row pull here' : 'ms-row pull', dataset: { number: String(p.number) }, ...(here ? { ariaCurrent: 'true' } : {}) },
    h('div', { className: 'ms-top' },
      ext(p.url, `PR #${p.number}`, { className: 'tag pull' }),
      h('span', { className: 'ms-title', title: p.title }, p.title),
      aside(here ? h('span', { className: 'tag here', title: 'the pull request this working copy is on' }, 'here')
        : btn('Switch', () => onSwitch?.(p.url), {
          className: 'pr-go', disabled: !!blocked || !onSwitch,
          title: blocked ? 'Commit or stash your changes first' : `Check out #${p.number} here`,
        }), p.updatedAt, now)),
    h('div', { className: 'ms-facts' },
      h('span', { className: `pr-merge ${cls}`.trim() }, word),
      review ? h('span', { className: 'pr-review' }, review) : null,
      item.effort ? null : h('em', {
        className: 'ms-guess',
        title: `${p.lines} lines changed (+${p.additions} −${p.deletions}) in ${p.changedFiles} file${p.changedFiles === 1 ? '' : 's'}: an effort guessed from its size, since none is recorded`,
      }, `~${effortGuess(p.lines)}`),
      ...oldLabels(item), ...otherLabels(p.labels)));
}

/**
 * One open issue: its chip, its title, and ▶, which types the issue and its
 * link into the coding agent as the Issues tab's ▶ does, for the turn to be
 * finished and sent by hand. Under it, its other labels and the open pull
 * requests that close it -- work already under way -- or, for an issue with
 * neither, nothing: the line is not drawn.
 */
function issueItem({ row: i, ...item }, { repo, home, now }, { onType }) {
  return h('li', { className: 'ms-row issue', dataset: { number: String(i.number) } },
    h('div', { className: 'ms-top' },
      ext(i.url, `#${i.number}`, { className: 'tag issue' }),
      h('span', { className: 'ms-title', title: i.title }, i.title),
      aside(btn('▶', () => onType?.(forClaude({ text: i.title, issue: i.number, repo: repo ?? null, kind: 'issue', issueUrl: i.url }, home)),
        { className: 'ms-type', title: 'type into the coding agent, with the link' }), i.updatedAt, now)),
    h('div', { className: 'ms-facts' },
      ...oldLabels(item), ...otherLabels(i.labels),
      ...i.pulls.map((p) => ext(p.url, `PR #${p.number}`, {
        className: 'tag pull', title: p.isDraft ? 'a draft pull request that closes this issue' : 'an open pull request that closes this issue',
      }))));
}

/**
 * The milestone viewer, as the nodes of the PR pane's body: one milestone's
 * open work in the order to do it, and how the pull request on screen stands
 * to that milestone.
 *
 * Top to bottom: the picker, which chooses the milestone to look at and
 * writes nothing; the status line (standing), whose button is the one thing
 * here that writes -- it puts the pull request where the viewer is looking;
 * what the milestone holds, as the queue's milestone lines say it; the two
 * kinds as buttons that are each pressed or not, with when the list was read
 * and a way to read it again; then the rows, in sections' groups, each headed
 * by its priority and effort. A milestone where nobody has judged anything is
 * one group, which gets no heading: `No priority · No effort` over every row
 * says nothing.
 *
 * `s` is what it is drawn from: the pull request `pr` and its repository's
 * URL and name (`repoUrl`, `repo`), the picker's `milestones` (null until
 * read), `viewing` (a number, or null for none), `view` (the route's answer
 * for it, or null), `loading`, `error`, the `kinds` listed, `moving` while a
 * move is on its way, `blocked` when a checkout would be refused, `wordOf`
 * (a pull request's merge word, pullItem), `home` (the clone's repository,
 * which a typed issue is named against) and `now`.
 * `on` is what it can ask for: onView(number), onMove(url, number),
 * onSwitch(url), onType(text), onKinds(kinds), onRefresh() and onReach().
 */
export function milestoneView(s, on) {
  const { pr, repoUrl, milestones = null, viewing = null, view = null, loading = false, error = null, kinds = kindsFrom(null), moving = null, now = Date.now() } = s;
  const key = viewing == null ? '' : String(viewing);
  const rows = milestoneChoices(pr.milestone, milestones, now);
  const m = view?.milestone ?? (viewing == null ? null
    : milestones?.find((x) => x.number === viewing) ?? (pr.milestone?.number === viewing ? pr.milestone : null));
  const sel = picker('milestone', {
    label: 'milestone to look at', text: rows.find((r) => r.key === key)?.text ?? `milestone #${key}`,
    rows, current: key, scope: pr.url,
    // `listed` once the repository's list is in, for a driver to wait on: the
    // rows alone cannot say, as a repository with none open has none.
    dataset: { pr: pr.url, on: key, ...(milestones ? { listed: '' } : {}) },
    title: 'look at another milestone: choosing one moves nothing',
    placeholder: 'find a milestone', none: 'no open milestone matches',
    onOpen: () => on.onReach?.(),
    onPick: (row) => on.onView?.(row.key ? Number(row.key) : null),
  });
  sel.onpointerenter = () => on.onReach?.();
  sel.onfocus = () => on.onReach?.();

  const st = standing(pr, viewing);
  const t = tally(m?.counts);
  const kindBtn = (which, word, n) => btn(n == null ? word : `${word} ${n}`, () => on.onKinds?.(flipKind(kinds, which)), {
    className: 'ms-kind', ariaPressed: String(!!kinds[which]), dataset: { kind: which },
    title: kinds[which] ? `listing the open ${word === 'PRs' ? 'pull requests' : 'issues'}: press to leave them out` : `list the open ${word === 'PRs' ? 'pull requests' : 'issues'} too`,
  });
  const listed = view ? [...(kinds.pulls ? view.pulls : []), ...(kinds.issues ? view.issues : [])] : [];
  const groups = sections(listed);
  const bare = groups.length === 1 && groups[0].parts.every((p) => p.level === 0);
  const isPull = new Set(view?.pulls ?? []);
  const where = viewing == null ? 'on no milestone' : 'on this milestone';
  const nothing = () => {
    const [shown, hidden, n, turn] = kinds.pulls && kinds.issues ? ['pull requests or issues', null, 0, '']
      : kinds.pulls ? ['pull requests', 'issues', view.issues.length, 'Issues'] : ['issues', 'pull requests', view.pulls.length, 'PRs'];
    return `No open ${shown} ${where}.` + (n ? ` It has ${n} open ${several(n, hidden)}: press ${turn} to list ${n === 1 ? 'it' : 'them'}.` : '');
  };

  return [
    h('div', { className: 'meta ms-pick' },
      m ? ext(`${repoUrl}/milestone/${m.number}`, 'milestone', { title: `${m.title} on GitHub` }) : h('span', {}, 'milestone'),
      sel),
    h('div', { className: `ms-standing ${st.dot}` },
      h('span', { className: 'ms-dot', ariaHidden: 'true' }),
      h('span', { className: 'ms-where' }, st.text, ...(st.due ? [', ', h('span', dueLabel(st.due, now))] : [])),
      st.move ? btn(moving ? 'Moving…' : st.move, () => on.onMove?.(pr.url, viewing), {
        className: 'ms-move', disabled: !!moving || !on.onMove,
        title: viewing == null ? `take #${pr.number} off its milestone on GitHub` : `put #${pr.number} on ${m?.title ?? 'this milestone'} on GitHub`,
      }) : null),
    m || view ? h('div', { className: 'meta ms-sum' },
      t ? pieButton(m, t) : null,
      t ? h('span', {}, `${t.done} of ${t.total} done`) : null,
      t?.pulls.merged ? h('span', { className: 'merged', title: `${t.pulls.merged} ${several(t.pulls.merged, 'pull requests')} merged into this milestone` }, `${t.pulls.merged} merged`) : null,
      m?.dueOn ? h('span', dueLabel(m.dueOn, now)) : null,
      m?.closed ? h('span', { className: 'closed-milestone', title: 'closed on GitHub' }, 'closed') : null,
      !m && view ? h('span', {}, `${view.total} open on no milestone`) : null) : null,
    m?.description ? h('p', { className: 'ms-desc', title: m.description }, m.description) : null,
    h('div', { className: 'ms-bar' },
      kindBtn('pulls', 'PRs', view?.pulls.length), kindBtn('issues', 'Issues', view?.issues.length),
      h('span', { className: 'ms-read' }, view ? `read ${age(new Date(view.read).toISOString(), now)}${loading ? ' · updating…' : ''}` : ''),
      btn('⟳', () => on.onRefresh?.(), { className: 'ms-refresh', disabled: loading, title: 'read this milestone again from GitHub' })),
    error ? h('p', { className: 'ms-error' }, error) : null,
    !view ? (error ? null : h('p', { className: 'empty' }, 'Reading…'))
      : !listed.length ? h('p', { className: 'empty' }, nothing())
        : h('div', { className: 'ms-groups' }, ...groups.map((g) => h('section', { className: 'ms-group' },
          bare ? null : h('h3', { className: `ms-head level-${g.parts[0].level}` },
            ...g.parts.flatMap((p, i) => [i ? ' · ' : null, h('span', { className: `level-${p.level}` }, p.text)]),
            h('span', { className: 'count', title: `${g.items.length} listed` }, String(g.items.length))),
          h('ul', {}, ...g.items.map((item) => (isPull.has(item.row) ? pullItem : issueItem)(item, { ...s, now }, on)))))),
    view && view.listed < view.total
      ? h('p', { className: 'ms-cut' }, `The ${view.listed} read of the ${view.total} open ${where}; the rest are on GitHub.`) : null,
  ];
}
