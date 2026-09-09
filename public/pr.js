import { TASK, fences } from './tasks.js';

// Skips absent sections; DOM append() would render them as the text "null".
const kids = (list) => list.flat().filter((k) => k != null);

// Small helper: build an element and append children.
export function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids(children));
  return node;
}

/** A button with its handler, the one shape every pane's chrome is built from. */
export const btn = (label, fn, props = {}) => {
  const b = h('button', props, label);
  b.onclick = fn;
  return b;
};

/**
 * JSON in, JSON out, an error thrown either way it can fail -- a bad status or
 * an `error` in the payload. No body means no body at all, not `{}`: fetch
 * refuses to send one on a GET, and handleApi already reads a missing one as
 * undefined.
 */
export const api = async (url, body, method = 'POST') => {
  const res = await fetch(url, body === undefined ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
  return data;
};

/**
 * A line over the panes: the app's one notification surface.
 *
 * `sticky` is for a notice that stays true until you act on it, rather than one
 * that reports something already finished -- it waits to be clicked instead of
 * timing out. Every toast is click-to-dismiss; only a sticky one says so, with
 * the ✕ its CSS adds.
 */
let toastTimer;
export function toast(msg, bad = false, sticky = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `${bad ? 'bad' : ''} ${sticky ? 'sticky' : ''}`.trim();
  el.hidden = false;
  // One slot, so a later toast replaces whatever is up -- including a sticky
  // one, which is the other way it goes away.
  el.onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : 4000);
}

/**
 * A checkbox that writes through to GitHub. The browser has already flipped it
 * by the time we hear about it, so a failure puts it back rather than
 * repainting -- the poll would take up to a minute to disagree. `settle` runs
 * either way, against whatever the box ended up saying.
 */
export function writeThrough(box, run, settle = () => {}) {
  // Assigned, not added: the diff pane's box is static markup and openDiff
  // rewires it on every file, where a listener per open would stack up.
  box.onchange = async () => {
    box.disabled = true;
    try { await run(box.checked); } catch { box.checked = !box.checked; }
    box.disabled = false;
    settle(box.checked);
  };
}

/** The light itself, for the two pane headers that survive a poll. */
function paintLight(id, state) {
  const light = document.getElementById(id);
  light.hidden = !state;
  if (!state) return;
  light.className = state.className;
  light.textContent = state.text;
}

const GROUPS = [
  ['tests', 'Tests'],
  ['code', 'Code'],
  ['docs', 'Config & docs'],
];

/**
 * The browser tab title. A row of tabs shows only the first few characters, so
 * the short URL — the one string that identifies this session against every
 * other prcoder tab, and against github.com's own tabs — comes first, and the
 * PR title is trimmed to whatever is left of a tab's width.
 *
 * The repository comes from the PR's own URL, not from the checkout: a PR from
 * a fork, or one opened with `prcoder <url>`, lives somewhere else entirely.
 *
 * `· prcoder` goes last, past what a tab shows, for the places that search
 * titles instead — Firefox's `%` tab search, the Window menu — so one string
 * finds every instance among the github.com tabs named the same way.
 */
const TITLE_MAX = 72;

const prRepo = (url) => url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1] ?? null;

export function pageTitle(status) {
  // A failed poll keeps the last good title (paint() is not reached), so this
  // is only the very first load, where there is nothing to name the tab with.
  if (!status || status.error) return 'prcoder';

  if (status.pr) {
    const repo = prRepo(status.pr.url) ?? status.nameWithOwner ?? 'prcoder';
    return `${clamp(`${repo}#${status.pr.number}`, status.pr.title)} · prcoder`;
  }

  const where = status.detached ? 'detached HEAD' : status.branch;
  return `${clamp(status.nameWithOwner ?? 'prcoder', where ? `${where} (no PR)` : 'no PR')} · prcoder`;
}

/** `head · tail`, with the tail cut to fit. The head is never truncated. */
function clamp(head, tail) {
  if (!tail) return head;
  const room = TITLE_MAX - head.length - 3;
  if (room < 8) return head;
  return `${head} · ${tail.length > room ? `${tail.slice(0, room - 1).trimEnd()}…` : tail}`;
}

/**
 * The header is the one part of this pane that is never blown away, so the
 * switcher and the light live there — a poll landing mid-click would otherwise
 * close an open dropdown.
 */
export function renderHeader(status, prs, { onSwitch, onCommit }) {
  const sel = document.getElementById('pr-switch');
  const commit = document.getElementById('pr-commit');

  // Rebuilt only when the set of PRs changes, so the open list survives a poll.
  // gh pr list is open PRs only, so a merged or closed one has no option of its
  // own — without this the select falls to selectedIndex -1 and renders blank
  // while the pane below it is showing that very PR.
  const shown = status.pr && !prs.some((p) => p.number === status.pr.number)
    ? [{ number: status.pr.number, title: status.pr.title, isDraft: false }, ...prs]
    : prs;

  const keys = shown.map((p) => p.number).join(',');
  if (sel.dataset.keys !== keys) {
    sel.dataset.keys = keys;
    sel.replaceChildren(
      h('option', { value: '' }, shown.length ? 'no pull request' : 'no open pull requests'),
      ...shown.map((p) => h('option', { value: String(p.number) },
        `#${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title}`)),
    );
    sel.onchange = () => sel.value && onSwitch(Number(sel.value));
  }
  // Always re-assert: a failed switch has to snap back to the real branch.
  sel.value = status.pr ? String(status.pr.number) : '';

  // Uncommitted work would make `gh pr checkout` fail, so offer the fix instead
  // of the switch. Claude is right there in the next pane.
  const blocked = status.dirtyFiles.length > 0;
  sel.hidden = blocked || status.scope === 'other-repo';
  commit.hidden = !blocked;
  commit.onclick = () => onCommit(status.dirtyFiles);
  commit.textContent = `Commit ${status.dirtyFiles.length} file${status.dirtyFiles.length === 1 ? '' : 's'}…`;

  paintLight('pr-sync', headerSync(status));
}

// The same words the terminal's status block uses (SYNC in server.js). `ahead`
// is not in the table because it counts.
const SYNC = { behind: 'pull needed', diverged: 'diverged', unpushed: 'not pushed' };

/** Pure: the status -> the PR pane's light, or null for nothing worth saying. */
export function headerSync(status) {
  if (status.error) return { className: 'light unknown', text: 'unavailable' };
  if (status.scope === 'other-repo') return { className: 'light', text: 'another repo' };
  if (status.scope === 'other-branch') return { className: 'light', text: 'not checked out' };
  const out = status.sync === 'ahead' ? `${status.ahead} unpushed` : SYNC[status.sync];
  if (out) return { className: 'light warn', text: out };
  if (status.detached) return { className: 'light', text: 'detached HEAD' };
  return null;
}

/**
 * Pure: the status -> the queue pane's light. Named states rather than a
 * boolean, because "nothing to mirror" and "GitHub has it" are both fine and
 * only one of them is worth a dot.
 *
 * `mirrorFailed` is the state this exists for. The store took the change and
 * GitHub did not, so prcoder has stopped trusting the description it can see --
 * and until now the only sign of that was a line on the server's stderr.
 */
export function queueSync(status) {
  if (status.error) return { className: 'light unknown', text: 'unavailable' };
  if (status.mirrorFailed) return { className: 'light bad', text: 'not saved to the PR' };
  if (!status.queue?.some((i) => i.inPr && !i.deleted)) return null;
  if (status.scope !== 'current') return { className: 'light unknown', text: 'not mirroring' };
  return { className: 'light ok', text: 'in the PR' };
}

/** The queue pane's header, like the PR pane's, survives polls. */
export const renderQueueSync = (status) => paintLight('queue-sync', queueSync(status));

/** The pane with no PR to show: why, and the one thing worth doing about it. */
export function renderNoPr(status, { onCreate }) {
  const host = document.getElementById('pr-body');
  // The head is a whole pull request's worth of identity -- title, badges,
  // tabs -- and nothing else clears it, so without this the last PR's heading
  // sits above "No pull request for main yet."
  document.getElementById('pr-head').replaceChildren();
  tab = 'detail';
  shownFor = null;
  const onDefault = status.branch === status.defaultBranch;

  const why = status.detached ? 'HEAD is detached — no branch to open a pull request for.'
    : onDefault ? `You are on ${status.branch}. Make a branch to start a pull request.`
    : `No pull request for ${status.branch} yet.`;

  // Comparing a branch with itself opens an empty diff, so on main there is
  // nothing to offer — the fix is a branch, not a button.
  const can = !status.detached && !onDefault;
  const btn = h('button', { className: 'pr-create', disabled: !can }, 'Create a pull request');
  if (can) btn.onclick = () => onCreate(btn);

  host.replaceChildren(...kids([
    h('p', { className: 'empty' }, why),
    status.sync === 'unpushed' && can
      ? h('p', { className: 'pr-note' }, 'This branch is not on GitHub yet; it will be pushed first.')
      : null,
    btn,
  ]));
}

/**
 * Which half of the pane is showing, where each half was scrolled to, and which
 * pull request that was all decided about.
 *
 * It lives out here because renderPr runs on every 60s poll and replaces both
 * roots wholesale, so anything the reader chose about the *view* is gone the
 * moment it does. diff.js and queue.js keep their state in module scope for the
 * same reason.
 *
 * Not localStorage. The tab is a per-pull-request fact, and a browser-wide one
 * would carry a decision about a description you have finished reading onto a
 * description you have not opened yet.
 */
let tab = 'detail';
let shownFor = null;
const scrolled = { detail: 0, files: 0 };
const openSections = new Set();

/**
 * The pull request pane, in two roots.
 *
 * #pr-head is the identity -- which pull request, on what branch, passing or
 * not -- and does not scroll. #pr-body is one of two views of it: the argument
 * (Detail) or the work (Files). They are tabs rather than one column because
 * they are two different things to be doing, they each want the whole pane, and
 * an agent-written description is long enough to bury a file list entirely.
 */
export function renderPr(pr, handlers) {
  // A different pull request is a different set of sections and a different
  // amount of scroll; none of the old numbers mean anything against it.
  if (shownFor !== pr.number) {
    shownFor = pr.number;
    scrolled.detail = 0;
    scrolled.files = 0;
    openSections.clear();
  }
  renderPrHead(pr, handlers);
  renderPrTab(pr, handlers);
}

function renderPrHead(pr, handlers) {
  const switchTo = (name) => {
    tab = name;
    renderPrHead(pr, handlers);
    renderPrTab(pr, handlers);
  };
  const tabBtn = (name, label) =>
    btn(label, () => switchTo(name), { className: tab === name ? 'tab on' : 'tab' });

  document.getElementById('pr-head').replaceChildren(...kids([
    h('a', { className: 'pr-link', href: pr.url, target: '_blank', rel: 'noopener' },
      `#${pr.number} on GitHub ↗`),
    h('h2', { className: 'pr-title' }, pr.title),
    pr.note ? h('p', { className: 'pr-note' }, pr.note) : null,
    h('div', { className: 'meta' },
      badge(pr.isDraft ? 'draft' : pr.state.toLowerCase(), pr.isDraft ? 'draft' : pr.state.toLowerCase()),
      h('span', {}, `${pr.headRefName} → ${pr.baseRefName}`),
      h('span', { className: 'add' }, `+${pr.additions}`),
      h('span', { className: 'del' }, `−${pr.deletions}`),
    ),
    checks(pr.checks),
    h('div', { className: 'tabs' },
      tabBtn('detail', tabLabel('Detail', taskCount(pr.body))),
      tabBtn('files', tabLabel('Files', viewedCount(pr.files)))),
  ]));
}

/**
 * The count each tab carries is what it can tell you while you are on the other
 * one: how many description checkboxes are still open, how many files are still
 * unviewed. `(3/10)` is done over total, the same way the file groups read.
 */
const tabLabel = (name, count) => (count.total ? `${name} (${count.done}/${count.total})` : name);

const taskCount = (body) => {
  const tasks = blocks(body).filter((b) => b.kind === 'task');
  return { done: tasks.filter((b) => b.done).length, total: tasks.length };
};

const viewedCount = (files = []) =>
  ({ done: files.filter((f) => f.viewed).length, total: files.length });

function renderPrTab(pr, handlers) {
  const host = document.getElementById('pr-body');
  // Read before the replace. Afterwards the old height is gone and the browser
  // has already clamped scrollTop against whatever went in.
  scrolled[tab] = host.scrollTop;
  // A <summary> is a keyboard control, and a poll landing a second after you
  // tabbed onto one would otherwise drop focus on the floor. queue.js decided
  // not to freeze a whole pane over focus and that still holds -- this restores
  // it instead.
  const focused = document.activeElement?.closest?.('.md-section')?.dataset.key;

  host.replaceChildren(...kids(tab === 'files' ? [
    ...GROUPS.map(([key, label]) => fileGroup(label, pr.groups[key], handlers)),
    h('div', { className: 'meta' },
      h('a', { href: `${pr.url}#issuecomment`, target: '_blank', rel: 'noopener' },
        `${pr.counts.comments} comments · ${pr.counts.reviews} reviews ↗`)),
  ] : [
    issueRow(pr.issues, true, 'Closes:'),
    h('div', { className: 'body md' }, ...description(pr.body, handlers.onTask)),
    issueRow(pr.issues, false, 'Mentions:'),
  ]));

  // Assigning forces layout, so this lands against the new content rather than
  // the old. Nothing reflows underneath it afterwards -- the description's
  // serif stack is all system faces, deliberately, because a webfont arriving
  // late would move every line under a scroll position already restored.
  host.scrollTop = scrolled[tab];
  if (focused) host.querySelector(`.md-section[data-key="${CSS.escape(focused)}"] > summary`)?.focus();
}

const badge = (text, kind) => h('span', { className: `badge ${kind}` }, text);

function checks({ passed, failed, pending }) {
  if (!passed && !failed && !pending) return null;
  return h('div', { className: 'meta' },
    failed ? badge(`${failed} failing`, 'fail') : null,
    pending ? badge(`${pending} pending`, 'pend') : null,
    passed ? badge(`${passed} passing`, 'pass') : null,
  );
}

/**
 * One row of issue chips. The row label says which kind, so the chips stay bare
 * numbers.
 *
 * The two kinds mean different things and are placed differently because of it.
 * `Closes:` is a handful of issues this pull request answers, and it belongs
 * above the description as part of what the pull request *is*. `Mentions:` is
 * every bare `#N` linkedIssues() could find in the body, which on a description
 * that discusses its own backlog is dozens -- six rows of chips between the
 * title and the first sentence, which is the burial this pane is being fixed
 * for. It goes underneath.
 */
function issueRow(list, closes, label) {
  const kind = list.filter((i) => i.closes === closes);
  if (!kind.length) return null;
  return h('div', { className: 'issues' },
    h('span', { className: 'issues-label' }, label),
    ...kind.map((i) => h('a', { href: i.url, target: '_blank', rel: 'noopener', title: i.title ?? '' },
      `#${i.number}`)));
}

function fileGroup(label, files, handlers) {
  if (!files?.length) return null;
  const seen = files.filter((f) => f.viewed).length;
  return h('section', { className: 'group' },
    h('h3', {}, `${label} `, h('span', { className: 'count' }, `${seen}/${files.length}`)),
    ...files.map((f) => fileRow(f, handlers)),
  );
}

function fileRow(f, { onViewed, onOpen, selected }) {
  const box = h('input', { type: 'checkbox', checked: f.viewed, title: 'mark viewed on GitHub' });
  writeThrough(box, (v) => onViewed(f.path, v), (v) => row.classList.toggle('viewed', v));
  const link = h('a', { href: f.url, target: '_blank', rel: 'noopener', className: 'path', title: f.path },
    f.path);
  link.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) return;   // GitHub stays one modifier away
    e.preventDefault();
    onOpen(f);
  });
  const row = h('div', { className: `file${f.viewed ? ' viewed' : ''}${f.path === selected ? ' sel' : ''}` },
    box,
    link,
    h('span', { className: 'nums' },
      h('span', { className: 'add' }, `+${f.additions}`), ' ',
      h('span', { className: 'del' }, `−${f.deletions}`)),
  );
  row.dataset.path = f.path;
  return row;
}

/**
 * A PR description as blocks, in body order: `code`, `p`, `heading`, `task` and
 * `list`. No DOM -- blockNode() below turns one of these into an element, and
 * sectionize() regroups them into folds. Splitting it this way is what lets the
 * whole renderer be tested without a browser.
 *
 * `index` counts every checklist line as it goes, because a tick is sent as a
 * *position* in that list and taskLines() in tasks.js recounts it the same way
 * on the server -- the two walks have to agree line for line (tasks.js says
 * what happens when they do not, and test/queue.test.js pins it).
 *
 * The numbering happens here, once, before anything downstream groups or hides
 * anything. So sectionize() may regroup these blocks and the pane may fold them
 * without renumbering a thing. Anything that wants to change *which lines
 * count* belongs in tasks.js, where both sides read it.
 */
export function blocks(text) {
  const out = [];
  let index = 0;

  for (const chunk of fences(withoutHtml(text))) {
    // A fence is not markdown, so nothing inside it is a heading, a task or a
    // list -- which is why this repo's own description can show a `## Queue`
    // sample without growing a fold, and a `- [ ]` sample without growing a
    // checkbox the server would refuse.
    if (chunk.code !== undefined) {
      out.push({ kind: 'code', code: chunk.code });
      continue;
    }
    for (const para of chunk.text.split(/\n{2,}/).filter(Boolean)) {
      let prose = [];
      let list = null;
      // Prose and a list are the two things that can be open, never both: every
      // branch that opens one closes the other, which is what keeps the output
      // in body order.
      const flush = () => {
        if (prose.length) out.push({ kind: 'p', text: prose.join('\n') });
        if (list) out.push(list);
        prose = [];
        list = null;
      };
      for (const line of para.split('\n')) {
        const task = TASK.exec(line);
        if (task) {
          flush();
          out.push({
            kind: 'task', done: task[1].toLowerCase() === 'x', text: task[2], index: index++,
          });
          continue;
        }
        // A heading is one line, so it is handled here rather than per
        // paragraph: one can open a paragraph that runs straight on into prose.
        const head = HEADING.exec(line);
        if (head) {
          flush();
          out.push({ kind: 'heading', level: head[1].length, text: head[2] });
          continue;
        }

        const num = ORDERED.exec(line);
        const bul = num ? null : BULLET.exec(line);
        if (num || bul) {
          // A change of marker starts a new list, the way GitHub renders it.
          if (list && list.ordered !== Boolean(num)) flush();
          if (prose.length) flush();
          list ??= { kind: 'list', ordered: Boolean(num), start: num ? Number(num[1]) : 1, items: [] };
          list.items.push(num ? num[2] : bul[1]);
          continue;
        }
        // A plain line under a list item is that item wrapping, not new prose.
        // Descriptions arrive from an editor with no hard wrap, and this repo's
        // own bullets run to four hundred characters.
        if (list) {
          list.items[list.items.length - 1] += `\n${line.trim()}`;
          continue;
        }
        prose.push(line);
      }
      flush();
    }
  }
  return out;
}

/**
 * A bullet needs its space, the way a heading does: `-flag` and `--body-file`
 * are prose, and this repo's own description is full of both.
 *
 * Both are matched *after* TASK, which matches `- [ ] x` as well. A checklist
 * line rendered as a bullet is a line that never gets an index, and every tick
 * after it in the body would then address the line above -- so the order of
 * those two tests in blocks() is load-bearing, and test/pr.test.js pins it.
 *
 * One level only. Leading whitespace is allowed but not counted, so an indented
 * sub-bullet becomes a sibling rather than being lost or mis-parsed: at 375px
 * there is nothing to indent into, and a real indent stack would need a notion
 * of a line that tasks.js does not have.
 */
export const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
/** `1.` and `1)`, the two GitHub renders. The author's start number is kept. */
export const ORDERED = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;

/** One block as an element. The DOM half of blocks(); everything above is pure. */
const blockNode = (b, onTask) => ({
  // textContent, not inline(): the point of a fence is that what is inside it
  // is not markdown.
  code: () => h('pre', {}, h('code', { textContent: b.code })),
  p: () => h('p', { innerHTML: inline(b.text) }),
  // Offset by two: the pane's own <h1> names it and the PR title is the <h2>,
  // so a description's top-level heading sits under both.
  heading: () => h(`h${Math.min(b.level + 2, 6)}`, { innerHTML: inline(b.text) }),
  task: () => taskRow(b, onTask),
  list: () => h(b.ordered ? 'ol' : 'ul', b.start > 1 ? { start: b.start } : {},
    ...b.items.map((t) => h('li', { innerHTML: inline(t) }))),
}[b.kind]());

/**
 * The description as an outline: everything before the first heading, then one
 * section per heading at the *shallowest* level the body actually uses.
 *
 * Deriving that level from the body rather than fixing one here is what lets a
 * description written with `#` and one written with `##` each fold at their own
 * top level -- prcoder's own mirrored block writes `## TODO`, and a description
 * someone typed may well start at `#`. Anything deeper stays a plain heading
 * inside the section it belongs to.
 *
 * Regrouping only. Every block comes out exactly once, in the order it went in,
 * carrying the `index` it went in with -- see blocks() for why that is the whole
 * safety argument for folding at all.
 */
export function sectionize(list) {
  const levels = list.filter((b) => b.kind === 'heading').map((b) => b.level);
  const top = Math.min(...levels);   // Infinity for a body with no headings
  if (!Number.isFinite(top)) return { lead: list, sections: [] };

  const lead = [];
  const sections = [];
  const seen = new Map();
  for (const b of list) {
    if (b.kind === 'heading' && b.level === top) {
      // Keyed by its own text, so the key survives the poll rebuilding this
      // list and survives a section being added above it -- an index would not.
      // A description with two `## Why` gets `Why` and `Why#2`: duplicates are
      // rare, and an ordinal is cheaper than pretending they cannot happen.
      const n = (seen.get(b.text) ?? 0) + 1;
      seen.set(b.text, n);
      sections.push({ title: b.text, key: n === 1 ? b.text : `${b.text}#${n}`, nodes: [] });
    } else (sections.at(-1)?.nodes ?? lead).push(b);
  }
  return { lead, sections };
}

/**
 * One section, collapsed behind its heading.
 *
 * A native <details> rather than a toggle of our own, for one reason above the
 * free keyboard operation and disclosure semantics: a closed <details> keeps its
 * subtree in the DOM. The obvious hand-rolled version builds a section's body
 * when it is first opened, and that is exactly the thing that would break the
 * checklist index -- an unopened section's task lines would never be counted,
 * and every tick after it would address the line above. Native removes the
 * temptation.
 *
 * Not `name=`, which would make these an accordion. The decision was that each
 * section folds, not that only one may be open: closing what someone is reading
 * because they opened the next one is worse than either.
 */
function sectionNode(s, onTask) {
  const tasks = s.nodes.filter((b) => b.kind === 'task');
  const d = h('details', { className: 'md-section', open: openSections.has(s.key) },
    h('summary', {},
      h('h3', {}, s.title),
      // So a fold never hides work without saying so.
      tasks.length
        ? h('span', { className: 'count' }, `${tasks.filter((b) => b.done).length}/${tasks.length}`)
        : null),
    h('div', { className: 'sec-body' }, ...s.nodes.map((b) => blockNode(b, onTask))));
  // Assigned after: `dataset` is a readonly accessor, so h()'s Object.assign
  // cannot reach it. fileRow does the same.
  d.dataset.key = s.key;
  // Fires for a click and for the `open` above, which re-adds a key already in
  // the set -- idempotent either way.
  d.addEventListener('toggle', () => {
    if (d.open) openSections.add(s.key); else openSections.delete(s.key);
  });
  return d;
}

/**
 * The description: the lead as it is, everything after the first heading folded.
 *
 * Collapsed by default, and the open set is deliberately not persisted -- a
 * description you finished reading yesterday reopening itself today is how the
 * pane becomes what this was written to fix.
 */
function description(body, onTask) {
  const { lead, sections } = sectionize(blocks(body));
  // A description that is one heading and nothing else would fold to a single
  // line showing nothing at all.
  if (!lead.length && sections.length === 1) openSections.add(sections[0].key);
  return [
    ...lead.map((b) => blockNode(b, onTask)),
    ...sections.map((sec) => sectionNode(sec, onTask)),
  ];
}

// A heading needs its space: `#hashtag` is prose, and rendering it as a heading
// would swallow the line.
export const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * The three pieces of raw HTML a PR description actually contains, dealt with
 * before anything is escaped. Everything else stays escaped and shows as text:
 * this is an allowlist of three, not the beginning of an HTML renderer.
 *
 * Comments go because GitHub hides them and prcoder's own block markers are
 * comments -- without this the pane shows a literal marker above the list it
 * delimits.
 *
 * `<details>` is unwrapped rather than reproduced. It used to be because the
 * pane merely scrolled and a collapsed half was usually history; now it is the
 * better reason: the pane folds its own sections, so an author's fold and
 * prcoder's are the same idea twice. Unwrapping it and promoting its summary to
 * a heading feeds it into that machinery instead of nesting inside it.
 *
 * Every substitution here must leave the body's *lines* where they are.
 * blocks() runs on the output and taskLines() runs on the raw body, and the two
 * counts of checklist lines have to match -- so anything added here that could
 * delete or merge a line containing a `- [ ]` breaks the tick, silently.
 */
export const withoutHtml = (text) => (text ?? '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\/?details[^>]*>/g, '')
  .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/g,
    (_, t) => `#### ${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`);

/** A checkbox in the description, ticked through to GitHub. */
function taskRow({ done, text, index }, onTask) {
  const box = h('input', { type: 'checkbox', checked: done, title: 'tick this on GitHub' });
  const row = h('label', { className: `task${done ? ' done' : ''}` },
    box, h('span', { innerHTML: inline(text) }));
  writeThrough(box, (v) => onTask({ index, done: v, text }),
    (v) => row.classList.toggle('done', v));
  return row;
}

/**
 * Code spans are lifted out before anything else runs and put back last, so no
 * other rule can reach inside one. Without that `PRCODER_NO_OPEN` italicises
 * its own middle, and a URL in backticks becomes a link inside a <code>.
 *
 * Emphasis comes after bold, so `**x**` is already <strong> by the time the
 * single-asterisk rule looks. The underscore form needs a non-word character
 * either side or it eats snake_case; the asterisk form needs no such guard,
 * because a bare `*` mid-word is vanishingly rare in prose and common only in
 * globs, which live in code spans and are already out of reach.
 */
export const inline = (s) => {
  const code = [];
  return escape(s)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\n/g, '<br>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
};

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
