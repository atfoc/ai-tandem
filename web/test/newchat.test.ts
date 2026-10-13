// "+" makes a chat without naming an agent: the body api.newChat posts (src/api.ts with a stubbed
// global fetch), and the places that make a chat, read as source (the unit tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "../src/api.ts";

const calls: { path: string; method?: string; body: unknown }[] = [];
let answer: Record<string, unknown> = { id: "c_1", agent: "claude" };
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; answer = { id: "c_1", agent: "claude" }; });

for (const where of [{ group: "g_1" }, { group: "__ungrouped__" }, { board: "b_1" }, { run: "r_1" }]) {
  test(`api.newChat posts ${JSON.stringify(where)} alone, with no agent`, async () => {
    const c = await api.newChat(where);
    assert.equal(c.id, "c_1");
    assert.deepEqual([calls[0].path, calls[0].method], ["/api/chats", "POST"]);
    assert.deepEqual(calls[0].body, where);
    assert.ok(!("agent" in (calls[0].body as object)));
  });
}

// Where a chat is made decides where it lives: the place's key names the server, and no body names one.
for (const [where, path, body] of [
  [{ group: "s_1~g_1" }, "/api/on/s_1/chats", { group: "g_1" }],
  [{ group: "s_1~__ungrouped__" }, "/api/on/s_1/chats", { group: "__ungrouped__" }],
  [{ board: "s_1~b_1" }, "/api/on/s_1/chats", { board: "b_1" }],
  [{ run: "s_1~r_1" }, "/api/on/s_1/chats", { run: "r_1" }],
  [{ group: "s_2~g_1" }, "/api/on/s_2/chats", { group: "g_1" }],
] as const) {
  test(`api.newChat in a section posts ${JSON.stringify(where)} to ${path}, with that server's own id in the body`, async () => {
    await api.newChat(where);
    assert.deepEqual(calls.map((c) => [c.path, c.method, c.body]), [[path, "POST", body]]);
    assert.ok(!("server" in (calls[0].body as object)) && !("agent" in (calls[0].body as object)));
  });
}

test("api.newChat answers a section's chat with the page's keys: its own, its group's, its board's and its run's", async () => {
  answer = { id: "c_1", agent: "claude", group: "g_1" };
  assert.deepEqual(await api.newChat({ group: "s_1~g_1" }), { id: "s_1~c_1", agent: "claude", group: "s_1~g_1" });
  answer = { id: "c_1", agent: "claude", group: "g_1", board: "b_1" };
  assert.deepEqual(await api.newChat({ board: "s_1~b_1" }), { id: "s_1~c_1", agent: "claude", group: "s_1~g_1", board: "s_1~b_1" });
  answer = { id: "c_1", agent: "claude", run: "r_1" };
  assert.deepEqual(await api.newChat({ run: "s_1~r_1" }), { id: "s_1~c_1", agent: "claude", run: "s_1~r_1" });
  // a chat of this computer comes as it is: the same id is another chat
  answer = { id: "c_1", agent: "claude", group: "g_1" };
  assert.deepEqual(await api.newChat({ group: "g_1" }), { id: "c_1", agent: "claude", group: "g_1" });
});

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

test("the places that make a chat have no agent menu and name no agent", () => {
  const files = { "Sidebar.tsx": src("Sidebar.tsx"), "App.tsx": src("App.tsx"), "run/RunBar.tsx": src("run/RunBar.tsx") };
  for (const [f, text] of Object.entries(files)) {
    assert.ok(!text.includes("AgentItems"), `${f} has AgentItems`);
    assert.ok(!/newChat\(\s*["'`a]\s*[,"'`]/.test(text) && !text.includes('newChat("'), `${f} gives newChat an agent`);
    assert.ok(!text.includes("AGENT_ORDER"), `${f} lists the agents`);
  }
  // the eight places: the top "+", a section's "+", a group's "+", a board row's, a run row's, the board bar, the run bar, the empty state
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: loose \}\)/g), 1); // a section's head: outside any group, on that server
  assert.ok(files["Sidebar.tsx"].includes("const loose = ungroupedOn(v.id);"));
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: g\.id \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ board: b\.id \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ run: r\.id \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ board \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files["run/RunBar.tsx"], /void newChat\(\{ run \}\)/g), 1);
  // and ⌘N, which makes one where the user is, if that place offers one (logic/newchatwhere.ts)
  assert.equal(count(files["App.tsx"], /const where = newChatPlace\(\{[^\n]*\}\);\s*if \(where\) void newChat\(where\);/g), 1);
  assert.equal(count(Object.values(files).join("\n"), /\bnewChat\(/g), 8 + 1 + 2); // and the function with its api call
  // no place asks where the chat should live, and none names a server: the place's key says it
  for (const [f, text] of Object.entries(files)) assert.ok(!/newChat\(\{[^}]*server/.test(text) && !text.includes("BoardChoice") && !text.includes("Where should this live"), f);
});

test("the two menus still offer a chat, a whiteboard and a run", () => {
  const side = src("Sidebar.tsx");
  for (const label of ["<ChatIcon /> New chat<", "<BoardIcon /> New whiteboard<", "<RunIcon /> New run<", "<GroupIcon /> New group<"]) assert.ok(side.includes(label), label);
  for (const label of ["<ChatIcon /> Chat<", "<BoardIcon /> Whiteboard<", "<RunIcon /> Run<", "<GroupIcon /> Group<"]) assert.ok(side.includes(label), label);
  const home = src("App.tsx");
  for (const label of ["New chat<", "New whiteboard<", "New run<", "homeAgentsText("]) assert.ok(home.includes(label), label);
  assert.ok(!home.includes("Claude Code, Cursor or pi"), "the empty state names fixed agents");
});

test("the draft run's agent picker lists the usable agents", () => {
  const text = src("run/RunComposer.tsx");
  assert.ok(text.includes("agentChoiceOn(w, usable, r.agent)") && text.includes("usableAgents(s, w.server)"));
  assert.ok(!text.includes("AGENT_ORDER"));
  assert.ok(text.includes("No agent"));
});
