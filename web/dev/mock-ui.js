// Read by mock.mjs when seedUI() is called through /mock/eval (evaluated inside it): the states of the composer
// and chat UI work (plans/composer-ui-improvements.md, section 3), one section per item. `seedUI()` makes all of
// them, `seedUI("A2", "A3")` the ones named; then it tells the page the list and the snapshots again (resync). It answers the list of its states, each
// with where the page shows it:
//   { id, section, sel, see, text?, count?, also?, pane?, act?, mock?, pre?, ls? }
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
//   pre    code run in the mock before the page loads (which servers are listed: UXH1)
//   ls     the page's localStorage before it loads, { key: value } (UXH1: this computer hidden, Home's saved place)
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
//   UXC1 the phone's composer (package C1): plain chats (new, started, busy, a ring over 80 %), chats on the board "Pipeline" (new, started, with a draft of
//       a mention and two quotes), five boards "R…" for the @ dock, a chat on the editable board b_ui for "Board selection"
//   UXB2 Point at and Add selection on the phone (ux-improvements B2; UX.B2-pick reads it): the group "UXB2 pick" with the board b_UXB2 "Checkout flow"
//       (its scene: the labelled rectangles uxb2_checkout "Checkout service", uxb2_payments "Payments", uxb2_inventory "Inventory", uxb2_orders "Orders DB"
//       and the unlabelled uxb2_blank, apart from each other, in no group) and the chat c_UXB2 "Draw the request flow" on it (Claude, started). The states
//       "point" and "select" are the board while the chat waits for a point / for shapes (started by window.__aiwbPick; P0.3's rows)
//   UXC2 the phone's chip row, its pickers and the empty chat (package C2): "new" a new plain Claude chat (every chip), "missing" a new chat whose agent
//       (cursor) its server (the remote "Pi box", agents claude and pi) lacks, "fork" a fork with no message of its own (the model chip alone), "pi" a new pi
//       chat on the Pi box whose catalog has ten models of three providers (headings and the search), "started" a started chat (no row). The folder
//       "docs" of the default folder, and "empty-repo" beside it, have no subfolders (mock.mjs TREE). UX.C2-pickers reads these
//   UXT1 the chat on the phone (ux-improvements T1): one chat with a long title and folder, three branches (one waits for approval, so the
//       Tree is amber) and a reply with an h2, an h3, a bulleted and a numbered list, inline code, a link with words, a six-column table
//       under a heading and a code block in a known language with a line longer than the screen. UX.T1-thread reads it
//   UXT2 tool steps, permissions and subagents on the phone (ux-improvements T2): "steps" a failed command with its exit code and 14
//       lines of output, three reads in a row, an edit of two changes (+5 −2) whose result shows the file's line numbers, a write; "perm"
//       a long thread that ends with two waiting permission requests (the dock: "1 of 2"); "busy" an answered request and a command at work;
//       "subs" one call of three subagents (one finished with 14 steps and a report, one waiting on a nested one at work, one finished) and
//       the report row of the last. UX.T2-tools reads these words, so a change here is a change there
//   SEC the sections of the sidebar (plans/remote-server-sections-goal.md, section 3), one server of the list per
//       state of a section, each made anew by every seed: s_studio "Studio Mac", connected, with a tree (loose: the
//       board b_loose that answers a take, with a chat; the chats c_plain and c_note, the second with a saved draft at
//       counter 2; the archived chat c_arch. The group g_shop "Renders", which that machine's own page shows
//       collapsed: the board b_arch with a chat, the chat c_queue at work, and in it the group g_sub "Nightly" with a
//       chat. The group g_old "Old takes" with a chat);
//       s_empty "Empty box", connected, with nothing; s_wait "Slow link", connecting; s_away "Attic server", not
//       connected; s_old "Old Mini", too old; s_cert "Cert box", whose certificate changed. The ids c_plain, g_shop and
//       b_arch are also ids of this computer's own things
//   UXS2 the Servers screens of the phone (ux-improvements package S2), one server per state, other ids than SEC's and made anew by every
//       seed: s_build "Build box", connected, version 1.8.2, agents claude and cursor, self-signed, pinned (BUILD); s_home "Home lab",
//       connected, 1.8.2; s_attic "Attic server", unreachable ("connection refused"); s_certbox "Cert box", certificate changed
//       (pinned CERT_OLD, presents CERT_NOW); s_mini "Old Mini", too old (0.9.1); s_slow "Slow link", connecting. The constants
//       (fingerprints, ids) are in dev/checks/srv.mjs; the states are for the phone, each pushes a screen of the stack by an act
//       ("srv-list", "srv-detail:<id>", "srv-cert:<id>", sel.mjs)
//   UXT3 Chat info, Context and usage, the chat tree, images and an offline or archived thread on the phone (ux-improvements T3), in the
//       collapsed group "UXT3 chat info": c_UXT3_chat "Fix the flaky cart test" (started, Claude, Opus, High, in
//       /Users/ana/projects/acme/checkout-service; a context split, two branches, one label, and a first message with two images);
//       c_UXT3_arch "Old refund spike" (archived); and on s_uxt3 "Design Mac" (connected; a check or the state `remote-off` drops it) the chat
//       c_UXT3_remote "Check the staging deploy" with a thread and a permission request that waits. The plan limits are not seeded (they
//       would show in every chat): a check sets `ux3.plan` (mock.mjs). UX.T3-chatinfo reads these words
//   UXH1 the phone's Home (plans/ux-improvements/h1-design.md; the states are `show(…)` in the section). Its servers are made (mock.mjs
//       `uxh1Make`, ids "h1_…") and left out of the list, so that no other state sees them: a state's `pre` lists the ones it needs
//       (`uxh1Show(ids, { connected })`, `uxh1NoServers()`), `uxh1Reset()` (the next seed's and P0.3's undo) puts the list back. This
//       computer is hidden by the page's own knob, `localStorage` `aiwb.uicheck.nolocal` = "1" (app/src/platform/thiscomputer.ts, a build
//       of the version "uicheck" only): the `ls` of every state. Home's selected server and the groups browsed are its saved place,
//       `localStorage` `aiwb.home` = {"server": "<entry id>", "groups": ["<entry id>~<group id>", …]} (the entry ids are the ones below;
//       "local" is this computer; a group is named by its key): a check selects a server by setting it before the load, in the same `ls`.
//         h1_studio "Studio Mac"   connected, rich as sh2-10a: groups Checkout service (> Payments > Refunds, > Experiments), Mobile app, Infra;
//                                  loose boards (Orders data model with a chat, Onboarding flow); loose chats (Regex for promo codes on pi,
//                                  Rename the env vars: needs approval, Fix the flaky cart test: stopped); under Checkout service two
//                                  chats on boards need approval (Checkout flow, Payment providers: the count 2 of the group, 1 of Payments)
//         h1_one "Studio Mac"      connected, a small tree (one group, two boards, three chats)
//         h1_build "Build box"     connecting, for good
//         h1_attic "Attic"         unreachable, with a tree of its own for the state that serves it connected first (`uxh1Show(…, { connected:
//                                  ["h1_attic"] })`, then `await uxh1DropAttic()` once Home has drawn: the app keeps that last copy, faded)
//         h1_cert "Garage Mac"     certificate changed
//         h1_release "Release box" connected: the group Release prep (a chat that needs approval and a stopped one: a count of 2), the group
//                                  Scratch (empty), the board Load test (a chat at work: no dot), the board Deploy plan (a chat that needs approval: a dot)
//         h1_empty "Empty box"     connected, with nothing on it
//       The states: one (h1_one alone: no chips), four (the chips of 10a; Studio Mac selected), connecting (Build box selected: placeholders),
//       trouble (Attic selected after it dropped), cert (Garage Mac selected), kinds (h1_release), nested (Refunds, three deep), empty-group,
//       empty-server, none (no server at all: first run)
//   UXH2 the phone's row actions, rename, + New, Archived and search (plans/ux-improvements/h2-design.md §8; UX.H2-rows reads it). Two servers are made
//       (`uxh1Make`, ids "h2_…", out of the list; a state's `pre` lists them: `uxh1Show(["h2_studio", "h2_build"])`), this computer hidden as in UXH1:
//         h2_studio "Studio Mac"  connected. Groups: Checkout service (> Payments), Infra. Boards: Checkout flow and Cart redesign in Checkout service
//                                  (a chat on Checkout flow: "Draft the checkout states"), Payment providers in Payments, Orders data model loose. Chats: in
//                                  Checkout service "Audit the checkout flow" and "Stock reservation bug", in Payments "Failed-payment retries", loose "Regex for
//                                  promo codes", "Rename the env vars", "Fix the flaky cart test". ARCHIVED: the chat "Old pricing notes" (in Checkout service),
//                                  the board "Retired sketch" (in Checkout service), the chat "Scratch ideas" (loose), and the group "Old experiments" holding the
//                                  chat "Experiment log", archived with it (the same archiveOp: the chat is not listed on its own)
//         h2_build "Build box"    connected. Group Release notes with a chat and the archived chat "Old changelog draft"
//       The states: rows (Home, Studio Mac selected), group (Checkout service's screen), archived (Settings › Archived), search (search open, recent
//       searches "checkout" and "regex", recently opened a chat and a board), away (Studio Mac dropped once Home has drawn: the last copy, faded).
//   UXV1 the phone's blocked composer, voice in the composer and the voice card (package V1; UX.V1-voice reads it). One group "UXV1 voice"
//       (collapsed): c_UXV1_plain "Plain" (a started chat: Dictate and the speech bar), c_UXV1_arch (archived), c_UXV1_legacy (the old board
//       connection, on no board) and c_UXV1_legacy_board (on the board b_ui), and the chats "Layout notes" and "Colours" on the editable board
//       b_ui (the voice card's two chats). On the server s_uxv1 "Design Mac" (agents claude and pi; pi's catalog has a 40k model and a big one,
//       and `s_uxv1` is also the server a state drops): c_UXV1_draft (a draft, "Reply to Dana about the staging rollout"), c_UXV1_arch_remote
//       (archived), c_UXV1_gone (a state removes it from its server once the page has it open), c_UXV1_small (a fork on pi whose model is
//       too small for the conversation); on s_uxv1_bare "Bare box" (no agent installed) c_UXV1_bare (started) and c_UXV1_bare_new (a new chat). The states: draft (the draft chat),
//       draft-off (the draft chat with Design Mac dropped), arch, arch-off (the remote archived chat, dropped), legacy, legacy-board, noagent,
//       toosmall, gone, plain, board. The refused card has no state: the check turns `flags.send` on and sends (a refusal comes from a send)
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
      tool("b2", "Write", { file_path: "/Users/demo/projects/shop/site/rows.ts", content: big }, "File created successfully at: /Users/demo/projects/shop/site/rows.ts"),
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

  // ---- UXT1: the chat on the phone (package T1)

  /** The reply of the chat: every block T1 draws on the phone. UX.T1-thread reads these words, so a change here is a change there. */
  const T1_REPLY = [
    "## Why the build is slow",
    "The copy step runs on every build and copies every font file again, so most of the time goes to the disk.",
    "### What I changed",
    "- Copy the fonts once, and keep `dist/fonts` between builds.\n- Skip the step when `fonts.lock` did not change.",
    "1. Read the lock file.\n2. Compare it with the copy.\n3. Copy only when they differ, as [the font copy notes](https://example.com/fonts) describe.",
    "### Timings per step",
    "| Step | Before | After | Saved | Share | Notes |\n|---|---|---|---|---|---|\n| fonts | 2.1 s | 0.0 s | 2.1 s | 41% | copied once now |\n| bundle | 1.8 s | 1.7 s | 0.1 s | 35% | no change |\n| images | 0.9 s | 0.4 s | 0.5 s | 17% | cached by hash |\n| types | 0.4 s | 0.4 s | 0.0 s | 7% | already incremental |",
    "```js\n// copies the fonts once, then only when the lock file changes\nconst fonts = \"node_modules/@excalidraw/excalidraw/dist/prod/fonts\";\nif (!fs.existsSync(\"dist/fonts\") || lockChanged()) { fs.cpSync(fonts, \"dist/fonts\", { recursive: true }); console.log(\"copied the fonts: \" + fs.readdirSync(fonts).join(\", \")); }\n```",
    "That is all of it."].join("\n\n");

  function UXT1() {
    longNames();
    group("g_UXT1", "UXT1 chat on the phone", { collapsed: true });
    const id = "c_UXT1_chat";
    add(id, { name: "Why is the build so slow on the storefront monorepo, and what can be done about the font copy step", group: "g_UXT1", cwd: LONG_DIR },
      [{ kind: "user", text: "Why is the build slow? Please look at the font copy step." }, say(T1_REPLY), { kind: "end", point: "p1" }]);
    // (the branches: "alt" waits for approval, which turns the Tree's number amber; "plain" is ready)
    const alt = addBranch(id, "main", 3, { status: "approval" }, "alt");
    alt.items.push(...turn("Is there a faster way?", "Yes: skip the copy when the fonts did not change.", "q2"));
    const plain = addBranch(id, "main", 3, {}, "plain");
    plain.items.push(...turn("And the images?", "They are cached by their hash.", "q3"));
    state("UXT1", "thread", { chat: id }, ".thread .md", { also: [{ see: ".thread .md-table" }, { see: ".thread .md-code" }] });
    // a chat without branches: the Tree has no number and is not amber
    add("c_UXT1_plain", { name: "Plain chat", group: "g_UXT1" }, clone(TURNS));
    state("UXT1", "plain", { chat: "c_UXT1_plain" }, ".thread .msg.user");
  }

  // ---- UXT3: Chat info, Context and usage, the chat tree, images, an offline or archived thread (package T3)

  /** The ids of the two images of the first message (64 hex characters, as the server makes them); UX.T3-chatinfo answers their fetches. */
  const T3_IMAGES = ["a".repeat(64), "b".repeat(64)];
  /** The context split of the chat: 36 % of 200k, with parts under Messages and items under System tools (the shape of L12's). */
  const T3_SPLIT = {
    atMessage: 7, atTurn: 3, total: 71800, window: 200000,
    categories: [
      { id: "system_prompt", label: "System prompt", tokens: 6200, kind: "used" },
      { id: "system_tools", label: "System tools", tokens: 14300, kind: "used", items: [{ name: "Edit", tokens: 700 }, { name: "Bash", tokens: 1200 }, { name: "Read", tokens: 900, note: "built-in" }] },
      { id: "mcp_tools", label: "MCP tools", tokens: 400, kind: "used" },
      { id: "messages", label: "Messages", tokens: 43000, kind: "used", parts: [
        { id: "tool_results", label: "Tool results", tokens: 20000, kind: "used" }, { id: "assistant", label: "Assistant", tokens: 15000, kind: "used" }, { id: "user", label: "User", tokens: 8000, kind: "used" }] },
      { id: "autocompact", label: "Autocompact buffer", tokens: 7800, kind: "buffer" },
      { id: "free", label: "Free space", tokens: 128200, kind: "free" },
    ],
    facts: [{ label: "Model", value: "claude-opus-5-5" }, { label: "Auto-compact", value: "on" }],
  };

  function UXT3() {
    const S = "s_uxt3";
    group("g_UXT3", "UXT3 chat info", { collapsed: true });
    const id = "c_UXT3_chat";
    add(id, { name: "Fix the flaky cart test", group: "g_UXT3", cwd: "/Users/ana/projects/acme/checkout-service", model: "opus", effort: "high", usage: { ctxIn: 71000, ctxOut: 800, ctxWindow: 200000, turns: 9 } },
      [{ kind: "user", text: "The cart test fails on CI and passes here. Two screenshots of the failure.", images: T3_IMAGES.map((i, n) => ({ id: i, name: n ? "two.png" : "one.png", type: "image/png", size: 1000 })) },
        say("The test reads the clock: it passes before noon UTC and fails after it. I will freeze the clock in the test."), { kind: "end", point: "p1" },
        ...turn("Do it.", "Done: the test freezes the clock at 09:00 UTC.", "p2")]);
    const alt = addBranch(id, "main", 3, {}, "alt");
    alt.items.push(...turn("Could we mock the date in the cart instead?", "Yes, but it hides the real dependency.", "q2"));
    ux3.context[id] = T3_SPLIT;
    ux3.labels[id] = [{ branch: "main", item: 1, text: "Root cause found" }];
    state("UXT3", "chat", { chat: id }, ".thread .msg.user", { also: [{ see: ".thread .msg-images" }] });
    add("c_UXT3_arch", { name: "Old refund spike", group: "g_UXT3", archived: true, archiveOp: "op_uxt3" }, clone(THREAD));
    state("UXT3", "archived", { chat: "c_UXT3_arch" }, ".thread .msg.user");
    // a chat on another machine: it drops while its state is on screen (and a check drops it and brings it back)
    delete worlds[S]; // each machine anew
    addServer({ id: S, name: "Design Mac", address: "https://design-mac.example:4790", state: "connected", version: "dev" }, { lists: { agents: ["claude"], catalogs: { claude }, home: "/Users/design", defaultCwd: "/Users/design/work" } });
    onServer(S, () => add("c_UXT3_remote", { name: "Check the staging deploy", cwd: "/Users/design/work", group: UNGROUPED, status: "approval" },
      [{ kind: "user", text: "Is the staging deploy healthy?" }, say("I will ask the cluster for the rollout status."),
        { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "kubectl rollout status deploy/web", description: "Read the rollout status" }, decided: "" }]));
    const remote = there(S, "c_UXT3_remote");
    state("UXT3", "remote", { chat: remote }, ".thread .perm.pending");
    state("UXT3", "remote-off", { chat: remote }, ".remote-bar.off", { act: `drop:${S}` });
  }

  // ---- UXT2: tool steps, permissions and subagents on the phone (package T2)

  /** The function an edit of UXT2 changes: 60 lines, the first change at line 46 of the file, the second 41 unchanged lines after it. */
  const T2_FN = (fixed) => {
    const head = ["// ApplyCoupon spreads the coupon's discount over the cart's lines", "// in proportion to each line's total.", "func ApplyCoupon(cart *Cart, c Coupon) error {",
      "\tif err := c.Valid(time.Now()); err != nil {", "\t\treturn err", "\t}", "\tdiscount := c.Discount(cart.Subtotal())", "\tvar allocated int64"];
    const loop = fixed
      ? ["\tskus := sortedSKUs(cart.Lines)", "\tfor _, sku := range skus {", "\t\tline := cart.Lines[sku]"]
      : ["\tfor sku, line := range cart.Lines {"];
    const body = ["\t\tshare := discount * line.Total / cart.Subtotal()", "\t\tline.Discount = share", "\t\tallocated += share", "\t}"];
    const middle = Array.from({ length: 41 }, (_, i) => `\t// step ${i + 1} of the audit trail is kept as it was`);
    const tail = fixed
      ? ["\t// the cent left over goes to the last line", "\tcart.Lines[skus[len(skus)-1]].Discount += discount - allocated"]
      : ["\tcart.Lines[lastSKU(cart)].Discount += discount - allocated"];
    return [...head, ...loop, ...body, ...middle, ...tail, "\tcart.Coupon = c.Code", "\treturn nil", "}"].join("\n");
  };

  function UXT2() {
    group("g_UXT2", "UXT2 tool steps on the phone", { collapsed: true });
    const g = { group: "g_UXT2", cwd: "/Users/demo/projects/checkout-service" }, ask = (text) => ({ kind: "user", text });
    const DIR = "/Users/demo/projects/checkout-service/internal/cart";
    const OUT = ["=== RUN   TestApplyCoupon", "coupon_test.go:48: total = 1799, want 1800", "--- FAIL: TestApplyCoupon (0.00s)", "=== RUN   TestApplyCoupon",
      "--- PASS: TestApplyCoupon (0.00s)", "=== RUN   TestApplyCoupon", "--- PASS: TestApplyCoupon (0.00s)", "=== RUN   TestApplyCoupon",
      "coupon_test.go:48: total = 1801, want 1800", "--- FAIL: TestApplyCoupon (0.00s)", "FAIL", "FAIL\tcheckout-service/internal/cart\t0.021s", "exit status 1", "Exit code 1"].join("\n");
    const snippet = (from, lines) => "The file " + DIR + "/coupon.go has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n" +
      lines.map((l, i) => `${String(from + i).padStart(6)}→${l}`).join("\n");
    const fixed = T2_FN(true).split("\n");
    add("c_UXT2_steps", { name: "Fix the flaky cart test", ...g }, [ask("TestApplyCoupon fails about one run in five on CI. Find out why and fix it."),
      say("Let me reproduce it first."),
      tool("u1", "Bash", { command: "go test ./internal/cart -run TestApplyCoupon -count=20", description: "Run the test 20 times" }, OUT, { isError: true }),
      tool("u2", "Read", { file_path: `${DIR}/coupon.go` }, "…"), tool("u3", "Read", { file_path: `${DIR}/cart.go` }, "…"), tool("u4", "Read", { file_path: `${DIR}/coupon_test.go` }, "…"),
      say("Found it. I'll allocate in a fixed order."),
      tool("u5", "Edit", { file_path: `${DIR}/coupon.go`, old_string: T2_FN(false), new_string: T2_FN(true) }, snippet(38, fixed.slice(0, 16))),
      tool("u6", "Write", { file_path: `${DIR}/skus.go`, content: "package cart\n\nimport \"sort\"\n\n// sortedSKUs is the cart's SKUs in a fixed order.\nfunc sortedSKUs(lines map[string]*Line) []string {\n\tskus := make([]string, 0, len(lines))\n\tfor sku := range lines {\n\t\tskus = append(skus, sku)\n\t}\n\tsort.Strings(skus)\n\treturn skus\n}\n" }, `File created successfully at: ${DIR}/skus.go`),
      say("The discount is now allocated in sorted order, and the cent left over goes to the last line."), { kind: "end" }]);
    state("UXT2", "steps", { chat: "c_UXT2_steps" }, ".thread .tool");
    // a long thread that ends with two requests waiting: scrolled up, the dock stands above the composer
    const earlier = [];
    for (let n = 1; n <= 6; n++) earlier.push(...turn(`Question ${n} about the refund path: does it round the same way as the charge?`,
      `Yes. Part ${n} of the answer: RefundLine calls the same allocate helper, so a partial refund of a discounted cart gives back exactly what was charged, to the cent.`, `pp${n}`));
    add("c_UXT2_perm", { name: "Ship the coupon fix", ...g, status: "approval" }, [...earlier, ask("Commit the coupon fix and push the branch."),
      say("The tests pass, so I'll commit and push the fix branch."),
      tool("v1", "Bash", { command: "git commit -am 'Allocate coupon discounts in a fixed order'", description: "Commit the fix" }, "[fix/coupon-rounding 4f2a1c9] Allocate coupon discounts in a fixed order\n 2 files changed, 18 insertions(+), 4 deletions(-)"),
      { kind: "perm", requestId: "w1", toolName: "Bash", input: { command: "git push origin fix/coupon-rounding", description: "Push the fix branch" }, decided: "" },
      { kind: "perm", requestId: "w2", toolName: "Bash", input: { command: "gh pr create --fill --base main --head fix/coupon-rounding --label checkout --reviewer payments-team", description: "Open the pull request" }, decided: "" }]);
    state("UXT2", "perm", { chat: "c_UXT2_perm" }, ".thread .perm");
    // answered, and the agent at work on the command it allowed
    add("c_UXT2_busy", { name: "Ship the coupon fix, allowed", ...g, status: "tool", statusTool: "Bash" }, [ask("Commit the coupon fix and push the branch."),
      say("The tests pass, so I'll commit and push the fix branch."),
      tool("x1", "Bash", { command: "git commit -am 'Allocate coupon discounts in a fixed order'", description: "Commit the fix" }, "[fix/coupon-rounding 4f2a1c9] Allocate coupon discounts in a fixed order"),
      { kind: "perm", requestId: "x2", toolName: "Bash", input: { command: "git push origin fix/coupon-rounding", description: "Push the fix branch" }, decided: "allow" },
      tool("x3", "Bash", { command: "git push origin fix/coupon-rounding", description: "Push the fix branch" })]);
    state("UXT2", "busy", { chat: "c_UXT2_busy" }, ".thread .perm");
    // one call of three subagents: the first finished with 14 steps and a report, the second waits on one it started, the third finished
    const prompt = (d) => `${d} against docs/pricing.md: allocation, rounding and the totals of every case. Report bugs; change nothing.`;
    const call = (id, sid, description) => ({ ...tool(id, "Task", { description, prompt: prompt(description), run_in_background: true }, "Started."), subagent: sid });
    add("c_UXT2_subs", { name: "Audit the checkout flow", ...g }, [ask("Audit the checkout service before Friday's release: the cart, the payment retries and stock reservation. Report what is wrong, fix nothing yet."),
      say("I'll split the audit in three and have each part looked at on its own."),
      call("y1", "t1", "Audit the cart totals and coupons"), call("y2", "t2", "Audit the payment retries"), call("y3", "t3", "Audit stock reservation"),
      say("All three are at work. Their reports come back to me here when they finish."), { kind: "end" },
      { kind: "subresult", subagent: "t3" }]);
    const sa = (id, description, o) => ({ id, description, prompt: prompt(description), kind: "claude", model: "sonnet", effort: "medium", background: true, window: 200000, ...o });
    subs.c_UXT2_subs = [
      sa("t1", "Audit the cart totals and coupons", { tool: "y1", status: "completed", started: T0 - 15 * MIN, ended: T0 - 4 * MIN, tokens: 52000, toolUses: 14, delivery: "sent",
        summary: "One real bug. ApplyCoupon spreads the discount by ranging over a map, so the rounding remainder lands on a random line and the total can be a cent off. That is the flaky TestApplyCoupon.\n\n- Totals match docs/pricing.md in all 9 cases.\n- Percentage and fixed coupons round half-up, as specified." }),
      sa("t2", "Audit the payment retries", { tool: "y2", status: "running", waiting: true, started: T0 - 15 * MIN, tokens: 30000, toolUses: 6 }),
      sa("t2a", "Trace the Stripe webhook handler", { tool: "z1", parent: "t2", status: "running", started: T0 - 7 * MIN, tokens: 21000, toolUses: 5 }),
      sa("t3", "Audit stock reservation", { tool: "y3", status: "completed", started: T0 - 15 * MIN, ended: T0 - 6 * MIN, tokens: 28000, toolUses: 7, delivery: "sent",
        summary: "Reservation expiry and Release are right: a reservation that times out is released once, and a paid order keeps its stock." }),
    ];
    const reads = ["coupon.go", "cart.go", "coupon_test.go", "pricing.md", "totals.go", "tax.go", "round.go", "lines.go"];
    subItems["c_UXT2_subs/t1"] = [say("Reading the cart package and the pricing doc."),
      ...reads.map((f, i) => tool(`t1r${i}`, "Read", { file_path: `${DIR}/${f}` }, "…")),
      ...["ApplyCoupon", "Discount(", "range cart.Lines", "lastSKU", "roundHalfUp", "allocated"].map((p, i) => tool(`t1g${i}`, "Grep", { pattern: p }, "3 matches")),
      say("One real bug: the remainder lands on a random line.")];
    subItems["c_UXT2_subs/t2"] = [say("The retries depend on the webhook."), { ...tool("z1", "Task", { description: "Trace the Stripe webhook handler", prompt: "Trace the Stripe webhook handler." }), subagent: "t2a" }];
    subItems["c_UXT2_subs/t2a"] = [say("Reading the handler."), tool("t2ar", "Read", { file_path: "/Users/demo/projects/checkout-service/internal/payment/webhook.go" }, "…"), say("Thinking about the retry window.", false)];
    subItems["c_UXT2_subs/t3"] = [tool("t3r", "Read", { file_path: "/Users/demo/projects/checkout-service/internal/stock/reserve.go" }, "…"), say("Reservation expiry and Release are right.")];
    state("UXT2", "subs", { chat: "c_UXT2_subs" }, ".thread .sub-row");
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

  // ---- UXS2: the Servers screens of the phone

  function UXS2() {
    // (the fingerprints are those of dev/checks/srv.mjs: BUILD, CERT_NOW, CERT_OLD)
    const BUILD = "3F:9A:0C:21:5B:7E:A4:D3:18:C6:92:F0:E7:B5:6D:14:CA:38:0F:9B:27:E1:B6:A5:4D:82:91:C7:F3:0E:7E:4D";
    const CERT_NOW = "8B:47:1E:C2:F9:03:6A:5D:D2:7B:40:E8:9C:16:B3:FA:05:D9:7E:21:C8:4A:6F:3B:1A:70:E5:C6:29:DF:4B:88";
    const CERT_OLD = "5E:21:A0:C9:7B:44:D1:F8:0C:3A:92:E6:4F:17:B8:5D:2A:60:E9:C3:71:BD:08:F4:C6:A2:3D:95:F1:4E:8B:07";
    for (const id of ["s_build", "s_home", "s_attic", "s_certbox", "s_mini", "s_slow"]) delete worlds[id]; // each machine anew
    const lists = { agents: ["claude"], catalogs: { claude }, home: "/home/ux", defaultCwd: "/home/ux" };
    addServer({ id: "s_build", name: "Build box", address: "https://build-box.example:4790", state: "connected", version: "1.8.2", agents: ["claude", "cursor"], selfSigned: true, pin: BUILD }, { lists });
    addServer({ id: "s_home", name: "Home lab", address: "https://home-lab.example:4790", state: "connected", version: "1.8.2" }, { lists });
    addServer({ id: "s_attic", name: "Attic server", address: "https://attic.example:4790", state: "unreachable", detail: "connection refused" });
    addServer({ id: "s_certbox", name: "Cert box", address: "https://cert-box.example:4790", state: "certificate_changed", selfSigned: true, pin: CERT_OLD, fingerprint: CERT_NOW });
    addServer({ id: "s_mini", name: "Old Mini", address: "https://old-mini.example:4790", state: "too_old", version: "0.9.1" });
    addServer({ id: "s_slow", name: "Slow link", address: "https://slow-link.example:4790", state: "connecting" });
    const on = (id) => `[data-testid="srv-facts"][data-server="${id}"]`;
    state("UXS2", "list", {}, '[data-testid="srv-list"]', { act: "srv-list", also: [{ see: '[data-testid="srv-row"][data-server="s_certbox"]' }] });
    state("UXS2", "detail", {}, on("s_build"), { act: "srv-detail:s_build", also: [{ see: '[data-testid="srv-version"]', text: "1.8.2" }] });
    state("UXS2", "unreachable", {}, on("s_attic"), { act: "srv-detail:s_attic", also: [{ see: '[data-testid="srv-why"]', text: "Connection refused" }] });
    state("UXS2", "too-old", {}, on("s_mini"), { act: "srv-detail:s_mini", also: [{ see: '[data-testid="srv-update"]' }] });
    state("UXS2", "cert", {}, on("s_certbox"), { act: "srv-detail:s_certbox", also: [{ see: '[data-testid="srv-cert-notice"]' }] });
    state("UXS2", "compare", {}, '[data-testid="srv-cert"][data-server="s_certbox"]', { act: "srv-cert:s_certbox", also: [{ see: '[data-testid="srv-fp-now"]' }, { see: '[data-testid="srv-fp-old"]' }] });
  }

  // ---- UXC1: the phone's composer (ux-improvements package C1, web/dev/checks/UX.C1-composer.mjs)

  // ux-c1: one group "UXC1 composer" with the board "Pipeline" and five boards whose names start with R (the @ dock shows four of the five for "@r"),
  // plain chats (new, started, at work, a ring over 80 %) and chats on the board (new, started with a draft that mentions a board and holds two quotes).
  // On the editable board b_ui (A1's `sketch`) a chat for "Board selection" with its count (the act "select" selects the three shapes).
  function UXC1() {
    sketch();
    group("g_UXC1", "UXC1 composer", { collapsed: true });
    const g = { group: "g_UXC1" };
    boards.b_UXC1 = { id: "b_UXC1", name: "Pipeline", group: "g_UXC1", created: iso(T0 - 110 * MIN) };
    ["Roadmap", "Rollout", "Render pass", "Review notes", "Rewrite plan"].forEach((name, i) => { boards[`b_UXC1_r${i + 1}`] = { id: `b_UXC1_r${i + 1}`, name, group: "g_UXC1", created: iso(T0 - (100 - i) * MIN) }; });
    const own = (chatId) => ({ board: "b_UXC1", chat: chatId });
    add("c_UXC1_new", { ...g, ...fresh }); state("UXC1", "new", { chat: "c_UXC1_new" }, ".composer .chip-row");
    add("c_UXC1_started", { name: "Started", ...g }, clone(THREAD)); state("UXC1", "started", { chat: "c_UXC1_started" }, ".composer");
    add("c_UXC1_busy", { name: "Busy", ...g, status: "tool", statusTool: "Bash" }, THREAD.slice(0, 2)); state("UXC1", "busy", { chat: "c_UXC1_busy" }, ".composer .send.stop");
    add("c_UXC1_amber", { name: "Nearly full", ...g, usage: { ...usage, ctxIn: 170000, ctxOut: 2000 } }, clone(THREAD)); state("UXC1", "amber", { chat: "c_UXC1_amber" }, ".composer .ctx-meter");
    add("c_UXC1_board_new", { board: "b_UXC1", ...fresh }); state("UXC1", "board-new", own("c_UXC1_board_new"), ".composer .chip-row");
    add("c_UXC1_board", { name: "Board started", board: "b_UXC1" }, clone(THREAD)); state("UXC1", "board-started", own("c_UXC1_board"), ".composer .context-row");
    add("c_UXC1_board_draft", { name: "Board with a draft", board: "b_UXC1", draft: { text: "Compare with @Roadmap", references: REFS } }, clone(THREAD)); state("UXC1", "board-draft", own("c_UXC1_board_draft"), ".composer .context-row");
    add("c_UXC1_sketch", { name: "On the sketch", board: "b_ui" }, clone(THREAD)); // (no state: the check selects the shapes itself, UX.C1-composer)
  }


  // ---- UXB2: Point at and Add selection on the phone (ux-improvements package B2, web/dev/checks/UX.B2-pick.mjs)

  // ux-b2: one group with a board of five shapes (four labelled, spread over the scene, one unlabelled) that has a chat which takes messages.
  // A rectangle's label is its bound text (core board/scene.ts `toFmt`), so every labelled rectangle has a text element with `containerId`.
  function UXB2() {
    group("g_UXB2", "UXB2 pick", { collapsed: true });
    boards.b_UXB2 = { id: "b_UXB2", name: "Checkout flow", group: "g_UXB2", created: iso(T0 - 90 * MIN) };
    const base = (id, type, x, y, width, height, seed) => ({ id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
      roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed, version: 1, versionNonce: seed, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false });
    const box = (id, x, y, seed, label) => {
      const r = { ...base(id, "rectangle", x, y, 180, 80, seed), backgroundColor: "#a5d8ff" };
      if (!label) return [r];
      const t = { ...base(`${id}_text`, "text", x + 90 - label.length * 5.5, y + 27.5, label.length * 11, 25, seed + 100), text: label, originalText: label, fontSize: 20, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
        containerId: id, lineHeight: 1.25, autoResize: true };
      r.boundElements = [{ id: t.id, type: "text" }];
      return [r, t];
    };
    scenes.b_UXB2 = { rev: 1, scene: { type: "excalidraw", version: 2, appState: {}, files: {}, elements: [
      ...box("uxb2_checkout", 0, 0, 11, "Checkout service"), ...box("uxb2_payments", 300, 0, 12, "Payments"), ...box("uxb2_inventory", 300, 200, 13, "Inventory"),
      ...box("uxb2_orders", 0, 200, 14, "Orders DB"), ...box("uxb2_blank", 150, 400, 15, "")] } };
    add("c_UXB2", { name: "Draw the request flow", board: "b_UXB2" }, clone(THREAD));
    // (the two waits are started by the page's seam, window.__aiwbPick: P0.3's rows play it on the phone)
    state("UXB2", "point", { board: "b_UXB2", chat: "c_UXB2" }, "[data-testid=pick-bar]");
    state("UXB2", "select", { board: "b_UXB2", chat: "c_UXB2" }, "[data-testid=pick-bar]");
  }


  // ---- UXH1: the phone's Home (plans/ux-improvements/h1-design.md)

  function UXH1() {
    uxh1Reset(); // (a state's list from before is gone: the machines below are made anew)
    const NOLOCAL = "aiwb.uicheck.nolocal";
    const ago = (min) => iso(T0 - min * MIN);
    const OFFERS = (home) => ({ agents: ["claude", "cursor", "pi"], catalogs: { claude, cursor, pi: PI }, home, defaultCwd: `${home}/work` });
    const perm = [{ kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "git push origin main", description: "Publish the change" }, decided: "" }];
    /** A thing on a machine: the chat's folder, its agent and its words (status: approval, stopped, tool, waiting). */
    const chatOf = (cwd, id, name, o = {}, list) => add(id, { name, cwd, created: ago(o.age ?? 30), ...o }, list ?? clone(THREAD));
    const board = (id, name, g, age) => { boards[id] = { id, name, group: g ?? UNGROUPED, created: ago(age) }; };
    const PIC = { agent: "pi", model: "claude-sonnet-5-5", effort: "medium" }, CUR = { agent: "cursor", model: "gpt-5.4", effort: "medium" };
    const APPROVE = { status: "approval" }, STOP = { status: "stopped" };

    // Studio Mac, rich as sh2-10a draws it: Checkout service (Payments > Refunds, Experiments), Mobile app, Infra, loose boards and chats
    uxh1Make({ id: "h1_studio", name: "Studio Mac", address: "https://studio-mac.example:4790", state: "connected", version: "dev" }, OFFERS("/Users/studio"), () => {
      const cwd = "/Users/studio/work";
      groups.push({ id: "g_checkout", name: "Checkout service" }, { id: "g_payments", name: "Payments", parent: "g_checkout" }, { id: "g_refunds", name: "Refunds", parent: "g_payments" },
        { id: "g_experiments", name: "Experiments", parent: "g_checkout" }, { id: "g_mobile", name: "Mobile app" }, { id: "g_infra", name: "Infra" });
      board("b_flow", "Checkout flow", "g_checkout", 50); board("b_cart", "Cart redesign", "g_checkout", 60);
      chatOf(cwd, "c_flow", "Approve the schema change", { board: "b_flow", age: 5, ...APPROVE }, perm); // the dot on Checkout flow
      chatOf(cwd, "c_flow_done", "Draft the checkout states", { board: "b_flow", age: 40 });
      chatOf(cwd, "c_audit", "Audit the checkout flow", { group: "g_checkout", age: 1, status: "waiting", subsRunning: 2 });
      chatOf(cwd, "c_stock", "Stock reservation bug", { group: "g_checkout", age: 20 });
      board("b_providers", "Payment providers", "g_payments", 70); board("b_retry", "Retry policy", "g_payments", 80);
      chatOf(cwd, "c_provider", "Pick the retry provider", { board: "b_providers", age: 120, ...APPROVE }, perm); // the second chat that needs you under Checkout service
      for (const [i, n] of ["Backoff numbers", "Idempotency keys", "Dead letters"].entries()) chatOf(cwd, `c_retry${i}`, n, { board: "b_retry", age: 200 + i });
      chatOf(cwd, "c_failed", "Failed-payment retries", { group: "g_payments", age: 60, ...CUR });
      board("b_refund_rules", "Refund rules", "g_refunds", 90);
      board("b_pricing", "Pricing test", "g_experiments", 100);
      board("b_icons", "App icons", "g_mobile", 110); board("b_screens", "Onboarding screens", "g_mobile", 120);
      board("b_net", "Network map", "g_infra", 130); board("b_runbook", "Runbook", "g_infra", 140); board("b_cost", "Cost sketch", "g_infra", 150);
      chatOf(cwd, "c_keys", "Rotate the keys", { group: "g_infra", age: 160 });
      board("b_orders", "Orders data model", UNGROUPED, 170); board("b_onboarding", "Onboarding flow", UNGROUPED, 180);
      chatOf(cwd, "c_orders", "Model the order lines", { board: "b_orders", age: 1500 });
      chatOf(cwd, "c_regex", "Regex for promo codes", { group: UNGROUPED, age: 4000, ...PIC });
      chatOf(cwd, "c_rename", "Rename the env vars", { group: UNGROUPED, age: 2, ...APPROVE }, perm);
      chatOf(cwd, "c_flaky", "Fix the flaky cart test", { group: UNGROUPED, age: 3000, ...STOP });
    });
    // a small tree for the one-server state: Studio Mac with a group, a board with a chat, a loose chat
    uxh1Make({ id: "h1_one", name: "Studio Mac", address: "https://studio-mac.example:4790", state: "connected", version: "dev" }, OFFERS("/Users/studio"), () => {
      const cwd = "/Users/studio/work";
      groups.push({ id: "g_checkout", name: "Checkout service" });
      board("b_flow", "Checkout flow", "g_checkout", 50); board("b_orders", "Orders data model", UNGROUPED, 170);
      chatOf(cwd, "c_flow", "Audit the checkout flow", { board: "b_flow", age: 5 });
      chatOf(cwd, "c_orders", "Model the order lines", { board: "b_orders", age: 1500 });
      chatOf(cwd, "c_regex", "Regex for promo codes", { group: UNGROUPED, age: 4000, ...PIC });
    });
    // the other chips of sh2-10d: Build box (connecting for good), Attic (unreachable: it has a tree for the state that serves it first), a certificate that changed
    uxh1Make({ id: "h1_build", name: "Build box", address: "https://build-box.example:4790", state: "connecting" });
    uxh1Make({ id: "h1_attic", name: "Attic", address: "https://attic.example:4790", state: "unreachable", detail: "connection refused" }, OFFERS("/home/attic"), () => {
      const cwd = "/home/attic/work";
      groups.push({ id: "g_nightly", name: "Nightly builds" });
      board("b_net", "Home network", UNGROUPED, 90);
      board("b_nb1", "Build matrix", "g_nightly", 30); board("b_nb2", "Cache layout", "g_nightly", 40);
      chatOf(cwd, "c_net", "Map the VLANs", { board: "b_net", age: 100 });
      chatOf(cwd, "c_fail", "Why did last night's build fail?", { group: UNGROUPED, age: 180 });
      chatOf(cwd, "c_cache", "Cache the Go modules", { group: UNGROUPED, age: 300, ...CUR });
    });
    uxh1Make({ id: "h1_cert", name: "Garage Mac", address: "https://garage-mac.example:4790", state: "certificate_changed" });
    // what the rows draw (sh2-10a 2 and 3, 10b 5): a group whose two chats need you (a count of 2: one waits for approval, one stopped), a board with a chat at
    // work (no dot), a board with a chat that needs approval (a dot), an empty group
    uxh1Make({ id: "h1_release", name: "Release box", address: "https://release-box.example:4790", state: "connected", version: "dev" }, OFFERS("/home/release"), () => {
      const cwd = "/home/release/work";
      groups.push({ id: "g_prep", name: "Release prep" }, { id: "g_scratch", name: "Scratch" });
      chatOf(cwd, "c_notes", "Write the release notes", { group: "g_prep", age: 10, ...APPROVE }, perm);
      chatOf(cwd, "c_bump", "Bump the versions", { group: "g_prep", age: 20, ...STOP });
      board("b_load", "Load test", UNGROUPED, 30); board("b_deploy", "Deploy plan", UNGROUPED, 40);
      chatOf(cwd, "c_load", "Run the load test", { board: "b_load", age: 2, status: "tool", statusTool: "Bash" }, THREAD.slice(0, 2));
      chatOf(cwd, "c_deploy", "Check the deploy order", { board: "b_deploy", age: 6, ...APPROVE }, perm);
    });
    // a connected server with nothing on it
    uxh1Make({ id: "h1_empty", name: "Empty box", address: "https://empty-box.example:4790", state: "connected", version: "dev" }, OFFERS("/home/empty"));

    // A state is opened with its `pre` (run in the mock before the page loads: which servers are listed) and its `ls` (the page's localStorage before
    // it loads: this computer hidden, and Home's saved place), then its `mock` (once the page is open).
    const place = (server, groupIds = []) => ({ [NOLOCAL]: "1", "aiwb.home": JSON.stringify({ server, groups: groupIds.map((g) => `${server}~${g}`) }) });
    const home = (word) => `[data-testid="home"][data-state="${word}"]`;
    const row = (kind, extra = "") => `[data-testid="home-row"][data-kind="${kind}"]${extra}`;
    const show = (id, ids, see, more = {}) => state("UXH1", id, {}, see, { pre: `uxh1Show(${JSON.stringify(ids)});`, ...more });
    const ALL = ["h1_studio", "h1_build", "h1_attic", "h1_cert"];

    // one server only: no chips, the sub-line "Studio Mac · Connected"; four: the chips, Studio Mac selected with its rich tree
    show("one", ["h1_one"], home("list"), { ls: place("h1_one"), also: [{ see: '[data-testid="home-sub"]', text: "Studio Mac" }] });
    show("four", ALL, home("list"), { ls: place("h1_studio"), also: [{ see: '[data-testid="server-chips"]' }, { see: '[data-testid="server-chip"]', count: 4 }, { see: row("group", '[data-attention="count"]'), text: "Checkout service" }] });
    // Build box is connecting: placeholders
    show("connecting", ALL, home("connecting"), { ls: place("h1_build"), also: [{ see: '[data-testid="home-placeholder"]' }] });
    // Attic is selected, served connected first and dropped once the page has its tree: the card above the faded list. The knob is a call of the mock
    // (`await uxh1DropAttic()`: the state's own `mock`), a check that selects it itself calls it once Home has drawn the list
    show("trouble", ALL, home("trouble"), { ls: place("h1_attic"), pre: `uxh1Show(${JSON.stringify(ALL)}, { connected: ["h1_attic"] });`, mock: "await uxh1DropAttic();",
      also: [{ see: '[data-testid="problem-card"]', text: "Attic" }, { see: '[data-testid="home-list"][data-stale="true"]' }] });
    // the certificate that changed, selected: Review (a card without a faded list: the server never had a tree here)
    show("cert", ALL, home("trouble"), { ls: place("h1_cert"), also: [{ see: '[data-testid="problem-card"][data-word="cert-changed"]' }, { see: '[data-testid="problem-review"]' }] });
    // rows: the group with two chats that need you (count 2), the board with a chat at work (no dot), the board with a chat that needs approval (a dot)
    show("kinds", ["h1_release"], home("list"), { ls: place("h1_release"), also: [
      { see: row("group", '[data-attention="count"][data-count="2"]'), text: "Release prep" },
      { see: row("board", '[data-attention="none"]'), text: "Load test" }, { see: row("board", '[data-attention="dot"]'), text: "Deploy plan" }] });
    // groups as screens: Refunds, three deep (Checkout service > Payments > Refunds); an empty group
    show("nested", ["h1_studio"], '[data-testid="group-screen"][data-key="h1_studio~g_refunds"]', { ls: place("h1_studio", ["g_checkout", "g_payments", "g_refunds"]), also: [{ see: row("board"), text: "Refund rules" }] });
    show("empty-group", ["h1_release"], '[data-testid="group-screen"][data-key="h1_release~g_scratch"]', { ls: place("h1_release", ["g_scratch"]), also: [{ see: '[data-testid="group-empty"]' }, { see: '[data-testid="home-empty-new"]' }] });
    // a connected server with nothing on it; no server at all (this computer hidden: first run)
    show("empty-server", ["h1_empty"], home("empty"), { ls: place("h1_empty"), also: [{ see: '[data-testid="home-empty-chat"]' }, { see: '[data-testid="home-empty-board"]' }] });
    show("none", [], '[data-testid="first-run"]', { ls: { [NOLOCAL]: "1" }, also: [{ see: '[data-testid="first-run-add"]' }, { see: '[data-testid="first-run-scan"]' }] });
  }

  // ---- UXH2: the phone's row actions, rename, + New, Archived and search (plans/ux-improvements/h2-design.md §8)

  function UXH2() {
    uxh1Reset();
    const NOLOCAL = "aiwb.uicheck.nolocal";
    const ago = (min) => iso(T0 - min * MIN);
    const OFFERS = (home) => ({ agents: ["claude", "cursor", "pi"], catalogs: { claude, cursor, pi: PI }, home, defaultCwd: `${home}/work` });
    const chatOf = (cwd, id, name, o = {}) => add(id, { name, cwd, created: ago(o.age ?? 30), ...o }, clone(THREAD));
    const board = (id, name, g, age, more = {}) => { boards[id] = { id, name, group: g ?? UNGROUPED, created: ago(age), ...more }; };
    const PIC = { agent: "pi", model: "claude-sonnet-5-5", effort: "medium" };
    uxh1Make({ id: "h2_studio", name: "Studio Mac", address: "https://studio-mac.example:4790", state: "connected", version: "dev" }, OFFERS("/Users/studio"), () => {
      const cwd = "/Users/studio/work";
      groups.push({ id: "g_checkout", name: "Checkout service" }, { id: "g_payments", name: "Payments", parent: "g_checkout" }, { id: "g_infra", name: "Infra" },
        { id: "g_old", name: "Old experiments", archived: true, archiveOp: "op_old" });
      board("b_flow", "Checkout flow", "g_checkout", 50); board("b_cart", "Cart redesign", "g_checkout", 60);
      board("b_providers", "Payment providers", "g_payments", 70); board("b_orders", "Orders data model", UNGROUPED, 170);
      board("b_sketch", "Retired sketch", "g_checkout", 400, { archived: true, archiveOp: "op_sketch" });
      chatOf(cwd, "c_flow", "Draft the checkout states", { board: "b_flow", age: 40 });
      chatOf(cwd, "c_audit", "Audit the checkout flow", { group: "g_checkout", age: 10 });
      chatOf(cwd, "c_stock", "Stock reservation bug", { group: "g_checkout", age: 20 });
      chatOf(cwd, "c_failed", "Failed-payment retries", { group: "g_payments", age: 60 });
      chatOf(cwd, "c_regex", "Regex for promo codes", { group: UNGROUPED, age: 30, ...PIC });
      chatOf(cwd, "c_env", "Rename the env vars", { group: UNGROUPED, age: 90 });
      chatOf(cwd, "c_flaky", "Fix the flaky cart test", { group: UNGROUPED, age: 150 });
      chatOf(cwd, "c_pricing", "Old pricing notes", { group: "g_checkout", age: 500, archived: true, archiveOp: "op_pricing" });
      chatOf(cwd, "c_scratch", "Scratch ideas", { group: UNGROUPED, age: 600, archived: true, archiveOp: "op_scratch" });
      chatOf(cwd, "c_explog", "Experiment log", { group: "g_old", age: 700, archived: true, archiveOp: "op_old" });
    });
    uxh1Make({ id: "h2_build", name: "Build box", address: "https://build-box.example:4790", state: "connected", version: "dev" }, OFFERS("/home/build"), () => {
      const cwd = "/home/build/work";
      groups.push({ id: "g_notes", name: "Release notes" });
      chatOf(cwd, "c_notes", "Write the release notes", { group: "g_notes", age: 15 });
      chatOf(cwd, "c_changelog", "Old changelog draft", { group: "g_notes", age: 800, archived: true, archiveOp: "op_changelog" });
    });
    const place = (groupIds = [], more = {}) => ({ [NOLOCAL]: "1", "aiwb.home": JSON.stringify({ server: "h2_studio", groups: groupIds.map((g) => `h2_studio~${g}`) }), ...more });
    const home = `[data-testid="home"][data-server="h2_studio"][data-state="list"]`;
    const show = (id, see, more = {}) => state("UXH2", id, {}, see, { pre: 'uxh1Show(["h2_studio", "h2_build"]);', ...more });
    const row = (kind, extra = "") => `[data-testid="home-row"][data-kind="${kind}"]${extra}`;
    show("rows", home, { ls: place(), also: [{ see: row("group"), text: "Checkout service" }, { see: row("board"), text: "Orders data model" }, { see: row("chat"), text: "Regex for promo codes" }] });
    show("group", '[data-testid="group-screen"][data-key="h2_studio~g_checkout"]', { ls: place(["g_checkout"]), also: [{ see: row("board"), text: "Checkout flow" }, { see: row("chat"), text: "Audit the checkout flow" }] });
    // (Settings › Archived is a screen of the stack: P0.3 plays the gear and the Archived row before it looks)
    show("archived", home, { ls: place() });
    show("search", home, { ls: place([], { "aiwb.search.recent": JSON.stringify(["checkout", "regex"]), "aiwb.search.opened": JSON.stringify([{ key: "h2_studio~c_regex", kind: "chat" }, { key: "h2_studio~b_flow", kind: "board" }]) }) });
    // Studio Mac drops once the page has its tree (`await uxh2Away("h2_studio")`, the state's own `mock`): Home keeps the last copy, faded
    show("away", '[data-testid="home"][data-server="h2_studio"][data-state="trouble"]', { ls: place(), also: [{ see: '[data-testid="home-list"][data-stale="true"]' }], mock: 'await uxh2Away("h2_studio");' });
  }

  // ---- UXC2: the phone's chip row, its pickers and the empty chat (ux-improvements package C2, web/dev/checks/UX.C2-pickers.mjs)

  // ux-c2: one group "UXC2 setup" on this computer and on the Pi box, a remote server that offers claude and pi (pi with a catalog of ten models of
  // three providers: this computer's pi catalog stays null for every other check). "missing" is the chat whose agent cursor the Pi box lacks.
  function UXC2() {
    const BOX = "s_uxc2", BOX_NAME = "Pi box", BOX_HOME = "/home/uxc2", BOX_DIR = `${BOX_HOME}/projects/app`;
    const model = (id, label, provider, efforts, contextWindow) => ({ id, label, provider, ...(efforts ? { efforts, defaultEffort: efforts[1] ?? efforts[0] } : {}), contextWindow });
    const LEVELS = ["low", "medium", "high"];
    const PI_MANY = { default: { model: "claude-sonnet-5-5", effort: "medium" }, models: [
      model("claude-opus-5-5", "Opus 5.5", "Anthropic", LEVELS, 200000), model("claude-sonnet-5-5", "Sonnet 5.5", "Anthropic", LEVELS, 200000), model("claude-haiku-4-5", "Haiku 4.5", "Anthropic", undefined, 200000),
      model("gpt-5.4", "GPT-5.4", "OpenAI", LEVELS, 128000), model("gpt-5.4-mini", "GPT-5.4 mini", "OpenAI", LEVELS, 128000), model("o4", "o4", "OpenAI", LEVELS, 200000),
      model("gemini-2.5-pro", "Gemini 2.5 Pro", "Google", undefined, 1000000), model("gemini-2.5-flash", "Gemini 2.5 Flash", "Google", undefined, 1000000),
      model("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "Google", undefined, 1000000), model("gemma-3", "Gemma 3", "Google", undefined, 128000) ] };
    Object.assign(TREE, { [BOX_HOME]: ["projects"], [`${BOX_HOME}/projects`]: ["app"], [BOX_DIR]: [] });
    addServer({ id: BOX, name: BOX_NAME, address: "https://pi-box.example:4790", state: "connected", version: "dev" },
      { lists: { agents: ["claude", "pi"], catalogs: { claude, pi: PI_MANY }, home: BOX_HOME, defaultCwd: `${BOX_HOME}/projects` } });
    group("g_UXC2", "UXC2 setup", { collapsed: true });
    onServer(BOX, () => group("g_UXC2", "UXC2 setup", { collapsed: true }));
    const g = { group: "g_UXC2" };
    add("c_UXC2_new", { ...g, ...fresh }); state("UXC2", "new", { chat: "c_UXC2_new" }, ".composer .chip-row");
    // (a chat on the Pi box is known by its entry id)
    onServer(BOX, () => add("c_UXC2_missing", { ...g, ...fresh, agent: "cursor", cwd: BOX_DIR, model: "", effort: undefined }));
    state("UXC2", "missing", { chat: `${BOX}~c_UXC2_missing` }, ".composer .agent-reason.missing", { text: "not installed" });
    add("c_UXC2_parent", { name: "Parent", ...g }, clone(TURNS));
    add("c_UXC2_fork", { name: "Parent (fork)", ...g, fresh: true, forkedFrom: "c_UXC2_parent", forkedFromTitle: "Parent", forkedBranch: "main", forkedAt: 3 }, clone(TURNS.slice(0, 3)));
    state("UXC2", "fork", { chat: "c_UXC2_fork" }, ".composer button.tchip[title^=\"Model\"]");
    onServer(BOX, () => add("c_UXC2_pi", { ...g, ...fresh, agent: "pi", cwd: BOX_DIR, model: PI_MANY.default.model, effort: PI_MANY.default.effort }));
    state("UXC2", "pi", { chat: `${BOX}~c_UXC2_pi` }, ".composer button.tchip[title^=\"Model\"]");
    add("c_UXC2_started", { name: "Started", ...g }, clone(THREAD)); state("UXC2", "started", { chat: "c_UXC2_started" }, ".composer");
  }

  // ---- UXV1: the phone's blocked composer, voice in the composer and the voice card (package V1, UX.V1-voice)

  function UXV1() {
    sketch();
    const S = "s_uxv1", B = "s_uxv1_bare";
    group("g_UXV1", "UXV1 voice", { collapsed: true });
    const g = { group: "g_UXV1" };
    add("c_UXV1_plain", { name: "Plain", ...g }, clone(THREAD));
    add("c_UXV1_arch", { name: "Old pricing notes", ...g, archived: true, archiveOp: "op_uxv1" }, clone(THREAD));
    add("c_UXV1_legacy", { name: "Before the new connection", ...g, instructionsSent: true }, clone(THREAD));
    add("c_UXV1_legacy_board", { name: "Old board chat", board: "b_ui", instructionsSent: true }, clone(THREAD));
    add("c_UXV1_b1", { name: "Layout notes", board: "b_ui" }, clone(THREAD));
    add("c_UXV1_b2", { name: "Colours", board: "b_ui" }, clone(THREAD));
    const SMALL = { default: { model: "big", effort: "medium" }, models: [
      { id: "small", label: "Haiku 5.5", provider: "anthropic", efforts: ["low", "medium"], defaultEffort: "medium", contextWindow: 40000 },
      { id: "big", label: "Sonnet 5.5", provider: "anthropic", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200000 }] };
    delete worlds[S]; delete worlds[B]; // each machine anew
    addServer({ id: S, name: "Design Mac", address: "https://design-mac-v1.example:4790", state: "connected", version: "dev" },
      { lists: { agents: ["claude", "pi"], catalogs: { claude, pi: SMALL }, home: "/Users/design", defaultCwd: "/Users/design/work" } });
    addServer({ id: B, name: "Bare box", address: "https://bare-box-v1.example:4790", state: "connected", version: "dev" },
      { lists: { agents: [], catalogs: {}, home: "/home/bare", defaultCwd: "/home/bare" } });
    const remote = { cwd: "/Users/design/work", group: UNGROUPED };
    onServer(S, () => {
      add("c_UXV1_draft", { name: "Staging rollout", ...remote, draft: { text: "Reply to Dana about the staging rollout", references: [] } }, clone(THREAD));
      add("c_UXV1_arch_remote", { name: "Old changelog", ...remote, archived: true, archiveOp: "op_uxv1r" }, clone(THREAD));
      add("c_UXV1_gone", { name: "Gone soon", ...remote }, clone(THREAD));
      add("c_UXV1_small", { name: "Fork on pi", ...remote, agent: "pi", model: "small", effort: "medium", fresh: true, forkedFrom: "c_UXV1_draft", forkedFromTitle: "Staging rollout", forkedBranch: "main", forkedAt: 2,
        usage: { ctxIn: 30000, ctxOut: 100, ctxWindow: 40000, turns: 2 } }, clone(THREAD));
    });
    onServer(B, () => {
      add("c_UXV1_bare", { name: "Nothing here", cwd: "/home/bare", group: UNGROUPED, agent: "", model: "", effort: undefined }, clone(THREAD));
      add("c_UXV1_bare_new", { name: "Nothing new", cwd: "/home/bare", group: UNGROUPED, ...fresh, agent: "", model: "", effort: undefined }); // (a new chat: the empty thread says the reason too)
    });
    const on = (id) => there(S, id);
    state("UXV1", "draft", { chat: on("c_UXV1_draft") }, ".composer");
    state("UXV1", "draft-off", { chat: on("c_UXV1_draft") }, ".composer", { act: `drop:${S}` });
    state("UXV1", "arch", { chat: "c_UXV1_arch" }, ".composer");
    state("UXV1", "arch-off", { chat: on("c_UXV1_arch_remote") }, ".composer", { act: `drop:${S}` });
    state("UXV1", "legacy", { chat: "c_UXV1_legacy" }, ".composer");
    state("UXV1", "legacy-board", { board: "b_ui", chat: "c_UXV1_legacy_board" }, ".composer");
    state("UXV1", "noagent", { chat: there(B, "c_UXV1_bare") }, ".composer");
    state("UXV1", "toosmall", { chat: on("c_UXV1_small") }, ".composer");
    state("UXV1", "gone", { chat: on("c_UXV1_gone") }, ".composer", { mock: `await new Promise((r) => setTimeout(r, 1500)); onServer("${S}", () => { delete chats.c_UXV1_gone; delete items.c_UXV1_gone; send({ type: "chat_removed", id: "c_UXV1_gone" }); });` });
    state("UXV1", "plain", { chat: "c_UXV1_plain" }, ".composer");
    state("UXV1", "board", { board: "b_ui", chat: "c_UXV1_b1" }, ".composer");
  }

  const SECTIONS = { A1, A2, A3, A4, A5, A6, SEC, UXS2, UXH1, UXH2, UXT1, UXT2, UXC1, UXB2, UXT3, UXC2, UXV1 };
  for (const name of only.length ? only : Object.keys(SECTIONS)) { if (!SECTIONS[name]) throw new Error(`the seed has no section ${name}`); SECTIONS[name](); }
  resync();
  return states;
}
