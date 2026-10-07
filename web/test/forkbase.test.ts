import { test } from "node:test";
import assert from "node:assert/strict";
import { branchCount, currentBranch, shownBranchOf } from "../src/logic/branches.ts";
import { api, ApiError } from "../src/api.ts";
import { MAIN, type ChatView, type PendingMove, type TreeView } from "../src/types.ts";

const view = (p: Partial<ChatView> = {}): ChatView => ({
  id: "c_1", agent: "claude", cwd: "/tmp", model: "m", locked: true, created: "2026-01-01T00:00:00Z",
  usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, status: "ready", ...p,
});
const held = { text: "", mentions: [], references: [] };
const move = (p: Partial<PendingMove> = {}): PendingMove => ({ branch: MAIN, at: 3, new: true, from: MAIN, held, put: null, ...p });

test("a view without the branch fields is one branch, main", () => {
  assert.equal(branchCount(view()), 1);
  assert.equal(currentBranch(view()), "main");
  assert.equal(shownBranchOf(undefined, view()), "main");
});

test("a chat that is not loaded reads as one branch, main", () => {
  assert.equal(branchCount(undefined), 1);
  assert.equal(currentBranch(undefined), "main");
  assert.equal(shownBranchOf(undefined, undefined), "main");
});

test("a split chat tells its branch count and its current branch", () => {
  const c = view({ branches: 3, branch: "a1b2c3d4" });
  assert.equal(branchCount(c), 3);
  assert.equal(currentBranch(c), "a1b2c3d4");
  assert.equal(shownBranchOf(undefined, c), "a1b2c3d4");
});

test("a pending move's branch is the one shown", () => {
  const c = view({ branches: 3, branch: "a1b2c3d4" });
  assert.equal(shownBranchOf(move({ branch: MAIN }), c), "main");
  assert.equal(shownBranchOf(move({ branch: "e5f6a7b8" }), c), "e5f6a7b8");
  assert.equal(shownBranchOf(move({ branch: "a1b2c3d4" }), view()), "a1b2c3d4");
  assert.equal(currentBranch(c), "a1b2c3d4"); // the move does not change the current branch
  // the branch the chat is on here is shown instead of the server's current one, and a move's over both
  assert.equal(shownBranchOf(undefined, c, "e5f6a7b8"), "e5f6a7b8");
  assert.equal(shownBranchOf(undefined, c, MAIN), "main");
  assert.equal(shownBranchOf(move({ branch: MAIN, from: "e5f6a7b8" }), c, "e5f6a7b8"), "main");
});

// The worked example of the tree on the wire (GET /api/chats/<chat id>/tree).
const TREE = `{
  "current": "a1b2c3d4",
  "branches": [
    {"id": "main", "at": 0, "len": 8, "items": [
      {"i": 0, "kind": "user", "text": "ask", "before": 0, "ok": true},
      {"i": 1, "kind": "text", "text": "options", "done": true, "end": 3, "ok": true},
      {"i": 3, "kind": "user", "text": "redis", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "looking", "done": true},
      {"i": 6, "kind": "text", "text": "lua", "done": true, "end": 8, "ok": true}
    ]},
    {"id": "a1b2c3d4", "from": "main", "at": 3, "len": 6, "items": [
      {"i": 3, "kind": "user", "text": "memory", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "map", "done": true, "end": 6}
    ]}
  ],
  "labels": [
    {"branch": "main", "item": 1, "text": "options"},
    {"branch": "a1b2c3d4", "item": 3, "text": "mem"}
  ]
}`;

test("the worked example reads as a TreeView", () => {
  const t: TreeView = JSON.parse(TREE);
  assert.equal(t.current, "a1b2c3d4");
  assert.deepEqual(t.branches.map((b) => b.id), [MAIN, "a1b2c3d4"]);
  const [main, br] = t.branches;
  assert.equal(main.from, undefined);
  assert.deepEqual([main.at, main.len], [0, 8]);
  assert.deepEqual([br.from, br.at, br.len], ["main", 3, 6]);
  assert.deepEqual(main.items.map((x) => x.i), [0, 1, 3, 4, 6]); // the tool call and the end marks are not sent
  assert.deepEqual(br.items.map((x) => x.i), [3, 4]);            // only its own part
  assert.equal(main.items[0].before, 0);
  assert.equal(main.items[0].ok, true);
  assert.equal(main.items[1].end, 3);
  assert.equal(main.items[3].end, undefined);
  assert.equal(br.items[1].ok, undefined);
  assert.deepEqual(t.labels, [{ branch: "main", item: 1, text: "options" }, { branch: "a1b2c3d4", item: 3, text: "mem" }]);
});

// ---- the API calls, against a fetch that records what it is asked

type Req = { method: string; path: string; body: unknown };
async function asked(run: () => Promise<unknown>, answer: unknown = { ok: true }): Promise<Req> {
  const real = globalThis.fetch;
  let req: Req | undefined;
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    req = { method: init.method ?? "GET", path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = real; }
  return req!;
}

test("send without a target sends today's body", async () => {
  const refs = [{ quote: "q", item: 1, start: 0, end: 1 }];
  assert.deepEqual(await asked(() => api.send("c_1", "main", "hi", "ctx")),
    { method: "POST", path: "/api/chats/c_1/messages?branch=main", body: { text: "hi", context: "ctx" } });
  assert.deepEqual(await asked(() => api.send("c_1", "a1b2c3d4", "hi", "ctx", [])),
    { method: "POST", path: "/api/chats/c_1/messages?branch=a1b2c3d4", body: { text: "hi", context: "ctx" } });
  assert.deepEqual((await asked(() => api.send("c_1", "main", "hi", "ctx", refs))).body, { text: "hi", context: "ctx", references: refs });
});

test("send with a target adds only the target's branch, at and new", async () => {
  assert.deepEqual(await asked(() => api.send("c_1", "main", "hi", "ctx", [], { branch: "main", at: 3, new: true })),
    { method: "POST", path: "/api/chats/c_1/messages", body: { text: "hi", context: "ctx", target: { branch: "main", at: 3, new: true } } });
  // a pending move is a Target with more on it
  assert.deepEqual(await asked(() => api.send("c_1", "a1b2c3d4", "hi", "", [], move({ branch: "a1b2c3d4", at: 6, new: false }))),
    { method: "POST", path: "/api/chats/c_1/messages", body: { text: "hi", context: "", target: { branch: "a1b2c3d4", at: 6, new: false } } });
});

test("the calls that take a server name it by its entry id, and not at all for this computer", async () => {
  const dirs = { path: "/w", parent: "/", dirs: [], git: false };
  const calls: [string, () => Promise<unknown>, string, string][] = [
    ["dirs", () => api.dirs("/w x"), "GET", "/api/dirs?path=%2Fw%20x"],
    ["dirs local", () => api.dirs("/w", "local"), "GET", "/api/dirs?path=%2Fw"],
    ["dirs there", () => api.dirs("/w", "s_1"), "GET", "/api/dirs?path=%2Fw&server=s_1"],
    ["usage", () => api.usage("claude"), "GET", "/api/usage/claude"],
    ["usage fresh", () => api.usage("claude", true), "GET", "/api/usage/claude?fresh=1"],
    ["usage local", () => api.usage("claude", false, "local"), "GET", "/api/usage/claude"],
    ["usage there", () => api.usage("claude", false, "s_1"), "GET", "/api/usage/claude?server=s_1"],
    ["usage fresh there", () => api.usage("claude", true, "s_1"), "GET", "/api/usage/claude?fresh=1&server=s_1"],
    ["deleteChat", () => api.deleteChat("c_1"), "DELETE", "/api/chats/c_1"],
    ["deleteChat here only", () => api.deleteChat("c_1", { local: true }), "DELETE", "/api/chats/c_1?local=1"],
    ["deleteChat not here only", () => api.deleteChat("c_1", { local: false }), "DELETE", "/api/chats/c_1"],
  ];
  for (const [name, run, method, path] of calls) {
    const r = await asked(run, dirs);
    assert.deepEqual([r.method, r.path], [method, path], name);
  }
  assert.deepEqual(await asked(() => api.configure("c_1", "main", { server: "s_1" })), { method: "PATCH", path: "/api/chats/c_1?branch=main", body: { server: "s_1" } });
  assert.deepEqual((await asked(() => api.newChat({ group: "g_1", server: "s_1" }))).body, { group: "g_1", server: "s_1" });
  assert.deepEqual((await asked(() => api.newChat({ group: "g_1" }))).body, { group: "g_1" });
});

test("items and subItems ask for the branch they are given", async () => {
  const items = { version: 1, items: [] };
  assert.equal((await asked(() => api.items("c_1", "main"), items)).path, "/api/chats/c_1/items?branch=main");
  assert.equal((await asked(() => api.items("c_1", "a1b2c3d4"), items)).path, "/api/chats/c_1/items?branch=a1b2c3d4");
  assert.equal((await asked(() => api.subItems("c_1", "main", "s1"), items)).path, "/api/chats/c_1/subagents/s1/items?branch=main");
  assert.equal((await asked(() => api.subItems("c_1", "a1b2c3d4", "s1"), items)).path, "/api/chats/c_1/subagents/s1/items?branch=a1b2c3d4");
});

test("every session call names its branch in the query; a send with a target names it in the target only", async () => {
  const B = "a1b2c3d4", items = { version: 1, items: [] }, draft = { text: "d" };
  const calls: [string, () => Promise<unknown>, string, string, unknown?][] = [
    ["items", () => api.items("c_1", B), "GET", `/api/chats/c_1/items?branch=${B}`, items],
    ["subItems", () => api.subItems("c_1", B, "s1"), "GET", `/api/chats/c_1/subagents/s1/items?branch=${B}`, items],
    ["openChat", () => api.openChat("c_1", B), "POST", `/api/chats/c_1/open?branch=${B}`],
    ["send", () => api.send("c_1", B, "hi", ""), "POST", `/api/chats/c_1/messages?branch=${B}`],
    ["configure", () => api.configure("c_1", B, { model: "m" }), "PATCH", `/api/chats/c_1?branch=${B}`],
    ["saveDraft", () => api.saveDraft("c_1", B, draft, 3), "PUT", `/api/chats/c_1/draft?branch=${B}&rev=3`],
    ["interrupt", () => api.interrupt("c_1", B), "POST", `/api/chats/c_1/interrupt?branch=${B}`],
    ["decide", () => api.decide("c_1", B, { requestId: "r1", allow: true }), "POST", `/api/chats/c_1/permission?branch=${B}`],
    ["contextSplit", () => api.contextSplit("c_1", B), "GET", `/api/chats/c_1/context?branch=${B}`],
    ["contextSplit fresh", () => api.contextSplit("c_1", B, true), "GET", `/api/chats/c_1/context?branch=${B}&fresh=1`],
    ["send with a target", () => api.send("c_1", B, "hi", "", [], { branch: B, at: 2, new: true }), "POST", "/api/chats/c_1/messages"],
  ];
  for (const [name, run, method, path, answer] of calls) {
    const r = await asked(run, answer ?? { ok: true });
    assert.deepEqual([r.method, r.path], [method, path], name);
  }
  // the bodies stay as they were: the branch is in the query alone
  assert.deepEqual((await asked(() => api.configure("c_1", B, { model: "m" }))).body, { model: "m" });
  assert.deepEqual((await asked(() => api.saveDraft("c_1", B, draft, 0))).body, draft);
  assert.deepEqual((await asked(() => api.decide("c_1", B, { requestId: "r1", allow: true }))).body, { requestId: "r1", allow: true });
  assert.equal((await asked(() => api.items("c_1", "a b"), items)).path, "/api/chats/c_1/items?branch=a%20b"); // escaped
});

test("saveDraft names its base and answers the new counter; a stale refusal is an ApiError with the server's counter and draft", async () => {
  const answer = (status: number, body: unknown) => async (run: () => Promise<unknown>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    try { return await run(); } finally { globalThis.fetch = real; }
  };
  assert.equal(await answer(200, { ok: true, rev: 5 })(() => api.saveDraft("c_1", "main", { text: "d" }, 4)), 5);
  for (const stored of [{ text: "theirs" }, null]) {
    const e = await answer(409, { error: "the draft was changed elsewhere", code: "stale", rev: 7, draft: stored })(() => api.saveDraft("c_1", "main", { text: "d" }, 4).catch((x) => x));
    assert.ok(e instanceof ApiError);
    assert.deepEqual([e.status, e.code, e.rev, e.draft, e.message], [409, "stale", 7, stored, "the draft was changed elsewhere"]);
  }
});

test("tree, label and fork use their routes", async () => {
  assert.deepEqual(await asked(() => api.tree("c_1"), JSON.parse(TREE)), { method: "GET", path: "/api/chats/c_1/tree", body: undefined });
  assert.deepEqual(await asked(() => api.setLabel("c_1", "main", 1, "options"), { labels: [] }),
    { method: "PUT", path: "/api/chats/c_1/label", body: { branch: "main", item: 1, text: "options" } });
  assert.deepEqual(await asked(() => api.fork("c_1", "main", 3, 3), view()),
    { method: "POST", path: "/api/chats/c_1/fork", body: { branch: "main", at: 3, message: 3 } });
  assert.deepEqual((await asked(() => api.fork("c_1", "main", 3), view())).body, { branch: "main", at: 3 });
});
