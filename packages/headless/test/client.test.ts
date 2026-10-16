// The writer over the real connection module (@aiwb/conn: pinned TLS, HTTP/2, the in-memory list) against the stand-in server of
// that package's tests: the configuration line is enough to connect, the headers are those of an app, a call is answered with the
// order the server needs, and the one stream is never opened again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { createClient } from "@aiwb/conn";
import { nodeConnector } from "@aiwb/conn/node";
import { memStore } from "../src/memstore.ts";
import { run } from "../src/main.ts";
import { fakeEngine, resetStore, until, wait } from "./support.ts";

const require = createRequire(import.meta.url);
const { standin, SNAPSHOT_BODY } = require("../../conn/test/standin.js");
const { FAST } = require("../../conn/test/fakes/support.js");

const quiet = console.error;
after(() => { console.error = quiet; });

const SECRET = "secret-one";
const CLIENT_ID = "6f1f1c3e-8a4b-4c55-9d0e-2b7a8c9d0e1f";

test("it connects from its configuration line alone, writes before it replies, and does not open a second stream", async () => {
  resetStore();
  const s = await standin({ secret: SECRET, snapshot: { ...SNAPSHOT_BODY, boards: [{ id: "b1", name: "Board", group: "" }] } });
  const scene = { type: "excalidraw", version: 2, elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1 }], appState: {}, files: {} };
  s.routes.set("GET /api/boards/b1/scene", () => ({ json: scene, headers: { "x-aiwb-scene-rev": "3" } }));
  s.routes.set("PUT /api/boards/b1/scene", () => ({ json: { rev: 4 } }));
  s.routes.set("POST /api/rpc-reply", () => ({ json: { ok: true } }));
  const stdin = new PassThrough();
  const exits: number[] = [];
  const err: string[] = [];
  console.error = () => {};
  const done = run({
    stdin, stderr: (l) => err.push(l), exit: (c) => exits.push(c), env: {}, assets: "unused",
    engine: { create: fakeEngine().create }, startLimitMs: 10_000, flushLimitMs: 500,
    makeClient: (entry, clientId, log) => createClient({ connector: nodeConnector(), store: memStore(entry, clientId), local: null, timing: FAST, log }),
  });
  stdin.write(JSON.stringify({
    address: `127.0.0.1:${s.port}`, fingerprint: s.fingerprint, secret: SECRET, clientId: CLIENT_ID, instanceId: s.instanceId,
    quietMs: 60_000, handoverMs: 2000, version: "dev",
  }) + "\n");
  try {
    await s.waitStreams(1);
    await wait(50);
    s.emit({ type: "held", board: "b1", rev: 3 });
    s.emit({ type: "rpc", id: "r1", method: "tool", params: { chat: "c1", branch: "main", board: "b1", target: "b1", name: "apply", args: { create: [{ type: "rectangle", key: "x" }] } } });
    await until(() => s.requests.some((q: any) => q.path === "/api/rpc-reply"), "the reply");
    const mine = s.requests.filter((q: any) => q.path.startsWith("/api/boards/") || q.path === "/api/rpc-reply").map((q: any) => `${q.method} ${q.path}`);
    assert.deepEqual(mine, ["GET /api/boards/b1/scene", "PUT /api/boards/b1/scene?rev=3", "POST /api/rpc-reply"]);
    const reply = JSON.parse(s.requests.find((q: any) => q.path === "/api/rpc-reply").body.toString());
    assert.equal(reply.id, "r1");
    assert.equal(reply.error, undefined);
    assert.deepEqual(Object.keys(JSON.parse(reply.result).created), ["x"]);
    const put = JSON.parse(s.requests.find((q: any) => q.method === "PUT").body.toString());
    assert.equal(put.elements.length, 2);
    // it is an app to the server: its secret, its own client id and a level
    for (const q of s.requests.filter((q: any) => q.path.startsWith("/api/boards/"))) {
      assert.equal(q.headers["x-aiwb-secret"], SECRET);
      assert.equal(q.headers["x-aiwb-client"], CLIENT_ID);
      assert.ok(Number(q.headers["x-aiwb-level"]) >= 6);
    }
    // the stream ends: the process ends, and the connection does not open a new stream
    s.endStreams();
    await done;
    assert.deepEqual(exits, [0]);
    assert.ok(err.some((l) => /the connection to the server ended/.test(l)), err.join("\n"));
    await wait(300);
    assert.equal(s.streamsOpened, 1);
    assert.ok(err.every((l) => !l.includes(SECRET)));
  } finally {
    stdin.end();
    await s.close();
  }
});

test("a wrong secret ends the start with the connection's own reason", async () => {
  resetStore();
  const s = await standin({ secret: "another-secret" });
  const stdin = new PassThrough();
  const exits: number[] = [], err: string[] = [];
  const done = run({
    stdin, stderr: (l) => err.push(l), exit: (c) => exits.push(c), env: {}, assets: "unused",
    engine: { create: fakeEngine().create }, startLimitMs: 10_000, flushLimitMs: 500,
    makeClient: (entry, clientId, log) => createClient({ connector: nodeConnector(), store: memStore(entry, clientId), local: null, timing: FAST, log }),
  });
  stdin.write(JSON.stringify({ address: s.address, fingerprint: s.fingerprint, secret: SECRET, clientId: CLIENT_ID, instanceId: s.instanceId }) + "\n");
  try {
    await done;
    assert.deepEqual(exits, [3]);
    assert.ok(err.some((l) => l.startsWith("cannot connect to the server: secret_not_accepted")), err.join("\n"));
    assert.ok(err.every((l) => !l.includes(SECRET)));
  } finally {
    stdin.end();
    await s.close();
  }
});
