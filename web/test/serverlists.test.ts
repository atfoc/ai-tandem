// A thing's server and what it offers (src/logic/serverlists.ts): the server its key names, the lists by server,
// why a chat's server is fixed, and the rules of the event `server_lists`, of a section's tree that arrives and of a
// thread's load error. The events through the real event layer are in conn.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_SERVER, SERVER_FINAL, listsFrom, listsOf, offered, RECENT_KEY, sectionBack, sectionName, serverConnected, serverFixed,
  serverName, serverOf, serverState, threadError, withLists, withThreadError, withoutThread } from "../src/logic/serverlists.ts";
import { readFileSync } from "node:fs";
import { LOCAL_ENTRY, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { keyOn } from "../src/logic/keys.ts";
import { ApiError } from "../src/api.ts";
import { LOCAL_SERVER, type AgentKind, type Catalog, type ChatView, type ServerLists, type TreeView } from "../src/types.ts";

const CAT: Catalog = { models: [], default: { model: "m" } };
const THERE: ServerLists = { agents: ["pi"], catalogs: { pi: CAT, claude: null }, home: "/home/u", defaultCwd: "/home/u/work" };
const entry = (id: string, state: ServerState, name = "Studio"): ServerView => ({ id, name, state });
const ALL: ServerState[] = ["connecting", "connected", "unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed",
  "certificate_not_accepted", "name_not_known", "not_aiwb", "too_old", "another_server"];
/** tree: the local server holds the tree of s_1 (a `section` event with a tree came, and none with null since). */
const store = (state: ServerState = "connected", tree = state === "connected") => ({
  usable: ["claude"] as AgentKind[], catalogs: { claude: CAT }, home: "/Users/me", defaultCwd: "/Users/me/code",
  lists: { s_1: THERE }, servers: [LOCAL_ENTRY, entry("s_1", state)], sections: tree ? { s_1: {} } : {},
});
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", locked: false, ...o }) as ChatView;
/** A chat of a section: the same id on another server. */
const far = (server: string, o: Partial<ChatView> = {}) => chat({ id: keyOn(server, "c_1"), ...o });

test("serverOf: the entry id the thing's key names, and this computer for a key that names none", () => {
  assert.equal(serverOf(chat()), LOCAL_SERVER);
  assert.equal(serverOf(far("s_1")), "s_1");
  assert.equal(serverOf({ id: "s_1~c_1" }), "s_1");
  assert.equal(serverOf({ id: "s_2~c_1" }), "s_2", "the same id in another section");
  assert.equal(serverOf({ id: "s_1~__ungrouped__" }), "s_1", "a group's key, and the key of a server's ungrouped area");
  assert.equal(serverOf({ id: "" }), LOCAL_SERVER);
  assert.equal(serverOf({}), LOCAL_SERVER);
  assert.equal(serverOf(undefined), LOCAL_SERVER);
  assert.equal(serverOf(null), LOCAL_SERVER);
  // no field of the thing is read: a view that still carried one is on the server of its key
  assert.equal(serverOf({ id: "c_1", server: "s_1" } as { id: string }), LOCAL_SERVER);
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

test("listsOf keeps another server's lists while it is not connected; offered gives them only while the local server holds its tree", () => {
  for (const state of ALL) for (const tree of [true, false]) {
    const s = store(state, tree);
    assert.equal(listsOf(s, "s_1"), THERE, state);
    assert.equal(offered(s, "s_1"), tree ? THERE : undefined, state);
    assert.equal(serverConnected(s, "s_1"), tree, `${state}: the tree decides, not the entry's state`);
    assert.equal(serverState(s, "s_1"), state, "the state says the words");
    assert.equal(offered(s, LOCAL_SERVER), listsOf(s, LOCAL_SERVER), "the local server always offers");
    assert.equal(serverConnected(s, LOCAL_SERVER), true);
  }
  assert.equal(offered({ ...store(), lists: {} }, "s_1"), undefined); // connected, its lists not here yet
  assert.equal(offered(store(), "s_2"), undefined);                   // no such entry
  assert.equal(serverState(store(), "s_2"), undefined);
  assert.equal(serverState(store(), LOCAL_SERVER), "connected");
  assert.equal(serverConnected(store(), "s_2"), false);
  assert.equal(serverConnected({}, LOCAL_SERVER), true);
  assert.equal(serverConnected({}, "s_1"), false, "a store with no sections");
  assert.equal(serverConnected({ sections: { s_1: {} } }, "s_1"), true, "a tree with nothing in it is a tree");
  assert.equal(serverConnected({ servers: [entry("s_1", "connected")] }, "s_1"), false, "connected, before the `section` event");
});

test("serverName: This computer, or the entry's name", () => {
  assert.equal(serverName(store(), LOCAL_SERVER), "This computer");
  assert.equal(serverName(store(), "s_1"), "Studio");
  assert.equal(serverName({ servers: [{ ...LOCAL_ENTRY, name: "renamed" }] }, LOCAL_SERVER), "This computer");
  assert.equal(serverName(store(), "s_2"), "Unknown server");
  assert.equal(serverName({}, "s_1"), "Unknown server");
});

test("sectionName: the name of the section a thing is in, and none for a thing of this computer", () => {
  assert.equal(sectionName(store(), "s_1~c_1"), "Studio");
  assert.equal(sectionName(store(), "s_1~__ungrouped__"), "Studio");
  assert.equal(sectionName(store("unreachable"), "s_1~c_1"), "Studio", "also while it is not connected");
  assert.equal(sectionName(store(), "s_2~c_1"), "Unknown server", "an entry the list no longer has");
  assert.equal(sectionName(store(), "c_1"), "");
  assert.equal(sectionName(store(), ""), "");
});

test("RECENT_KEY: this computer's recent folders have the one key in the browser; no other server has one", () => {
  assert.equal(RECENT_KEY, "aiwb.dirs");
});

test("serverFixed: a chat's server is never a choice, and its chip says why", () => {
  assert.equal(SERVER_FINAL, "A chat is on the server it was made on");
  assert.equal(BOARD_SERVER, "A chat on a board is on the board's server");
  // unstarted or started, a fork or a branch: the same reason, the chat was made there
  for (const o of [{}, { locked: true }, { forkedFrom: "c_0" }, { branch: "ab12cd34" }, { branches: 2 }] as Partial<ChatView>[]) {
    assert.equal(serverFixed(far("s_1", o)), SERVER_FINAL, JSON.stringify(o));
    assert.equal(serverFixed(chat(o)), SERVER_FINAL, JSON.stringify(o));
  }
  // the place comes first
  assert.equal(serverFixed(far("s_1", { board: "s_1~b_1" })), BOARD_SERVER);
  assert.equal(serverFixed(far("s_1", { board: "s_1~b_1", locked: true })), BOARD_SERVER);
});

test("a chat's server is no choice: the lists hold nothing to choose one with", () => {
  // (the choice of a server for a chat is gone with the question where a chat should live)
  const lists = readFileSync(new URL("../src/logic/serverlists.ts", import.meta.url), "utf8");
  for (const gone of ["serverOptions", "waitsForUser", "serverOfChat", "serverOnBoard", "serverBack", "chatReload"]) assert.ok(!lists.includes(gone), gone);
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
  assert.deepEqual(threadError(new ApiError(404, "chat not found", true, "not_found")), { code: "not_found", message: "chat not found" });
  assert.deepEqual(threadError(new ApiError(500, "boom")), { message: "boom" });
  assert.deepEqual(threadError(new Error("asked for branch a, got b")), { message: "asked for branch a, got b" });
  assert.deepEqual(threadError(undefined), { message: "The thread could not be loaded." });
  const e = { code: "server_unreachable", message: "x" };
  const set = withThreadError({}, "c_1", e);
  assert.deepEqual(set, { c_1: e });
  assert.deepEqual(withThreadError(set, "c_1", null), {});
  assert.equal(withThreadError(set, "c_2", null), set, "nothing to clear: the same map");
});

test("a section's tree arrives: what goes of that server's chats, and what is read again", () => {
  const tree = { current: "main", branches: [], labels: [] } as TreeView;
  const err = { message: "x" };
  // c_1 is a chat of this computer, of s_1 and of s_2: three chats
  const s = {
    chats: { "s_1~c_1": far("s_1"), "s_1~c_2": chat({ id: "s_1~c_2" }), "s_2~c_1": far("s_2"), c_1: chat() },
    gone: {} as Record<string, true>,
    sel: { chat: "s_1~c_1" as string | null },
    trees: { "s_1~c_1": tree, "s_2~c_1": tree, c_1: tree },
    threadErrors: { "s_1~c_2": err, "s_2~c_1": err },
  };
  const back = sectionBack(s, "s_1");
  assert.deepEqual(back.chats, ["s_1~c_1", "s_1~c_2"]);
  assert.deepEqual(back.patch, { trees: { "s_2~c_1": tree, c_1: tree }, threadErrors: { "s_2~c_1": err } });
  assert.equal(back.load, "s_1~c_1", "the chat on screen is read again at once");
  assert.equal(Object.keys(s.trees).length, 3, "the state given is not changed");

  assert.equal(sectionBack({ ...s, sel: { chat: "s_2~c_1" } }, "s_1").load, null, "a chat of another section on screen: nothing is read");
  assert.equal(sectionBack({ ...s, sel: { chat: "c_1" } }, "s_1").load, null, "nor for the local chat with the same id");
  assert.equal(sectionBack({ ...s, sel: { chat: null } }, "s_1").load, null);

  // the local server's own chats are those whose key names no server
  assert.deepEqual(sectionBack(s, LOCAL_SERVER).chats, ["c_1"]);
  assert.deepEqual(sectionBack(s, "s_2").chats, ["s_2~c_1"]);

  // a server with no chat here: nothing changes, and the maps are the same ones
  const none = sectionBack(s, "s_9");
  assert.deepEqual(none.chats, []);
  assert.equal(none.patch.trees, s.trees);
  assert.equal(none.patch.threadErrors, s.threadErrors);
  assert.equal(none.load, null);
  // (the branch records are the new tree's own: the patch names none)
  assert.deepEqual(Object.keys(back.patch).sort(), ["threadErrors", "trees"]);
});

test("a section's tree arrives: a chat that is no longer on that server is none of them, and what the page shows of it stays", () => {
  const tree = { current: "main", branches: [], labels: [] } as TreeView;
  const err = { code: "not_found", message: "chat not found" };
  const s = {
    chats: { "s_1~c_1": far("s_1"), "s_1~c_2": chat({ id: "s_1~c_2" }) },
    gone: { "s_1~c_1": true } as Record<string, true>,
    sel: { chat: "s_1~c_1" as string | null },
    trees: { "s_1~c_1": tree, "s_1~c_2": tree },
    threadErrors: { "s_1~c_1": err },
  };
  const back = sectionBack(s, "s_1");
  assert.deepEqual(back.chats, ["s_1~c_2"]);
  assert.deepEqual(back.patch, { trees: { "s_1~c_1": tree }, threadErrors: s.threadErrors });
  assert.equal(back.patch.threadErrors, s.threadErrors, "its load error stays, with the same map");
  assert.equal(back.load, null, "nothing of it can be read");
  // a state with no `gone` map reads as one where none is gone
  const { gone: _, ...plain } = s;
  assert.deepEqual(sectionBack(plain, "s_1").chats, ["s_1~c_1", "s_1~c_2"]);
  assert.equal(sectionBack(plain, "s_1").load, "s_1~c_1");
});

// ---- a subagent's chat is read by the server its chat's key names (Subagents.tsx)

test("a subagent's model is named by the catalog of its chat's server", () => {
  const src = readFileSync(new URL("../src/Subagents.tsx", import.meta.url), "utf8");
  assert.equal(src.split("const server = serverOf(chat);").length, 3, "the row and the drawer");
  assert.equal(src.split("<SubStats sa={sa} items={items} now={now} server={server} />").length, 3);
  assert.doesNotMatch(src, /serverOfChat/);
  assert.match(src, /const cat = useStore\(\(s\) => catalogFor\(s, server, sa\.kind \?\? ""\)\);/);
});

// ---- what a failed reload after a section's tree arrived takes away (conn.ts dropStale)

test("withoutThread: a list goes with its subagents' threads, a subagent's thread alone; another branch and another chat stay", () => {
  const m = { "c_1:main": 1, "c_1:main/5f": 2, "c_1:main/6a": 3, "c_1:ab12cd34": 4, "c_1:mainline": 5, "c_2:main": 6 };
  assert.deepEqual(Object.keys(withoutThread(m, "c_1:main")), ["c_1:ab12cd34", "c_1:mainline", "c_2:main"]);
  assert.deepEqual(Object.keys(withoutThread(m, "c_1:main/5f")), ["c_1:main", "c_1:main/6a", "c_1:ab12cd34", "c_1:mainline", "c_2:main"]);
  assert.equal(withoutThread(m, "c_3:main"), m, "the map itself when it has none of them");
});
