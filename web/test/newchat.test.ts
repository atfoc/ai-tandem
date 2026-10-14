// "+" makes a chat without naming an agent: the body api.newChat posts (src/api.ts through a fake
// transport), and the places that make a chat, read as source (the unit tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "../src/api.ts";
import { installFake, ok } from "./fixtures/faketransport.ts";

const fake = installFake();
const calls = fake.calls;
let answer: Record<string, unknown> = { id: "c_1", agent: "claude" };
fake.handler = () => ok(answer);
beforeEach(() => { fake.reset(); answer = { id: "c_1", agent: "claude" }; });

for (const where of [{ group: "g_1" }, { group: "__ungrouped__" }, { board: "b_1" }]) {
  test(`api.newChat posts ${JSON.stringify(where)} alone, with no agent`, async () => {
    const c = await api.newChat(where);
    assert.equal(c.id, "c_1");
    assert.deepEqual([calls[0].server, calls[0].path, calls[0].method], ["local", "/api/chats", "POST"]);
    assert.deepEqual(calls[0].body, where);
    assert.ok(!("agent" in (calls[0].body as object)));
  });
}

// Where a chat is made decides where it lives: the place's key names the server, and no body names one.
for (const [where, server, body] of [
  [{ group: "s_1~g_1" }, "s_1", { group: "g_1" }],
  [{ group: "s_1~__ungrouped__" }, "s_1", { group: "__ungrouped__" }],
  [{ board: "s_1~b_1" }, "s_1", { board: "b_1" }],
  [{ group: "s_2~g_1" }, "s_2", { group: "g_1" }],
] as const) {
  test(`api.newChat in a section posts ${JSON.stringify(where)} to the server ${server}, with that server's own id in the body`, async () => {
    await api.newChat(where);
    assert.deepEqual(calls.map((c) => [c.server, c.path, c.method, c.body]), [[server, "/api/chats", "POST", body]]);
    assert.ok(!("server" in (calls[0].body as object)) && !("agent" in (calls[0].body as object)));
  });
}

test("api.newChat answers a section's chat with the page's keys: its own, its group's and its board's", async () => {
  answer = { id: "c_1", agent: "claude", group: "g_1" };
  assert.deepEqual(await api.newChat({ group: "s_1~g_1" }), { id: "s_1~c_1", agent: "claude", group: "s_1~g_1" });
  answer = { id: "c_1", agent: "claude", group: "g_1", board: "b_1" };
  assert.deepEqual(await api.newChat({ board: "s_1~b_1" }), { id: "s_1~c_1", agent: "claude", group: "s_1~g_1", board: "s_1~b_1" });
  // a chat of this computer comes as it is: the same id is another chat
  answer = { id: "c_1", agent: "claude", group: "g_1" };
  assert.deepEqual(await api.newChat({ group: "g_1" }), { id: "c_1", agent: "claude", group: "g_1" });
});

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

test("the places that make a chat have no agent menu and name no agent", () => {
  const files = { "Sidebar.tsx": src("Sidebar.tsx"), "App.tsx": src("App.tsx") };
  for (const [f, text] of Object.entries(files)) {
    assert.ok(!text.includes("AgentItems"), `${f} has AgentItems`);
    assert.ok(!/newChat\(\s*["'`a]\s*[,"'`]/.test(text) && !text.includes('newChat("'), `${f} gives newChat an agent`);
    assert.ok(!text.includes("AGENT_ORDER"), `${f} lists the agents`);
  }
  // the six places: the top "+", a section's "+", a group's "+", a board row's, the board bar, the empty state
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: loose \}\)/g), 1); // a section's head: outside any group, on that server
  assert.ok(files["Sidebar.tsx"].includes("const loose = ungroupedOn(v.id);"));
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: g\.id \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ board: b\.id \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ board \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  // and ⌘N, which makes one where the user is, if that place offers one (logic/newchatwhere.ts)
  assert.equal(count(files["App.tsx"], /const where = newChatPlace\(\{[^\n]*\}\);\s*if \(where\) void newChat\(where\);/g), 1);
  assert.equal(count(Object.values(files).join("\n"), /\bnewChat\(/g), 6 + 1 + 2); // and the function with its api call
  // no place asks where the chat should live, and none names a server: the place's key says it
  for (const [f, text] of Object.entries(files)) assert.ok(!/newChat\(\{[^}]*server/.test(text) && !text.includes("BoardChoice") && !text.includes("Where should this live"), f);
});

test("the two menus still offer a chat and a whiteboard", () => {
  const side = src("Sidebar.tsx");
  for (const label of ["<ChatIcon /> New chat<", "<BoardIcon /> New whiteboard<", "<GroupIcon /> New group<"]) assert.ok(side.includes(label), label);
  for (const label of ["<ChatIcon /> Chat<", "<BoardIcon /> Whiteboard<", "<GroupIcon /> Group<"]) assert.ok(side.includes(label), label);
  const home = src("App.tsx");
  for (const label of ["New chat<", "New whiteboard<", "homeAgentsText("]) assert.ok(home.includes(label), label);
  assert.ok(!home.includes("Claude Code, Cursor or pi"), "the empty state names fixed agents");
});
