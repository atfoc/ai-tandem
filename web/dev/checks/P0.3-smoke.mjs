// Ports P0.3 (dev/checks/P0.3-smoke.mjs) to the new build: the mock's seeded states (dev/mock-ui.js, `seedUI()`: 57 of them in sections
// A1…A6 and SEC) each show on screen where the table DRAWN below says, with no page error, at each viewport the entry names (all three by
// default). All 57 are in the table. An entry is the new build's counterpart of the seed's `see`, its `text`, its `count` and each part of its
// `also`, and not less: a part the seed names is a part of the entry (the sweep, rn-sw-p03, wrote the ones that had stayed short, see the list of
// them below).
//   - the key of an entry is "<section>.<id>" of the seed's list ("A2.plain-started"); a key that is not in the list (a state
//     renamed or removed in dev/mock-ui.js) fails the check, and so does a state of the seed with no entry, so a table cannot go stale;
//   - `see` is a list of parts, each { tid, data?, text?, exact?, count?, last?, label?, state?, in? } or { css } (the testID and its dataSet
//     values; a part of the first match's text, or all of it with `exact`, or the last match's with `last`; how many match; a part of its aria-label;
//     "attached" for a part that is in the tree but may be hidden; `in`: the elements it is looked for in, outermost first, each { tid, data? };
//     `css`: a selector, for what the page does not draw itself, Excalidraw's own toolbar). The seed's own `see` selectors are what the old
//     build shows: they are not read.
//   - `run(page, { fail })` is a part that needs more than a locator (A3.tree reads the sidebar's outline);
//   - the state's `sel` (the page's aiwb.sel), its `mock` (code run in the mock once the page is open, undone before the next) and
//     its `act` (sel.mjs: act) are the seed's, as the old check used them; `pane` is a window and widths for a measured state, taken
//     on the desktop only (the other viewports are the devices' own);
//   - `phone` says where the phone differs: a board and its chat are two screens of the stack there and the chat is on screen (AD-71), so
//     "board" is read on the board's screen (the stack's back first), and "board-then-chat" plays the `act` on the board's screen and goes
//     on to the chat by the bar's "Show chat".
// What the old check does and this one does otherwise:
//   - the old one seeded each section alone and drew its states, then all together. This one draws all of them together at each viewport and
//     each section alone at the desktop (a section's states stand on what the section seeds, nothing of another);
//   - a state is open for a count of frames, not for a time (MOMENT of the old one, a second): an error thrown after the load is seen.
//     `atRest` (24 frames with nothing changed) was the wait here before and never came for a page that animates (the typing dots, the
//     presence of an agent, a spinner): it waited out its bound, 1200 frames (20 s), and its answer was not read. The states are open one
//     at a time, as the old check's: the mock has one stream for one page (`open()` of shot.mjs fails a second), and two pages would take
//     it from each other;
//   - the old one failed when the build's version was not "uicheck" (the state of another build needs a page that differs): so does this.
// A package that draws a state adds its entry in the same commit as its screen, and says in its first comment which entries it
// added (S3: A1.servers; S9: the ring of A2.plain-ctxerr, plain-remote-new, plain-remote-started, plain-remote-started-long and plain-off-started, the
// `also` of those states in the seed that names `.ctx-meter`; K5: the count of A2.plain-quotes and A2.board-quotes, the seed's `.composer .qcount`).
// rn-sw-p03 (the sweep) made the entries whole: the text of A2.plain-new-long, plain-started-long, board-long ("extended thinking"), of the
// server in the header of A2.plain-remote-* and of "is not connected" in A2.plain-off-new and plain-off-started; the model's chip of A4.fork-*;
// the five labels of A5.gaps; the groups of A3.tree and the eight sections of SEC.sidebar; A1.servers' words; the toolbar of A6.board and
// SEC.board (the canvas was only in the tree), at the tablet and, by the stack's back, at the phone; A2.board-selected at the tablet and the phone.
import { check, dropped, mockEval, paneSize, seed, until } from "../shot.mjs";
import { act, back, byTid, press, tidSel } from "./sel.mjs";
import { MORE } from "./composer.mjs";
import { sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const SECTION = (server) => ({ tid: "side-section", data: { server } });
const TOOLBAR = ".excalidraw:not(.excalidraw--view-mode) .App-toolbar"; // (Excalidraw's own, as the old check had it)

/** A3.tree: the five chats of the seed are in the groups it names (the seed's `also`): a chat is a row of the group it is in, and its row says
 *  so in its title; a group's title is the path of its names. The outline is the sidebar's (side.mjs). */
async function treeShape(page, { fail }) {
  const seen = await sideSeen(page, "local");
  if (!seen.there) return fail("A3.tree: this computer's section is not drawn");
  const stack = [];
  const at = new Map(); // name of a chat -> { path, title }
  seen.outline.forEach((line, i) => {
    const depth = (line.length - line.trimStart().length) / 2, [kind, ...rest] = line.trim().split(" "), name = rest.join(" ");
    stack.length = depth;
    if (kind === "group") { stack[depth] = name; if (seen.titles[i] !== stack.join(" / ")) fail(`A3.tree: the group ${name} has the title "${seen.titles[i]}", not "${stack.join(" / ")}"`); }
    else if (kind === "chat" && !at.has(name)) at.set(name, { path: stack.slice(), title: seen.titles[i] });
  });
  for (const [name, path] of [["Chat A", ["Shop"]], ["Chat B", ["Shop", "Sub"]], ["Chat O", ["Other"]], ["Chat M", ["Other", "Mid"]], ["Loose", []]]) {
    const c = at.get(name);
    if (!c) fail(`A3.tree: no row for "${name}"`);
    else if (c.path.join(" / ") !== path.join(" / ")) fail(`A3.tree: "${name}" is in ${c.path.length ? c.path.join(" / ") : "no group"}, not ${path.length ? path.join(" / ") : "no group"}`);
    else if (!c.title.startsWith(`${name} —`)) fail(`A3.tree: the row of "${name}" has the title "${c.title}", not "${name} —…"`);
  }
}

/** The states the new build draws. key: "<section>.<id>"; value: { see: [parts], viewports?: where it applies }. */
export const DRAWN = {
  // ---- the chat view (S4): the header, the thread, its empty state and the warning of a server that is away. The composer's parts of
  // these states (their `see` in the seed) are K3's, the tool and permission cards S6's, the tree and the fork actions S8's: each adds
  // them to its entry (A4.turns, A4.two-branches and A4.remote-turns have an `act` of S8's: it adds them with the act).
  "A2.plain-started": { see: [{ tid: "chat-head", text: "Why is the build slow" }, { tid: "msg", data: { role: "user" } }, { tid: "msg", data: { role: "assistant" } }, { tid: "tchip", data: { kind: "model", fixed: true } }] },
  "A2.plain-new": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 2 }, { tid: "tchip", data: { kind: "agent" } }] },
  "A2.plain-new-long": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 2 }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: false }, text: "extended thinking" }] },
  "A2.plain-started-long": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }] },
  "A2.plain-busy": { see: [{ tid: "chat-head" }, { tid: "typing" }, { tid: "stop" }] },
  "A2.plain-ctxerr": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "ctx-meter", data: { error: true }, text: "Context unavailable" }] }, // S9: the ring's error meter
  "A2.plain-quotes": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "qcount", data: { n: 2 }, text: "❝ 2" }] }, // K5: the count of the draft's two quotes
  "A2.plain-remote-new": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "empty-thread" }, { tid: "ctx-meter" }] },
  "A2.plain-remote-started": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "msg" }, { tid: "ctx-meter" }] },
  "A2.plain-remote-started-long": { see: [{ tid: "chat-head-server", text: "lab-gpu-box.tailnet-1234.ts.net" }, { tid: "msg" }, { tid: "ctx-meter" }] },
  "A2.plain-loading": { see: [{ tid: "chat-head-server" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "Loading models" }] },
  "A2.plain-noagent": { see: [{ tid: "chat-head" }, { tid: "empty-reason", text: "Choose an agent to send a message." }, { tid: "agent-reason", text: "Choose an agent" }] },
  "A2.plain-noagent-installed": { see: [{ tid: "chat-head-server" }, { tid: "empty-reason", text: "No agent is installed on Bare box" }, { tid: "agent-reason", data: { tone: "missing" }, text: "No agent is installed on Bare box" }] },
  "A2.plain-off-new": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "empty-thread" }, { tid: "empty-reason", text: "is not connected: nothing can be sent or changed until it is back." }, { tid: "agent-reason", data: { tone: "missing" }, text: "lab-gpu-box.tailnet-1234.ts.net is not connected" }] },
  "A2.plain-off-started": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "remote-bar-text", text: "lab-gpu-box.tailnet-1234.ts.net is not connected" }, { tid: "msg" }, { tid: "ctx-meter" }, { tid: "composer-box" }] },
  "A2.plain-fork-fresh": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "effort" } }] },
  "A2.plain-fork-notice": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "model-notice", text: "Another model" }] },
  "A2.plain-branches": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "fk-tree-btn", data: { count: 2 } }, { tid: "fk-crumb" }, { tid: "composer-box" }] },
  "A2.board-started": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 3 }, { tid: "tchip", data: { kind: "model", fixed: true } }] },
  "A2.board-new": { see: [{ tid: "chat-head" }, { tid: "empty-thread" }, { tid: "suggestion", count: 3 }, { tid: "tchip", data: { kind: "agent" } }] },
  "A2.board-quotes": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "qcount", data: { n: 2 }, text: "❝ 2" }] },
  "A2.board-long": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "composer-box" }, { tid: "tchip", data: { kind: "model", fixed: true }, text: "extended thinking" }] },
  "A2.board-longname": { see: [{ tid: "chat-head" }, { tid: "msg" }, { tid: "ctx-chip", text: "second draft" }] },
  "A4.fork-claude": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  "A4.fork-cursor": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  "A4.fork-pi": { see: [{ tid: "chat-head" }, { tid: "forked-from" }, { tid: "tchip", data: { kind: "model", fixed: false } }] },
  "A6.code": { see: [{ tid: "chat-head" }, { tid: "md-code", count: 4 }] },
  // S6, the cards: the tool items of the three agents, the incomplete ones, the large, the wide and the malformed (A5), and the chat with
  // a permission request that waits and two that were decided (A6.cards). A5.sub is a card in the subagent's drawer: S7's.
  "A5.claude": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 9 }, { tid: "tool-card", data: { kind: "edit" }, count: 3 }] },
  "A5.cursor": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 11 }] },
  "A5.pi": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.gaps": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 5 }, { tid: "tool-card", data: { running: true }, count: 3 }, { tid: "tool-card", data: { err: true }, count: 2 },
    // the labels of the five (the seed's `also`): the two that failed and the three that run
    { in: [{ tid: "tool-card", data: { err: true } }], tid: "tool-label", exact: "Build", count: 1 }, { in: [{ tid: "tool-card", data: { err: true } }], tid: "tool-label", exact: "Editing sum.go — denied", count: 1 },
    { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "…", count: 1 }, { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "Run the tests…", count: 1 },
    { in: [{ tid: "tool-card", data: { running: true } }], tid: "tool-label", exact: "Writing a file…", count: 1 }] },
  "A5.big": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 4 }] },
  "A5.wide": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.panel": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 6 }] },
  "A5.junk": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 15 }] },
  "A5.sub": { see: [{ tid: "sub-row", state: "attached" }, { tid: "sub-drawer-body" }, { tid: "tool-card", count: 2 }] }, // S7: the drawer of a subagent, opened by the state's act
  "A6.cards": { see: [{ tid: "chat-head" }, { tid: "tool-card", count: 2 }, { tid: "perm", count: 3 }, { tid: "perm", data: { state: "pending" }, count: 1 }, { tid: "perm-allow" }, { tid: "perm-deny" }] },
  "SEC.chat": { see: [{ tid: "chat-head-server", text: "Studio Mac" }, { tid: "msg", data: { role: "user" }, text: "render queue" }] },
  "SEC.chat-away": { see: [{ tid: "remote-bar", data: { kind: "off" } }, { tid: "remote-bar-text", text: "Studio Mac is not connected" }] },
  // S8: the fork parts of the chat view: the banner of a pending move (the composer's parts of these states are K3's), the actions of a message, the header's
  // Tree button with its count, the chat tree popup (their `act` is in sel.mjs: move, hover, tree)
  "A2.plain-move": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A2.plain-move-long": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A2.board-move": { see: [{ tid: "chat-head" }, { tid: "fk-banner" }, { tid: "fk-back" }] },
  "A4.turns": { see: [{ tid: "msg", data: { role: "assistant" } }, { tid: "fk-act", data: { kind: "branch" } }] },
  "A4.remote-turns": { see: [{ tid: "chat-head-server" }, { tid: "fk-act", data: { kind: "branch" } }] },
  "A4.two-branches": { see: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }, { tid: "fk-here" }] },
  "A6.tree-popup": { see: [{ tid: "fk-nav-sub", text: "2 branches" }, { tid: "fk-row", count: 6 }] },
  "A1.servers": { see: [{ tid: "servers-btn", data: { dot: true }, label: "not connected" }, { tid: "servers-dot" }] }, // S3: the Servers button's dot (the dialog: L7)
  // "A2.plain-started": { see: [{ tid: "composer" }, { tid: "chat-head", text: "A plain chat" }] },
  // S1, the sidebar:
  "A1.stream-down": { see: [{ tid: "side-section-state", data: { server: "local", tone: "wait" }, text: "Connecting…" }] },
  "A1.local-other-build": { see: [{ tid: "side-section-extra", text: "another build" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Restart server" }] },
  "A1.local-not-started": { see: [{ tid: "side-section-reason", text: "not set up" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Retry" }] },
  "A1.local-too-old": { see: [{ tid: "side-section-line", text: "older than the app" }, { in: [{ tid: "side-section-extra" }], tid: "btn", text: "Restart server" }] },
  // (the seed's `also`: the chats in the groups the tree names: `treeShape`)
  "A3.tree": { see: [{ tid: "side-group-head", data: { depth: 2 }, text: "Leaf" }, { tid: "side-row", data: { kind: "chat" } }], run: treeShape },
  "SEC.sidebar": { see: [{ tid: "side-section", data: { server: "s_studio", tone: "ok" } }, { in: [SECTION("s_studio"), { tid: "side-group" }, { tid: "side-group" }], tid: "side-row", data: { kind: "chat", key: "s_studio~c_night" }, text: "Last night's failures" },
    // the other sections, each in the state the seed gives it (the seed's `also`)
    { in: [SECTION("s_studio")], tid: "side-section-state", text: "Connected" }, { in: [SECTION("s_empty")], tid: "side-section-line", text: "Nothing on this server yet." },
    { in: [SECTION("s_wait")], tid: "side-section-state", text: "Connecting" }, { in: [SECTION("s_away")], tid: "side-section-line", text: "when the server is back" },
    { in: [SECTION("s_old")], tid: "side-section-state", text: "Too old" }, { in: [SECTION("s_old")], tid: "side-section-line", text: "Update the server on that machine." },
    { in: [SECTION("s_old")], tid: "side-section-line", last: true, text: "0.9.1" }, { in: [SECTION("s_cert")], tid: "side-section-state", text: "Certificate changed" }] },
  // B4: the board's canvas, drawn by the view (state "ready"). On the phone a board and its chat are two screens of the stack and the chat is the one on
  // screen (AD-71), so the canvas of a state that names a chat is in the tree and not on screen there: a state whose point is the board (A6.board, SEC.board,
  // and the selection of A2.board-selected) goes `phone: "board"`, to the board's screen by the stack's back (and, for the selection, on to the chat by the bar's "Show chat").
  "A2.board-selected": { see: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" }, state: "attached" }, { tid: "ctx-act", data: { kind: "selection" }, text: "3 selected" }], phone: "board-then-chat" }, // (the select is the keyboard's ⌘A: a tablet or a phone with a keyboard, as P7.4-board's)
  // (A2.board-busy: the agent's presence is on the canvas, which is a screen under the chat on the phone, so there it is in the tree, as the seed's chat is what the state is about)
  "A2.board-busy": { see: [{ tid: "chat-head" }, { tid: "typing" }, { tid: "board-canvas", data: { board: "b_A2" }, state: "attached" }, { tid: "presence", state: "attached" }, { tid: "stop" }] },
  "A6.board": { see: [{ tid: "board-canvas", data: { board: "b_ui", state: "ready" } }, { css: TOOLBAR }], phone: "board" },
  "SEC.board": { see: [{ tid: "board-canvas", data: { board: "s_studio~b_loose", state: "ready" } }, { css: TOOLBAR }], phone: "board" },
};

const UNDO = "delete flags.streamDown; delete flags.hello; setServerState('local', 'connected');"; // what a state's `mock` may have set
const LIMIT = 15000;
const FRAMES = 60; // (a second at 60 Hz; the frames a loaded machine draws more slowly, and the page gets as much longer)

/** The frames the page draws with the state showing: an error thrown after the load is seen by check(), which watches every page. */
const frames = (page, n = FRAMES) => page.evaluate((n) => new Promise((done) => { let i = 0; const tick = () => (++i < n ? requestAnimationFrame(tick) : done()); requestAnimationFrame(tick); }), n);

await check("P0.3 every seeded state renders", async ({ url, mock, viewport, layout, open, fail, note }) => {
  // (the build has a version of its own, not "dev": a server of another build is then told by this computer's section; buildAppDist of dev/shot.mjs gives it)
  const index = await fetch(url + "/").then((r) => r.text(), () => ""), main = index.match(/src="\.?\/?(_expo\/static\/js\/web\/index-[^"]+\.js)"/)?.[1];
  const bundle = main ? await fetch(`${url}/${main}`).then((r) => r.text(), () => "") : "";
  if (!bundle.includes('"uicheck"')) fail("the build's version is not \"uicheck\": this computer's server of another build needs a version of the page to differ from (buildAppDist of dev/shot.mjs gives it)");
  const reconnect = async () => { // (the server a state dropped is back before the next page: openApp does it too, but not for pages that open together)
    const id = dropped.get(url);
    if (id) { dropped.delete(url); await mockEval(`setServerState(${JSON.stringify(id)}, "connected");`, url); }
  };
  // One part of a state: on screen (or in the tree), its text, its count.
  const part = async (page, key, p) => {
    const where = p.css ?? `${p.in ? p.in.map((c) => tidSel(c.tid, c.data) + " ").join("") : ""}${tidSel(p.tid, p.data)}${p.exact !== undefined ? `:text-is(${JSON.stringify(p.exact)})` : ""}`;
    const name = p.css ?? `${p.in ? p.in.map((c) => c.tid + (c.data ? JSON.stringify(c.data) : "")).join(" ") + " " : ""}${p.tid}${p.data ? " " + JSON.stringify(p.data) : ""}${p.exact !== undefined ? ` "${p.exact}"` : ""}`;
    let all = page.locator(where), el = p.last ? all.last() : all.first();
    // (a chip of the toolbar that the row has no room for is in the open "more" popup, as A2.2 has it: composerfit)
    const folded = p.tid === "tchip" && !await until(async () => await all.count() > 0, 4000) && await page.locator(MORE).count() > 0;
    if (folded) {
      await press(page, page.locator(MORE));
      const pop = byTid(page, "more-pop");
      await pop.waitFor({ state: "visible", timeout: LIMIT }).catch(() => { throw new Error(`the toolbar has no ${name}, and its "more" chip opens no popup`); });
      all = pop.locator(where); el = all.first();
    }
    await el.waitFor({ state: p.state ?? "visible", timeout: LIMIT }).catch(() => { throw new Error(`nothing on screen has ${p.css ? "the selector" : "the testID"} ${name}${folded ? ' (in the toolbar, or in the "more" popup)' : ""}`); });
    if (p.text && !await until(async () => ((await el.textContent()) ?? "").includes(p.text), 5000)) fail(`${key}: ${name} says "${((await el.textContent()) ?? "").slice(0, 80)}", not "${p.text}"`);
    if (p.label && !((await el.getAttribute("aria-label")) ?? "").includes(p.label)) fail(`${key}: ${name} is labelled "${await el.getAttribute("aria-label")}", not "${p.label}"`);
    if (p.count !== undefined && !await until(async () => await all.count() === p.count, 5000)) fail(`${key}: ${await all.count()} elements match ${name}, not ${p.count}`);
    if (folded) { // (closed again: the next part is looked for in the page)
      await page.keyboard.press("Escape");
      if (!await until(async () => !await byTid(page, "more-pop").count(), 5000)) fail(`${key}: Esc did not close the "more" popup`);
    }
  };
  const show = async (s, entry, tag) => {
    const key = `${s.section}.${s.id}`, name = `${tag}: ${key}`;
    const o = await open({ sel: s.sel, wait: "", ...(s.pane && viewport === "desktop" ? paneSize(s.pane[0], Math.max(s.pane[1], 480)) : {}) });
    try {
      if (s.mock) await mockEval(s.mock, url);
      const onBoard = layout === "phone" && entry.phone;
      if (onBoard) { // (the chat is the screen: back to the board's)
        await byTid(o.page, "chat-head").first().waitFor({ state: "visible", timeout: LIMIT });
        if (!await back(o.page)) throw new Error("the phone's stack has no back from the chat to the board");
        await byTid(o.page, "board-bar").first().waitFor({ state: "visible", timeout: LIMIT });
      }
      if (s.act === "select") await o.page.waitForSelector(tidSel("board-canvas", { state: "ready" }), { timeout: LIMIT }); // (the shapes are drawn before they are selected, as composer.mjs openState)
      await act(o.page, s.act);
      if (onBoard === "board-then-chat") {
        await press(o.page, byTid(o.page, "board-chats").first());
        await byTid(o.page, "chat-head").first().waitFor({ state: "visible", timeout: LIMIT });
      }
      for (const p of entry.see) await part(o.page, name, p);
      await entry.run?.(o.page, { fail: (line) => fail(line.replace(/^([A-Z0-9]+\.[\w-]+)/, `${tag}: $1`)) });
      await frames(o.page);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await o.ctx.close();
  };
  // A seed's states, those the table names drawn, one after the other.
  const draw = async (states, tag) => {
    let drawn = 0;
    for (const s of states) {
      const entry = DRAWN[`${s.section}.${s.id}`];
      if (!entry || (entry.viewports && !entry.viewports.includes(viewport))) continue;
      drawn++;
      if (s.mock || s.act?.startsWith("drop:")) {
        if (s.mock) { await mock?.restart(); await seed(url, ...(tag === "alone" ? [s.section] : [])); }
        await reconnect();
        await show(s, entry, tag);
        await reconnect();
        if (s.mock) await mockEval(UNDO, url);
        continue;
      }
      await show(s, entry, tag);
    }
    return drawn;
  };
  const states = await seed(url);
  const keys = new Set(states.map((s) => `${s.section}.${s.id}`));
  if (states.length !== keys.size) fail("the seed's list has two states with one key");
  for (const key of Object.keys(DRAWN)) if (!keys.has(key)) fail(`${key} is not a state of the seed (dev/mock-ui.js): a state renamed or removed, or a mistyped key`);
  for (const key of keys) if (!DRAWN[key]) fail(`${key} is a state of the seed with no entry in DRAWN: add what the build draws of it, or why it cannot (the seed's see, text, count and also are what the old build shows)`);
  const drawn = await draw(states, "together");
  note(`${drawn} of ${states.length} seeded states are drawn by the new build at ${layout}`);
  if (viewport === "desktop") { // each section on a mock of its own: a section's states stand on what it seeds
    let alone = 0;
    for (const section of [...new Set(states.map((s) => s.section))]) {
      await mock?.restart();
      const own = await seed(url, section);
      if (!own.length || own.some((s) => s.section !== section)) fail(`seedUI("${section}") answered ${own.length} states, ${own.filter((s) => s.section !== section).length} of another section`);
      alone += await draw(own, "alone");
    }
    note(`${alone} states alone, each section on a mock of its own`);
  }
}, { viewports, page: false });
