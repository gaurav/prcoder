// test/browser.test.js again, in Firefox. prcoder is used in Firefox, and the
// engines disagree on layout often enough that a test written against one has
// been wrong in the other -- the ⟳'s header height was, on 2026-09-26. The suite
// takes its engine from the environment, so this sets it and loads the suite;
// `node --test` runs each file in a process of its own, so the two runs never
// share a browser or a server.
process.env.PRCODER_TEST_BROWSER = 'firefox';
await import('./browser.test.js');
