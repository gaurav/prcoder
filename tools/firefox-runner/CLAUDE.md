Read README.md in this directory before changing anything here or debugging a
Firefox launch. It is one problem -- macOS 27 denies a terminal-launched Firefox
its own app-data directory -- and the README carries the cause, the upstream
bugs, and the `MOZ_APP_DATA` workaround `tools/browser.mjs` depends on. The
diagnosis history, including the hypotheses already eliminated, is in #61. A
fresh look at the same failure costs a re-read rather than an afternoon.

The workaround is temporary: #80 says when it comes out and what goes with it.
Don't widen it -- a new Firefox launch elsewhere should use the same variables
and the same `data/firefox-appdata/`, so that #80 is still one search.

`PRCODER_BROWSER=chromium` is the way past it for any work that is not about
Firefox itself.
