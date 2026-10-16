// The process around the loop: its configuration on stdin, its start (the engine, then the connection, within the limit), its end
// (stdin, the stream), and that the secret is in no line it prints.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseConfig, entryOf, redact, holdOf, run, EXIT_START_FAILED, type Config, type Deps } from "../src/main.ts";
import { FakeServer, fakeEngine, resetStore, until, wait } from "./support.ts";

const quiet = console.error;
after(() => { console.error = quiet; });

const SECRET = "s3cr3t-Value-0123456789";
const CONFIG = {
  address: "127.0.0.1:4749", fingerprint: "AA:BB", secret: SECRET, clientId: "6f1f1c3e-8a4b-4c55-9d0e-2b7a8c9d0e1f",
  instanceId: "0b0c7f0e-2a3b-4c4d-8e5f-6a7b8c9d0e1f", quietMs: 60_000, handoverMs: 2000, version: "dev",
};

test("parseConfig reads the line, adds https to the address, and defaults the waits", () => {
  const c = parseConfig(JSON.stringify({ ...CONFIG, quietMs: undefined, handoverMs: undefined }));
  assert.equal(c.address, "https://127.0.0.1:4749");
  assert.equal(c.quietMs, 60_000);
  assert.equal(c.handoverMs, 8_000);
  assert.equal(parseConfig(JSON.stringify({ ...CONFIG, address: "https://host:1" })).address, "https://host:1");
});

test("parseConfig refuses a bad line and never quotes it", () => {
  for (const bad of ["not json", "[]", JSON.stringify({ ...CONFIG, clientId: "nope" }), JSON.stringify({ ...CONFIG, fingerprint: "" }),
    JSON.stringify({ ...CONFIG, quietMs: "soon" }), JSON.stringify({ ...CONFIG, secret: undefined })]) {
    assert.throws(() => parseConfig(bad), (e: Error) => !e.message.includes(SECRET), bad);
  }
});

test("entryOf pins the certificate and keeps the secret in the entry only", () => {
  const e = entryOf(parseConfig(JSON.stringify(CONFIG)), (n) => Buffer.alloc(n, 0xab));
  assert.deepEqual(e, { id: "s_abababababab", name: "AI Whiteboard", address: "https://127.0.0.1:4749", secret: SECRET, selfSigned: true, pin: "AA:BB", instanceId: CONFIG.instanceId });
});

test("redact takes the secret out of a line", () => {
  assert.equal(redact(`a ${SECRET} b ${SECRET}`, SECRET), "a *** b ***");
  assert.equal(redact("nothing", ""), "nothing");
});

type Harness = { stdin: PassThrough; err: string[]; exits: number[]; server: FakeServer; deps: Deps; fake: ReturnType<typeof fakeEngine>; made: Config[]; done: Promise<void> };

function harness(o: Partial<Deps> & { config?: unknown; noConfig?: boolean; fakeEngine?: boolean } = {}): Harness {
  resetStore();
  const stdin = new PassThrough();
  const err: string[] = [], exits: number[] = [];
  const server = new FakeServer();
  const fake = fakeEngine();
  const made: Config[] = [];
  const closeLog = () => server.log.push("client closed");
  const deps: Deps = {
    stdin, stderr: (l) => err.push(l), exit: (c) => { exits.push(c); server.log.push(`exit ${c}`); }, env: {}, assets: "unused",
    makeClient: (entry, clientId, log) => {
      server.serverId = entry.id;
      made.push({ ...CONFIG, secret: entry.secret, clientId } as Config);
      log(`dialing ${entry.address} with ${entry.secret}`); // (a log line of the connection module that quotes the secret)
      return Object.assign(server, { close: async () => closeLog() }) as any;
    },
    engine: o.fakeEngine === false ? {} : { create: fake.create },
    startLimitMs: 3000, flushLimitMs: 1000, captureConsole: false,
    ...o,
  };
  if (!o.noConfig) stdin.write(JSON.stringify(o.config ?? CONFIG) + "\n");
  return { stdin, err, exits, server, deps, fake, made, done: run(deps) };
}

test("with no engine folder, it prints why and exits 3 before it connects", async () => {
  const h = harness({ fakeEngine: false });
  await h.done;
  assert.deepEqual(h.exits, [EXIT_START_FAILED]);
  assert.ok(h.err.some((l) => /^cannot start the board engine: the engine's folder .*unused does not exist$/.test(l)), h.err.join("\n"));
  assert.equal(h.made.length, 0, "it did not connect");
  assert.ok(h.err.every((l) => !l.includes(SECRET)));
});

test("no configuration, or a bad one: exit 3 and no secret in any line", async () => {
  const none = harness({ noConfig: true });
  none.stdin.end();
  await none.done;
  assert.deepEqual(none.exits, [3]);
  assert.deepEqual(none.err, ["no configuration on stdin"]);
  const bad = harness({ config: { ...CONFIG, clientId: "nope" } });
  await bad.done;
  assert.deepEqual(bad.exits, [3]);
  assert.ok(bad.err.every((l) => !l.includes(SECRET)), bad.err.join("\n"));
});

test("a first connection that does not come within the limit: exit 3 with the state it was in", async () => {
  const h = harness({ startLimitMs: 150 });
  await h.done; // (the fake never opens)
  assert.deepEqual(h.exits, [3]);
  assert.ok(h.err.some((l) => l.startsWith("cannot connect to the server: connecting")), h.err.join("\n"));
  assert.ok(h.server.log.includes("client closed"));
});

test("a connection that is refused names why", async () => {
  const h = harness({ startLimitMs: 60_000 }); // (not waited for)
  await until(() => h.made.length === 1 && h.server.subscribed === 1, "the client");
  h.server.state("secret_not_accepted", "The server did not accept the secret");
  await h.done;
  assert.deepEqual(h.exits, [3]);
  assert.ok(h.err.some((l) => l.includes("secret_not_accepted") && l.includes("The server did not accept the secret")), h.err.join("\n"));
});

async function connected(h: Harness) {
  await until(() => h.made.length === 1 && h.server.subscribed === 1, "the loop");
  h.server.open();
  await wait(5);
}

test("the end of stdin saves what waits and exits 0", async () => {
  const h = harness();
  await connected(h);
  h.server.scenes.set("b1", { scene: { elements: [], appState: {}, files: {} }, rev: 3 });
  h.server.held("b1", 3);
  let fail = true;
  h.server.routes.set("PUT /api/boards/b1/scene", async () => { if (fail) return { status: 500, json: { error: "x" } }; h.server.log.push("PUT scene (at the end)"); return { json: { rev: 4 } }; });
  console.error = () => {};
  const reply = await h.server.reply(h.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }));
  assert.match(reply.error!, /^SAVE_FAILED/);
  fail = false;
  h.stdin.end();
  await h.done;
  assert.deepEqual(h.exits, [0]);
  const log = h.server.log;
  assert.ok(log.indexOf("PUT scene (at the end)") >= 0 && log.indexOf("PUT scene (at the end)") < log.indexOf("exit 0"), log.join(" | "));
  assert.ok(log.indexOf("client closed") < log.indexOf("exit 0"));
  assert.equal(h.fake.closed, 1, "the engine was closed");
});

test("the stream ending after it was connected exits 0 and says why", async () => {
  const h = harness();
  await connected(h);
  h.server.state("unreachable", "The connection to the server ended");
  await h.done;
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.err.some((l) => /the connection to the server ended/.test(l)), h.err.join("\n"));
});

test("the secret is in no line it prints, not even one of the connection module's or of console", async () => {
  const was = { error: console.error, warn: console.warn, log: console.log };
  const h = harness({ captureConsole: true });
  await connected(h);
  console.error(`something failed with ${SECRET}`);
  console.warn(new Error(`bad ${SECRET}`));
  h.stdin.end();
  await h.done;
  assert.equal(console.error, was.error, "console is put back");
  assert.ok(h.err.length >= 3, h.err.join("\n"));
  for (const l of h.err) assert.ok(!l.includes(SECRET), l);
  assert.ok(h.err.some((l) => l.includes("dialing https://127.0.0.1:4749 with ***")), h.err.join("\n"));
});

test("AIWB_HEADLESS_TEST=hold-before-save makes the loop print HOLD after the apply", async () => {
  const h = harness({ env: { AIWB_HEADLESS_TEST: "hold-before-save" } });
  await connected(h);
  h.server.scenes.set("b1", { scene: { elements: [], appState: {}, files: {} }, rev: 3 });
  h.server.held("b1", 3);
  h.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => h.err.includes("HOLD apply b1"), "the HOLD line");
  assert.ok(!h.server.log.some((l) => l.startsWith("PUT")));
  h.stdin.end(); // (it is still waiting for the save: the end of stdin bounds what is waited for, then exits)
  await h.done;
  assert.deepEqual(h.exits, [0]);
});

test("holdOf reads the knob: off, the first apply, or the Nth", () => {
  for (const [v, want] of [[undefined, false], ["", false], ["hold-before-save", true], ["hold-before-save:3", 3], ["hold-before-save:0", false], ["hold-before-save:x", false], ["other", false]] as const) {
    assert.equal(holdOf(v), want, String(v));
  }
});

test("SIGTERM ends it as the end of stdin does: what waits is saved, then exit 0", async () => {
  const signals = new EventEmitter();
  const h = harness({ signals });
  await connected(h);
  h.server.scenes.set("b1", { scene: { elements: [], appState: {}, files: {} }, rev: 3 });
  h.server.held("b1", 3);
  console.error = () => {};
  await h.server.reply(h.server.rpc("read_board"));
  signals.emit("SIGTERM");
  await h.done;
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.err.includes("stopped by SIGTERM"));
  assert.ok(h.server.log.includes("client closed"));
});
