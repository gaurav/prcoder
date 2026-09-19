// Grouping changed files by what they tell you, and linking them into GitHub's
// diff viewer.

import { createHash } from 'node:crypto';

const TEST = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)test_[^/]+$|[._-](test|spec)\.[^./]+$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|json|ya?ml|toml|ini|cfg|lock)$/i;
const DOC_PATH = /(^|\/)(docs?|\.github)\/|(^|\/)(LICENSE|CHANGELOG|NOTICE)$|(^|\/)\.[^/]+$/i;

/** Tests first: they are the fastest way to see what functionality changed. */
export function groupFiles(files) {
  const groups = { tests: [], code: [], docs: [] };
  for (const f of files) groups[bucket(f.path)].push(f);
  return groups;
}

export function bucket(p) {
  if (TEST.test(p)) return 'tests';
  if (DOC_EXT.test(p) || DOC_PATH.test(p)) return 'docs';
  return 'code';
}

/** GitHub anchors each file in a diff by the sha256 of its path. */
export function diffAnchor(p) {
  return 'diff-' + createHash('sha256').update(p).digest('hex');
}

export function fileUrl(prUrl, p) {
  return `${prUrl}/files#${diffAnchor(p)}`;
}

/**
 * The whole file as this pull request leaves it, in the three views GitHub has
 * of it. A patch cannot show any of them: the parts nobody touched, a Markdown
 * file rendered rather than as source (`blob`), who last touched each of the
 * lines around a hunk (`blame`), or what else has landed in the file
 * (`history`).
 *
 * One function because the three differ by a path segment and nothing else --
 * GitHub's own URLs are `/blob/`, `/blame/` and `/commits/` over the same ref
 * and path.
 *
 * Pinned to the head commit rather than the branch name, so they keep saying
 * what the pane was showing after another push. The commit is enough for a
 * fork's pull request too, and that is not an assumption: GitHub keeps the head
 * of an open PR in the *base* repository, so a fork's sha resolves under the
 * base repo's URL. Checked 2026-09-16 against cli/cli#14373, a cross-repository
 * PR -- `/cli/cli/blob/682398a/docs/install_linux.md` answered 200.
 */
export function fileViews(prUrl, sha, p) {
  const repo = prUrl.replace(/\/pull\/\d+$/, '');
  return {
    blob: `${repo}/blob/${sha}/${p}`,
    blame: `${repo}/blame/${sha}/${p}`,
    history: `${repo}/commits/${sha}/${p}`,
  };
}
