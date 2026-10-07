// "+" makes a chat without naming an agent: the body api.newChat posts (src/api.ts with a stubbed
// global fetch), and the places that make a chat, read as source (the unit tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "../src/api.ts";

const calls: { path: string; method?: string; body: unknown }[] = [];
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify({ id: "c_1", agent: "claude" }), { status: 200 });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; });

for (const where of [{ group: "g_1" }, { group: "__ungrouped__" }, { board: "b_1" }, { run: "r_1" }]) {
  test(`api.newChat posts ${JSON.stringify(where)} alone, with no agent`, async () => {
    const c = await api.newChat(where);
    assert.equal(c.id, "c_1");
    assert.deepEqual([calls[0].path, calls[0].method], ["/api/chats", "POST"]);
    assert.deepEqual(calls[0].body, where);
    assert.ok(!("agent" in (calls[0].body as object)));
  });
}

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

test("the places that make a chat have no agent menu and name no agent", () => {
  const files = { "Sidebar.tsx": src("Sidebar.tsx"), "App.tsx": src("App.tsx"), "run/RunBar.tsx": src("run/RunBar.tsx") };
  for (const [f, text] of Object.entries(files)) {
    assert.ok(!text.includes("AgentItems"), `${f} has AgentItems`);
    assert.ok(!/newChat\(\s*["'`a]\s*[,"'`]/.test(text) && !text.includes('newChat("'), `${f} gives newChat an agent`);
    assert.ok(!text.includes("AGENT_ORDER"), `${f} lists the agents`);
  }
  // the seven places: the top "+", a group's "+", a board row's, a run row's, the board bar, the run bar, the empty state
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ group: g\.id \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ board: b\.id \}\)/g), 1);
  assert.equal(count(files["Sidebar.tsx"], /void newChat\(\{ run: r\.id \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ board \}\)/g), 1);
  assert.equal(count(files["App.tsx"], /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files["run/RunBar.tsx"], /void newChat\(\{ run \}\)/g), 1);
  assert.equal(count(Object.values(files).join("\n"), /\bnewChat\(/g), 7 + 2); // and the function with its api call
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
