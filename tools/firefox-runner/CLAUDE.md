Read README.md in this directory before changing anything here or debugging a
Firefox launch. It is one problem -- macOS 27 denies a terminal-launched Firefox
its own app-data directory -- and the README carries the cause, the upstream
bugs, and the `MOZ_APP_DATA` workaround `tools/browser.mjs` depends on. The
diagnosis history, including the hypotheses already eliminated, is in #61. A
fresh look at the same failure costs a re-read rather than an afternoon.

The workaround is temporary: #80 says when it comes out and what goes with it.
Don't widen it -- a new driver launches through `launchBrowser()` in
`tools/driver.mjs`, and anything else that starts Firefox takes the variables
from `firefoxEnv()` there, so that #80 is still one file.
