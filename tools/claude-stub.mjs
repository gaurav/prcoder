#!/usr/bin/env node
// A stand-in for `claude` in the drivers, spawned as CLAUDE_BIN.
//
// It was /bin/cat, which echoes -- and an echo is the same burst of output a
// turn is made of, which is all the tab icon's busy state needs. But a real
// session is not silent between turns: Claude asks the terminal where the
// cursor is every ~200ms, forever, and an icon that counts any byte as work
// never goes back to idle. cat never asks, so the driver could not see it.
//
// So: echo like cat, and probe like Claude.
//
// Two things cat gets wrong once there is a probe. Raw mode, because the tty's
// own echo would send the answers back as output on top of the deliberate echo
// below; and the filter, because a real session reads the answer to its
// question rather than printing it. Leave either out and the reply is output,
// which is the state this is here to tell apart.
process.stdin.setRawMode?.(true);
process.stdin.on('data', (b) => process.stdout.write(String(b).replace(/\x1b\[\?[\d;]*R/g, '')));
setInterval(() => process.stdout.write('\x1b[?6n'), 200);
