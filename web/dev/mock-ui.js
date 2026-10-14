// Read by mock.mjs when seedUI() is called through /mock/eval (evaluated inside it): the states of the composer
// and chat UI work (plans/composer-ui-improvements.md, section 3), one section per item. `seedUI()` makes all of
// them, `seedUI("A2", "A3")` the ones named; then it tells the page the list and the snapshots again (resync). It answers the list of its states, each
// with where the page shows it:
//   { id, section, sel, see, text?, count?, also?, pane?, act?, mock? }
//   sel    the selection that shows the state (the page's aiwb.sel)
//   see    a selector that matches when the state is on screen; text: what its first match says, in part; count:
//          how many elements match it, where the state is that many of them
//   also   more parts of the state, each { see, text?, count? }: every one is on screen too
//   pane   ["panel" | "page", width]: the pane and its width, for a state measured at one
//   act    what the page is told first: "move" (Branch from here on the first reply), "hover" (the pointer on the
//          first reply), "select" (select all on the board), "drawer" (open the first subagent), "tree" (open the
//          chat's tree), "drop:<entry id>" (that server of the list drops while the page has its chat open:
//          a thing of a server that is not connected is on screen only so; the driver connects the server again before
//          it opens the next page)
//   mock   code run in the mock once the page is open (a knob: the stream cut, another version)
// The smoke check (dev/checks/P0.3-smoke.mjs) opens every one; a check of an item reads the ids it needs.
//
// A section adds only to what is its own: chats "c_<section>_…" in the group "g_<section>".
// Seeding again makes each of its chats anew, as seeded: what the mock still had to do for the chat it replaces (a
// held call, a canned reply, a branch's late events) is dropped, so a check seeds again to start over.
// A later phase adds its states to its own section. Shared by sections, and made by each that needs it: the
// servers (s_lab, connected, with a 31-character name and no Cursor catalog; s_off, not connected; s_bare, no
// agent installed), pi's catalog, the long folder and model, and the board b_ui that answers a take (three shapes),
// in a closed group "Shared" of its own.
// A server of the list is another machine (mock.mjs addServer, onServer): what a section seeds "on the lab box"
// is in that machine's own tree, in a group of its own there (with the id the section's group has here), and shows in
// that server's section of the sidebar. The page names such a thing "<entry id>~<id>": that is what its `sel` has.
//
//   A1  the servers; the stream closed for good (every entry connecting, this computer's too); this computer's server
//       of another build, not started (with the reason), too old; the board b_ui, whose canvas takes the keys
//   A2  every toolbar state: plain chats (started, unstarted, busy, quotes, a context error, long names, on s_lab,
//       a pending move, "Loading models…", no agent, a server not connected, a fresh fork, a model notice, two
//       branches with unlike toolbars) and chats on a board (the editable b_ui among them, and one at work). The
//       names of G1's cases are kept where a state is one of them. "A server not connected" is the lab box dropped
//       while the chat is open
//   A3  the tree of G2: Shop > Sub and Other > Mid > Leaf, a chat in each level, one ungrouped
//   A4  a thread whose turns end with a point; a chat with two branches; a fresh fork of each agent kind; a chat
//       with points on s_lab. The waits themselves are the knobs of mock.mjs (flags.send, flags.items, …)
//   A5  tool items as the three agent kinds send them (the table of G4; Cursor's edit and delete with their texts, and
//       as a thread from before has them), the incomplete ones (G4 §5), a long output, a large input, a long change, a
//       card of many edits, names and lines with nowhere to break (as a plain chat and beside a board), items with
//       fields of other types than the page reads, a tool item in a subagent's thread
//   A6  a chat with code (every kind of word the page colours in code is in it), a tool card and a permission card;
//       a chat with two branches for the tree popup. The board and the Servers dialog are the mock's own and A1's
//   SEC the sections of the sidebar (plans/remote-server-sections-goal.md, section 3), one server of the list per
//       state of a section, each made anew by every seed: s_studio "Studio Mac", connected, with a tree (loose: the
//       board b_loose that answers a take, with a chat; the chats c_plain and c_note, the second with a saved draft at
//       counter 2; the archived chat c_arch. The group g_shop "Renders", which that machine's own page shows
//       collapsed: the board b_arch with a chat, the chat c_queue at work, and in it the group g_sub "Nightly" with a
//       chat. The group g_old "Old takes" with a chat);
//       s_empty "Empty box", connected, with nothing; s_wait "Slow link", connecting; s_away "Attic server", not
//       connected; s_old "Old Mini", too old; s_cert "Cert box", whose certificate changed. The ids c_plain, g_shop and
//       b_arch are also ids of this computer's own things
(only) => {
  const states = [];
  const state = (section, id, sel, see, more = {}) => { states.push({ id, section, sel, see, ...more }); };
  const add = (id, o, list = []) => { chats[id] = chat(id, o); items[id] = list; delete branches[id]; delete sessions[id]; delete subs[id]; };
  const group = (id, name, more = {}) => { const g = groups.find((x) => x.id === id); if (g) Object.assign(g, { name, ...more }); else groups.push({ id, name, ...more }); };
  const turn = (ask, answer, point) => [{ kind: "user", text: ask }, say(answer), { kind: "end", point }];
  const TURNS = [...turn("Why is the build slow?", "Because of the font copy step. It copies every font file on each build.", "p1"), ...turn("Fix it.", "Done: the fonts are copied once.", "p2")];
  const THREAD = TURNS.slice(0, 3).map((x) => (x.kind === "end" ? { kind: "end" } : x)); // a thread with no point: nothing to branch from
  const REFS = [{ quote: "font copy step", comment: "which step exactly?", item: 1, start: 15, end: 29 }, { quote: "copies every font", comment: "", item: 1, start: 34, end: 51 }];
  const FULL = { ctxIn: 186400, ctxOut: 2100, ctxWindow: 1000000, turns: 9 };

  // ---- shared by sections

  const LAB = "s_lab", OFF = "s_off", BARE = "s_bare", LAB_NAME = "lab-gpu-box.tailnet-1234.ts.net", LAB_HOME = "/home/dev";
  const LONG_NAME = "storefront-monorepo-with-a-very-long-folder-name", LONG_DIR = `${SHOP}/${LONG_NAME}`, LAB_LONG = `${LAB_HOME}/projects/${LONG_NAME}`;
  const PI = { default: { model: "claude-sonnet-5-5", effort: "medium" }, models: [
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "anthropic", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200000 },
    { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 128000 } ] };
  /** The 47-character folder and model names of G1's long cases. */
  function longNames() {
    TREE[LONG_DIR] = [];
    if (!TREE[SHOP].includes(LONG_NAME)) TREE[SHOP].push(LONG_NAME);
    if (!claude.models.some((m) => m.id === "long")) claude.models.push({ id: "long", label: "Claude Opus 5.5 (1M context, extended thinking)", efforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 1000000 });
  }
  /** Three more servers in the list, each a machine with a tree of its own, and what each offers. */
  function servers() {
    longNames();
    addServer({ id: LAB, name: LAB_NAME, address: `https://${LAB_NAME}:4790`, state: "connected", version: "dev" },
      { lists: { agents: ["claude", "cursor", "pi"], catalogs: { claude, pi: PI }, home: LAB_HOME, defaultCwd: `${LAB_HOME}/projects` } }); // no Cursor catalog yet: "Loading models…"
    addServer({ id: OFF, name: "Office Mac", address: "https://office-mac.example:4790", state: "unreachable", detail: "connection refused" });
    addServer({ id: BARE, name: "Bare box", address: "https://bare-box.example:4790", state: "connected", version: "dev" }, { lists: { agents: [], catalogs: {}, home: "/home/bare", defaultCwd: "/home/bare" } });
    Object.assign(TREE, { [LAB_HOME]: ["projects"], [`${LAB_HOME}/projects`]: [LONG_NAME, "shop"], [`${LAB_HOME}/projects/shop`]: [], [LAB_LONG]: [] });
  }
  /** What the page names a thing of another server by: its `sel` has that. */
  const there = (server, id) => `${server}~${id}`;
  /** A chat on the lab box, in that machine's own group with the id `o.group`; answers what the page names it by. */
  const onLab = (id, o, list) => { onServer(LAB, () => add(id, { cwd: `${LAB_HOME}/projects/shop`, ...o }, list)); return there(LAB, id); };
  /** The lab box drops while the state is on screen. */
  const LAB_DROPS = { act: `drop:${LAB}` };
  /** A board this window may hold, with a drawing of three shapes: its canvas can be edited. */
  function sketch() {
    const shape = (id, type, x, y, more) => ({ id, type, x, y, width: 160, height: 90, ...more });
    group("g_ui", "Shared", { collapsed: true });
    boards.b_ui = { id: "b_ui", name: "Sketch", group: "g_ui", created: iso(T0 - 90 * MIN) };
    scenes.b_ui = { rev: 1, scene: { type: "excalidraw", version: 2, elements: [shape("ui_rect", "rectangle", 80, 80), shape("ui_ellipse", "ellipse", 320, 80), shape("ui_diamond", "diamond", 200, 240)], appState: {}, files: {} } };
  }
  /** A chat with two branches: main with both turns, and "alt", split from main after the first turn, with a turn of
   *  its own. main is the current one. st: what alt's session has that main's has not. */
  function twoBranches(id, o, st = {}) {
    add(id, o, clone(TURNS));
    const b = addBranch(id, "main", 3, st, "alt");
    b.items.push(...turn("Is there a faster way?", "Yes: skip the copy when the fonts did not change.", "q2"));
  }

  // ---- A1: the sidebar

  function A1() {
    servers(); sketch();
    state("A1", "servers", {}, '.side-foot .servers-btn[title*="not connected"]'); // (the dot of Office Mac: with no seed the button has none)
    const here = '.side-section[data-server="local"]';
    state("A1", "stream-down", {}, `${here} .side-section-state.wait`, { text: "Connecting", mock: "flags.streamDown = true; dropStreams();" });
    state("A1", "local-other-build", {}, `${here} .side-section-extra`, { text: "another build", also: [{ see: `${here} .side-section-extra .btn`, text: "Restart server" }], mock: 'flags.hello = { version: "old" }; dropStreams();' });
    state("A1", "local-not-started", {}, `${here} .side-section-reason`, { text: "not set up", also: [{ see: `${here} .side-section-extra .btn`, text: "Retry" }],
      mock: 'setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine.\\nSet it up once with: ai-whiteboard remote setup" });' });
    state("A1", "local-too-old", {}, `${here} .side-section-extra .btn`, { text: "Restart server", also: [{ see: `${here} .side-section-line`, text: "older than the app" }],
      mock: 'setServerState("local", "too_old", { version: "0.9.1" });' });
  }

  // ---- A2: the composer

  function A2() {
    servers(); sketch();
    group("g_A2", "A2 composer", { collapsed: true });
    const g = { group: "g_A2" }, long = { cwd: LONG_DIR, model: "long", effort: "max", usage: FULL };
    for (const id of [LAB, BARE]) onServer(id, () => group("g_A2", "A2 composer")); // those machines' own groups, with the id this computer's has
    const page = (name, chatId, see, more) => state("A2", name, { chat: chatId }, see, { pane: ["page", 300], ...more });
    const panel = (name, sel, see, more) => state("A2", name, sel, see, { pane: ["panel", 300], ...more });
    const SEND = ".composer .send:not(.stop)", AGENT = '.composer button.tchip[title^="Agent"]', FIXED = '.composer .tchip.static[title^="Model and effort"]';
    // (a chat on the lab box is known by its header: the toolbar's server chip is in the "more" popup where the pane is narrow)
    const ON_LAB = { text: LAB_NAME, also: [{ see: ".composer .composer-tools .ctx-meter" }] }, HEAD_SERVER = ".chat-head .chat-head-server";

    // plain chats (G1's cases of the chat page)
    page("plain-started", "c_plain", FIXED);
    add("c_A2_new", { ...g, ...fresh }); page("plain-new", "c_A2_new", AGENT);
    add("c_A2_new_long", { ...g, ...fresh, ...long, usage: fresh.usage }); page("plain-new-long", "c_A2_new_long", '.composer button.tchip[title^="Model"]', { text: "extended thinking" });
    add("c_A2_long", { name: "Long names", ...g, ...long }, THREAD); page("plain-started-long", "c_A2_long", FIXED, { text: "extended thinking" });
    add("c_A2_busy", { name: "Busy", ...g, status: "tool", statusTool: "Bash" }, THREAD.slice(0, 2)); page("plain-busy", "c_A2_busy", ".composer .send.stop");
    add("c_A2_ctxerr", { name: "Context error", ...g, usage: { ...usage, ctxError: "the agent did not report its context" } }, THREAD); page("plain-ctxerr", "c_A2_ctxerr", ".composer .ctx-meter.error");
    add("c_A2_quotes", { name: "Quotes", ...g, draft: { text: "", references: REFS } }, THREAD); page("plain-quotes", "c_A2_quotes", ".composer .qcount");
    page("plain-remote-new", onLab("c_A2_remote_new", { ...g, ...fresh }), HEAD_SERVER, ON_LAB);
    page("plain-remote-started", onLab("c_A2_remote", { name: "On the lab box", ...g }, THREAD), HEAD_SERVER, ON_LAB);
    page("plain-remote-started-long", onLab("c_A2_remote_long", { name: "On the lab box, long", ...g, ...long, cwd: LAB_LONG }, THREAD), HEAD_SERVER, ON_LAB);
    add("c_A2_move", { name: "Move", ...g }, clone(TURNS)); page("plain-move", "c_A2_move", ".composer .fk-banner", { act: "move" });
    add("c_A2_move_long", { name: "Move long", ...g, ...long }, clone(TURNS)); page("plain-move-long", "c_A2_move_long", ".composer .fk-banner", { act: "move" });
    // plain chats G1 did not see
    page("plain-loading", onLab("c_A2_loading", { ...g, ...fresh, agent: "cursor", model: "", effort: undefined }), ".composer .tchip.static", { text: "Loading models" });
    add("c_A2_noagent", { ...g, ...fresh, agent: "", model: "", effort: undefined }); page("plain-noagent", "c_A2_noagent", ".composer .agent-reason", { text: "Choose an agent" });
    onServer(BARE, () => add("c_A2_bare", { ...g, ...fresh, cwd: "/home/bare", agent: "", model: "", effort: undefined })); page("plain-noagent-installed", there(BARE, "c_A2_bare"), ".composer .agent-reason.missing", { text: "No agent is installed on Bare box" });
    // (open as the lab box drops: the chat stays on screen as it was, and its composer says why it takes nothing)
    page("plain-off-new", onLab("c_A2_off_new", { ...g, ...fresh }), ".composer .agent-reason.missing", { text: `${LAB_NAME} is not connected`, ...LAB_DROPS });
    page("plain-off-started", onLab("c_A2_off", { name: "On the lab box, away", ...g }, THREAD), ".chat-page .remote-bar.off", { text: `${LAB_NAME} is not connected`, also: [{ see: ".composer .composer-tools .ctx-meter" }], ...LAB_DROPS });
    const fork = { ...g, fresh: true, forkedFrom: "c_A2_move", forkedFromTitle: "Move", forkedBranch: "main", forkedAt: 3 };
    add("c_A2_fork", { name: "Move (fork)", ...fork }, clone(TURNS.slice(0, 3))); page("plain-fork-fresh", "c_A2_fork", '.composer button.tchip[title^="Effort"]');
    add("c_A2_notice", { name: "Move (fork), another model", ...fork, model: "sonnet", effort: "medium" }, clone(TURNS.slice(0, 3))); page("plain-fork-notice", "c_A2_notice", ".composer .model-notice", { text: "Another model" });
    // two branches whose toolbars differ: alt is at work on the long model (a branch change puts up another composer)
    twoBranches("c_A2_two", { name: "Two toolbars", ...g }, { ...long, status: "tool", statusTool: "Bash" }); page("plain-branches", "c_A2_two", ".chat-head .fk-tree-btn");

    // chats on a board (G1's cases of the panel)
    const on = (chatId) => ({ board: "b_A2", chat: chatId });
    boards.b_A2 = { id: "b_A2", name: "pipeline", group: "g_A2", created: iso(T0 - 110 * MIN) }; // read-only, as the mock's own board
    panel("board-started", { board: "b_arch", chat: "c_board" }, FIXED);
    add("c_A2_board_new", { board: "b_A2", ...fresh }); panel("board-new", on("c_A2_board_new"), AGENT);
    add("c_A2_board_quotes", { name: "Board quotes", board: "b_A2", draft: { text: "", references: REFS } }, THREAD); panel("board-quotes", on("c_A2_board_quotes"), ".composer .qcount");
    add("c_A2_board_long", { name: "Board long", board: "b_A2", ...long }, THREAD); panel("board-long", on("c_A2_board_long"), FIXED, { text: "extended thinking" });
    add("c_A2_board_move", { name: "Board move", board: "b_A2" }, clone(TURNS)); panel("board-move", on("c_A2_board_move"), ".composer .fk-banner", { act: "move" });
    boards.b_A2_long = { id: "b_A2_long", name: "Checkout and refunds architecture, second draft (2026)", group: "g_A2", created: iso(T0 - 100 * MIN) };
    add("c_A2_longname", { name: "On the long board", board: "b_A2_long" }, THREAD); panel("board-longname", { board: "b_A2_long", chat: "c_A2_longname" }, ".composer .ctx-chip", { text: "second draft" });
    add("c_A2_sketch", { name: "On the sketch", board: "b_ui" }, THREAD); panel("board-selected", { board: "b_ui", chat: "c_A2_sketch" }, ".composer .ctx-act", { text: "3 selected", act: "select" });
    // (at work: Stop stands beside Send)
    add("c_A2_board_busy", { name: "Board busy", board: "b_A2", status: "tool", statusTool: "Bash" }, THREAD.slice(0, 2)); panel("board-busy", on("c_A2_board_busy"), ".composer .send.stop");
  }

  // ---- A3: the drop highlight

  function A3() {
    for (const [id, name, more] of [["g_shop", "Shop"], ["g_sub", "Sub", { parent: "g_shop" }], ["g_other", "Other"], ["g_mid", "Mid", { parent: "g_other" }], ["g_leaf", "Leaf", { parent: "g_mid" }]]) {
      group(id, name, more); const g = groups.find((x) => x.id === id); if (!more?.parent) delete g.parent; if (!more?.collapsed) delete g.collapsed;
    }
    boards.b_arch.group = "g_shop";
    add("c_plain", { name: "Why is the build slow", group: "g_shop" }, items.c_plain);
    add("c_A3_a", { name: "Chat A", group: "g_shop" });
    add("c_A3_b", { name: "Chat B", group: "g_sub" });
    add("c_A3_loose", { name: "Loose", group: UNGROUPED });
    add("c_A3_o", { name: "Chat O", group: "g_other" });
    add("c_A3_m", { name: "Chat M", group: "g_mid" });
    const row = (path, name) => ({ see: `.side-group:has(> .side-group-head[title="${path}"]) > .side-group-body > .side-row[title^="${name} —"]` });
    state("A3", "tree", {}, ".side-group .side-group .side-group > .side-group-head .side-group-name", { text: "Leaf",
      also: [row("Shop", "Chat A"), row("Shop / Sub", "Chat B"), row("Other", "Chat O"), row("Other / Mid", "Chat M"), { see: '.side-loose > .side-row[title^="Loose —"]' }] });
  }

  // ---- A4: the waits of the fork flows

  function A4() {
    servers(); catalogs.pi = PI;
    group("g_A4", "A4 waits", { collapsed: true });
    const g = { group: "g_A4" };
    add("c_A4_turns", { name: "Branch send", ...g }, clone(TURNS)); state("A4", "turns", { chat: "c_A4_turns" }, ".thread .fk-act.k-branch", { act: "hover" });
    twoBranches("c_A4_two", { name: "Two branches", ...g }); state("A4", "two-branches", { chat: "c_A4_two" }, ".fk-nav .fk-rows", { act: "tree" });
    onServer(LAB, () => group("g_A4", "A4 waits"));
    state("A4", "remote-turns", { chat: onLab("c_A4_remote", { name: "Branch send on the lab box", ...g }, clone(TURNS)) }, ".thread .fk-act.k-branch", { act: "hover" });
    const fork = (kind, more) => {
      const id = `c_A4_fork_${kind}`, c = catalogs[kind].default;
      add(id, { name: `Branch send (fork, ${kind})`, ...g, agent: kind, model: c.model, effort: c.effort, fresh: true, forkedFrom: "c_A4_turns", forkedFromTitle: "Branch send", forkedBranch: "main", forkedAt: 3, ...more }, clone(TURNS.slice(0, 3)));
      state("A4", `fork-${kind}`, { chat: id }, '.composer button.tchip[title^="Model"]');
    };
    fork("claude"); fork("cursor"); fork("pi");
  }

  // ---- A5: tool cards

  function A5() {
    group("g_A5", "A5 tool cards", { collapsed: true });
    const g = { group: "g_A5" }, ask = (text) => ({ kind: "user", text }), done = [say("Done."), { kind: "end" }];
    const OLD = "func Sum(xs []int) int {\n\ttotal := 0\n\tfor _, x := range xs {\n\t\ttotal += x\n\t}\n\treturn total\n}", NEW = OLD.replace("total += x", "total += x * 2");
    const FILE = "package calc\n\n// Sum adds the numbers.\n" + OLD + "\n";
    // (a file of 124 lines with Sum in its middle: Cursor's edit carries all of it, before and after)
    const filler = (from) => Array.from({ length: 56 }, (_, i) => `// note ${from + i}`).join("\n");
    const LONG_FILE = "package calc\n\n" + filler(1) + "\n\n// Sum adds the numbers.\n" + OLD + "\n\n" + filler(57) + "\n";
    const thread = (id, name, agent, list) => { add(id, { name, ...g, agent, ...(agent === "claude" ? {} : { model: catalogs[agent]?.default.model ?? "", effort: catalogs[agent]?.default.effort }) }, [ask("Make the change and run the tests."), ...list, ...done]); state("A5", id.slice(5), { chat: id }, ".thread .tool .tool-label", { count: list.length }); };
    // Claude: Bash (done, failed with its "Exit code" line, in the background), Edit (one, all occurrences), MultiEdit, Write, NotebookEdit, rm
    thread("c_A5_claude", "Tool items, Claude", "claude", [
      tool("c1", "Bash", { command: "go test ./internal/calc/\n", description: "Run the calc tests" }, "ok  \tai-whiteboard/internal/calc\t0.412s"),
      tool("c2", "Bash", { command: "go vet ./... &&\n  go test ./internal/calc/ -run TestSum", description: "Vet, then one test", timeout: 120000 }, "--- FAIL: TestSum (0.00s)\n    calc_test.go:12: Sum([1 2 3]) = 12, want 6\nFAIL\nFAIL\tai-whiteboard/internal/calc\t0.288s\nExit code 1", { isError: true }),
      tool("c3", "Bash", { command: "npm run watch", description: "Rebuild on change", run_in_background: true }, "Command running in background with ID: bash_1. Output is being written to: /tmp/claude/bash_1.log."),
      tool("c4", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", old_string: OLD, new_string: NEW }, "The file /Users/demo/projects/shop/internal/calc/sum.go has been updated successfully."),
      tool("c5", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", old_string: "total", new_string: "sum", replace_all: true }, "The file /Users/demo/projects/shop/internal/calc/sum.go has been updated successfully."),
      tool("c6", "MultiEdit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", edits: [{ old_string: "Sum adds", new_string: "Sum doubles and adds" }, { old_string: "x * 2", new_string: "2 * x" }] }, "The file /Users/demo/projects/shop/internal/calc/sum.go has been updated successfully."),
      tool("c7", "Write", { file_path: "/Users/demo/projects/shop/internal/calc/sum_test.go", content: "package calc\n\nimport \"testing\"\n\nfunc TestSum(t *testing.T) {\n\tif got := Sum([]int{1, 2, 3}); got != 12 {\n\t\tt.Fatalf(\"Sum = %d\", got)\n\t}\n}\n" }, "File created successfully at: /Users/demo/projects/shop/internal/calc/sum_test.go"),
      tool("c8", "NotebookEdit", { notebook_path: "/Users/demo/projects/shop/notes/sums.ipynb", cell_id: "cell-3", new_source: "sum(x * 2 for x in xs)", cell_type: "code", edit_mode: "replace" }, "Updated cell cell-3"),
      tool("c9", "Bash", { command: "rm internal/calc/old_sum.go", description: "Delete the old file" }, ""),
    ]);
    // Cursor, as the server maps it: Bash with the command alone; Edit with the file before and after (the whole of it), of a new file
    // (no old text), with texts over the server's bound left out; Delete with the deleted text, and without. Then the items of a thread
    // from before the texts were kept: Edit with the path alone, a delete named by its title. And another tool named by its title
    thread("c_A5_cursor", "Tool items, Cursor", "cursor", [
      tool("k1", "Bash", { command: "go test ./internal/calc/" }, "ok  \tai-whiteboard/internal/calc\t0.412s"),
      tool("k2", "Bash", { command: "go test ./internal/calc/ -run TestSum" }, "--- FAIL: TestSum (0.00s)\nFAIL\nexit status 1", { isError: true }),
      tool("k7", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", old_string: LONG_FILE, new_string: LONG_FILE.replace("total += x", "total += x * 2") }, ""),
      tool("k8", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/doc.go", new_string: "// Package calc adds numbers.\npackage calc\n" }, ""),
      tool("k9", "Edit", { file_path: "/Users/demo/projects/shop/web/dist/main.js", texts_omitted: true }, ""),
      tool("k10", "Delete", { file_path: "/Users/demo/projects/shop/internal/calc/old_sum.go", old_string: FILE }, ""),
      tool("k11", "Delete", { file_path: "/Users/demo/projects/shop/internal/calc/tmp.go" }, ""),
      tool("k3", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go" }, ""),
      tool("k4", "Delete `/Users/demo/projects/shop/internal/calc/old_sum.go`", { path: "/Users/demo/projects/shop/internal/calc/old_sum.go" }, ""),
      tool("k5", "Update todos", { todos: [{ content: "Double the sum", status: "completed" }] }, ""),
      tool("k6", "Read", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go" }, FILE),
    ]);
    // pi: its own lower-case names; edit with edits[] and with the legacy pair
    thread("c_A5_pi", "Tool items, pi", "pi", [
      tool("p1", "bash", { command: "go test ./internal/calc/", timeout: 120 }, "ok  \tai-whiteboard/internal/calc\t0.412s"),
      tool("p2", "bash", { command: "go test ./internal/calc/ -run TestSum" }, "--- FAIL: TestSum (0.00s)\nFAIL\n\nCommand exited with code 1", { isError: true }),
      tool("p3", "edit", { path: "internal/calc/sum.go", edits: [{ oldText: OLD, newText: NEW }, { oldText: "Sum adds", newText: "Sum doubles and adds" }] }, "Successfully replaced 2 block(s) in internal/calc/sum.go."),
      tool("p4", "edit", { path: "internal/calc/sum.go", oldText: "x * 2", newText: "2 * x" }, "Successfully replaced 1 block(s) in internal/calc/sum.go."),
      tool("p5", "write", { path: "internal/calc/doc.go", content: "// Package calc adds numbers.\npackage calc\n" }, "Successfully wrote to internal/calc/doc.go"),
      tool("p6", "bash", { command: "rm internal/calc/old_sum.go" }, "(no output)"),
    ]);
    // incomplete items (G4 §5): closed by a copy, denied, a call with nothing but its id, one that was never written (the server
    // loads an empty item in its place), running with its input, and running with a partial that does not parse yet
    add("c_A5_gaps", { name: "Tool items, incomplete", ...g, status: "tool", statusTool: "Write" }, [ask("Make the change."),
      tool("i1", "Bash", { command: "go build ./...", description: "Build" }, "", { isError: true }),
      tool("i2", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", old_string: OLD, new_string: NEW }, undefined, { denied: true }),
      { kind: "tool", toolId: "i3" }, { kind: "" },
      tool("i4", "Bash", { command: "go test ./...", description: "Run the tests" }),
      { kind: "tool", toolId: "i5", name: "Write", partial: '{"file_path": "/Users/demo/projects/shop/internal/calc/doc.go", "content": "// Package calc adds num' }]);
    // (a card per kind, told apart by its label; the item that was never written draws nothing)
    const card = (cls, label) => ({ see: `.thread .tool${cls} .tool-label:text-is("${label}")`, count: 1 });
    state("A5", "gaps", { chat: "c_A5_gaps" }, ".thread .tool .tool-label", { count: 5,
      also: [card(".err:not(.running)", "Build"), card(".err:not(.running)", "Editing sum.go — denied"), card(".running", "…"), card(".running", "Run the tests…"), card(".running", "Writing a file…")] });
    // a long output (3,000 lines) and a large input (a file of some 200,000 characters)
    const lines = Array.from({ length: 3000 }, (_, i) => `ok  \tai-whiteboard/internal/pkg${String(i + 1).padStart(4, "0")}\t0.${String(100 + (i * 37) % 900)}s`).join("\n");
    const big = Array.from({ length: 4000 }, (_, i) => `export const row${i} = { id: ${i}, name: "row ${i}", tags: ["a", "b"] };`).join("\n");
    // a long change (300 lines, each another) and a card of 30 edits
    const column = (tag) => Array.from({ length: 300 }, (_, i) => `\t${tag}Row${i}: ${i},`).join("\n");
    add("c_A5_big", { name: "Tool items, large", ...g }, [ask("Run everything and write the table."),
      tool("b1", "Bash", { command: "go test ./...", description: "Run every test" }, lines),
      tool("b2", "Write", { file_path: "/Users/demo/projects/shop/web/src/rows.ts", content: big }, "File created successfully at: /Users/demo/projects/shop/web/src/rows.ts"),
      tool("b3", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/table.go", old_string: column("old"), new_string: column("new") }, "The file /Users/demo/projects/shop/internal/calc/table.go has been updated successfully."),
      tool("b4", "MultiEdit", { file_path: "/Users/demo/projects/shop/internal/calc/table.go", edits: Array.from({ length: 30 }, (_, i) => ({ old_string: `v${i} := 0`, new_string: `v${i} := 1` })) }, "The file /Users/demo/projects/shop/internal/calc/table.go has been updated successfully."), ...done]);
    state("A5", "big", { chat: "c_A5_big" }, ".thread .tool .tool-label", { count: 4 });
    // names and lines with nowhere to break: a command, a description, a path, a file's name, a tool's name, an output, a change. As a
    // plain chat, and in the panel beside a board
    const run = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n), DEEP = "/Users/demo/projects/shop/" + "generated/".repeat(12) + run("AVeryLongGeneratedFileName", 120) + ".go";
    const WIDE = [
      tool("w1", "Bash", { command: "curl -fsSL https://example.com/" + run("download/", 400) + "\necho done" }, run("0123456789", 3000)),
      tool("w2", "Bash", { command: run("ENVIRONMENT_VARIABLE_", 300) + "=1 make", description: run("Describedwithoutasinglespace", 200) }, "ok", { isError: true }),
      tool("w3", "Edit", { file_path: DEEP, old_string: "const key = \"" + run("a", 600) + "\";", new_string: "const key = \"" + run("b", 600) + "\";" }, ""),
      tool("w4", "Write", { file_path: DEEP, content: "package generated\n\nconst blob = \"" + run("z", 900) + "\"\n" }, "ok"),
      tool("w5", "mcp__some_server__" + run("tool_name_", 150), { key: run("v", 500) }, run("r", 700)),
      tool("w6", run("ToolNamedWithNoBreak", 160), { key: run("v", 500) }, run("r", 700)),
    ];
    add("c_A5_wide", { name: "Tool items, nowhere to break", ...g }, [ask("Fetch it and write the key."), ...clone(WIDE), ...done]);
    state("A5", "wide", { chat: "c_A5_wide" }, ".thread .tool .tool-label", { count: WIDE.length, pane: ["page", 300] });
    boards.b_A5 = { id: "b_A5", name: "calc", group: "g_A5", created: iso(T0 - 100 * MIN) };
    add("c_A5_panel", { name: "Tool items, beside a board", board: "b_A5" }, [ask("Fetch it and write the key."), ...clone(WIDE), ...done]);
    state("A5", "panel", { board: "b_A5", chat: "c_A5_panel" }, ".board-panel .thread .tool .tool-label", { count: WIDE.length, pane: ["panel", 300] });
    // items no agent sends: fields of other types than the page reads. Each is a card all the same
    const JUNK = [{ kind: "tool" },
      { kind: "tool", toolId: "j1", name: 5, input: "text", result: { code: 1 } },
      { kind: "tool", toolId: "j2", name: "Bash", input: { command: 5 }, result: 7 },
      { kind: "tool", toolId: "j3", name: "Bash", input: ["ls"], partial: 5, result: null },
      { kind: "tool", toolId: "j4", name: "Edit", input: { file_path: {}, old_string: 1, new_string: [] }, isError: "yes" },
      { kind: "tool", toolId: "j5", name: "Edit", input: { file_path: "/a.go", edits: "none" }, result: "" },
      { kind: "tool", toolId: "j6", name: "MultiEdit", input: { file_path: "/a.go", edits: [null, 5, { old_string: {}, new_string: "b" }] }, result: "" },
      { kind: "tool", toolId: "j7", name: "Write", input: { path: ["a"], content: { a: 1 } }, result: "" },
      { kind: "tool", toolId: "j8", name: "Write", input: null, partial: '{"file_path": 12, "content": [', denied: 1 },
      { kind: "tool", toolId: "j9", name: "Delete", input: { file_path: "/a.go", old_string: 9, texts_omitted: "yes" }, result: "" },
      { kind: "tool", toolId: "j10", name: "mcp__board__apply", input: { board: {} }, result: "{" },
      { kind: "tool", toolId: "j11", name: "mcp__board__create_board", input: 3, result: "[]" },
      { kind: "tool", toolId: "j12", name: "toString", input: { command: "ls" }, result: "x" },
      { kind: "tool", toolId: "j13", name: "Bash", input: { command: "ls", description: { text: "x" } }, result: "ok" },
      { kind: "tool", toolId: "j14", name: "write", input: { path: "a.go", content: "x" }, result: ["a"], isError: true }];
    add("c_A5_junk", { name: "Tool items, malformed", ...g }, [ask("Anything."), ...JUNK, ...done]);
    state("A5", "junk", { chat: "c_A5_junk" }, ".thread .tool", { count: JUNK.length });
    // a tool item in a subagent's thread
    add("c_A5_sub", { name: "Tool items, subagent", ...g }, [ask("Have the change reviewed."),
      { ...tool("s0", "Agent", { description: "Review the doubled sum", prompt: "Read internal/calc/sum.go and say whether doubling is right." }, "The doubling is intended."), subagent: "s1" }, ...done]);
    subs.c_A5_sub = [{ id: "s1", tool: "s0", description: "Review the doubled sum", prompt: "Read internal/calc/sum.go and say whether doubling is right.", kind: "claude", model: "sonnet", effort: "medium",
      status: "completed", started: T0 - 95000, ended: T0 - 30000, tokens: 31000, window: 200000, toolUses: 2, summary: "The doubling is intended." }];
    subItems["c_A5_sub/s1"] = [say("Reading the file."), tool("s1a", "Bash", { command: "git log -3 -- internal/calc/sum.go", description: "Recent changes" }, "4f2a1c9 Double the sum\n9b0d3e1 Add Sum"),
      tool("s1b", "Edit", { file_path: "/Users/demo/projects/shop/internal/calc/sum.go", old_string: "// Sum adds the numbers.", new_string: "// Sum doubles the numbers and adds them." }, "The file /Users/demo/projects/shop/internal/calc/sum.go has been updated successfully."),
      say("The doubling is intended.")];
    state("A5", "sub", { chat: "c_A5_sub" }, ".sub-drawer-body .tool .tool-label", { act: "drawer", count: 2 });
  }

  // ---- A6: the themes

  function A6() {
    servers(); sketch();
    group("g_A6", "A6 themes", { collapsed: true });
    const g = { group: "g_A6" };
    const code = "The copy step is in `build.mjs`:\n\n```js\n// copies the fonts once\nconst fonts = \"node_modules/@excalidraw/excalidraw/dist/prod/fonts\";\nif (!fs.existsSync(\"dist/fonts\")) fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\nexport const COUNT = 42;\n```\n\n```diff\n-fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\n+if (!fs.existsSync(\"dist/fonts\")) fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\n```\n\n```ts\nclass FontCopy extends Step {\n  run(count: number): string { return `copied ${count}`; }\n}\nfunction copyFonts() { console.log(new FontCopy().run(3)); }\n```\n\n```json\n{ \"name\": \"ai-whiteboard-web\", \"private\": true, \"version\": 1 }\n```\n\n| Step | Before | After |\n|---|---|---|\n| fonts | 2.1 s | 0.0 s |\n\n> A quoted line, **bold**, _italic_ and a [link](https://example.com).";
    add("c_A6_cards", { name: "Code, tool and permission cards", ...g, status: "approval" }, [{ kind: "user", text: "Why is the build slow? Fix it." }, say(code),
      tool("t1", "Bash", { command: "node build.mjs", description: "Build the client" }, "dist/main.js  9.2mb\n⚡ Done in 412ms"),
      tool("t2", "Bash", { command: "node build.mjs --fail", description: "Build again" }, "error: unknown option --fail", { isError: true }),
      { kind: "note", text: "The agent was interrupted.", tone: "muted" }, { kind: "note", text: "The agent ended with an error.", tone: "error" },
      { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "rm -rf dist/fonts", description: "Remove the copied fonts" }, decided: "allow" },
      { kind: "perm", requestId: "q2", toolName: "Edit", input: { file_path: "/Users/demo/projects/shop/web/build.mjs" }, decided: "deny" },
      { kind: "perm", requestId: "q3", toolName: "Bash", input: { command: "git push origin main", description: "Publish the fix" }, decided: "" }]);
    state("A6", "cards", { chat: "c_A6_cards" }, ".thread .perm.pending .perm-actions");
    state("A6", "code", { chat: "c_A6_cards" }, ".thread .md-code");
    twoBranches("c_A6_tree", { name: "Tree popup", ...g }); state("A6", "tree-popup", { chat: "c_A6_tree" }, ".fk-nav .fk-rows", { act: "tree" });
    add("c_A6_sketch", { name: "On the sketch", board: "b_ui" }, clone(THREAD)); state("A6", "board", { board: "b_ui", chat: "c_A6_sketch" }, ".excalidraw:not(.excalidraw--view-mode) .App-toolbar");
  }

  // ---- SEC: the sections of the sidebar

  function SEC() {
    const STUDIO = "s_studio", HOME_ = "/Users/studio", WORK = `${HOME_}/work`;
    for (const id of [STUDIO, "s_empty", "s_wait", "s_away", "s_old", "s_cert"]) delete worlds[id]; // each machine anew
    addServer({ id: STUDIO, name: "Studio Mac", address: "https://studio-mac.example:4790", state: "connected", version: "dev" }, { lists: { agents: ["claude"], catalogs: { claude }, home: HOME_, defaultCwd: WORK } });
    addServer({ id: "s_empty", name: "Empty box", address: "https://empty-box.example:4790", state: "connected", version: "dev" }, { lists: { agents: ["claude"], catalogs: { claude }, home: "/home/empty", defaultCwd: "/home/empty" } });
    addServer({ id: "s_wait", name: "Slow link", address: "https://slow-link.example:4790", state: "connecting" });
    addServer({ id: "s_away", name: "Attic server", address: "https://attic.example:4790", state: "unreachable", detail: "connection refused" });
    addServer({ id: "s_old", name: "Old Mini", address: "https://old-mini.example:4790", state: "too_old", version: "0.9.1" });
    addServer({ id: "s_cert", name: "Cert box", address: "https://cert-box.example:4790", state: "certificate_changed" });
    onServer(STUDIO, () => {
      const at = (o) => ({ cwd: WORK, ...o });
      groups.push({ id: "g_shop", name: "Renders", collapsed: true }, { id: "g_sub", name: "Nightly", parent: "g_shop" }, { id: "g_old", name: "Old takes" });
      boards.b_loose = { id: "b_loose", name: "Floor plan", group: UNGROUPED, created: iso(T0 - 200 * MIN) };
      scenes.b_loose = { rev: 3, scene: { type: "excalidraw", version: 2, elements: [{ id: "sec_rect", type: "rectangle", x: 120, y: 100, width: 180, height: 110 }], appState: {}, files: {} } };
      boards.b_arch = { id: "b_arch", name: "Storyboard", group: "g_shop", created: iso(T0 - 300 * MIN) };
      add("c_plain", at({ name: "Render queue is stuck", group: UNGROUPED }), [{ kind: "user", text: "Why is the render queue stuck?" }, say("Two jobs hold the GPU lock."), { kind: "end" }]);
      add("c_note", at({ name: "Scratch", group: UNGROUPED, created: iso(T0 - 3 * MIN), draft: { text: "remember the LUTs" }, draftRev: 2 }), clone(THREAD)); // (the newest: the first of the chats)
      add("c_arch", at({ name: "Put away there", group: UNGROUPED, archived: true, archiveOp: "op_sec1" }), clone(THREAD));
      add("c_on_floor", at({ name: "Label the rooms", board: "b_loose" }), clone(THREAD));
      add("c_story", at({ name: "Tighten act two", board: "b_arch" }), clone(THREAD));
      add("c_queue", at({ name: "Queue order", group: "g_shop", status: "tool", statusTool: "Bash" }), THREAD.slice(0, 2));
      add("c_night", at({ name: "Last night's failures", group: "g_sub" }), clone(THREAD));
      add("c_take", at({ name: "Take 14", group: "g_old" }), clone(THREAD));
    });
    const sec = (id) => `.side-section[data-server="${id}"]`, says = (id, text) => ({ see: `${sec(id)} .side-section-state`, text });
    state("SEC", "sidebar", {}, `${sec(STUDIO)} .side-group .side-group .side-row`, { text: "Last night's failures",
      also: [says(STUDIO, "Connected"), { see: `${sec("s_empty")} .side-section-line`, text: "Nothing on this server yet." }, says("s_wait", "Connecting"), { see: `${sec("s_away")} .side-section-line`, text: "when the server is back" },
        says("s_old", "Too old"), { see: `${sec("s_old")} .side-section-line`, text: "Update the server on that machine." }, { see: `${sec("s_old")} .side-section-line:last-child`, text: "0.9.1" }, says("s_cert", "Certificate changed")] });
    state("SEC", "chat", { chat: there(STUDIO, "c_plain") }, ".chat-head .chat-head-server", { text: "Studio Mac", also: [{ see: ".thread .msg.user", text: "render queue" }] });
    state("SEC", "board", { board: there(STUDIO, "b_loose"), chat: there(STUDIO, "c_on_floor") }, ".excalidraw:not(.excalidraw--view-mode) .App-toolbar");
    const drops = { act: `drop:${STUDIO}` };
    state("SEC", "chat-away", { chat: there(STUDIO, "c_plain") }, ".remote-bar.off", { text: "Studio Mac is not connected", ...drops });
  }

  const SECTIONS = { A1, A2, A3, A4, A5, A6, SEC };
  for (const name of only.length ? only : Object.keys(SECTIONS)) { if (!SECTIONS[name]) throw new Error(`the seed has no section ${name}`); SECTIONS[name](); }
  resync();
  return states;
}
