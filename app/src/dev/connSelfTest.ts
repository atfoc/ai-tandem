// The connection core on Hermes (architecture AD-83, flow conn-on-hermes). Inside the real JavaScript engine of the app, with
// the native module's JS fake (modules/aiwb-net/src/fake.ts) behind the adapter (platform/net/nativeConnector.ts), it runs:
//   1. the connector contract (packages/conn/test/contract) on the adapter: the same cases the Node connector passes;
//   2. the shared connection code (`createClient` of @aiwb/conn) over that adapter against a scripted server: the cases of
//      packages/conn/test/core.test.js that show the states and the order of what a server says, on the real engine.
// That proves AD-10 (core/ names nothing that only Node has) where it matters: in Hermes. No network, no native code is used.
// The cases are the repository's own: this file only gives them a runner that needs no test framework.
import { createClient } from "@aiwb/conn";

import { createFakeAiwbNet } from "../../modules/aiwb-net/src/fake.ts";
import { nativeConnector } from "../platform/net/nativeConnector.ts";
import { collector, equal, ok, run, summarize, type Case, type Outcome } from "./selftest.ts";

// The scripted server, the fake network, the memory store, the waits of the tests and the contract are CommonJS in
// packages/conn/test (the type check reads them as JavaScript). They are imported by path: this is dev code, compiled in only
// for a self-test build, and the package's own tests are what it runs.
import { ScriptedServer } from "../../../packages/conn/test/fakes/scripted-server.js";
import { fakeConnector } from "../../../packages/conn/test/fakes/fake-connector.js";
import { memoryStore } from "../../../packages/conn/test/fakes/memory-store.js";
import { FAST, sleep, until, seededRandom, Recorder } from "../../../packages/conn/test/fakes/support.js";
import { runConnectorContract } from "../../../packages/conn/test/contract/connector-contract.js";

const STEPS = [31, 62, 124];

/** The handle of the contract over a scripted server that sends no hello and no snapshot (as the repository's own tests do). */
function handle(network: any, s: any) {
  network.add(s);
  return {
    host: s.host, port: s.port, fingerprint: s.fingerprint, secret: s.secret,
    close: async () => { s.cut(); network.remove(s); },
    requests: () => s.requests.map((r: any) => ({ method: r.method, path: r.path, headers: r.headers, body: r.body })),
    connections: () => s.dials,
    body: (path: string, bytes: Uint8Array) => { s.routes.set(`GET ${path}`, () => ({ bytes, type: "application/octet-stream" })); },
    echo: (path: string) => { s.routes.set(`POST ${path}`, (req: any) => ({ bytes: req.body || new Uint8Array(0), type: "application/octet-stream" })); },
    hang: (path: string) => { s.hangPaths.add(path); },
    waitStream: () => s.waitStreams(1),
    write: (text: string) => s.write(text),
    endStreams: () => s.endStreams(),
    cut: () => s.cut(),
  };
}

function contractCases(): Case[] {
  const network = fakeConnector();
  const c = collector();
  const start = async (kind: string) => {
    const base = { withHello: false, noSnapshot: true };
    switch (kind) {
      case "aiwb": return handle(network, new ScriptedServer(base));
      case "h1": return handle(network, new ScriptedServer({ ...base, transport: "http1" }));
      case "plain": return handle(network, new ScriptedServer({ ...base, transport: "plain" }));
      case "blackhole": return handle(network, new ScriptedServer({ ...base, handshakeHang: true }));
      case "closed": return { host: "nothing.test", port: 9, close: async () => {} };
      default: throw new Error(`unknown kind ${kind}`);
    }
  };
  runConnectorContract(() => nativeConnector(createFakeAiwbNet(network)), { test: c.test, start });
  return c.cases;
}

/** A client of the shared code over one scripted server, reached through the adapter over the module's fake. */
function setup(serverOpts: Record<string, unknown> = {}, timing: Record<string, unknown> = {}) {
  const s = new ScriptedServer(serverOpts);
  const network = fakeConnector({ servers: [s] } as any);
  const fake = createFakeAiwbNet(network);
  const rec = new Recorder();
  const client = createClient({
    connector: nativeConnector(fake), store: memoryStore(), timing: { ...FAST, backoff: STEPS, stable: 400, ...timing } as any,
    log: rec.onLog, random: seededRandom(),
  });
  const sub = client.subscribe(rec.onEnvelope);
  const h = {
    s, fake, rec, client,
    async add(extra: Record<string, unknown> = {}) {
      rec.secrets.add(s.secret);
      const a = await client.app("servers.add", { force: true, form: { name: "Remote", address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint, ...extra } } as any);
      rec.keep(a);
      equal(a.status, 200, `servers.add answered ${JSON.stringify(a.body)}`);
      return (a.body as any).server as { id: string };
    },
    reaches: (id: string, state: string) => until(() => rec.stateOf(id) === state, `${id} to be ${state}`),
    async close() { sub.close(); await client.close(); },
  };
  return h;
}

async function withEntry(opts: { server?: Record<string, unknown>; timing?: Record<string, unknown> }, fn: (h: ReturnType<typeof setup>, v: { id: string }) => Promise<void>) {
  const h = setup(opts.server, opts.timing);
  try {
    const v = await h.add();
    await fn(h, v);
    h.rec.assertNoSecrets();
  } finally {
    await h.close();
  }
}

function coreCases(): Case[] {
  const cases: Case[] = [];
  const test = (name: string, fn: Case["fn"]) => cases.push({ name: `core on the module's fake: ${name}`, fn });

  test("connected: hello and the snapshot as the server sent them, then connected, then the events in order", () => withEntry({}, async (h, v) => {
    await h.reaches(v.id, "connected");
    for (let i = 1; i <= 5; i++) h.s.emit({ type: "tick", n: i });
    h.s.ping();
    await until(() => h.rec.eventsOf(v.id).length === 7, "five events");
    const mine = h.rec.envelopes.filter((e: any) => e.server === v.id || (e.app && e.app.type === "server_state" && e.app.server.id === v.id));
    const seen = mine.map((e: any) => (e.server ? e.event.type + (e.event.n || "") : `state:${e.app.server.state}`)).join(",");
    equal(seen, "hello,snapshot,state:connected,tick1,tick2,tick3,tick4,tick5", "the envelopes in order");
    const view = h.rec.viewOf(v.id);
    equal(JSON.stringify([view.state, view.version, view.agents, view.address]), JSON.stringify(["connected", "1.2.3", ["claude"], h.s.address]), "the view of the entry");
    equal("secret" in view, false, "the view holds no secret");
  }));

  test("a snapshot cut into pieces of three characters, with text of every width, is the same snapshot", () => withEntry(
    { server: { snapshot: { agents: ["claude", "é✓😀"], catalogs: {}, home: "/h", defaultCwd: "/h", chats: [] }, chunkSize: 3 } }, async (h, v) => {
      await h.reaches(v.id, "connected");
      equal(JSON.stringify(h.rec.viewOf(v.id).agents), JSON.stringify(["claude", "é✓😀"]), "the agents");
      h.s.emit({ type: "say", text: "héllo ✓ 😀" });
      await until(() => h.rec.eventsOf(v.id).some((e: any) => e.type === "say"), "the event");
      equal(h.rec.eventsOf(v.id).find((e: any) => e.type === "say").text, "héllo ✓ 😀", "the text of the event");
    }));

  test("a cut: not connected at once, then connected again with a new hello", () => withEntry({}, async (h, v) => {
    await h.reaches(v.id, "connected");
    h.s.cut();
    await until(() => h.rec.stateOf(v.id) !== "connected", "the cut");
    await until(() => h.rec.stateOf(v.id) === "connected" && h.rec.eventsOf(v.id).length >= 4, "the return");
    equal(h.rec.eventsOf(v.id).filter((e: any) => e.type === "hello").length, 2, "one hello per stream");
  }));

  test("a changed certificate: certificate_changed with the presented fingerprint, nothing sent, and an accept connects", async () => {
    const h = setup();
    try {
      const pinned = h.s.fingerprint;
      h.s.setCert("b");
      ok(h.s.fingerprint !== pinned, "the server presents another certificate");
      const v = await h.add({ pin: pinned });
      await h.reaches(v.id, "certificate_changed");
      equal(h.rec.viewOf(v.id).fingerprint, h.s.fingerprint, "the presented fingerprint");
      equal(h.rec.viewOf(v.id).pin, pinned, "the pinned one");
      equal(h.s.requests.length, 0, "not a byte was sent to the new certificate");
      const a = await h.client.app("servers.accept", { id: v.id, fingerprint: h.s.fingerprint } as any);
      equal(a.status, 200, "accept");
      await h.reaches(v.id, "connected");
    } finally { await h.close(); }
  });

  test("no pin with the box on: fingerprint_not_accepted without dialing", async () => {
    const h = setup();
    try {
      const v = await h.add({ pin: "" });
      await h.reaches(v.id, "fingerprint_not_accepted");
      equal(h.s.dials, 0, "nothing was dialed");
      equal(h.fake.calls.filter((c) => c.fn === "openSession").length, 0, "the module was not asked to open a session");
    } finally { await h.close(); }
  });

  test("a refused secret stops the trying; an edit of the secret connects", async () => {
    const h = setup();
    try {
      h.s.secret = "the-secret-of-the-server";
      const v = await h.add({ secret: "the-wrong-secret" });
      h.rec.secrets.add("the-wrong-secret");
      await h.reaches(v.id, "secret_not_accepted");
      const asked = h.s.requests.filter((r: any) => r.path.startsWith("/api/events")).length;
      await sleep(300);
      equal(h.s.requests.filter((r: any) => r.path.startsWith("/api/events")).length, asked, "it does not try again");
      h.rec.secrets.add(h.s.secret);
      const e = await h.client.app("servers.edit", { id: v.id, patch: { secret: h.s.secret }, force: true } as any);
      equal((e.body as any).saved, true, "the edit is saved");
      await h.reaches(v.id, "connected");
      h.rec.assertNoSecrets();
    } finally { await h.close(); }
  });

  test("too old: the state and the version, and it connects once the server was updated", () => withEntry({ server: { level: 5 }, timing: { tooOld: 120 } }, async (h, v) => {
    await h.reaches(v.id, "too_old");
    equal(h.rec.viewOf(v.id).version, "1.2.3", "the version");
    h.s.level = 6;
    await h.reaches(v.id, "connected");
  }));

  test("local_network_denied is a state that retries by itself and connects once the permission is given", async () => {
    const h = setup();
    try {
      h.s.down("local_network_denied");
      const v = await h.add();
      await h.reaches(v.id, "unreachable");
      ok(/local network/i.test(String(h.rec.viewOf(v.id).detail)) || h.rec.viewOf(v.id).detail !== undefined, "the entry says why");
      h.s.up();
      await h.reaches(v.id, "connected");
    } finally { await h.close(); }
  });

  test("what the client says holds no secret", () => withEntry({}, async (h, v) => {
    await h.reaches(v.id, "connected");
    const r = await h.client.call({ server: v.id, method: "GET", path: "/api/state" });
    h.rec.keep(r);
    h.rec.assertNoSecrets();
  }));

  return cases;
}

export type ConnSelfTestResult = ReturnType<typeof summarize> & { outcomes: Outcome[] };

/** Runs the contract and the core cases; `say` is told each outcome. `ok` is false when a case failed, or when the contract ran too few cases to mean anything. */
export async function runConnSelfTest(say: (o: Outcome) => void = () => {}): Promise<ConnSelfTestResult> {
  const outcomes = await run([...contractCases(), ...coreCases()], say);
  // The contract has about twenty cases and the core cases are nine: fewer passes than this means the suites did not load.
  return { ...summarize(outcomes, 20), outcomes };
}
