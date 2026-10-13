// A mock of the server for the browser checks (dev/checks, run by dev/uicheck.mjs) and for working on the client
// without the Go server and without an agent. Plain Node, no dependency; it serves web/dist.
//
// IT IS NOT THE CONTRACT. The Go server is (internal/server, internal/chats): where the two differ, the server is
// right and this file is wrong. Known differences:
//   - the active-client header (X-AIWB-Client) is not required, and several tabs are all served (there is no takeover)
//   - chats: a message gets a canned reply (a Read, a sentence) on the branch it was sent to. A message with a
//     target makes its branch as the server does (nothing is told of the branch until the message is on it,
//     then `branch_state`, `chat`, `tree`, then the answer names it), but no point is checked: any `at` is
//     taken, no message finds a branch busy, there is no cap, and a model or effort is taken as it is named. A chat with
//     main alone has no state record here (the server sends one for every branch, main too, in each snapshot):
//     its first new branch tells main's `branch_state` before its own. A turn's end mark gets a point only in a
//     thread that has points already. A fork (POST …/fork) copies the items and starts nothing; a model or effort
//     pick on a fork without a message of its own answers at once (the server starts the agent again first:
//     flags.configure.delay stands in for that). The tree's labels cannot be set
//   - a folder, model or effort pick on a chat that has started is taken (the server refuses it, 409: they are
//     fixed once the chat has started). PUT …/draft with ?rev= is saved on that counter and answers {ok, rev}, and
//     one typed on another counter is refused 409 with the code "stale", the counter and the draft there are, as
//     on the server; a call that names no counter is taken (the server refuses it). A message takes its branch's
//     draft with it, which raises the counter
//   - images of a chat (POST …/images, GET …/images/{id}): kept in memory, never cleaned up, no cap of unsent ones.
//     A draft that names an image its chat does not hold is saved without it, and the answer's `missing` lists it.
//     A message is not checked for its images otherwise (their ids, the limits, the model): it is taken with
//     whatever it names. flags.upload = { hold: true } | { delay: ms } | { fail: [status, sentence, code] } holds,
//     delays or fails an upload's answer
//   - a board answers a take only when the seed gave it a scene (dev/mock-ui.js); any other board is
//     read-only with an empty scene, and no board is ever another window's. A scene is saved on the revision named
//     (?rev=), and refused 409 "stale" on another
//   - remote servers as sections: see "Remote servers" below for what is not as on the server
//   - a subagent's record and thread stay as they were written: nothing moves by itself, and no `sub` event goes out
//   - a call under /api/ that has no route here answers {ok: true}
//   - made up, with no counterpart on the server: T0 (the mock's own "now" at its start), flags.send,
//     flags.items, flags.fork, flags.configure, flags.spawn, flags.make, flags.hello, flags.streamDown, dropStreams(),
//     addServer(), setServerState(), removeServer(), onServer(), elsewhere(), onCalls, seedUI() and what it adds
//     to the snapshot
//
//   cd web && npm run build && node dev/mock.mjs           then open http://127.0.0.1:4791
//   PORT=4899 node dev/mock.mjs                            another port
//   DIST=/some/folder node dev/mock.mjs                    serves another build of the client
//   T0=1768478400000 node dev/mock.mjs                     the times of what it starts with are told from that moment, not from now
//
// Everything is in memory: a restart is a reset. It binds 127.0.0.1 only. Nothing changes by itself: but for a
// canned reply, which plays out over a second and a half, the mock moves only when it is called.
//
// What it starts with (one group "Shop" g_shop, one board b_arch in it):
//   chats       c_plain (in the group, one turn), c_board (on the board, no message)
//   subagent settings  c_new (in the group) and c_board_new (on the board) have had no message: the
//               composer's Subagents chip is open on them. PATCH /api/chats/{id} takes subDepth (0 to 3)
//               and subCap (1 to 100) as the server does: 400 outside the range, 409 on a chat that has
//               started; the answer carries the chat; a chat made later starts with the last pick.
//               c_nested has started at depth 3 with a cap of 25, and has subagents at three levels:
//               sa1 waits for the two it started (sa1a at work, which started sa1a1, at work, and sa1a2,
//               done, its result not sent yet; sa1b done, its result a row in sa1's thread), sa2 is done.
// Groups, boards and chats are made, renamed, moved, archived and deleted as the page asks; a group's archive and
// delete take its boards and chats with it (DELETE ?contents=keep moves them up instead). GET /api/dirs lists the
// folders of a small made-up tree under /Users/demo.
//
// Controls (they answer the mock's state: the tabs that are connected):
//   GET  /mock/state
//   POST /mock/snapshot   sends the snapshot again on the open stream
//   POST /mock/eval       body {"code": "…"}: runs the code inside this file (an async function body; `chats`, `items`,
//                         `boards`, `groups`, `subs`, `flags`, `send`, `snapshot`, `setSession`, `addBranch`, `seedUI`,
//                         `setLibrary`, `release`, … are in scope) and answers {ok, r: what it returned}. Examples:
//                           a chat at work:        setSession("c_plain", "main", { status: "tool", statusTool: "Bash" })
//                           a chat with a name:    chats.c_new.name = "Named"; send({ type: "chat", chat: chats.c_new })
//                           every seeded state:    return seedUI()
//
// The states of the composer and chat UI work (plans/composer-ui-improvements.md, section 3) are not in what the
// mock starts with: dev/mock-ui.js adds them when `seedUI()` is called through /mock/eval (`seedUI("A2")`: one
// section). Until then the sidebar is as above. Its file lists the states. The chat routes
// answer as the server does, seeded or not: POST …/messages {ok, branch}; the chat PATCH {ok, chat}, and it takes
// `agent` too and refuses `server` (409 `server_fixed`); GET …/items the list of the branch asked for, 404 for one
// the chat has not; GET …/tree the messages and replies of each branch; POST …/fork the new chat.
//
// Remote servers (plans/remote-server-sections-contract.md, section 3). A server of the server list is another
// machine: it has a tree of its own (groups, boards, chats, with what the mock keeps per chat and board), and
// ids of its own, which may be the ids of things of this computer. Until the seed ran there is none. The local
// server holds the tree of an entry that is connected, and then:
//   - the snapshot (GET /api/state, the `snapshot` event) has it under `sections[<entry id>]`: { groups, boards,
//     chats, states, defaults } with that server's own ids, and no group says whether it is collapsed. The
//     snapshot's own groups, boards and chats are this computer's alone, and nothing names a server
//   - /api/on/<entry id>/<the path of the local call after /api> is the call for a thing of that server, answered
//     by that machine's own routes: what is made is made there, and a thing it has not is its 404 `not_found`. The
//     local server answers itself, in this order, as internal/server/section.go does: 404 {"error":"not found"}
//     for a path that is no call of a section, whatever the id; 404 `no_server` for an id that is no other
//     server of the list ("local" too), in every call; 400 `not_here` for a board's …/reveal and 200 for
//     …/unfollow, in every state of the entry; 503 `server_unreachable` ("<name> is not connected.", or that it is
//     too old) while it holds no tree of the entry, but 200 for a board's …/release; 400 `collapsed_refused` for a
//     PATCH of a group with `collapsed`; 400 `replace_refused` for ?replace on a draft's save (a message with it
//     is passed on); 503 `not_held_there` for a save of a board that is being taken again on its server
//     (flags.retake)
//   - every event about a thing of that server is the local event with the top-level `server`: <entry id>, sent
//     only while the tree is held: what changes on a machine that is not connected is told to nobody here
//   - the local routes serve this computer's things only: a make with another server in its body is 400
//     `server_refused` (POST /api/chats, POST /api/boards), a delete with ?local=1 is 400
//     `no_record`, and GET /api/servers/{id}/items is 404
// Through /mock/eval:
//   addServer(entry, { tree, lists })       puts { id, name, address, state, … } into the list, with a machine of its
//                                           own; lists: what it offers a new chat. Nothing is told
//   setServerState(id, state, { tree, sectionFirst, …fields })   the entry's state changes: the pages get
//                                           `server_state`, and `section` with the whole tree when the local server
//                                           holds it from now on (connected; tree: false for "connected, its snapshot
//                                           not read yet"), or with null when it held one. sectionFirst: the two in the
//                                           other order. A page that held a board of that server is told `held` with
//                                           the revision the board has there when the tree is back: at once, or
//                                           flags.retake.delay ms later, and a save of the board is 503
//                                           `not_held_there` until then, as while the local server takes it again
//   removeServer(id)                        the entry leaves the list: `servers`, `server_lists` and `section` with null
//   onServer(id, () => { … })               runs code on that machine: `chats`, `items`, `groups`, `boards`,
//                                           `scenes`, `send`, `setSession`, … are that machine's in it, and what it
//                                           sends goes to the pages as that server's events
//   await elsewhere(id, method, path, body) a change made there by its owner or another client: that machine's own
//                                           route ("/chats", "/groups/g_x/move", "/boards/b_x?…"), whose events reach
//                                           the pages as that server's. id "local": another window of this computer.
//                                           Answers { status, body }
//   onCalls                                 every call that came under /api/on/: { server, method, path, body }
//   worlds[id]                              a machine as the mock holds it ("local": this computer)
// Not as on the server: a chat's content events (`chat_items`, `tree`) go to every page while the tree is held,
// followed or not; a board is held by whoever asks, and no `superseded`, `release_request` or `rpc` is sent; no call is ever answered 401, 502
// `bad_answer` or 504 (but a make that waited on flags.make while its server dropped: 504 `no_answer`); an entry
// that waits for its next try is not made to try by a call; `defaults` are always empty, and a new chat there
// starts with that server's first agent, its default model and its default folder; a write needs no known client
// (the server answers 409 "unknown_client" to a page with no open stream, under /api/on/ as everywhere); a save
// of a board is taken from a page that does not hold it (the server: 409 `not_holder`).
//
// The prompt library (plans/prompt-library.md): GET /api/library and the calls that change a library answer as the
// server does, with its rules and its sentences, and every change goes to the pages as a `library` event before the
// call's answer. This computer's library is there from the start, empty. Through /mock/eval: `setLibrary(id, {
// groups, prompts, connected, notice })` gives a server of the list a library, or another one, and tells the pages
// (null takes it away: `library_removed`); `libraries[id]` is what the mock holds, `sendLibrary(id)` tells the pages
// of a change made to it by hand. flags.library = { delay | hold | refuse } holds or refuses the calls that change one.
//
// Knobs for the waits of the fork flows, set through /mock/eval and kept until deleted (`delete flags.send`). send,
// items, fork, configure and spawn may name a `chat` (and `items` a `branch`) to hold for that one alone, and the
// fields of one knob go together:
//   flags.send = { delay: ms }                      POST …/messages answers that much later; the events of a new
//                                                   branch still go out just before the answer
//              = { hold: true }                     it waits until release("send") is called (through /mock/eval),
//                                                   which answers how many calls it let go (release(): those of
//                                                   every knob); `flags.send.held.length` tells how many wait.
//                                                   items, fork, configure and spawn take `hold` in the place of
//                                                   their `delay` the same way
//              = { refuse: { status, code, error } } it is refused after the delay (409 and "busy" by default; the
//                                                   code "" answers none). The server's refusals are listed below
//              = { unknown: true }                  504 send_unknown, and no branch is made; "arrived": the branch is
//                                                   made with its message all the same, and told 50 ms after the answer
//              = { noBranch: true }                 the answer names no branch, as an older server's
//              = { eventsAfter: ms }                the new branch's events go out that long after the answer. The
//                                                   branch is there with its message at the answer, as on the server
//              = { noReply: true }                  no canned reply: the branch stays "thinking"
//   flags.items = { delay: ms } | { fail: status }  GET …/items of a chat's branch waits, or fails
//   flags.fork = { delay: ms } | { refuse: { … } }  POST …/fork
//   flags.draft = { delay: ms } | { hold: true }    a save of a draft on another server (PUT /api/on/<entry id>/chats/
//                                                   <id>/draft; `server`: of that entry alone) waits; one that waited
//                                                   while its server dropped is 504 `no_answer`, and nothing is stored
//   flags.retake = { delay: ms }                    after a server came back, the `held` of a board a page holds comes
//                                                   that long after the tree, and a save of the board meanwhile is
//                                                   503 `not_held_there` (setServerState)
//   flags.make = { delay: ms } | { hold: true } | { refuse: { … } }   a make on another server (POST /api/on/<entry
//                                                   id>/chats, …/boards, …/groups; `server`: of that entry
//                                                   alone): it waits, or is refused there and nothing is made
//   flags.configure = { delay: ms } | { refuse: { … } }   a PATCH of agent, model, effort or folder. On a
//                                                   fork without a message of its own a model or effort pick
//                                                   shows the choice and "thinking" meanwhile, but for pi, as on
//                                                   the server; a second pick meanwhile is refused (409 "busy"),
//                                                   and after a refusal the fork has its old choice again, as
//                                                   after a start that failed (a refusal the server makes before
//                                                   the start, "window", tells nothing there)
//   flags.spawn = { delay: ms }                     the first message to such a fork finds no process: the fork is
//                                                   "thinking" and still fresh for that long before the message is added
//   flags.hello = { version, webVersion }           what GET /api/hello answers (the update notice needs a client
//                                                   built with a version of its own: dev/shot.mjs buildDist)
//   flags.streamDown = true; dropStreams()          cuts every open event stream and refuses new ones: the page
//                                                   says it is reconnecting until the flag is deleted
// What the server refuses these calls with, for a knob's `refuse` (internal/server/server.go statusOf, codeOf):
//   { status: 409, code: "busy" }        the branch, the fork or a fork's source is working
//   { status: 429, code: "cap" }         too many branches of the chat, or agents of the app, are working (a message)
//   { status: 409, code: "window" }      the model's context window is too small for the conversation
//   { status: 400, code: "bad_point" }   a branch or a fork cannot start at that place
//   { status: 409, code: "" }            the chat is archived: no code
// and a message another server did not answer with 504 "send_unknown" (flags.send.unknown).
//
// Seeding again is a reset. A chat the seed makes anew is another record: what was pending of the one it replaces
// (a held call, a canned reply, a branch's late events) answers 404 or does nothing.
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.DIST || path.resolve(HERE, "../dist"));
const PORT = Number(process.env.PORT || 4791);

const T0 = Number(process.env.T0) || Date.now();
const MIN = 60000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
const newId = (p) => p + Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const UNGROUPED = "__ungrouped__";

// ---- catalogs and folders

const claude = { default: { model: "opus", effort: "high" }, models: [
  { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 200000 },
  { id: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200000 },
  { id: "haiku", label: "Haiku 4.5", contextWindow: 200000 } ] };
const cursor = { default: { model: "gpt-5.4", effort: "medium" }, models: [
  { id: "gpt-5.4", label: "GPT-5.4", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "gpt-5.4-nano", label: "GPT-5.4 nano" } ] };
const catalogs = { claude, cursor, pi: null }; // pi has reported no models yet: a chat on it has no model to start with
const catalogOf = (agent) => catalogs[agent] ?? null;

const HOME = "/Users/demo", DATA = HOME + "/.aiwb-demo";
const TREE = { // the folders that exist
  [HOME]: ["notes", "projects"], [HOME + "/notes"]: [], [HOME + "/projects"]: ["empty-repo", "scratch", "shop"],
  [HOME + "/projects/shop"]: ["docs", "web"], [HOME + "/projects/shop/docs"]: [], [HOME + "/projects/shop/web"]: [],
  [HOME + "/projects/empty-repo"]: [], [HOME + "/projects/scratch"]: [], [DATA]: [],
};
const SHOP = HOME + "/projects/shop";
const expand = (p) => { p = String(p ?? "").trim().replace(/\/+$/, ""); return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p || "/"; };
const exists = (p) => Object.hasOwn(TREE, p);
const inside = (p, root) => p === root || p.startsWith(root + "/");

const flags = {}; // switches set through /mock/eval (see the header)

// ---- the machines: this computer, and one for every other server of the list. Each has a tree of its own, with ids
// of its own: the same id can be a chat here and a chat there.

/** What one machine holds: its groups, boards and chats, and what the mock keeps per chat and per board. */
const newWorld = (id) => ({ id, groups: [], boards: {}, chats: {}, items: {}, versions: {}, subs: {}, subItems: {}, branches: {}, sessions: {}, scenes: {}, images: {}, lastSubLimits: null });
const worlds = { local: newWorld("local") }; // by entry id of the server list
const here = new AsyncLocalStorage();        // the machine a call works on, with everything the call starts (a timer, a held answer)
const world = () => here.getStore() ?? worlds.local;
/** Runs fn on the machine of a server of the list: `chats`, `groups`, … are that machine's in it, and what it sends
 *  goes out as that server's events. */
const onServer = (id, fn) => { if (!worlds[id]) throw new Error(`the mock has no server ${id}`); return here.run(worlds[id], fn); };
/** One part of the machine a call works on, under the name this file has always used for it: `chats` is this
 *  computer's outside a call for another server, and that server's inside one. */
function part(k) {
  const at = () => world()[k];
  return new Proxy(Array.isArray(worlds.local[k]) ? [] : {}, {
    get: (_, p) => { const o = at(), v = o[p]; return typeof v === "function" ? v.bind(o) : v; },
    set: (_, p, v) => { at()[p] = v; return true; },
    has: (_, p) => p in at(),
    deleteProperty: (_, p) => delete at()[p],
    ownKeys: () => Reflect.ownKeys(at()),
    getOwnPropertyDescriptor: (_, p) => Reflect.getOwnPropertyDescriptor(at(), p),
  });
}

// ---- groups, boards, chats

const groups = part("groups"), boards = part("boards"), chats = part("chats"), items = part("items");
groups.push({ id: "g_shop", name: "Shop" });
boards.b_arch = { id: "b_arch", name: "arch", group: "g_shop", created: iso(T0 - 5000 * MIN) };
const usage = { ctxIn: 42000, ctxOut: 900, ctxWindow: 200000, turns: 3 };
const fresh = { locked: false, usage: { ...usage, ctxIn: 0, ctxOut: 0, turns: 0 } };
const chat = (id, o) => ({ id, agent: "claude", cwd: SHOP, model: "opus", effort: "high", locked: true, created: iso(T0 - 30 * MIN), usage, status: "ready", ...o });
Object.assign(chats, {
  c_plain: chat("c_plain", { name: "Why is the build slow", group: "g_shop" }),
  c_board: chat("c_board", { name: "Draw the pipeline", board: "b_arch" }),
  c_new: chat("c_new", { group: "g_shop", created: iso(T0 - 2 * MIN), ...fresh }),
  c_board_new: chat("c_board_new", { board: "b_arch", created: iso(T0 - 2 * MIN), ...fresh }),
  c_nested: chat("c_nested", { name: "Audit the checkout flow", group: "g_shop", created: iso(T0 - 12 * MIN), subDepth: 3, subCap: 25, subsRunning: 3 }),
});
const tool = (id, name, input, result, more) => ({ kind: "tool", toolId: id, name, input, ...(result === undefined ? {} : { result }), ...more });
const say = (text, done = true) => ({ kind: "text", done, text });
Object.assign(items, { // by chat id
  c_plain: [{ kind: "user", text: "Why is the build slow?" }, say("Because of the font copy step."), { kind: "end" }],
  c_board: [], c_new: [], c_board_new: [],
  c_nested: [
    { kind: "user", text: "Audit the checkout flow and fix what you find." },
    say("I'll split this: one subagent audits the cart, another the payment step."),
    { ...tool("n1", "mcp__board__spawn_subagent", { description: "Audit the cart", prompt: "Audit cart/ for wrong totals and coupon rules. Start subagents of your own for the parts." }, "Started."), subagent: "sa1" },
    { ...tool("n2", "mcp__board__spawn_subagent", { description: "Audit the payment step", prompt: "Audit payment/ and report what is wrong." }, "Started."), subagent: "sa2" },
    say("Both are at work. Their results come to me when they finish."), { kind: "end" },
    { kind: "subresult", subagent: "sa2" },
    say("The payment step is clean. The cart audit is still running."), { kind: "end" },
  ],
});
const versions = part("versions");  // by thread key (chat id, "<chat>:<branch>" for a branch that is not main, or "<chat>/<sid>"): the version of its items
const subs = part("subs");          // by chat id: its subagents (main's)
const subItems = part("subItems");  // by "<chat>/<sid>"
{ // c_nested's subagents, three levels deep (parent: the sid of the one that started it)
  const sa = (id, description, o) => ({ id, description, prompt: `${description}. Report what is wrong.`, kind: "claude", model: "sonnet", effort: "medium", background: true, window: 200000, ...o });
  subs.c_nested = [
    sa("sa1", "Audit the cart", { tool: "n1", status: "running", waiting: true, started: T0 - 9 * MIN, tokens: 48000, toolUses: 9 }),
    sa("sa1a", "Check the cart totals", { tool: "a1", parent: "sa1", status: "running", started: T0 - 8 * MIN, tokens: 61000, toolUses: 14 }),
    sa("sa1a1", "Trace the rounding in tax.go", { tool: "b1", parent: "sa1a", status: "running", started: T0 - 5 * MIN, tokens: 22000, toolUses: 5 }),
    sa("sa1a2", "List the callers of roundCents", { tool: "b2", parent: "sa1a", status: "completed", started: T0 - 5 * MIN, ended: T0 - 3 * MIN, tokens: 15000, toolUses: 4, delivery: "owed", last: "Seven callers, two of them in tests." }),
    sa("sa1b", "Check the coupon rules", { tool: "a2", parent: "sa1", status: "completed", started: T0 - 8 * MIN, ended: T0 - 6 * MIN, tokens: 27000, toolUses: 7, delivery: "sent", last: "The coupon rules match the spec." }),
    sa("sa2", "Audit the payment step", { tool: "n2", status: "completed", started: T0 - 9 * MIN, ended: T0 - 7 * MIN, tokens: 33000, toolUses: 8, delivery: "sent", last: "Nothing wrong in payment/." }),
  ];
  const spawn = (id, sid, description) => ({ ...tool(id, "mcp__board__spawn_subagent", { description, prompt: `${description}. Report what is wrong.` }, "Started."), subagent: sid });
  Object.assign(subItems, {
    "c_nested/sa1": [say("The cart has two parts: the totals and the coupon rules."), spawn("a1", "sa1a", "Check the cart totals"), spawn("a2", "sa1b", "Check the coupon rules"),
      say("Both parts are being checked."), { kind: "end" }, { kind: "subresult", subagent: "sa1b" }, say("The coupon rules are fine. The totals are still being checked."), { kind: "end" }],
    "c_nested/sa1a": [say("The totals depend on the rounding."), spawn("b1", "sa1a1", "Trace the rounding in tax.go"), spawn("b2", "sa1a2", "List the callers of roundCents"),
      tool("a1r", "Read", { file_path: "cart/totals.go" })],
    "c_nested/sa1a1": [say("Reading tax.go."), tool("b1g", "Grep", { pattern: "math.Round" })],
    "c_nested/sa1a2": [tool("b2g", "Grep", { pattern: "roundCents\\(" }, "7 matches"), say("Seven callers, two of them in tests.")],
    "c_nested/sa1b": [tool("a2r", "Read", { file_path: "cart/coupons.go" }, "…"), say("The coupon rules match the spec.")],
    "c_nested/sa2": [tool("n2r", "Read", { file_path: "payment/charge.go" }, "…"), say("Nothing wrong in payment/.")],
  });
}

/** A chat's subagent settings as its view carries them: Off is a field of its own, and a depth of 0 is left out. */
function setSubLimits(c, depth, cap) {
  delete c.subOff; delete c.subDepth;
  if (depth === 0) c.subOff = true; else c.subDepth = depth;
  c.subCap = cap;
}
// (the last pick, what a chat made later starts with, is its machine's: world().lastSubLimits)

// ---- branches: a chat that has more than main keeps the other branches' lists and every branch's session
// fields here. The seed (dev/mock-ui.js) makes such chats, and so does a message with a target. A chat with
// main alone has neither, and its view tells its state, as before.

const branches = part("branches");  // by chat id: its branches besides main, in the order they were made: { id, from, at, items }
const sessions = part("sessions");  // by chat id, once it has a second branch: each branch's session fields, by branch id ("main" too)
const scenes = part("scenes");      // by board id: { rev, scene } of a board that answers a take (the seed's); any other is read-only
const extra = {};     // what the seed adds to the snapshot: servers, lists (by server), agents
const SESSION = ["cwd", "model", "effort", "locked", "usage", "status", "statusTool", "error", "fresh", "draft", "draftRev", "subsRunning"];
const WORKING = ["thinking", "writing", "tool", "approval"];
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const session = (o) => Object.fromEntries(SESSION.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const curOf = (c) => c.branch ?? "main";
const threadKey = (id, branch) => (branch === "main" ? id : `${id}:${branch}`);
/** The item list of a chat's branch; undefined for a branch the chat has not. */
const listOf = (id, branch = "main") => (branch === "main" ? (items[id] ??= []) : branches[id]?.find((b) => b.id === branch)?.items);
/** A branch's session fields: its own once the chat has a second branch, the view's until then. */
const sessionOf = (id, branch) => sessions[id]?.[branch] ?? session(chats[id]);
const branchState = (id, branch) => ({ chat: id, branch, ...sessionOf(id, branch) });

/** Changes session fields of a chat's branch (undefined takes one away) and tells the clients: `branch_state` for a
 *  chat that has branch records, then `chat`, whose view has the current branch's fields and the counts over all. */
function setSession(id, branch, patch) {
  const c = chats[id], all = sessions[id];
  const put = (o) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete o[k]; else o[k] = v; } };
  if (all) { put((all[branch] ??= {})); send({ type: "branch_state", state: branchState(id, branch) }); }
  if (branch === curOf(c)) put(c);
  if (all) Object.assign(c, { branches: Object.keys(all).length, working: Object.values(all).filter((st) => WORKING.includes(st.status)).length });
  send({ type: "chat", chat: c });
}

/** Makes a branch of a chat at item count `at` of branch `from` and answers it: its list is the first `at` items of
 *  `from`, its session fields are `from`'s with `st` over them. Nothing is sent. The chat's first branch gives main a
 *  record of its own. */
function addBranch(id, from, at, st = {}, bid = newId("b_")) {
  sessions[id] ??= { main: session(chats[id]) };
  const b = { id: bid, from, at, items: clone(listOf(id, from).slice(0, at)) };
  (branches[id] ??= []).push(b);
  sessions[id][bid] = { ...sessions[id][from], status: "ready", ...st };
  for (const k of ["statusTool", "error", "draft", "fresh"]) if (st[k] === undefined) delete sessions[id][bid][k];
  chats[id].branches = Object.keys(sessions[id]).length;
  return b;
}

/** Makes `branch` the chat's current one: the view takes its session fields. Nothing is sent. */
function setCurrent(id, branch) {
  const c = chats[id], st = sessions[id]?.[branch];
  if (!st) return;
  if (branch === "main") delete c.branch; else c.branch = branch;
  for (const k of SESSION) { if (st[k] === undefined) delete c[k]; else c[k] = st[k]; }
}

/** Whether item count n of a list is a point a message can be sent to (internal/chats/points.go pointOK, without
 *  its rules for an agent that is working and for pi). */
const pointOK = (list, n) => (n === 0 ? !!list.find((x) => x.kind === "end")?.point : list[n - 1]?.kind === "end" && !!list[n - 1].point);

/** The messages and replies of a list from index `at` on, as the tree shows them (internal/chats/tree.go treeItems). */
function treeItems(list, at) {
  const out = [];
  for (let i = Math.max(at, 0); i < list.length; i++) {
    const it = list[i];
    if (it.kind === "user") {
      let before = 0, ok = true; // right after the last end mark before it; none when a reply or a tool call lies between
      for (let m = i - 1; m >= 0; m--) { if (list[m].kind === "end") { before = m + 1; break; } if (list[m].kind === "text" || list[m].kind === "tool") { ok = false; break; } }
      out.push({ i, kind: "user", text: it.text?.trim() || !it.references?.length ? it.text ?? "" : "❝ " + (it.references[0].comment?.trim() || it.references[0].quote), ...(ok ? { before, ...(pointOK(list, before) ? { ok: true } : {}) } : {}) });
    } else if (it.kind === "text") {
      let end = 0; // the item count after the turn this reply closes
      if (it.done) for (let j = i + 1; j < list.length; j++) { if (list[j].kind === "note") continue; if (list[j].kind === "end") end = j + 1; break; }
      out.push({ i, kind: "text", text: it.text ?? "", ...(it.done ? { done: true } : {}), ...(end ? { end, ...(pointOK(list, end) ? { ok: true } : {}) } : {}) });
    }
  }
  return out;
}
const branchView = (b) => ({ id: b.id, ...(b.from ? { from: b.from } : {}), at: b.at, len: b.items.length, items: treeItems(b.items, b.at) });
/** One branch's own part of a chat's tree. */
const treePart = (id, branch) => (branch === "main" ? branchView({ id: "main", at: 0, items: listOf(id) }) : branchView(branches[id].find((b) => b.id === branch)));
/** GET /api/chats/{id}/tree: main first, then the branches in the order they were made. */
const treeOf = (id) => ({ current: curOf(chats[id]), branches: [treePart(id, "main"), ...(branches[id] ?? []).map(branchView)], labels: [] });

// ---- the stream

let clients = []; // the open streams: { id (the tab's client id), res, boards: the boards of other servers it holds }
const write = (c, m) => c.res.write(`data: ${JSON.stringify(m)}\n\n`);
/** The events that are about a thing of a tree: one about a thing of another server carries that server's entry id. */
const OF_A_THING = new Set(["groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state", "tree", "chat_items", "sub", "sub_items", "held", "release_request", "superseded", "rpc"]);
const holding = new Set(); // the entries whose tree the local server holds: connected, and its snapshot read
/** An event as the pages get it. One about a thing of another server has that server's ids and the top-level
 *  `server`, its group list no `collapsed`, and goes out only while the local server holds that server's tree (null
 *  otherwise: what changes on a machine that is not connected is heard of by nobody here). */
function told(m) {
  const id = world().id;
  if (id === "local" || !OF_A_THING.has(m.type)) return m;
  if (!holding.has(id)) return null;
  return { ...m, ...(m.type === "groups" ? { groups: m.groups.map(({ collapsed: _, ...g }) => g) } : {}), server: id };
}
const send = (m) => { const out = told(m); if (out) for (const c of clients) write(c, out); };
/** What a page names a thing of the machine a call works on by, in the mock's own lists of what a page holds. */
const pageKey = (id) => (world().id === "local" ? id : `${world().id}~${id}`);
/** The branch records of the machine a call works on: one per branch of every chat that has more than main. */
const statesNow = () => Object.keys(sessions).filter((id) => chats[id]).flatMap((id) => Object.keys(sessions[id]).map((b) => branchState(id, b)));
/** A server's whole tree, as the local server holds it: that server's own ids, and no group says whether it is collapsed. */
const sectionTree = (id) => onServer(id, () => ({ groups: groups.map(({ collapsed: _, ...g }) => g), boards: Object.values(boards), chats: Object.values(chats), states: statesNow(),
  defaults: { last: {}, groups: {} } }));
/** GET /api/state and the `snapshot` event: this computer's own tree, and under `sections` the tree of each server held. */
const snapshot = () => here.run(worlds.local, () => ({
  groups: [...groups], boards: Object.values(boards),
  chats: Object.values(chats),
  defaults: { last: {}, groups: {} }, catalogs, home: HOME, defaultCwd: SHOP, dataDir: DATA,
  ...extra, // nothing until the seed ran
  sections: Object.fromEntries([...holding].filter((id) => worlds[id]).map((id) => [id, sectionTree(id)])),
  libraries: libraryList(),
  ...(Object.keys(sessions).length ? { states: statesNow() } : {}),
}));
/** Cuts every open event stream. With flags.streamDown a new one is cut as it opens: the page stays "reconnecting". */
function dropStreams() { for (const c of clients) c.res.destroy(); clients = []; }

/** Adds the states of the composer and chat UI work (dev/mock-ui.js, read and evaluated inside this file): all of
 *  its sections, or the ones named. It sends a snapshot and answers the list of its states. Called through
 *  /mock/eval alone; calling it again puts its states back as they were made. */
function seedUI(...sections) { return eval(fs.readFileSync(path.resolve(HERE, "mock-ui.js"), "utf8"))(sections); }

// ---- HTTP

const ERR = {
  group: [404, "no such group", "not_found"], chat: [404, "no such chat", "not_found"], board: [404, "no such board", "not_found"],
  busy: [409, "the agent is still working; wait for it to finish or stop it", "busy"],
};
const fail = (code, error, word) => ({ fail: [code, error, word] }); // word: the refusal's code, when it has one
const subtree = (id) => { const out = new Set([id]); for (let grew = true; grew;) { grew = false; for (const g of groups) if (!out.has(g.id) && g.parent && out.has(g.parent)) { out.add(g.id); grew = true; } } return out; };
/** A call's JSON body, {} for none; read once, and the same for whoever asks again. */
const body = (req) => (req.parsed ??= new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); }));
/** The page a call is of, by its client id: the stream it has open; undefined for a call of no page. */
const clientOf = (req) => clients.find((c) => c.id === req.headers["x-aiwb-client"]);
const json = (res, v, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
const answer = (res, v) => (v && v.fail ? json(res, { error: v.fail[1], ...(v.fail[2] ? { code: v.fail[2] } : {}) }, v.fail[0]) : json(res, v ?? { ok: true }));
/** The knob `name` of flags as it holds for a chat (and a branch): {} when it is not set, or names another one. */
const knob = (name, chat, branch) => { const k = flags[name]; return k && (!k.chat || k.chat === chat) && (!k.branch || !branch || k.branch === branch) ? k : {}; };
/** What a knob makes a call wait for: its `delay`, or with `hold` the release of the knob. */
const holds = new Set(); // the knobs that hold a call
const pause = (k) => (k.hold ? new Promise((ok) => { (k.held ??= []).push(ok); holds.add(k); }) : k.delay ? wait(k.delay) : undefined);
/** Lets go the calls a knob holds (`hold`): those of flags[name], or with no name those of every knob, also of one
 *  that was replaced or deleted since. Answers how many. */
function release(name) {
  let n = 0;
  for (const k of name ? [flags[name]] : [...holds]) {
    if (!k?.held) continue;
    n += k.held.length;
    for (const ok of k.held.splice(0)) ok();
    holds.delete(k);
  }
  return n;
}
/** A knob's refusal as an answer: 409 "busy" unless it says otherwise. */
const refusal = (r) => fail(r.status ?? 409, r.error ?? "the mock refused it", r.code ?? "busy");
const mockState = () => ({ clients: clients.map((c) => ({ id: c.id })) });

// ---- the server list, and the trees the local server holds of it

/** An entry of the server list that is another server; null for this computer's and for an id the list lacks. */
const entryOf = (id) => extra.servers?.find((x) => x.id === id && !x.local) ?? null;
/** What the local server answers a call for a thing of a server it holds no tree of (contract 3.5): that the server
 *  is not connected, or, of one that is too old, that it is. */
const awayAnswer = (entry) => fail(503, entry.state === "too_old" ? `${entry.name} is too old: update the server on that machine.` : `${entry.name} is not connected.`, "server_unreachable");

/** Puts a server into the list, or changes the one with its id, and gives it a machine of its own if it has none: its
 *  tree is empty until something is made on it (onServer). The local server holds the tree of an entry that is
 *  connected; `tree: false` is one whose snapshot has not been read yet. lists: what that server offers a new chat.
 *  Nothing is told: the seed sends a snapshot. */
function addServer(entry, { tree = entry.state === "connected", lists } = {}) {
  extra.servers ??= [{ id: "local", local: true, name: "This computer", state: "connected" }];
  const at = extra.servers.findIndex((x) => x.id === entry.id);
  if (at < 0) extra.servers.push(entry); else extra.servers[at] = entry;
  worlds[entry.id] ??= newWorld(entry.id);
  if (tree) holding.add(entry.id); else holding.delete(entry.id);
  if (lists) { (extra.lists ??= {})[entry.id] = lists; for (const dir of [lists.home, lists.defaultCwd]) if (dir) TREE[dir] ??= []; }
  else if (extra.lists) delete extra.lists[entry.id];
  return entry;
}

/** Changes the state of an entry of the server list and tells the pages: `server_state`, and `section` with that
 *  server's whole tree when the local server holds it from now on (connected; `tree: false`: connected, its snapshot
 *  not read yet), or with null when it held one and holds none any more. sectionFirst: the two events in the other
 *  order, which is not fixed. more: other fields of the entry (detail, version). With the tree back, each page that
 *  held a board of that server through the outage is given it again, at the revision it has there (`held`). */
function setServerState(id, state, { tree = state === "connected", sectionFirst = false, ...more } = {}) {
  const entry = entryOf(id);
  if (!entry || !worlds[id]) return false;
  const had = holding.has(id);
  Object.assign(entry, more, { state });
  if (state === "connected") delete entry.detail;
  if (tree) holding.add(id); else holding.delete(id);
  const events = [{ type: "server_state", server: entry }, ...(tree ? [{ type: "section", server: id, tree: sectionTree(id) }] : had ? [{ type: "section", server: id, tree: null }] : [])];
  for (const m of sectionFirst ? events.reverse() : events) send(m);
  if (!tree) return true;
  // A board a page here holds is taken again on its server, and the page is told `held` with the revision the board
  // has there: at once, or flags.retake.delay later. Until then a save of it is 503 `not_held_there` (sectionRoute).
  const wait = Math.max(0, Number(flags.retake?.delay) || 0);
  for (const c of clients) for (const k of c.boards) {
    const board = k.startsWith(id + "~") ? k.slice(id.length + 1) : "", sc = board ? worlds[id].scenes[board] : null;
    if (!board) continue;
    if (!sc || !worlds[id].boards[board]) { c.boards.delete(k); continue; }
    const held = () => { c.retaking.delete(k); if (holding.has(id) && c.boards.has(k) && worlds[id].boards[board]) write(c, { type: "held", server: id, board, rev: worlds[id].scenes[board].rev }); };
    if (wait) { c.retaking.add(k); setTimeout(held, wait); } else held();
  }
  return true;
}

/** Takes an entry out of the server list, as its removal in the Servers dialog does, and tells the pages. That server
 *  is told nothing: its machine stays as it is. */
function removeServer(id) {
  if (!entryOf(id)) return false;
  extra.servers = extra.servers.filter((x) => x.id !== id);
  holding.delete(id);
  if (extra.lists) delete extra.lists[id];
  send({ type: "servers", servers: extra.servers });
  send({ type: "server_lists", server: id, lists: null });
  if (libraries[id]) { delete libraries[id]; send({ type: "library_removed", server: id }); }
  send({ type: "section", server: id, tree: null });
  return true;
}

/** A change made on a server from elsewhere, as its owner or another client of it makes one: the call `method path`
 *  (the path as under /api: "/chats", "/groups/g_x/move", …) with `body`, answered by that machine, whose events go
 *  to the pages as that server's. `id` "local": on this computer, as another window does it. Answers { status, body }.
 *  A server that is not connected takes it all the same: nothing is heard of it here until its tree is back. */
async function elsewhere(id, method, path, body) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url: path, headers: {} });
  const got = { status: 200, body: null };
  const res = { headersSent: false, writeHead(code) { got.status = code; this.headersSent = true; }, end(text) { try { got.body = text ? JSON.parse(String(text)) : null; } catch { got.body = String(text); } } };
  const u = new URL(path, "http://x");
  if (await onServer(id, () => treeRoute(req, res, u.pathname, u)) === false) throw new Error(`the mock has no call ${method} ${path}`);
  return got;
}

/** A message as an item of a thread. */
const message = (b) => ({ kind: "user", text: b.text, ...(b.references?.length ? { references: b.references } : {}), ...(b.images?.length ? { images: b.images } : {}) });

/** The images uploaded to each chat, by the chat's id and the image's: { name, type, bytes }. */
const images = part("images");
const IMAGE_MAGIC = [["image/png", [0x89, 0x50, 0x4e, 0x47]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/gif", [0x47, 0x49, 0x46, 0x38]], ["image/webp", [0x52, 0x49, 0x46, 0x46]]];
/** POST /api/chats/{id}/images?name=: the body is the image's bytes. The type is found from the bytes, the id is their
 *  SHA-256. flags.upload holds or delays the answer, or fails it ({ fail: [status, sentence, code] }). */
async function uploadImage(id, req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bytes = Buffer.concat(chunks), k = knob("upload", id);
  await pause(k);
  if (k.fail) return fail(...k.fail);
  if (bytes.length > 5 * 1024 * 1024) return fail(413, "The image is over 5 MB.", "image_too_large");
  const type = IMAGE_MAGIC.find(([, magic]) => magic.every((x, i) => bytes[i] === x))?.[0];
  if (!type) return fail(415, "Not a PNG, JPEG, GIF or WebP image.", "image_type");
  const name = (new URL(req.url, "http://x").searchParams.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "image";
  const image = { id: crypto.createHash("sha256").update(bytes).digest("hex"), name, type, size: bytes.length };
  (images[id] ??= {})[image.id] ??= { ...image, bytes };
  return image;
}

/** Puts a message on the end of a chat's branch and plays the canned reply there: a tool call, a sentence, the
 *  turn's end. first: what is done before the message's own events go out. made: the branch was made for this
 *  message, which is its last item already and was there before anything was told of the branch: no `chat_items`
 *  tells it, as on the server. The reply goes on only while the chat and the branch are the ones it started with: a
 *  chat that was deleted, or made anew by the seed, gets nothing of it. */
function reply(id, branch, b, first = () => {}, made = false) {
  const own = chats[id], list = listOf(id, branch), key = threadKey(id, branch), at = list.length - (made ? 1 : 0);
  const gone = () => chats[id] !== own || listOf(id, branch) !== list;
  const points = list.some((x) => x.kind === "end" && x.point), k = knob("send", id);
  const put = (i, item) => { list[i] = item; send({ type: "chat_items", chat: id, branch, version: (versions[key] = (versions[key] ?? 1) + 1), updates: [{ index: i, item }] }); };
  // (the message takes the branch's draft with it: a change of the draft, which raises its counter)
  const state = (status, more) => { const st = sessionOf(id, branch); setSession(id, branch, { status, locked: true, draft: undefined, ...(st.draft ? { draftRev: (st.draftRev ?? 0) + 1 } : {}), fresh: undefined, ...more }); };
  const tree = (current) => { if (points || sessions[id]) send({ type: "tree", chat: id, branch: treePart(id, branch), ...(current ? { current: curOf(own) } : {}) }); };
  if (!made) list[at] = message(b);
  first();
  if (!made) put(at, list[at]);
  state("thinking"); tree(true);
  if (k.noReply) return;
  const read = (result) => tool("r" + at, "Read", { file_path: "README.md" }, result);
  setTimeout(() => { if (gone()) return; put(at + 1, read()); state("tool"); }, 500);
  setTimeout(() => {
    if (gone()) return;
    put(at + 1, read("ok"));
    put(at + 2, say("A canned reply of the mock."));
    put(at + 3, { kind: "end", ...(points ? { point: newId("p_") } : {}) });
    const u = sessionOf(id, branch).usage; state("ready", { usage: { ...u, turns: u.turns + 1 } }); tree(false);
  }, 1400);
}

/** POST /api/chats/{id}/messages. With no target the message goes to the end of the branch named (?branch=), or of
 *  the current one. A target that asks for a new branch gets one, as the server makes it: the clients hear nothing of
 *  the branch until the message is on it, then `branch_state`, `chat` and `tree`, and then the answer names the
 *  branch. The first branch of a chat tells main's `branch_state` before its own: the clients have no record of main
 *  until then. flags.send and flags.spawn (the header) delay, refuse and reorder that: whatever the order, the branch
 *  is made, current and has its message when the call is answered, and only what is told of it comes later. A call
 *  that was held while its chat was deleted or made anew answers 404 and changes nothing. */
async function sendMessage(own, b, named) {
  const id = own.id, tg = b.target, k = knob("send", id);
  if (tg && tg.at === undefined) return fail(400, "at is missing");
  if (tg && named) return fail(400, "branch and target together");
  const from = tg?.branch ?? (named || curOf(own));
  if (!listOf(id, from)) return fail(404, `no branch ${from}`);
  await pause(k);
  if (chats[id] !== own) return fail(...ERR.chat);
  if (own.archived) return fail(409, "the chat is archived");
  if (k.refuse) return refusal(k.refuse);
  if (!tg?.new) { // the end of a branch, which becomes the current one
    const cold = knob("spawn", id);
    if ((cold.delay || cold.hold) && sessionOf(id, from).fresh) { setSession(id, from, { status: "thinking" }); await pause(cold); if (chats[id] !== own) return fail(...ERR.chat); }
    reply(id, from, b, () => { if (sessions[id] && curOf(own) !== from) setCurrent(id, from); });
    return k.noBranch ? { ok: true } : { ok: true, branch: from };
  }
  const lost = fail(504, "it is not known whether the message arrived", "send_unknown");
  if (k.unknown && k.unknown !== "arrived") return lost;
  const alone = !sessions[id];
  const br = addBranch(id, from, tg.at, { status: "thinking", ...(tg.model ? { model: tg.model, effort: tg.effort || undefined } : {}) });
  br.items.push(message(b)); setCurrent(id, br.id);
  const tell = () => { if (chats[id] === own && listOf(id, br.id) === br.items) reply(id, br.id, b, () => { if (alone) send({ type: "branch_state", state: branchState(id, "main") }); }, true); };
  if (k.unknown) { setTimeout(tell, 50); return lost; }
  if (k.eventsAfter) setTimeout(tell, k.eventsAfter); else tell();
  return k.noBranch ? { ok: true } : { ok: true, branch: br.id };
}

/** POST /api/chats/{id}/fork: a new chat with the first `at` items of a branch, in the place of its source; with
 *  `message`, that user message is its draft, with its quotes of the items copied. A fork that starts with a
 *  conversation is fresh: its model and effort are open until its first own message. Nothing is told of it before the
 *  answer. flags.fork delays or refuses it. */
async function forkChat(src, b) {
  const k = knob("fork", src.id), branch = b.branch || "main", list = listOf(src.id, branch);
  if (b.at === undefined) return fail(400, "at is missing");
  if (!list) return fail(404, `no branch ${branch}`);
  await pause(k);
  if (chats[src.id] !== src) return fail(...ERR.chat);
  if (k.refuse) return refusal(k.refuse);
  const id = newId("c_"), st = sessionOf(src.id, branch), said = list.find((x) => x.kind === "user")?.text ?? "";
  const title = src.name || (said.length > 40 ? said.slice(0, 40) + "…" : said) || "New chat", edit = list[b.message];
  const quotes = (edit?.references ?? []).filter((r) => r.item < b.at); // those of what the copy lacks would name other items there
  chats[id] = chat(id, { agent: src.agent, ...(src.board ? { board: src.board } : { group: src.group }),
    cwd: st.cwd, model: st.model, effort: st.effort, usage: st.usage, name: `${title} (fork)`, created: iso(Date.now()), locked: b.at > 0, ...(b.at > 0 ? { fresh: true } : {}),
    forkedFrom: src.id, forkedFromTitle: title, forkedBranch: branch, forkedAt: b.at,
    ...(edit?.kind === "user" ? { draft: { text: edit.text ?? "", ...(quotes.length ? { references: quotes } : {}) } } : {}) });
  items[id] = clone(list.slice(0, b.at));
  send({ type: "chat", chat: chats[id] });
  return chats[id];
}

/** What the machine a call works on offers (its agents, their catalogs, its default folder): this computer's own, or
 *  what the seed gave the entry. */
const listsHere = () => (world().id !== "local" ? extra.lists?.[world().id] : null) ?? { agents: extra.agents ?? Object.keys(catalogs), catalogs, home: HOME, defaultCwd: SHOP };

/** The agent, model, effort and folder of a PATCH, on one branch. A server is refused (409 `server_fixed`: a chat is
 *  on the server it was made on); an agent gives its default model and effort; a model keeps the effort it offers, else takes
 *  its default. A fork without a message of its own starts its agent again on a model or effort: it has the choice
 *  and is "thinking" until the answer, and has its old choice again after a refusal, but for pi, which tells nothing
 *  of it. While such a fork is working (this start, or its first message's) a second pick is refused: 409 "busy".
 *  flags.configure delays or refuses the change. */
async function configureChat(own, branch, b) {
  const id = own.id, k = knob("configure", id), st = sessionOf(id, branch), pick = !!st.fresh && !!(b.model || b.effort), restart = pick && own.agent !== "pi";
  if (b.server) return fail(409, "a chat is on the server it was made on: that cannot be changed", "server_fixed");
  if (pick && WORKING.includes(st.status)) return fail(...ERR.busy);
  const was = { model: st.model, effort: st.effort }, modelsOf = () => listsHere().catalogs?.[own.agent];
  /** The model and effort of the pick, over what p has. */
  const choice = (p) => {
    if (b.model) { const mm = modelsOf()?.models.find((x) => x.id === b.model), had = p.effort ?? sessionOf(id, branch).effort; p.model = b.model; p.effort = mm?.efforts?.includes(had) ? had : mm?.defaultEffort; }
    if (b.effort) p.effort = b.effort;
    return p;
  };
  if (restart) setSession(id, branch, { ...choice({}), status: "thinking" });
  await pause(k);
  if (chats[id] !== own) return fail(...ERR.chat);
  if (k.refuse) { if (restart) setSession(id, branch, { ...was, status: "ready" }); return refusal(k.refuse); }
  const p = {};
  const byDefault = () => { const d = modelsOf()?.default; p.model = d?.model ?? ""; p.effort = d?.effort; };
  if (b.agent) { own.agent = b.agent; byDefault(); }
  choice(p);
  if (b.cwd) p.cwd = b.cwd;
  setSession(id, branch, { ...p, ...(restart ? { status: "ready" } : {}) });
  return null;
}

/** What a delete that asks for the local record alone is answered: this computer keeps no record of a thing of another server. */
const NO_RECORD = [400, "there is no record to remove: nothing of another server is kept here", "no_record"];
/** What a make on this computer that names another server is answered: a thing is made on a server by the calls under /api/on/. */
const SERVER_REFUSED = [400, "this call is for this computer: a thing of another server is reached under /api/on/<server>", "server_refused"];
const namesServer = (b) => b.server !== undefined && b.server !== "local";

async function chatRoute(req, res, id, rest) {
  const M = req.method, own = chats[id], query = new URL(req.url, "http://x").searchParams, named = query.get("branch");
  if (!own) { await body(req); return answer(res, fail(...ERR.chat)); }
  let m;
  if (rest === "" && M === "GET") return answer(res, own);
  if (rest === "/items" && M === "GET") {
    const branch = named || curOf(own), k = knob("items", id, branch), key = threadKey(id, branch);
    const list = listOf(id, branch);
    await pause(k);
    if (k.fail) return answer(res, fail(k.fail === true ? 500 : k.fail, "the mock failed this read"));
    if (!list) return answer(res, fail(404, `no branch ${branch}`));
    // (a chat with main alone sends no record: its view tells its state, and only `chat` events change it)
    return answer(res, { version: (versions[key] ??= 1), branch, items: list, subagents: (branch === "main" && subs[id]) || [], ...(sessions[id] ? { state: branchState(id, branch) } : {}) });
  }
  if ((m = /^\/subagents\/([^/]+)\/items$/.exec(rest)) && M === "GET") return answer(res, { version: 1, items: subItems[`${id}/${m[1]}`] ?? [] });
  if (rest === "/tree" && M === "GET") return answer(res, treeOf(id));
  if (rest === "/context" && M === "GET") return answer(res, { atMessage: 0, atTurn: 0, total: 42900, window: 200000, categories: [{ id: "messages", label: "Messages", tokens: 42900, kind: "used" }, { id: "free", label: "Free space", tokens: 157100, kind: "free" }] });
  if (rest === "/open" && M === "POST") return answer(res);
  if (rest === "/permission" && M === "POST") { await body(req); return answer(res); }
  if (rest === "/images" && M === "POST") return answer(res, await uploadImage(id, req));
  if ((m = /^\/images\/([0-9a-f]{64})$/.exec(rest)) && M === "GET") {
    const image = images[id]?.[m[1]];
    if (!image) return answer(res, fail(404, "no such image"));
    res.writeHead(200, { "Content-Type": image.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" });
    return res.end(image.bytes);
  }
  const b = await body(req);
  if (rest === "" && M === "PATCH") { // the name and the group are the chat's; the rest goes to one branch (?branch=)
    if (b.subDepth !== undefined || b.subCap !== undefined) {
      if (own.locked) return answer(res, fail(409, "the chat has started: its subagent settings are fixed"));
      const depth = b.subDepth ?? (own.subOff ? 0 : own.subDepth ?? 1), cap = b.subCap ?? own.subCap ?? 100;
      if (!Number.isInteger(depth) || depth < 0 || depth > 3) return answer(res, fail(400, `subagent depth ${depth} is out of range: 0 (off) to 3`));
      if (!Number.isInteger(cap) || cap < 1 || cap > 100) return answer(res, fail(400, `subagent cap ${cap} is out of range: 1 to 100`));
      setSubLimits(own, depth, cap); world().lastSubLimits = { depth, cap };
      send({ type: "chat", chat: own }); return answer(res, { ok: true, chat: own });
    }
    for (const k of ["name", "group"]) if (b[k] !== undefined) own[k] = b[k];
    if (b.name !== undefined) own.userNamed = true;
    const refused = b.server || b.agent || b.model || b.effort || b.cwd ? await configureChat(own, named || curOf(own), b) : void send({ type: "chat", chat: own });
    return answer(res, refused ?? { ok: true, chat: own }); // the chat as it is after the change, as the server
  }
  if (rest === "" && M === "DELETE") {
    if (query.has("local")) return answer(res, fail(...NO_RECORD));
    delete chats[id]; send({ type: "chat_removed", id }); return answer(res);
  }
  if (rest === "/draft" && M === "PUT") {
    // The draft's counter decides between writers: a save names the counter it was typed on (?rev=), and one typed on
    // another is refused with the counter and the draft there are. A call that names none is taken.
    const branch = named || curOf(own), was = sessionOf(id, branch), rev = was.draftRev ?? 0, base = query.get("rev");
    if (base !== null && Number(base) !== rev) return json(res, { error: "the draft was changed elsewhere", code: "stale", rev, draft: was.draft ?? null }, 409);
    // (a draft that names an image the chat does not hold is saved without it, and the answer names it)
    const missing = (b.images ?? []).filter((x) => !images[id]?.[x.id]).map((x) => x.id), kept = (b.images ?? []).filter((x) => !missing.includes(x.id));
    const { images: _, ...rest0 } = b, d = kept.length ? { ...rest0, images: kept } : rest0;
    setSession(id, branch, { draft: d.text || d.references?.length || d.images?.length ? d : undefined, draftRev: rev + 1 });
    return answer(res, { ok: true, rev: rev + 1, ...(missing.length ? { missing } : {}) });
  }
  if (rest === "/fork" && M === "POST") return answer(res, await forkChat(own, b));
  if (rest === "/archive" || rest === "/unarchive") {
    if (rest === "/archive") Object.assign(own, { archived: true, archiveOp: newId("op_") }); else { delete own.archived; delete own.archiveOp; }
    send({ type: "chat", chat: own });
    return answer(res);
  }
  if (rest === "/messages" && M === "POST") return answer(res, await sendMessage(own, b, named)); // a canned reply, so that a chat can be tried
  return answer(res);
}

/** Group routes: the effects a group's archive and delete have on its boards and chats. */
function groupRoute(req, res, id, rest, b, u) {
  const M = req.method, g = groups.find((x) => x.id === id);
  if (!g) return answer(res, fail(...ERR.group));
  const ids = subtree(id), within = (x) => ids.has(x.group);
  if (rest === "" && M === "PATCH") { for (const k of ["name", "collapsed"]) if (b[k] !== undefined) g[k] = b[k]; send({ type: "groups", groups }); return answer(res); }
  if (rest === "/move") { if (b.parent) g.parent = b.parent; else delete g.parent; send({ type: "groups", groups }); return answer(res); }
  if (rest === "/archive" || rest === "/unarchive") {
    const arch = rest === "/archive", op = arch ? newId("op_") : g.archiveOp;
    for (const x of groups) if (ids.has(x.id) && (arch ? !x.archived : x.archiveOp === op)) { if (arch) Object.assign(x, { archived: true, archiveOp: op }); else { delete x.archived; delete x.archiveOp; } }
    send({ type: "groups", groups });
    for (const x of Object.values(boards)) if (within(x) && (arch ? !x.archived : x.archiveOp === op)) { if (arch) Object.assign(x, { archived: true, archiveOp: op }); else { delete x.archived; delete x.archiveOp; } send({ type: "board", board: x }); }
    for (const c of Object.values(chats)) if ((within(c) || (c.board && within(boards[c.board] ?? {}))) && (arch ? !c.archived : c.archiveOp === op)) { if (arch) Object.assign(c, { archived: true, archiveOp: op }); else { delete c.archived; delete c.archiveOp; } send({ type: "chat", chat: c }); }
    return answer(res);
  }
  if (rest === "" && M === "DELETE") {
    const keep = u.searchParams.get("contents") === "keep", parent = g.parent ?? UNGROUPED;
    for (const x of Object.values(boards)) if (keep ? x.group === id : within(x)) {
      if (keep) { x.group = parent; send({ type: "board", board: x }); continue; }
      for (const c of Object.values(chats)) if (c.board === x.id) { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); }
      delete boards[x.id]; send({ type: "board_removed", id: x.id });
    }
    for (const c of Object.values(chats)) if (keep ? c.group === id : within(c)) { if (keep) { c.group = parent; send({ type: "chat", chat: c }); } else { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); } }
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].id === id || (!keep && ids.has(groups[i].id))) groups.splice(i, 1);
      else if (keep && groups[i].parent === id) { if (g.parent) groups[i].parent = g.parent; else delete groups[i].parent; }
    }
    send({ type: "groups", groups });
    return answer(res);
  }
  return answer(res);
}

// ---- the prompt library (internal/library, internal/server/library.go): one library per server

const libraries = { local: { groups: [], prompts: [] } }; // by server id: { groups, prompts, connected: false for a copy of a server that dropped, notice }
const LIB = { name: 80, text: 100000, depth: 16 };
const libraryName = (id) => (id === "local" ? "This computer" : extra.servers?.find((x) => x.id === id)?.name ?? id);
const libraryView = (id) => ({ server: id, name: libraryName(id), connected: libraries[id].connected !== false, ...(libraries[id].notice ? { notice: libraries[id].notice } : {}), groups: libraries[id].groups, prompts: libraries[id].prompts });
/** GET /api/library and the snapshot's list: this computer's first, then the servers' in the order of the server list. */
const libraryList = () => ["local", ...(extra.servers ?? []).map((x) => x.id).filter((id) => id !== "local")].filter((id) => libraries[id]).map(libraryView);
const sendLibrary = (id) => send({ type: "library", library: libraryView(id) });
/** Gives a server a library, or another one, and tells the pages; null takes it away, as when its server leaves the list. */
function setLibrary(id, lib) {
  if (lib) { libraries[id] = { groups: [], prompts: [], ...lib }; return sendLibrary(id); }
  delete libraries[id];
  send({ type: "library_removed", server: id });
}
/** A name as the library keeps it, or its refusal: empty, too long, with "/" or a line break, or taken in its group whatever the case. */
function libraryNameOf(lib, raw, parent, self) {
  if (typeof raw !== "string") return fail(400, "A name must be text.", "bad_name");
  const name = raw.trim();
  if (!name) return fail(400, "A name cannot be empty.", "bad_name");
  if ([...name].length > LIB.name) return fail(400, `A name can have at most ${LIB.name} characters.`, "bad_name");
  if (name.includes("/")) return fail(400, 'A name cannot contain "/".', "bad_name");
  if (/[\n\r]/.test(name)) return fail(400, "A name cannot contain a line break.", "bad_name");
  const g = lib.groups.find((x) => x.id === parent), where = g ? `in the group "${g.name}"` : "at the top of the library";
  const same = (x) => x.parent === parent && x.id !== self && x.name.toLowerCase() === name.toLowerCase();
  const group = lib.groups.find(same), prompt = lib.prompts.find(same);
  if (group || prompt) return fail(409, `There is already a ${group ? "group" : "prompt"} called "${(group ?? prompt).name}" ${where}.`, "name_taken");
  return name;
}
/** The ids of a group and of every group below it. */
function libraryBelow(lib, id) {
  const ids = new Set([id]);
  for (let grew = true; grew; ) { grew = false; for (const g of lib.groups) if (ids.has(g.parent) && !ids.has(g.id)) { ids.add(g.id); grew = true; } }
  return ids;
}
/** How many groups deep a group is (0 for the top), and how many levels of groups a group and those below it have. */
const libraryDepth = (lib, id) => { let d = 0; for (let g = lib.groups.find((x) => x.id === id); g && d <= lib.groups.length; g = lib.groups.find((x) => x.id === g.parent)) d++; return d; };
const libraryHeight = (lib, id) => 1 + Math.max(0, ...lib.groups.filter((g) => g.parent === id).map((g) => libraryHeight(lib, g.id)));
/** The calls that change the library of `server`: kind "groups" or "prompts", id of the item for a change or a delete. */
async function libraryRoute(req, res, server, kind, id) {
  const M = req.method, b = await body(req), k = flags.library ?? {};
  await pause(k);
  if (k.refuse) return answer(res, refusal(k.refuse));
  const lib = libraries[server], groups = kind === "groups", word = groups ? "group" : "prompt";
  if (!lib) return answer(res, fail(404, "This server has no prompt library here.", "no_server"));
  if (lib.connected === false) return answer(res, fail(503, `${libraryName(server)} is not connected: its prompts cannot be changed until it is back.`, "server_unreachable"));
  const list = groups ? lib.groups : lib.prompts, hasGroup = (g) => g === "" || lib.groups.some((x) => x.id === g);
  const tooLong = (text) => typeof text === "string" && [...text].length > LIB.text;
  if (M === "POST" && !id) {
    const parent = b.parent ?? "";
    if (!hasGroup(parent)) return answer(res, fail(404, "The group it should be in no longer exists.", "no_group"));
    const name = libraryNameOf(lib, b.name, parent, "");
    if (name.fail) return answer(res, name);
    if (!groups && tooLong(b.text)) return answer(res, fail(413, "The text of a prompt can have at most 100,000 characters.", "text_too_long"));
    if (groups && libraryDepth(lib, parent) + 1 > LIB.depth) return answer(res, fail(409, `Groups can be at most ${LIB.depth} deep.`, "too_deep"));
    const item = { id: (groups ? "g_" : "p_") + Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join(""), name, parent, ...(groups ? {} : { text: b.text ?? "" }) };
    list.push(item);
    sendLibrary(server);
    return answer(res, { [word]: item });
  }
  const item = list.find((x) => x.id === id);
  if (!item) return answer(res, fail(404, `This ${word} no longer exists.`, "not_found"));
  if (M === "PATCH") {
    const parent = b.parent ?? item.parent;
    if (!hasGroup(parent)) return answer(res, fail(404, "The group it should be in no longer exists.", "no_group"));
    if (groups && parent === id) return answer(res, fail(409, "A group cannot be moved into itself.", "bad_move"));
    if (groups && libraryBelow(lib, id).has(parent)) return answer(res, fail(409, "A group cannot be moved into a group below it.", "bad_move"));
    const name = libraryNameOf(lib, b.name ?? item.name, parent, id);
    if (name.fail) return answer(res, name);
    if (!groups && tooLong(b.text)) return answer(res, fail(413, "The text of a prompt can have at most 100,000 characters.", "text_too_long"));
    if (groups && libraryDepth(lib, parent) + libraryHeight(lib, id) > LIB.depth) return answer(res, fail(409, `Groups can be at most ${LIB.depth} deep.`, "too_deep"));
    Object.assign(item, { name, parent }, !groups && b.text !== undefined ? { text: b.text } : {});
    sendLibrary(server);
    return answer(res, { [word]: item });
  }
  if (M === "DELETE") {
    const gone = groups ? libraryBelow(lib, id) : null;
    if (gone) { lib.groups = lib.groups.filter((g) => !gone.has(g.id)); lib.prompts = lib.prompts.filter((p) => !gone.has(p.parent)); }
    else lib.prompts = lib.prompts.filter((p) => p.id !== id);
    sendLibrary(server);
    return answer(res, { ok: true });
  }
  return answer(res, fail(405, "method not allowed"));
}

/** The calls about the things of one machine's tree (its groups, boards and chats), by their path after /api: this
 *  computer's as they come, another server's inside onServer. Answers false for a path that is none of them. */
async function treeRoute(req, res, p, u) {
  const M = req.method, there = world().id === "local" ? null : extra.lists?.[world().id] ?? { agents: [], catalogs: {}, defaultCwd: "" }; // what another server offers a new chat
  let m;
  if (p === "/chats" && M === "POST") {
    const b = await body(req);
    if (namesServer(b)) return answer(res, fail(...SERVER_REFUSED));
    if (b.group && b.group !== UNGROUPED && !groups.some((x) => x.id === b.group)) return answer(res, fail(...ERR.group));
    // A chat is made on the machine the call is for. On another server it starts with what that server offers: its first agent, with that
    // agent's default model and effort, in its default folder.
    const agent = there ? there.agents[0] ?? "" : b.agent, cat = there ? there.catalogs?.[agent] ?? null : catalogOf(b.agent), id = newId("c_");
    chats[id] = chat(id, { agent, ...(b.board ? { board: b.board } : { group: b.group }), cwd: there ? there.defaultCwd : SHOP,
      model: cat?.default.model ?? "", effort: cat?.default.effort, created: iso(Date.now()), ...fresh });
    items[id] = [];
    if (world().lastSubLimits) setSubLimits(chats[id], world().lastSubLimits.depth, world().lastSubLimits.cap);
    send({ type: "chat", chat: chats[id] });
    return json(res, chats[id]);
  }
  if ((m = /^\/chats\/([^/]+)(\/.*)?$/.exec(p))) return await chatRoute(req, res, m[1], m[2] ?? "");
  if (p === "/groups" && M === "POST") {
    const b = await body(req);
    if (b.parent && !groups.some((x) => x.id === b.parent)) return answer(res, fail(...ERR.group));
    const g = { id: newId("g_"), name: b.name || "New group", ...(b.parent ? { parent: b.parent } : {}) }; groups.push(g); send({ type: "groups", groups }); return json(res, g);
  }
  if ((m = /^\/groups\/([^/]+)(\/.*)?$/.exec(p))) return groupRoute(req, res, m[1], m[2] ?? "", await body(req), u);
  if (p === "/boards" && M === "POST") {
    const b = await body(req);
    if (namesServer(b)) return answer(res, fail(...SERVER_REFUSED));
    const x = { id: newId("b_"), name: b.name || "untitled", group: b.group, created: iso(Date.now()) }; boards[x.id] = x; send({ type: "board", board: x }); return json(res, x);
  }
  if ((m = /^\/boards\/([^/]+)(\/.*)?$/.exec(p))) {
    const x = boards[m[1]], rest = m[2] ?? "", b = M === "GET" ? {} : await body(req);
    if (!x) return answer(res, fail(...ERR.board));
    const sc = scenes[x.id], mine = clientOf(req)?.boards; // the seed's: a board that this window may hold, with a stored drawing
    if (sc && rest === "/scene" && M === "GET") { res.writeHead(200, { "Content-Type": "application/json", "X-AIWB-Scene-Rev": String(sc.rev) }); return res.end(JSON.stringify(sc.scene)); }
    if (sc && rest === "/scene" && M === "PUT") { // on the revision the drawing was read at (?rev=): one stored at another is not replaced
      const base = u.searchParams.get("rev");
      if (base !== null && Number(base) !== sc.rev) return answer(res, fail(409, "the board was changed elsewhere", "stale"));
      sc.scene = b; return json(res, { rev: ++sc.rev });
    }
    if (sc && rest === "/take") { mine?.add(pageKey(x.id)); return json(res, { state: "held", rev: sc.rev }); }
    if (sc && rest === "/release") { mine?.delete(pageKey(x.id)); return json(res, { state: "free" }); }
    if (rest === "/scene" && M === "GET") return json(res, { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
    if (rest === "/rename") { x.name = b.name; send({ type: "board", board: x }); return json(res, x); }
    if (rest === "" && M === "PATCH") { x.group = b.group; send({ type: "board", board: x }); return json(res, x); }
    if (rest === "/archive" || rest === "/unarchive") { if (rest === "/archive") Object.assign(x, { archived: true, archiveOp: newId("op_") }); else { delete x.archived; delete x.archiveOp; } send({ type: "board", board: x }); return json(res, { ok: true }); }
    if (rest === "" && M === "DELETE") {
      if (u.searchParams.has("local")) return answer(res, fail(...NO_RECORD));
      for (const c of Object.values(chats)) if (c.board === x.id) { delete chats[c.id]; send({ type: "chat_removed", id: c.id }); }
      delete boards[x.id]; delete scenes[x.id]; send({ type: "board_removed", id: x.id });
    }
    return json(res, { ok: true });
  }
  return false;
}

/** The calls of a section the local server knows (contract 3.4), by method and by the path after /api/on/{server}. */
const ON_ROUTES = [
  ["POST", /^\/(groups|chats|boards)$/],
  ["PATCH DELETE", /^\/groups\/[^/]+$/], ["POST", /^\/groups\/[^/]+\/(move|archive|unarchive)$/],
  ["GET PATCH DELETE", /^\/chats\/[^/]+$/], ["GET", /^\/chats\/[^/]+\/(context|items|tree|subagents\/[^/]+\/items|images\/[^/]+)$/],
  ["POST", /^\/chats\/[^/]+\/(unfollow|interrupt|permission|open|fork|archive|unarchive|messages|images)$/], ["PUT", /^\/chats\/[^/]+\/(label|draft)$/],
  ["POST", /^\/boards\/[^/]+\/(take|release|rename|archive|unarchive|seen|reveal)$/], ["GET PUT", /^\/boards\/[^/]+\/scene$/], ["PATCH DELETE", /^\/boards\/[^/]+$/],
];

/** /api/on/{server}/…: the call of a thing of a section. The local server answers some itself, and passes the others
 *  on to that server, whose answer is the page's (contract 3.4 and 3.5): here that machine's own routes answer, with
 *  its own ids. Every call counts in `onCalls`, as a check reads it: { server, method, path (with its query), body? }. */
const onCalls = [];
async function sectionRoute(req, res, id, p, u) {
  const M = req.method, entry = entryOf(id);
  const upload = /^\/chats\/[^/]+\/images$/.test(p) && M === "POST"; // (its body is bytes, read by its own route)
  const drain = async () => { if (upload) for await (const _ of req); else await body(req); };
  onCalls.push({ server: id, method: M, path: p + u.search, ...(M !== "GET" && !upload ? { body: await body(req) } : {}) });
  // A path that is no row of the table is 404 before anything else, whatever the id names (internal/server/section.go sectionFirst).
  if (!ON_ROUTES.some(([methods, path]) => methods.split(" ").includes(M) && path.test(p))) { await drain(); return json(res, { error: "not found" }, 404); }
  let m;
  // The entry decides next, in every row: an id that is no entry is 404 no_server (sectionTable.always).
  if (!entry || !worlds[id]) { await drain(); return answer(res, fail(404, "This server is not in the list.", "no_server")); }
  // answered here, whatever the entry's state
  if (/^\/boards\/[^/]+\/reveal$/.test(p)) return answer(res, fail(400, "A board on another server has no file on this computer", "not_here"));
  if (/^\/chats\/[^/]+\/unfollow$/.test(p)) return json(res, { ok: true });
  if (!holding.has(id)) { // not connected, or connected with its snapshot not read yet: nothing is sent
    await drain();
    if ((m = /^\/boards\/([^/]+)\/release$/.exec(p))) return json(res, { state: clientOf(req)?.boards.delete(`${id}~${m[1]}`) ? "free" : "none" });
    return answer(res, awayAnswer(entry));
  }
  if (/^\/groups\/[^/]+$/.test(p) && M === "PATCH" && Object.keys(await body(req)).some((k) => k.toLowerCase() === "collapsed")) return answer(res, fail(400, "whether a group of another server shows collapsed is kept by the page alone", "collapsed_refused"));
  // (a draft's save alone: a message with ?replace is passed on as any other, and that server does not read the word)
  if (/^\/chats\/[^/]+\/draft$/.test(p) && M === "PUT" && u.searchParams.has("replace")) return answer(res, fail(400, "a draft is not replaced: save it on the counter it was typed on", "replace_refused"));
  // flags.draft: a save of a draft on another server waits; one that waited while its server dropped never got there (504 `no_answer`).
  if (/^\/chats\/[^/]+\/draft$/.test(p) && M === "PUT" && flags.draft && (!flags.draft.server || flags.draft.server === id)) {
    await pause(flags.draft);
    if (!holding.has(id)) { await drain(); return answer(res, fail(504, `${entry.name} did not answer.`, "no_answer")); }
  }
  // A save of a board that this computer's server is still taking again on its server, after that server came back
  // (flags.retake): "not yet". The `held` that ends the re-take follows (setServerState).
  if ((m = /^\/boards\/([^/]+)\/scene$/.exec(p)) && M === "PUT" && clientOf(req)?.retaking?.has(`${id}~${m[1]}`)) { await drain(); return answer(res, fail(503, `The board is being taken again on ${entry.name}.`, "not_held_there")); }
  if (M === "POST" && /^\/(groups|chats|boards)$/.test(p)) { // flags.make: a make on another server waits, or is refused by that server
    const k = flags.make && (!flags.make.server || flags.make.server === id) ? flags.make : {};
    await pause(k);
    if (k.refuse) { await drain(); return answer(res, refusal(k.refuse)); }
    if (!holding.has(id)) { await drain(); return answer(res, fail(504, `${entry.name} did not answer.`, "no_answer")); } // (it dropped while the make waited)
  }
  return await onServer(id, () => treeRoute(req, res, p, u));
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, M = req.method;
  let m;
  try {
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (flags.streamDown) return void req.socket.destroy(); // the browser tries again by itself
      const c = { id: u.searchParams.get("client") ?? "", res, boards: new Set(), retaking: new Set() }; // every tab is "active": the mock has no takeover
      clients.push(c);
      write(c, { type: "hello", active: true }); write(c, { type: "snapshot", ...snapshot() });
      req.on("close", () => { clients = clients.filter((x) => x !== c); });
      return;
    }
    if (p.startsWith("/mock/")) {
      if (M === "POST") {
        const mb = await body(req);
        if (p === "/mock/eval") { try { const r = await eval(`(async () => { ${mb.code} })()`); return json(res, { ok: true, r: r ?? null }); } catch (e) { return json(res, { error: String(e.stack ?? e) }, 500); } }
        else if (p === "/mock/snapshot") send({ type: "snapshot", ...snapshot() });
        else return json(res, { error: "no such control" }, 404);
      }
      return json(res, mockState());
    }
    if (p === "/api/hello") return json(res, { app: "ai-whiteboard", version: flags.hello?.version ?? "dev", pid: process.pid, webVersion: flags.hello?.webVersion ?? "dev" });
    if (p === "/api/state") return json(res, snapshot());
    if (p === "/api/library" && M === "GET") return json(res, { libraries: libraryList() });
    if ((m = /^\/api\/library\/([^/]+)\/(groups|prompts)(?:\/([^/]+))?$/.exec(p))) return await libraryRoute(req, res, decodeURIComponent(m[1]), m[2], m[3] ? decodeURIComponent(m[3]) : "");
    if (p === "/api/dirs") {
      const dir = expand(u.searchParams.get("path") || HOME);
      if (!exists(dir)) return json(res, { error: `${dir} is not a directory` }, 400);
      return json(res, { path: dir, parent: path.dirname(dir), dirs: TREE[dir] });
    }
    if ((m = /^\/api\/usage\/([^/]+)$/.exec(p))) return json(res, { plan: false, note: "The mock has no plan limits.", limits: [], fetchedAt: iso(Date.now()) });
    if (/^\/api\/servers\/[^/]+\/items$/.test(p)) return json(res, { error: "not found" }, 404); // (what an entry's removal would take away is no longer counted)
    if ((m = /^\/api\/on\/([^/]+)(\/.*)?$/.exec(p))) return await sectionRoute(req, res, decodeURIComponent(m[1]), m[2] ?? "", u);
    if (p.startsWith("/api/") && await treeRoute(req, res, p.slice(4), u) !== false) return;
    if (p.startsWith("/api/")) { await body(req); return json(res, { ok: true }); }
    const f = path.join(DIST, p === "/" ? "index.html" : p);
    if (!inside(f, DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  } catch (err) {
    console.error(`${M} ${p}:`, err);
    if (!res.headersSent) json(res, { error: String(err?.message ?? err) }, 500); else res.end();
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock on http://127.0.0.1:${PORT} (pid ${process.pid}); serving ${DIST}`));
