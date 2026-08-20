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
