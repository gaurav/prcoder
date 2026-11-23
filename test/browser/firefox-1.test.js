// The first half of suite.js in Firefox; firefox-2.test.js is the second.
// prcoder is used in Firefox, and the engines disagree on layout often enough
// that a test written against one has been wrong in the other -- the ⟳'s
// header height was, on 2026-09-26.
process.env.PRCODER_TEST_BROWSER = 'firefox';
process.env.PRCODER_TEST_HALF = '1';
await import('./suite.js');
