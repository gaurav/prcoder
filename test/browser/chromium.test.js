// suite.js in Chromium. firefox.test.js is the same suite in the other engine.
process.env.PRCODER_TEST_BROWSER = 'chromium';
await import('./suite.js');
