// A chat's server and what it offers (src/logic/serverlists.ts): the lists by server, the server
// choice, and the rules of the events `server_lists`, `server_back` and `chat_reload` and of a
// thread's load error. The events through the real event layer are in conn.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_LOCAL, RUN_SERVER, SERVER_FIXED, START_UNCONFIRMED, chatReload, listsFrom, listsOf, offered, recentKey, serverBack, serverChoice, serverConnected,
  serverName, serverOf, serverOfChat, serverState, threadError, waitsForUser, withLists, withThreadError, withoutThread } from "../src/logic/serverlists.ts";
import { readFileSync } from "node:fs";
import { LOCAL_ENTRY, stateLabel, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { ApiError } from "../src/api.ts";
import { LOCAL_SERVER, type AgentKind, type Catalog, type ChatView, type ServerLists, type TreeView } from "../src/types.ts";

const CAT: Catalog = { models: [], default: { model: "m" } };
const THERE: ServerLists = { agents: ["pi"], catalogs: { pi: CAT, claude: null }, home: "/home/u", defaultCwd: "/home/u/work" };
const entry = (id: string, state: ServerState, name = "Studio"): ServerView => ({ id, name, state });
const ALL: ServerState[] = ["connecting", "connected", "unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed",
  "certificate_not_accepted", "name_not_known", "not_aiwb", "too_old", "another_server"];
const store = (state: ServerState = "connected") => ({
  usable: ["claude"] as AgentKind[], catalogs: { claude: CAT }, home: "/Users/me", defaultCwd: "/Users/me/code",
  lists: { s_1: THERE }, servers: [LOCAL_ENTRY, entry("s_1", state)],
});
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", locked: false, ...o }) as ChatView;

test("serverOf: the chat's entry id, and this computer for a chat that names none", () => {
  assert.equal(serverOf(chat()), LOCAL_SERVER);
  assert.equal(serverOf(chat({ server: "s_1" })), "s_1");
  assert.equal(serverOf(chat({ server: "" })), LOCAL_SERVER);
  assert.equal(serverOf(undefined), LOCAL_SERVER);
});

test("listsOf: the local server's from the store's own fields, another's as received", () => {
  const s = store();
  assert.deepEqual(listsOf(s, LOCAL_SERVER), { agents: ["claude"], catalogs: { claude: CAT }, home: "/Users/me", defaultCwd: "/Users/me/code" });
  assert.equal(listsOf(s, LOCAL_SERVER), listsOf({ ...s }, LOCAL_SERVER), "the same object for the same parts: it can be a store selector");
  assert.notEqual(listsOf(s, LOCAL_SERVER), listsOf({ ...s, home: "/elsewhere" }, LOCAL_SERVER));
  assert.equal(listsOf(s, "s_1"), THERE);
  assert.equal(listsOf(s, "s_2"), undefined);
  assert.deepEqual(listsOf({}, LOCAL_SERVER), { agents: [], catalogs: {}, home: "", defaultCwd: "" });
  assert.equal(listsOf({}, "s_1"), undefined);
});

test("listsOf keeps another server's lists while it is not connected; offered gives them only while it is", () => {
  for (const state of ALL) {
    const s = store(state);
    assert.equal(listsOf(s, "s_1"), THERE, state);
    assert.equal(offered(s, "s_1"), state === "connected" ? THERE : undefined, state);
    assert.equal(serverConnected(s, "s_1"), state === "connected", state);
    assert.equal(serverState(s, "s_1"), state);
    assert.equal(offered(s, LOCAL_SERVER), listsOf(s, LOCAL_SERVER), "the local server always offers");
  }
  assert.equal(offered({ ...store(), lists: {} }, "s_1"), undefined); // connected, its lists not here yet
  assert.equal(offered(store(), "s_2"), undefined);                   // no such entry
  assert.equal(serverState(store(), "s_2"), undefined);
  assert.equal(serverConnected(store(), "s_2"), false);
  assert.equal(serverConnected({}, LOCAL_SERVER), true);
});

test("serverName: This computer, or the entry's name", () => {
  assert.equal(serverName(store(), LOCAL_SERVER), "This computer");
  assert.equal(serverName(store(), "s_1"), "Studio");
  assert.equal(serverName({ servers: [{ ...LOCAL_ENTRY, name: "renamed" }] }, LOCAL_SERVER), "This computer");
  assert.equal(serverName(store(), "s_2"), "Unknown server");
  assert.equal(serverName({}, "s_1"), "Unknown server");
});

test("recentKey: the recent folders are kept per server", () => {
  assert.equal(recentKey(LOCAL_SERVER), "aiwb.dirs");
  assert.equal(recentKey("s_1"), "aiwb.dirs.s_1");
});

test("serverChoice: every entry with its name, this computer first", () => {
  const servers = [LOCAL_ENTRY, entry("s_1", "connected"), entry("s_2", "unreachable", "Laptop")];
  assert.deepEqual(serverChoice(servers, chat()), {
    options: [{ id: "local", label: "This computer" }, { id: "s_1", label: "Studio" }, { id: "s_2", label: "Laptop", reason: stateLabel("unreachable") }], fixed: "",
  });
  assert.deepEqual(serverChoice([], chat()).options, [{ id: "local", label: "This computer" }]); // a list with no local entry
  assert.deepEqual(serverChoice([entry("s_1", "connected"), LOCAL_ENTRY], chat()).options.map((o) => o.id), ["local", "s_1"]);
});

test("serverChoice: an entry that waits for the user is disabled with its state as the reason", () => {
  const old = serverChoice([LOCAL_ENTRY, entry("s_1", "too_old")], chat()).options[1];
  assert.deepEqual(old, { id: "s_1", label: "Studio", disabled: true, reason: "Too old: update the server on that machine" });
  const stopped: ServerState[] = ["secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "name_not_known", "not_aiwb", "too_old", "another_server"];
  for (const state of ALL) {
    const o = serverChoice([LOCAL_ENTRY, entry("s_1", state)], chat()).options[1];
    assert.equal(waitsForUser(state), stopped.includes(state), state);
    if (stopped.includes(state)) assert.deepEqual([o.disabled, o.reason], [true, stateLabel(state)], state);
    else if (state === "connected") assert.deepEqual(o, { id: "s_1", label: "Studio" }, state);
    else assert.deepEqual(o, { id: "s_1", label: "Studio", reason: stateLabel(state) }, state); // unreachable, connecting, certificate_not_accepted: it may come back by itself, and can be chosen; its state is shown
  }
});

test("serverChoice: why the server cannot be changed", () => {
  const servers = [LOCAL_ENTRY, entry("s_1", "connected")];
  const fixed = (o: Partial<ChatView>) => serverChoice(servers, chat(o)).fixed;
  assert.equal(fixed({}), "");
  assert.equal(fixed({ server: "s_1" }), "");
  assert.equal(fixed({ board: "b_1" }), "Boards and their chats are on this computer");
  assert.equal(fixed({ run: "r_1" }), "A chat on a run is on the run's server");
  assert.match(fixed({ server: "s_1", start: "unconfirmed" }), /first message may have arrived.*cannot be changed until that is known/);
  for (const o of [{ locked: true }, { forkedFrom: "c_0" }, { branch: "ab12cd34" }, { branches: 2 }]) assert.equal(fixed(o), SERVER_FIXED, JSON.stringify(o));
  // the place comes first: a started chat on a board is still said to be local
  assert.equal(fixed({ board: "b_1", locked: true }), BOARD_LOCAL);
  assert.equal(fixed({ run: "r_1", locked: true }), RUN_SERVER);
  assert.equal(fixed({ start: "unconfirmed", server: "s_1" }), START_UNCONFIRMED);
  assert.equal(serverChoice(servers, chat({ board: "b_1" })).options.length, 2, "the options are listed all the same");
});

test("server_lists: an entry's lists are set, and removed for null", () => {
  const a = withLists({}, "s_1", THERE);
  assert.deepEqual(a, { s_1: THERE });
  const other: ServerLists = { agents: [], catalogs: {}, home: "", defaultCwd: "" };
  const b = withLists(a, "s_2", other);
  assert.deepEqual(b, { s_1: THERE, s_2: other });
  assert.equal(withLists(b, "s_1", other).s_1, other);
  assert.deepEqual(withLists(b, "s_1", null), { s_2: other });
  assert.equal(withLists(a, "s_2", null), a, "nothing to remove: the same map");
  assert.deepEqual(a, { s_1: THERE }, "the map given is not changed");
});

test("a snapshot's lists; a server that sends none has none", () => {
  assert.deepEqual(listsFrom({ lists: { s_1: THERE } }), { s_1: THERE });
  assert.deepEqual(listsFrom({}), {});
  assert.deepEqual(listsFrom({ lists: null }), {});
});

test("a thread's load error keeps the server's code and sentence; it is set and cleared by chat", () => {
  assert.deepEqual(threadError(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), { code: "server_unreachable", message: "Studio is not connected." });
  assert.deepEqual(threadError(new ApiError(404, "This chat is no longer on Studio.", true, "gone_there")), { code: "gone_there", message: "This chat is no longer on Studio." });
  assert.deepEqual(threadError(new ApiError(500, "boom")), { message: "boom" });
  assert.deepEqual(threadError(new Error("asked for branch a, got b")), { message: "asked for branch a, got b" });
  assert.deepEqual(threadError(undefined), { message: "The thread could not be loaded." });
  const e = { code: "server_unreachable", message: "x" };
  const set = withThreadError({}, "c_1", e);
  assert.deepEqual(set, { c_1: e });
  assert.deepEqual(withThreadError(set, "c_1", null), {});
  assert.equal(withThreadError(set, "c_2", null), set, "nothing to clear: the same map");
});

test("server_back: what goes of that server's chats, and what is read again", () => {
  const tree = { current: "main", branches: [], labels: [] } as TreeView;
  const err = { message: "x" };
  const s = {
    chats: { c_1: chat({ id: "c_1", server: "s_1" }), c_2: chat({ id: "c_2", server: "s_1" }), c_3: chat({ id: "c_3", server: "s_2" }), c_4: chat({ id: "c_4" }) },
    sel: { chat: "c_1" as string | null },
    trees: { c_1: tree, c_3: tree, c_4: tree },
    states: { "c_1:main": 1, "c_1:ab12cd34": 2, "c_2:main": 3, "c_3:main": 4, "c_4:main": 5 },
    threadErrors: { c_2: err, c_3: err },
  };
  const back = serverBack(s, "s_1");
  assert.deepEqual(back.chats, ["c_1", "c_2"]);
  assert.deepEqual(back.patch, { trees: { c_3: tree, c_4: tree }, states: { "c_3:main": 4, "c_4:main": 5 }, threadErrors: { c_3: err } });
  assert.equal(back.load, "c_1", "the chat on screen is read again at once");
  assert.equal(Object.keys(s.trees).length, 3, "the state given is not changed");

  assert.equal(serverBack({ ...s, sel: { chat: "c_3" } }, "s_1").load, null, "a chat of another server on screen: nothing is read");
  assert.equal(serverBack({ ...s, sel: { chat: null } }, "s_1").load, null);

  // the local server's own chats are those that name no server
  assert.deepEqual(serverBack(s, LOCAL_SERVER).chats, ["c_4"]);

  // a server with no chat here: nothing changes, and the maps are the same ones
  const none = serverBack(s, "s_9");
  assert.deepEqual(none.chats, []);
  assert.equal(none.patch.trees, s.trees);
  assert.equal(none.patch.states, s.states);
  assert.equal(none.patch.threadErrors, s.threadErrors);
});

test("chat_reload: the chat is read again, and its tree when one is kept", () => {
  const s = { chats: { c_1: chat(), c_2: chat({ id: "c_2" }) }, trees: { c_1: {} } };
  assert.deepEqual(chatReload(s, "c_1"), { refresh: true, tree: true });
  assert.deepEqual(chatReload(s, "c_2"), { refresh: true, tree: false });
  assert.deepEqual(chatReload(s, "c_9"), { refresh: false, tree: false });
  assert.deepEqual(chatReload(s, ""), { refresh: false, tree: false });
});

// ---- a run agent's chat is read by its run's server (Subagents.tsx)

test("serverOfChat: a run agent's view names no server, so its run's is taken; a sidebar chat's is its own", () => {
  const s = { runs: { r_1: { server: "s_1" }, r_2: {} } };
  assert.equal(serverOfChat(s, { run: "r_1" }), "s_1", "a task agent of a run on another server");
  assert.equal(serverOfChat(s, { run: "r_1", server: "s_1" }), "s_1", "the user's chat on that run");
  assert.equal(serverOfChat(s, { run: "r_2" }), "local");
  assert.equal(serverOfChat(s, { run: "r_9" }), "local", "a run the page does not have");
  assert.equal(serverOfChat(s, { server: "s_2" }), "s_2");
  assert.equal(serverOfChat(s, {}), "local");
  assert.equal(serverOfChat({}, undefined), "local");
});

test("a subagent's model is named by the catalog of its chat's server, a run agent's by its run's", () => {
  const src = readFileSync(new URL("../src/Subagents.tsx", import.meta.url), "utf8");
  assert.equal(src.split("const server = useStore((s) => serverOfChat(s, chat));").length, 3, "the row and the drawer");
  assert.equal(src.split("<SubStats sa={sa} items={items} now={now} server={server} />").length, 3);
  assert.doesNotMatch(src, /serverOf\(chat\)/);
  assert.match(src, /const cat = useStore\(\(s\) => catalogFor\(s, server, sa\.kind \?\? ""\)\);/);
});

// ---- what a failed reload after `server_back` takes away (conn.ts dropStale)

test("withoutThread: a list goes with its subagents' threads, a subagent's thread alone; another branch and another chat stay", () => {
  const m = { "c_1:main": 1, "c_1:main/5f": 2, "c_1:main/6a": 3, "c_1:ab12cd34": 4, "c_1:mainline": 5, "c_2:main": 6 };
  assert.deepEqual(Object.keys(withoutThread(m, "c_1:main")), ["c_1:ab12cd34", "c_1:mainline", "c_2:main"]);
  assert.deepEqual(Object.keys(withoutThread(m, "c_1:main/5f")), ["c_1:main", "c_1:main/6a", "c_1:ab12cd34", "c_1:mainline", "c_2:main"]);
  assert.equal(withoutThread(m, "c_3:main"), m, "the map itself when it has none of them");
});
