// Renamed by the pull request with no other change, so the diff pane shows
// only where it came from.
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const percent = (part, whole) => `${Math.round((100 * part) / whole)}%`;
