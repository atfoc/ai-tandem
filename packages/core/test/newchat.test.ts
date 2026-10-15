// "+" makes a chat without naming an agent: the body api.newChat posts (src/api.ts through a fake
// transport), and the places that make a chat, read as source (the unit tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
