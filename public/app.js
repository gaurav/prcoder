import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { renderPr, renderNoPr, renderHeader, pageTitle, api, toast, pref, setPref, debug } from './pr.js';
import { openDiff, closeDiff, selectedPath, setViewed, toggleWrap, openMention } from './diff.js';
import { initQueue, addItem, setItems } from './queue.js';
import { bindKeys, keyName } from './keys.js';
import { fold, folded, canFold } from './folds.js';
import './panes.js';   // draggable pane gutters; nothing here calls into it

// Every shortcut the page has, in one table; keys.js says what a binding may
// and may not do. W for wrap: no browser binds Alt+W, and the owner chose it
// over VS Code's Alt+Z. M for mention, the diff header's @: not Alt+2, the key
// @ is on, because Chrome and Firefox on Linux and Windows switch tabs with
// Alt+digit, and M is none of Firefox's menu letters.
bindKeys({ 'Alt+KeyW': toggleWrap, 'Alt+KeyM': mentionOpenFile });

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 14,   // one step up from the default, matching the panes' 14px body
  cursorBlink: true,
  theme: { background: '#1c1f26', foreground: '#d5d9e0' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
term.open(document.getElementById('term-host'));
// Alt+M is the one shortcut that also fires from the terminal, since that is
// where you are when you want it: halfway through typing a request about the
// open file. xterm handles its keydowns itself and stops them there, so the
// document listener bindKeys installs never sees this one -- the hook has to
// be xterm's. The agent no longer gets Alt+M: µ on a Mac, ESC m elsewhere.
term.attachCustomKeyEventHandler((e) => {
  if (keyName(e) !== 'Alt+KeyM') return true;
  if (e.type === 'keydown') {
    e.preventDefault();
    mentionOpenFile();
  }
  return false;
});

const PTY_SEEN = 'prcoder:pty';
// The server serves only public/, so the docs are linked where they live.
const PORTS_DOC = 'https://github.com/gaurav/prcoder/blob/main/docs/Ports.md#finding-it-again';
// Replaced, not reopened, by the exit panel's "Start coding agent": one
// socket is one PTY.
let ws;
// `WebSocket.OPEN` is read off the global constructor, so a Playwright init
// script that wraps `window.WebSocket` without copying its four state statics
// makes it undefined. Every send then returns false, and the page silently
// stops talking to the PTY, with no error and no closed socket.
const send = (msg) => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  // A line sent is the start of a turn -- Enter in the terminal, or an item
  // sent from the queue, which appends its own. See the tab icon below.
  if (msg.type === 'input' && msg.data.endsWith('\r')) turn(true);
  return true;
};

// A splitter drag resizes #term-host on every frame, but the PTY only cares
// when the character grid changes — which is every few pixels at most. `sent`
// records what the *server* was told, so a resize dropped while the socket was
// still opening is re-sent by the sync() in ws.onopen rather than skipped.
let sent = '';
const sync = () => {
  fit.fit();
  const dims = `${term.cols}x${term.rows}`;
  if (dims !== sent && send({ type: 'resize', cols: term.cols, rows: term.rows })) sent = dims;
};

// The tab icon, blue while a turn is running, so a session left in a
// background tab says whether it is still going without switching to it. The
// folded pane's header says the same with `● working`, from the same state, so
// a session you folded away says when it is done without unfolding it.
// The PTY carries no "thinking" signal and nothing here reads the frames, so a
// turn is bracketed rather than detected: sending a line starts one, and the
// output holds it open. Claude repaints its spinner every few hundred ms
// mid-turn -- measured 2026-09-11 against a turn with a 12s tool call in it, no
// gap ran over 750ms until the turn ended -- so 2s of quiet is the end of one.
//
// Output cannot *start* a turn, because a PTY echoes what is typed at it:
// Claude repainting its prompt as you type is output too, and keying off that
// alone turned the icon busy while it was waiting on the operator -- which is
// the one state it exists to tell apart.
//
// Amber is deliberately not used: it is held for the third state, "stopped to
// ask you something", which prcoder cannot see yet -- issue #51.
//
// One sequence has to come out of the signal even so, because it is a question
// rather than output, and it arrives *during* a turn where the bracketing above
// cannot help: Claude asks the terminal where the cursor is (DSR,
// `ESC [ ? 6 n`) every ~200ms for as long as the session is up, and xterm
// answers every one, so the stream is never quiet for two seconds and a turn
// once started never ended. It only happens against a terminal that answers:
// measured 2026-09-12 against a bare PTY with nothing replying, Claude asks
// once and never again, which is why a driver on a `cat` stub saw nothing
// wrong. Dropping a frame that is nothing but probes is not parsing the TUI --
// it is a question for the terminal, answered by the terminal, and this never
// looks at anything Claude drew.
const PROBE = /^(?:\x1b\[\?6n)+$/;
const link = document.querySelector('link[rel=icon]');
const busyLabel = document.getElementById('term-busy');
// Derived, not written out a second time -- so the icon in index.html stays the
// one definition of it. Change its colour there and change this to match.
const IDLE = link.href;
const BUSY = IDLE.replace('%23238636', '%231f6feb');
// Re-inserted rather than mutated in place: browsers disagree about whether an
// href changed on a live <link rel=icon> is noticed at all.
// Tracked here rather than read back off the element: `link.href` returns the
// URL re-resolved, and a compare against that is a compare against something
// the browser wrote, not something this did.
let shown = IDLE;
const icon = (href) => {
  if (shown === href) return;
  shown = link.href = href;
  link.remove();
  document.head.append(link);
  // Here rather than in turn(): the quiet timer ends a turn through icon()
  // alone, and this is the one place the two can never disagree.
  busyLabel.hidden = href !== BUSY;
};
let quiet;
const turn = (on) => {
  clearTimeout(quiet);
  icon(on ? BUSY : IDLE);
  // ponytail: typing during a turn echoes, and the echo holds the turn open, so
  // busy can outlast the turn's real end by as long as you keep typing. Closing
  // that needs what the frames say rather than when they arrive -- see #51,
  // which is the same wall from the other side.
  if (on) quiet = setTimeout(() => icon(IDLE), 2000);
};
// `query` is the exit panel's settings, which the server turns into claude's
// flags (sessionArgs in server.js). The first socket sends none.
let sockets = 0;
function connect(query = '') {
  sockets++;
  ws = new WebSocket(`ws://${location.host}/pty${query && `?${query}`}`);
  ws.onmessage = (e) => {
    term.write(e.data);
    if (PROBE.test(e.data)) return;
    if (shown === BUSY) turn(true);   // holds an open turn open; cannot start one
  };
  // A tab the browser unloaded in the background comes back as a fresh page, and
  // the socket it closed on the way out has already killed the PTY — so this is a
  // new Claude session nobody asked for. sessionStorage is per-tab and survives
  // the restore, which is exactly what tells that apart from a first open. A
  // deliberate reload lands here too, and the message is just as true there.
  // Starting the agent again from the exit panel does not: you asked for that
  // one, and chose whether to continue.
  ws.onopen = () => {
    sent = '';   // a new PTY starts at 80x24, whatever the last one was told
    sync();
    term.focus();
    if (sockets > 1) return;
    try {
      if (sessionStorage.getItem(PTY_SEEN)) {
        // Not the error style: the session did end, but on a deliberate reload
        // that is the answer to what you just did, not something that went wrong.
        // A tab the browser unloaded is different: nobody asked, and the fix is
        // in the browser, not here (Ports.md, "Tab unloaders"). Sticky, since a
        // link needs longer than 4s to click.
        //
        // Only document.wasDiscarded, Chrome's, says so for certain. Elsewhere a
        // restored tab is just a load that was not a reload, and so are Back to
        // a tab you navigated away from and a duplicated tab, which copies
        // sessionStorage (and whose original is still running). Firefox's
        // restore can't be driven to see which type it reports, so none of them
        // is ruled out: they share a toast that names the other causes rather
        // than claiming the browser did it.
        const nav = performance.getEntriesByType('navigation')[0]?.type;
        const unloaders = { href: PORTS_DOC, text: 'Keep tab unloaders off prcoder' };
        if (document.wasDiscarded) {
          toast('The browser unloaded this tab, and the coding agent\'s session went with it. '
            + '/resume picks it back up, or start prcoder with -- --continue.', false, true, unloaders);
        } else if (nav && nav !== 'reload') {
          toast('This page was loaded again, so the coding agent started a new session here. If you '
            + 'didn\'t come back to it or duplicate it yourself, the browser unloaded the tab. '
            + '/resume picks the old session back up, or start prcoder with -- --continue.',
          false, true, unloaders);
        } else {
          toast('Claude was restarted — this tab\'s previous session ended when it disconnected. '
            + '/resume picks it back up, or start prcoder with -- --continue.');
        }
      }
      sessionStorage.setItem(PTY_SEEN, '1');
    } catch { /* private mode: no memory, so no claim about a previous session */ }
  };
  // 1008 is the server refusing before the spawn (sameOrigin, sessionArgs), so
  // no agent ever ran: say why, since after a start-again with a model it would
  // not take, the reason is the only clue that the setting was the problem.
  ws.onclose = (e) => {
    turn(false);
    const why = e.code === 1008 ? `refused: ${e.reason}` : 'coding agent exited';
    term.write(`\r\n\x1b[31m[${why}]\x1b[0m\r\n`);
    // The bar's note repeats the terminal's line, not the reason: that is
    // already there in red, a line up.
    exitForm.querySelector('span').textContent = e.code === 1008 ? 'Start refused.' : 'Coding agent has exited.';
    exitForm.hidden = false;
    // Refit now rather than waiting on the ResizeObserver: in a page that isn't
    // in front it never delivered the shrink, and the terminal went on
    // covering the bar -- Playwright could not click Quit (2026-09-23).
    sync();
    // Start, not the first button: Quit is first in the bar, and Enter after
    // an exit should start again rather than ask about quitting.
    document.getElementById('term-start').focus();
  };
}

// What to do once Claude is gone: start it again, perhaps differently, or stop
// prcoder from here rather than from the terminal it was started in.
const exitForm = document.getElementById('term-exit');
// Filled once, with what prcoder's command line started the agent with. Never
// reset after, so the next exit offers whatever the last start chose instead.
// Only into a field still blank: one already set was set by you, or by a start
// from the bar, and a reply landing late must not take it back. An effort the
// select has no option for (`--effort extreme`) gets one: setting a select to
// a value it lacks blanks it, which shows "as started" rather than the value.
api('/api/whoami', undefined, 'GET').then(({ started }) => {
  const { model, effort } = exitForm.elements;
  if (!model.value) model.value = started.model;
  if (effort.value || !started.effort) return;
  if (![...effort.options].some((o) => o.value === started.effort)) effort.add(new Option(started.effort));
  effort.value = started.effort;
}).catch(() => { /* blank fields still mean "as started" */ });
exitForm.onsubmit = (e) => {
  e.preventDefault();
  exitForm.hidden = true;
  term.reset();
  connect(new URLSearchParams(new FormData(exitForm)).toString());
};
document.getElementById('term-quit').onclick = async () => {
  try {
    let r = await api('/api/quit', {});
    // The same question the terminal's q asks, put where you are.
    if (r.risk) {
      if (!confirm(`Quit prcoder? ${r.risk.join('; ')}.`)) return;
      r = await api('/api/quit', { force: true });
    }
    exitForm.replaceChildren('prcoder has quit — this tab can be closed.');
  } catch (e) {
    toast(e.message, true);
  }
};
connect();

term.onData((d) => send({ type: 'input', data: d }));
new ResizeObserver(sync).observe(document.getElementById('term-host'));

// Folding a pane to its header line (folds.js paints; this is the rules).
// The PTY keeps its size while the terminal is folded: a display:none host has
// no height, so fit() gets NaN rows and returns without resizing, and the
// ResizeObserver above re-fits it on the way back out. The panes that are
// always there remember their fold, like the outline's ✕ in diff.js; the
// diff's is not stored (closeDiff says why).
const FOLD_KEY = { term: 'prcoder:term', queue: 'prcoder:queue' };
function foldAndStore(pane, off) {
  fold(pane, off);
  if (FOLD_KEY[pane]) setPref(FOLD_KEY[pane], off ? 'off' : 'on');
}
function setFold(pane, off) {
  foldAndStore(pane, off);
  settleFolds(off ? pane : null);
  if (pane === 'term' && !off) term.focus();   // expanding it is to talk to it
}
// Two rules, checked after everything that changes what is folded or open --
// a click on a bar, the folds a reload restores, a closed diff -- rather than
// beside each one, which is how a way round them got in. Never the diff and
// the terminal both: each fold hands its room to the other, and both folded
// would hand it to the queue, which nobody asked for. And never every pane:
// with no diff open, a folded terminal and a folded queue leave the column
// empty. Whichever pane was just folded keeps its fold and the other comes
// back; with none (a reload, a closed diff) the terminal does.
function settleFolds(just) {
  const other = folded('diff') && folded('term') ? 'diff'
    : !selectedPath() && folded('term') && folded('queue') ? 'queue' : null;
  if (!other) return;
  const back = just === 'term' ? other : 'term';
  foldAndStore(back, false);
  if (back === 'term' && just) term.focus();   // a fold made to talk to it
}
for (const pane in FOLD_KEY) if (canFold(pane) && pref(FOLD_KEY[pane]) === 'off') fold(pane, true);
settleFolds(null);
// The whole bar is the toggle, and the ▼ is only the part of it that says so
// -- and the part a keyboard can reach, since a button's Enter is a click and
// bubbles here. One listener for both, so a click on the ▼ toggles once. A
// control on the bar -- the diff's viewed box, its links, Wrap -- keeps its own
// click, so the fold is the rest of the bar: the title, the path, the gaps.
// No double-click: two clicks would already have folded and unfolded it.
for (const pane of ['diff', 'term', 'queue']) {
  document.querySelector(`#${pane} > header`).addEventListener('click', (e) => {
    const control = e.target.closest('a, button, label, input, textarea, select');
    if (!canFold(pane) || (control && control.id !== `${pane}-fold`)) return;
    setFold(pane, !folded(pane));
  });
}

// Types `data` into the agent's prompt exactly as given, as keystrokes, and
// puts the focus there so typing carries on where it landed. Whether it went is
// the return value: `send` refuses on a socket that is not open -- a dead PTY,
// a reload in flight -- and then the focus stays where it was, rather than
// moving to a terminal nothing is reading, where the page's shortcuts are off.
function typeIntoAgent(data) {
  const sent = send({ type: 'input', data });
  if (sent) term.focus();
  return sent;
}

// Type an item into Claude's prompt. If Claude is mid-turn it queues the
// message itself, which is exactly the behaviour we want.
//
// `submit` false types the text and stops there: the prompt is left ready to
// edit and send by hand, which is what the queue's ▶ wants. Trailing
// whitespace is cut either way -- a newline in the text *is* the Enter that
// would have sent it half-written.
//
// The queue ticks an item off on the strength of the return value, and an item
// checked off after a refused send is one nobody has done and nobody is going
// to be reminded of.
function sendToClaude(text, submit = true) {
  return typeIntoAgent(text.replace(/\s+$/, '') + (submit ? '\r' : ''));
}

// The diff header's @: the open file's mention, typed and not sent, so the
// sentence about it can go on around it. Nothing while no file is open or the
// open one was deleted (openMention says which). The path is from where the
// agent runs, which the status carries as `prefix`.
function mentionOpenFile() {
  const text = openMention(last?.prefix ?? '');
  if (text != null && !typeIntoAgent(text)) toast('The coding agent is not connected — nothing was typed.', true);
}
document.getElementById('diff-mention').onclick = mentionOpenFile;

// The diff header's ⧉: the open file's path from the repository root, the way
// the bar and GitHub name it, onto the clipboard, with a ✓ for a moment to say
// it went. It is a button because the path itself cannot be selected off the
// bar: the bar is user-select: none so a quick second click does not select its
// title, and giving the path alone user-select: text let Chromium select it with
// a drag but not Firefox, where a drag selected nothing although the computed
// style said text and a Range set from script selected it fine. The drag also
// ends in a click, which would have folded the pane.
const copyButton = document.getElementById('diff-copy');
let copied;
copyButton.onclick = async () => {
  const path = selectedPath();
  if (path == null) return;
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    return toast('The browser refused the clipboard — the path was not copied.', true);
  }
  copyButton.textContent = '✓';
  clearTimeout(copied);
  copied = setTimeout(() => { copyButton.textContent = '⧉'; }, 1200);
};

// The switcher only changes when PRs are opened or closed, so it is not worth a
// call every minute — page load, opening the dropdown, opening the Stack tab,
// and a checkout are enough. The branch-only pane's list of what merges into
// this branch comes out of the same array, and is as fresh as that. The Stack
// tab is too, but it states outright that nothing is stacked on a branch, so it
// asks for the list itself rather than trust one from minutes ago.
//
// Null until the first list lands: no list, which the panes say, rather than an
// empty one, which they would read as "nothing is stacked" or "nothing merges
// into this branch". A failed fetch is not a banner, and it keeps the list we
// had for the same reason -- an empty list in its place told the Stack tab that
// the pull requests it showed a moment ago had gone, because gh had a blip.
let prs = null;
let last = null;
// `why` is only for the console: which of the triggers above asked.
const loadPrs = (why) => {
  debug('fetching the PR list:', why);
  // Repaint, or a PR opened since page load stays invisible until the next
  // poll — the switcher only rebuilds its options when the set changes. The
  // whole status, because the branch-only pane reads this list too; `last` is
  // already the branch this fetch was for, so nothing asks for it again.
  return api('/api/prs', undefined, 'GET').then((l) => {
    debug('PR list landed:', l.map((p) => p.number).join(',') || '(empty)',
      document.activeElement?.id === 'pr-switch' ? '(switcher focused)' : '');
    prs = l;
    // The list is what says which branches have a pull request, so what git
    // said under the others is asked again against it, in place.
    asked.clear();
    [...below.keys()].forEach(loadBelow);
    if (last) paint(last);
  }, (e) => debug('PR list failed:', e.message));
};

// What git says each branch with no pull request is built on (#93), for the
// branch-only pane and a Stack tab that reaches one: branch -> `{ branch,
// names, toDefault }`. Asked for by the pane that needs it, once per list. A
// map rather than the last answer, or a stack with two such branches in it
// asks for one, loses the other, and asks for that again. A failed ask keeps
// what we had, as loadPrs does.
const below = new Map();
const asked = new Set();
const loadBelow = (branch) => {
  if (asked.has(branch)) return;
  asked.add(branch);
  const pairs = (prs ?? []).filter((p) => !p.isCrossRepository)
    .map(({ headRefName, baseRefName }) => ({ headRefName, baseRefName }));
  api('/api/below', { branch, prs: pairs })
    .then((b) => { below.set(branch, b); if (last) paint(last); }, () => {});
};
document.getElementById('pr-switch').addEventListener('mousedown', () => loadPrs('switcher opened'));

const NOTES = {
  'other-branch': 'Not checked out — this pull request is on another branch.',
  'other-repo': 'This pull request is in another repository.',
};

/**
 * A checkbox in the description, ticked through to GitHub -- the one edit to a
 * description prcoder makes, on your click. The route answers with the body
 * GitHub now has, which becomes the pane's, so the Detail count, the section's
 * pie and the queue's PR tab move with the box rather than a poll later.
 * Rethrown so the box snaps back, and the status reload is for the one error
 * that matters: the description moved under us, and the pane is now showing a
 * stale copy of it.
 */
async function toggleTask(task) {
  let body;
  try {
    ({ body } = await api('/api/pr/task', task));
  } catch (e) {
    toast(e.message, true);
    loadStatus();
    throw e;
  }
  if (last?.pr) {
    last.pr.body = body;
    paint(last);
  }
}

/** A file marked viewed or not, on GitHub and then in every place that shows it. */
async function markViewed(path, viewed) {
  await setViewed(path, viewed);
  const f = last?.pr?.files.find((x) => x.path === path);
  if (!f) return;
  f.viewed = viewed;
  paint(last);
  // The diff pane's box is static markup, outside anything paint() draws.
  if (selectedPath() === path) document.getElementById('diff-viewed').checked = viewed;
}

// A click on a row unfolds the pane: you asked for the file. The refresh in
// paint() below does not -- a push from the agent must not undo a fold made to
// talk to it.
const openFile = (f) => { fold('diff', false); return openDiff(f, markViewed); };
// Closing unfolds the diff (closeDiff says why), and can leave the terminal and
// the queue folded with nothing between them; settleFolds brings one back.
function closeFile() {
  closeDiff();
  settleFolds(null);
}
document.getElementById('diff-close').onclick = closeFile;
const fileHandlers = {
  onViewed: markViewed,
  onOpen: openFile,
  onTask: toggleTask,
};

// What the pull request pane was last drawn from. A poll that finds nothing new
// -- most of them -- skips rebuilding it: every row, fold and listener, and the
// scroll, focus and fold state put back afterwards.
let drawn = null;

function paint(status) {
  const moved = last?.pr?.headRefOid !== status.pr?.headRefOid;
  // A checkout is the one thing that changes which pull requests merge into the
  // branch under you, and the branch-only pane lists them. Refreshed here rather
  // than on the poll, which is the whole reason that list is affordable.
  // `last &&`, or the first paint counts as a change and fetches the list a
  // second time behind the one the page load already asked for.
  const switched = last && last.branch !== status.branch;
  // The PR on screen merging or closing takes it out of the open list, and
  // GitHub retargets the ones stacked on it. Fetched now, from the poll that
  // noticed -- the one that runs as you come back to the tab -- because the
  // fetch on opening the switcher lands after the dropdown is already open:
  // you picked from the old list, or had the options rebuilt under the pick.
  const ended = last?.pr && last.pr.number === status.pr?.number
    && last.pr.state !== status.pr.state;
  last = status;
  // Named for the tab strip, not the page: which PR, in which repo. A poll
  // that fails leaves the last good name up rather than reverting to
  // "prcoder", which is why this is here and not in loadStatus's catch.
  document.title = pageTitle(status);
  renderHeader(status, prs, handlers);
  if (status.pr) {
    // The Stack tab reads `prs`, which is this repository's list: against a pull
    // request in another one it would name strangers, and Switch would check
    // out whichever PR here has the same number. Null rather than empty, so the
    // tab says it has no list instead of saying the list is empty, and
    // `otherRepo` says which of the two reasons for having none it is.
    const otherRepo = status.scope === 'other-repo';
    const stack = otherRepo ? null : prs;
    const blocked = status.dirtyFiles.length > 0;
    // Everything the pane is drawn from, the Stack tab's inputs included: a
    // fresh PR list, or a tree going dirty, is a redraw even when the PR is not.
    const key = JSON.stringify([status.pr, status.scope, stack, blocked, [...below.values()]]);
    if (key !== drawn) {
      drawn = key;
      renderPr({ ...status.pr, note: NOTES[status.scope] }, {
        ...fileHandlers,
        selected: selectedPath(),
        prs: stack,
        otherRepo,
        onStackOpen: () => loadPrs('Stack tab opened'),
        below: [...below.values()],
        onBelow: loadBelow,
        defaultBranch: status.defaultBranch,
        onSwitch: switchPr,
        blocked,
      });
    }
  } else {
    drawn = null;
    renderNoPr(status, prs, { onCreate: createPr, onSwitch: switchPr, onBelow: loadBelow, below: [...below.values()], creating });
  }
  // What was under the old branch is not what is under this one.
  if (switched) {
    below.clear();
    asked.clear();
    loadPrs('branch changed');
  } else if (ended) loadPrs(`#${status.pr.number} is now ${status.pr.state}`);
  // Reading its checklist into the PR tab needs only a PR on screen.
  if (status.queue) setItems(status.queue, status.pr);

  // Keep an open diff honest: close it if its file left the PR (or the PR
  // switched away), refresh it if the branch moved — the server cache is
  // keyed by head oid, so a re-open shows the freshly pushed version.
  const open = selectedPath();
  if (!open) return;
  const f = status.pr?.files.find((x) => x.path === open);
  if (!f) closeFile();
  else if (moved) openDiff(f, markViewed);   // not openFile: keeps the fold
}

/**
 * A failed fetch must not read as "no pull request" — that is a real state with
 * its own UI, and a laptop on a train would hit it every minute.
 */
let polledAt = 0;
async function loadStatus() {
  polledAt = Date.now();
  try {
    paint(await api('/api/status', undefined, 'GET'));
  } catch (e) {
    const failed = { error: e.message, dirtyFiles: [], pr: null };
    renderHeader(failed, prs, handlers);
  }
}

async function switchPr(number) {
  debug('switching to', number);
  try {
    const status = await api('/api/pr/switch', { number });
    debug('switched: now on', status.branch, `#${status.pr?.number}`);
    paint(status);
    // Claude's cwd survives a checkout, but its idea of the files does not, and
    // nothing tells it: prcoder has no channel into the session that isn't a
    // typed user turn (issue #21). So this is addressed to you, not to Claude,
    // and it is sticky because it stays true until you have said something.
    toast(`Switched to ${status.branch} (#${number}). Claude still has the old`
      + " branch's files in mind — tell it to re-read anything it had open.",
    false, true);
  } catch (e) {
    debug('switch failed:', e.message);
    toast(e.message, true);
    await loadStatus();   // re-derive: the checkout may have half-succeeded
  }
}

// Held here, not on the button: the pane with no PR is redrawn on every poll,
// and a push can outlast one. Disabling only the button that was clicked put
// an enabled one back in its place a poll later, and a second click was a
// second push and a second compare tab.
let creating = false;

async function createPr(btn) {
  if (creating) return;
  // Opened before the await, or the popup blocker eats it. Blocked outright and
  // this is null -- which used to throw on `win.location`, throw again on
  // `win.close()` inside the catch, and leave the button disabled for good with
  // nothing said. The request is still worth making; only the tab is lost.
  const win = window.open('', '_blank');
  creating = true;
  btn.disabled = true;
  try {
    const { url, pushed } = await api('/api/pr/create');
    if (win) win.location = url;
    else toast(`Popup blocked — the compare page is at ${url}`, true, true);
    if (pushed) toast('Pushed this branch to origin first.');
  } catch (e) {
    win?.close();
    toast(e.message, true);
  }
  creating = false;
  btn.disabled = false;
  // The button on screen may be a redrawn one, drawn disabled from `creating`.
  if (last && !last.pr) paint(last);
}

const askClaudeToCommit = (files) =>
  sendToClaude(`Commit the current changes: ${files.join(', ')}`);

const handlers = { onSwitch: switchPr, onCommit: askClaudeToCommit };

document.getElementById('pr-refresh').onclick = loadStatus;

// Polling is the client's job: no server timer, and a hidden tab costs nothing.
setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 60_000);
// Coming back to the tab polls too, but not one that just ran: a poll is a gh
// call plus half a dozen git spawns behind the server's serial lock, and
// alt-tabbing to Claude and back is a thing you do every few seconds.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - polledAt > 10_000) loadStatus();
});

const input = document.getElementById('queue-input');
input.addEventListener('keydown', async (e) => {
  // Shift-Enter is the newline; plain Enter still saves, which is the whole
  // reason this is a textarea with a key handler rather than a form.
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  // Cleared only once the server has the item. addItem is async and save()
  // reports a refusal with a toast rather than a throw, so clearing on the way
  // past threw the text away on any API failure.
  if (await addItem(input.value)) {
    input.value = '';
    grow();
  }
});
/** One line until it needs more, then up to a third of the pane. */
const grow = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
};
input.addEventListener('input', grow);

// Not awaited: the switcher's list is a whole `gh pr list` and nothing below
// needs it — renderHeader synthesises an option for the current PR until it
// lands, and loadPrs repaints the header itself when it does.
loadPrs('page load');
await initQueue({ sendToClaude, onTask: toggleTask });
loadStatus();
