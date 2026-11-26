// The second half of suite.js in Chromium; chromium-1.test.js says more.
process.env.PRCODER_TEST_BROWSER = 'chromium';
process.env.PRCODER_TEST_HALF = '2';
await import('./suite.js');
