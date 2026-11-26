// The second half of suite.js in Firefox; firefox-1.test.js says why Firefox.
process.env.PRCODER_TEST_BROWSER = 'firefox';
process.env.PRCODER_TEST_HALF = '2';
await import('./suite.js');
