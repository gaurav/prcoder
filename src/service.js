// A small service with several functions, so that a change to two of them
// makes two hunks, each named by git after the function it sits in.

export function parseQuery(text) {
  const out = {};
  for (const pair of text.split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key) out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}

export function formatQuery(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function retry(fn, times) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
