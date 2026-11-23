// The first half of suite.js in Chromium; chromium-2.test.js is the second,
// and firefox-1.test.js and firefox-2.test.js the same suite in the other engine.
process.env.PRCODER_TEST_BROWSER = 'chromium';
process.env.PRCODER_TEST_HALF = '1';
await import('./suite.js');
