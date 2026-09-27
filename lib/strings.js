// Renamed by the pull request with one line changed, so the diff pane shows
// where it came from above the hunk.
export const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const words = (s) => s.trim().split(/\s+/);
export const initials = (s) => words(s).map((w) => w[0]).join('');
