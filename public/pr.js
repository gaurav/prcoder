// Skips absent sections; DOM append() would render them as the text "null".
const kids = (list) => list.flat().filter((k) => k != null);

// Small helper: build an element and append children.
export function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids(children));
  return node;
}

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

export function renderPr(pr, handlers) {
  const host = document.getElementById('pr-body');

  host.replaceChildren(...kids([
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
    h('div', { className: 'body md' }, ...markdown(pr.body, handlers.onTask)),
    issues(pr.issues),
    h('div', { className: 'meta' },
      h('a', { href: `${pr.url}#issuecomment`, target: '_blank', rel: 'noopener' },
        `${pr.counts.comments} comments · ${pr.counts.reviews} reviews ↗`)),
    ...GROUPS.map(([key, label]) => fileGroup(label, pr.groups[key], handlers)),
  ]));
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

// Two rows, because the two kinds of link mean different things: one set closes
// on merge, the other is only mentioned in the body. The row label says which,
// so the chips stay bare numbers.
function issues(list) {
  return [['Closes:', true], ['Mentions:', false]].map(([label, closes]) => {
    const kind = list.filter((i) => i.closes === closes);
    if (!kind.length) return null;
    return h('div', { className: 'issues' },
      h('span', { className: 'issues-label' }, label),
      ...kind.map((i) => h('a', { href: i.url, target: '_blank', rel: 'noopener', title: i.title ?? '' },
        `#${i.number}`)));
  });
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

// The same checklist line GitHub renders as a checkbox, and the same one
// queue.js parses server-side. The two patterns have to agree on which lines
// are checkboxes, because a tick is sent as a position in that list --
// test/queue.test.js walks a body through both to keep them honest.
export const TASK = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/;

/**
 * Just enough markdown for a PR description: links, code, headings, lists --
 * and checklists as real checkboxes, which are the point of reading a
 * description in a pane rather than on github.com. `index` counts every
 * checklist line in the body, in order, which is how the server finds the line
 * again; prose either side of a run of them stays in its own paragraph.
 */
function markdown(text, onTask) {
  const out = [];
  let index = 0;

  for (const chunk of fences(withoutHtml(text))) {
    // textContent, not inline(): the point of a fence is that what is inside it
    // is not markdown.
    if (chunk.code !== undefined) {
      out.push(h('pre', {}, h('code', { textContent: chunk.code })));
      continue;
    }
    for (const para of chunk.text.split(/\n{2,}/).filter(Boolean)) {
      let prose = [];
      const flush = () => {
        if (prose.length) out.push(h('p', { innerHTML: inline(prose.join('\n')) }));
        prose = [];
      };
      for (const line of para.split('\n')) {
        const task = TASK.exec(line);
        if (task) {
          flush();
          out.push(taskRow(task[1].toLowerCase() === 'x', task[2], index++, onTask));
          continue;
        }
        // A heading is one line, so it is handled here rather than per
        // paragraph: one can open a paragraph that runs straight on into prose.
        const head = HEADING.exec(line);
        if (head) {
          flush();
          // Offset by two: the pane's own <h1> names it and the PR title is the
          // <h2>, so a description's top-level heading sits under both.
          out.push(h(`h${Math.min(head[1].length + 2, 6)}`, { innerHTML: inline(head[2]) }));
          continue;
        }
        prose.push(line);
      }
      flush();
    }
  }
  return out;
}

// A heading needs its space: `#hashtag` is prose, and rendering it as a heading
// would swallow the line.
export const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * The body cut into fenced blocks and the text between them, in order. Fences
 * come out before paragraphs are split on blank lines, because a fence is
 * allowed to contain them.
 *
 * A checklist line inside a fence is code, not a checkbox -- and toggleTask in
 * queue.js skips fenced lines for the same reason. A tick is sent as a position
 * in the list of checklist lines, so the two counts have to agree; that they do
 * is pinned in test/queue.test.js.
 */
export function fences(body) {
  const out = [];
  const re = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push({ text: body.slice(last, m.index) });
    out.push({ code: m[1].replace(/\n$/, '') });
    last = re.lastIndex;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/**
 * The three pieces of raw HTML a PR description actually contains, dealt with
 * before anything is escaped. Everything else stays escaped and shows as text:
 * this is an allowlist of three, not the beginning of an HTML renderer.
 *
 * Comments go because GitHub hides them and prcoder's own block markers are
 * comments -- without this the pane shows a literal marker above the list it
 * delimits. `<details>` is unwrapped rather than reproduced: the pane already
 * scrolls, and a description's collapsed half is usually its history. Its
 * summary is the heading of what follows, so it becomes one.
 */
export const withoutHtml = (text) => (text ?? '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\/?details[^>]*>/g, '')
  .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/g,
    (_, t) => `#### ${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`);

/** A checkbox in the description, ticked through to GitHub. */
function taskRow(done, text, index, onTask) {
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
