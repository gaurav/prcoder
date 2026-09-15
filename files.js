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
