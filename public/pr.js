// Small helper: build an element and append children.
export function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) node.append(k);
  return node;
}

const GROUPS = [
  ['tests', 'Tests'],
  ['code', 'Code'],
  ['docs', 'Config & docs'],
];

/**
 * The header is the one part of this pane that is never blown away, so the
 * switcher and the light live there — a poll landing mid-click would otherwise
 * close an open dropdown.
 */
export function renderHeader(status, prs, { onSwitch, onCommit }) {
  const sel = document.getElementById('pr-switch');
  const commit = document.getElementById('pr-commit');
  const light = document.getElementById('pr-sync');

  // Rebuilt only when the set of PRs changes, so the open list survives a poll.
  const keys = prs.map((p) => p.number).join(',');
  if (sel.dataset.keys !== keys) {
    sel.dataset.keys = keys;
    sel.replaceChildren(
      h('option', { value: '' }, prs.length ? 'no pull request' : 'no open pull requests'),
      ...prs.map((p) => h('option', { value: String(p.number) },
        `#${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title}`)),
    );
    sel.onchange = () => sel.value && onSwitch(Number(sel.value));
  }
  // Always re-assert: a failed switch has to snap back to the real branch.
  sel.value = status.pr ? String(status.pr.number) : '';

  // Uncommitted work would make `gh pr checkout` fail, so offer the fix instead
  // of the switch. Claude is right there in the next pane.
  const blocked = status.dirty;
  sel.hidden = blocked || status.scope === 'other-repo';
  commit.hidden = !blocked;
  commit.onclick = () => onCommit(status.dirtyFiles);
  commit.textContent = `Commit ${status.dirtyFiles.length} file${status.dirtyFiles.length === 1 ? '' : 's'}…`;

  light.className = '';
  light.hidden = false;
  if (status.error) { light.className = 'unknown'; light.textContent = 'offline'; }
  else if (status.scope === 'other-repo') light.textContent = 'another repo';
  else if (status.scope === 'other-branch') light.textContent = 'not checked out';
  else if (status.sync === 'ahead') { light.className = 'warn'; light.textContent = `${status.ahead} unpushed`; }
  else if (status.sync === 'behind') { light.className = 'warn'; light.textContent = 'pull needed'; }
  else if (status.sync === 'diverged') { light.className = 'warn'; light.textContent = 'diverged'; }
  else if (status.sync === 'unpushed') { light.className = 'warn'; light.textContent = 'not pushed'; }
  else if (status.detached) light.textContent = 'detached HEAD';
  else light.hidden = true;
}

/** The pane with no PR to show: why, and the one thing worth doing about it. */
export function renderNoPr(status, { onCreate }) {
  const host = document.getElementById('pr-body');

  if (status.error) {
    return host.replaceChildren(
      h('p', { className: 'empty' }, 'Could not reach GitHub.'),
      h('p', { className: 'pr-note' }, String(status.error)));
  }

  const why = status.detached ? 'HEAD is detached — no branch to open a pull request for.'
    : status.onDefaultBranch ? `You are on ${status.branch}. Make a branch to start a pull request.`
    : `No pull request for ${status.branch} yet.`;

  // Comparing a branch with itself opens an empty diff, so on main there is
  // nothing to offer — the fix is a branch, not a button.
  const can = !status.detached && !status.onDefaultBranch;
  const btn = h('button', { className: 'pr-create', disabled: !can }, 'Create a pull request');
  if (can) btn.onclick = () => onCreate(btn);

  host.replaceChildren();
  append(host,
    h('p', { className: 'empty' }, why),
    status.sync === 'unpushed' && can
      ? h('p', { className: 'pr-note' }, 'This branch is not on GitHub yet; it will be pushed first.')
      : null,
    btn,
  );
}

export function renderPr(pr, { onViewed }) {
  const host = document.getElementById('pr-body');
  host.replaceChildren();

  if (!pr) {
    host.append(h('p', { className: 'empty' }, 'No pull request for this branch.'));
    return;
  }

  append(host,
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
    h('div', { className: 'body md' }, ...markdown(pr.body)),
    issues(pr.issues),
    h('div', { className: 'meta' },
      h('a', { href: `${pr.url}#issuecomment`, target: '_blank', rel: 'noopener' },
        `${pr.counts.comments} comments · ${pr.counts.reviews} reviews ↗`)),
    ...GROUPS.map(([key, label]) => fileGroup(label, pr.groups[key], onViewed)),
  );
}

/** Skips absent sections; DOM append() would render them as the text "null". */
const append = (host, ...kids) => host.append(...kids.flat().filter((k) => k != null));

const badge = (text, kind) => h('span', { className: `badge ${kind}` }, text);

function checks({ passed, failed, pending }) {
  if (!passed && !failed && !pending) return null;
  return h('div', { className: 'meta' },
    failed ? badge(`${failed} failing`, 'fail') : null,
    pending ? badge(`${pending} pending`, 'pend') : null,
    passed ? badge(`${passed} passing`, 'pass') : null,
  );
}

function issues(list) {
  if (!list.length) return null;
  return h('div', { className: 'issues' },
    ...list.map((i) => h('a', { href: i.url, target: '_blank', rel: 'noopener', title: i.title ?? '' },
      `${i.closes ? 'closes ' : ''}#${i.number}`)));
}

function fileGroup(label, files, onViewed) {
  if (!files?.length) return null;
  const seen = files.filter((f) => f.viewed).length;
  return h('section', { className: 'group' },
    h('h3', {}, `${label} `, h('span', { className: 'count' }, `${seen}/${files.length}`)),
    ...files.map((f) => fileRow(f, onViewed)),
  );
}

function fileRow(f, onViewed) {
  const box = h('input', { type: 'checkbox', checked: f.viewed, title: 'mark viewed on GitHub' });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try { await onViewed(f.path, box.checked); } catch { box.checked = !box.checked; }
    box.disabled = false;
    row.classList.toggle('viewed', box.checked);
  });
  const row = h('div', { className: `file${f.viewed ? ' viewed' : ''}` },
    box,
    h('a', { href: f.url, target: '_blank', rel: 'noopener', className: 'path', title: f.path },
      f.path),
    h('span', { className: 'nums' },
      h('span', { className: 'add' }, `+${f.additions}`), ' ',
      h('span', { className: 'del' }, `−${f.deletions}`)),
  );
  return row;
}

/** Just enough markdown for a PR description: links, code, headings, lists. */
function markdown(text) {
  return (text ?? '').split(/\n{2,}/).filter(Boolean).map((para) => {
    const p = h('p');
    p.innerHTML = escape(para)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\n/g, '<br>');
    return p;
  });
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
