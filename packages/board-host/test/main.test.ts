// The process around the loop: its configuration on stdin, its start within the limit, its end (stdin, a signal, the stream) with
// every dirty room saved first, and no secret in any line it prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { run, EXIT_START_FAILED, type Deps } from "../src/main.ts";
import type { Host } from "../src/host.ts";
import { FakeServer, geo, pageOf, until, type FakeWindow } from "./support.ts";

const SECRET = "s3cr3t-Value-0123456789";
const CONFIG = {
  address: "127.0.0.1:4749", fingerprint: "AA:BB", secret: SECRET, clientId: "6f1f1c3e-8a4b-4c55-9d0e-2b7a8c9d0e1f",
  instanceId: "0b0c7f0e-2a3b-4c4d-8e5f-6a7b8c9d0e1f", quietMs: 60_000, handoverMs: 2000, version: "dev",
};

type Harness = { stdin: PassThrough; err: string[]; exits: number[]; server: FakeServer; host: () => Host; done: Promise<void>; signals: EventEmitter };

function harness(o: Partial<Deps> & { config?: unknown; noConfig?: boolean; noOpen?: boolean } = {}): Harness {
  const stdin = new PassThrough();
  const err: string[] = [], exits: number[] = [];
  const server = new FakeServer();
  const signals = new EventEmitter();
  let host: Host | null = null;
  const deps: Deps = {
    stdin, stderr: (l) => err.push(l), exit: (c) => { exits.push(c); server.log.push(`exit ${c}`); }, env: {}, signals,
    makeClient: (entry, _clientId, log) => {
      server.serverId = entry.id;
      log(`dialing ${entry.address} with ${entry.secret}`);
      if (!o.noOpen) setImmediate(() => server.open());
      return Object.assign(server, { close: async () => { server.log.push("client closed"); } }) as any;
    },
    onHost: (h) => { host = h; },
    startLimitMs: 3000, flushLimitMs: 1000, waits: { sendGapMs: 5, saveDelayMs: 60_000 },
    ...o,
  };
  if (!o.noConfig) stdin.write(JSON.stringify(o.config ?? CONFIG) + "\n");
  return { stdin, err, exits, server, signals, host: () => host!, done: run(deps) };
}

async function withDirtyRoom(h: Harness): Promise<FakeWindow> {
  await until(() => h.host() !== null, "the host");
  await h.host().connected;
  const w = h.server.window("b1", "s_a");
  await until(() => w.loaded, "the window loaded");
  w.store.put([geo("unsaved", pageOf(w))]);
  await until(() => h.host().rooms.info()[0]?.dirty, "the room dirty");
  return w;
}

test("no configuration, or a bad one: exit 3 and no secret in any line", async () => {
  const none = harness({ noConfig: true });
  none.stdin.end();
  await none.done;
  assert.deepEqual(none.exits, [EXIT_START_FAILED]);
  assert.deepEqual(none.err, ["no configuration on stdin"]);
  const bad = harness({ config: { ...CONFIG, clientId: "nope" } });
  await bad.done;
  assert.deepEqual(bad.exits, [EXIT_START_FAILED]);
  assert.ok(bad.err.every((l) => !l.includes(SECRET)));
});

test("a preparation that fails exits 3 before it connects", async () => {
  let made = 0;
  const h = harness({ prepare: async () => { throw new Error("no fonts"); }, makeClient: () => { made++; throw new Error("unreachable"); } });
  await h.done;
  assert.deepEqual(h.exits, [EXIT_START_FAILED]);
  assert.deepEqual(h.err, ["cannot start the board host: no fonts"]);
  assert.equal(made, 0);
});

test("no first connection within the limit: exit 3 with the state", async () => {
  const h = harness({ noOpen: true, startLimitMs: 100 });
  await h.done;
  assert.deepEqual(h.exits, [EXIT_START_FAILED]);
  assert.ok(h.err.some((l) => /^cannot connect to the server: connecting; the first connection to the server did not finish/.test(l)), h.err.join("\n"));
  assert.ok(h.err.every((l) => !l.includes(SECRET)), "the secret is redacted");
  assert.ok(h.err.some((l) => l.includes("with ***")));
});

test("the end of stdin saves every dirty room, then exits 0", async () => {
  const h = harness();
  const w = await withDirtyRoom(h);
  h.stdin.end();
  await h.done;
  w.close();
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.server.snapshots.get("b1")!.includes("shape:unsaved"));
  const log = h.server.log;
  assert.ok(log.lastIndexOf("PUT snapshot b1") < log.indexOf("client closed") && log.indexOf("client closed") < log.indexOf("exit 0"), log.join("\n"));
});

test("SIGTERM saves and exits 0", async () => {
  const h = harness();
  const w = await withDirtyRoom(h);
  h.signals.emit("SIGTERM");
  await h.done;
  w.close();
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.err.includes("stopped by SIGTERM"));
  assert.ok(h.server.snapshots.get("b1")!.includes("shape:unsaved"));
});

test("a save that does not finish does not hold the exit past the flush limit", async () => {
  const h = harness({ flushLimitMs: 100 });
  const w = await withDirtyRoom(h);
  h.server.call = (() => new Promise(() => {})) as any;
  const t0 = Date.now();
  h.stdin.end();
  await h.done;
  w.close();
  assert.deepEqual(h.exits, [0]);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test("the end of the stream ends the process", async () => {
  const h = harness();
  await until(() => h.host() !== null, "the host");
  await h.host().connected;
  h.server.state("unreachable", "reset");
  await h.done;
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.err.includes("the connection to the server ended (reset)"));
});
