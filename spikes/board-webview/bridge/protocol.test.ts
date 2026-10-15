// node --test --experimental-strip-types bridge/protocol.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { request, encode, parseRequest, parseFromBoard, ok, fail, MAX_MESSAGE, REQUEST_TYPES } from "./protocol.ts";
import { BoardBridge } from "./client.ts";
import { smallScene } from "../app/scenes.ts";

const rect = { id: "a", type: "rectangle", x: 0, y: 0 };
const good = (type: any, params: any = {}) => encode(request("1", type, params));

test("every request type parses with good params", () => {
  const params: Record<string, any> = {
    loadScene: { scene: smallScene() }, applyChange: { change: { create: [{ type: "rectangle" }], select: [{ key: "k" }] } }, getScene: {}, select: { ids: ["a"] },
    exportPng: { scale: 2 }, flush: {}, setTheme: { theme: "mocha" }, setTool: { tool: "freedraw" }, probeNetwork: { urls: ["http://x"] },
  };
  for (const t of REQUEST_TYPES) assert.equal(parseRequest(good(t, params[t])).ok, true, t);
});

test("what is not a request is refused", () => {
  const no = (raw: unknown, why: RegExp) => { const p = parseRequest(raw); assert.equal(p.ok, false); assert.match((p as any).reason, why); };
  no(5, /not text/);
  no("not json", /not JSON/);
  no("[]", /not an object/);
  no(JSON.stringify({ v: 2, kind: "request", id: "1", type: "flush" }), /version/);
  no(JSON.stringify({ v: 1, kind: "request", id: "1", type: "eval", code: "x" }), /unknown request type/);
  no(JSON.stringify({ v: 1, kind: "request", type: "flush" }), /id/);
  no(JSON.stringify({ v: 1, kind: "event", type: "ready" }), /not a request/);
  no(good("loadScene", { scene: { elements: [{ id: "a" }] } }), /type/);
  no(good("loadScene", { scene: { elements: [{ id: "a", type: "rectangle", x: "0", y: 0 }] } }), /position/);
  no(good("loadScene", { scene: { elements: [rect], appState: { zoom: 2 } } }), /zoom/);
  no(good("applyChange", { change: { create: [1] } }), /non-object/);
  no(good("applyChange", { change: { select: ["a"] } }), /non-ref/);
  no(good("select", { ids: [1] }), /ids/);
  no(good("exportPng", { scale: 99 }), /scale/);
  no(good("setTheme", { theme: "red" }), /theme/);
  no(good("setTool", { tool: "laser" }), /tool/);
  no(encode({ v: 1, kind: "request", id: "1", type: "flush", extra: 1 } as any), /no parameters/);
  no("x".repeat(MAX_MESSAGE + 1), /over/);
});

test("a refused request keeps its id, so the page can answer it", () => {
  const p = parseRequest(JSON.stringify({ v: 1, kind: "request", id: "q7", type: "nope" }));
  assert.equal(p.ok, false);
  assert.equal((p as any).id, "q7");
});

test("the app takes replies and the known events, nothing else", () => {
  assert.equal(parseFromBoard(encode(ok("1", { a: 1 }))).ok, true);
  assert.equal(parseFromBoard(encode(fail("1", "X", "bad"))).ok, true);
  assert.equal(parseFromBoard(encode({ v: 1, kind: "event", type: "selection", ids: ["a"], elements: [{ id: "a", type: "rectangle" }] } as any)).ok, true);
  assert.equal(parseFromBoard(encode({ v: 1, kind: "event", type: "log", level: "info", text: "t" })).ok, true);
  assert.equal(parseFromBoard(encode({ v: 1, kind: "event", type: "sceneChanged", version: 1, flushed: false, elements: 1, scene: { elements: [rect] } })).ok, true);
  for (const m of [
    { v: 1, kind: "event", type: "navigate", url: "x" }, { v: 1, kind: "reply", ok: true, result: 1 }, { v: 1, kind: "reply", id: "1" },
    { v: 1, kind: "event", type: "log", level: "fatal", text: "t" }, { v: 1, kind: "request", id: "1", type: "flush" }, { v: 1, kind: "other" },
    { v: 1, kind: "event", type: "sceneChanged", version: 1, flushed: false, elements: 1, scene: { elements: "x" } },
  ]) assert.equal(parseFromBoard(JSON.stringify(m)).ok, false, JSON.stringify(m));
});

test("the client matches a reply to its request by id and refuses what does not parse", async () => {
  const b = new BoardBridge();
  const sent: string[] = [];
  b.attach((raw) => sent.push(raw));
  const p1 = b.call("flush", {});
  const p2 = b.call("setTheme", { theme: "dark" });
  const [m1, m2] = sent.map((s) => JSON.parse(s));
  b.onMessage("garbage");
  b.onMessage(encode(ok(m2.id, { theme: "dark" })));
  b.onMessage(encode(fail(m1.id, "NO_BOARD", "none")));
  assert.deepEqual(await p2, { theme: "dark" });
  await assert.rejects(p1, /NO_BOARD/);
  assert.equal(b.stats.refused, 1);
  const events: any[] = [];
  b.on((e) => events.push(e));
  b.onMessage(encode({ v: 1, kind: "event", type: "log", level: "info", text: "hi" }));
  assert.equal(events.length, 1);
  await assert.rejects(b.call("flush", {}, 20), /TIMEOUT/);
});
