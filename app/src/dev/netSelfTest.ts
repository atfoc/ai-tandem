// The native module on a device (architecture AD-83, flow net-selftest): the Connector over the real module (or, under Node,
// over the Node ports: `run.mjs --platform node`) against a scratch Go server and four stand-ins the runner started. It runs
//   1. the connector contract (packages/conn/test/contract): the cases that need a server the case can script (writes on the
//      event stream, cuts, requests it saw) are skipped with their reason, since a real Go server cannot be scripted; the rest run
//      against the stand-ins (a refused port, a listener that is not TLS, TLS without h2, a handshake that never ends) and the server;
//   2. checks against the real server: the pin, the secret that only goes where the caller puts it, the event stream of a real
//      server, a cancel, the limits of a call, the module's own `localNetwork`.
// `host` is the name the device reaches the server and the stand-ins by: 127.0.0.1, then the dotted name of the server's certificate.
import type { Connector, Session } from "@aiwb/conn";

import { netInfoOf } from "../../modules/aiwb-net/src/AiwbNet.ts";

import { decode, encode } from "../../../packages/conn/core/utf8.js";
import { runConnectorContract } from "../../../packages/conn/test/contract/connector-contract.js";
import { collector, equal, ok, run, summarize, type Case, type Outcome } from "./selftest.ts";
import { Control, mirrored } from "./standinControl.ts";

export type NetSelfTestConfig = {
  /** How the device reaches the server and the stand-ins: "127.0.0.1" or the dotted name. */
  host: string;
  port: number;
  fingerprint: string;
  secret: string;
  closedPort: number;
  plainPort: number;
  h1Port: number;
  h1Fingerprint: string;
  blackholePort: number;
  /** The control server of the stand-in that can be scripted (modules/aiwb-net/dev/control.mjs): with it the whole contract runs. */
  control?: string;
  /** The platform's module sends a probe request when it opens a session (iOS, README.md "What the module writes"): the stand-in leaves it
   *  out of the requests it lists. false on Android, which writes none. Default true. */
  probe?: boolean;
};

/** What of the native module the module-level cases use (`AiwbNetModule.ts`; its `selfTestUtf8` is not part of the contract). */
export type NativeModuleLike = {
  selfTestUtf8(text: string): string;
  localNetwork(): Promise<string>;
  openSession(o: { request: string; host: string; port: number; selfSigned: boolean; pin: string; dialMs: number; handshakeMs: number }): Promise<unknown>;
  closeSession(session: string): void;
};

const SECOND = 1000;
const CLIENT = "00000000-0000-4000-8000-000000000000";
const CASE_LIMIT = 60 * SECOND; // a case that hangs fails; the contract's own waits are 15 s
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The case, failing when it has not ended in CASE_LIMIT. */
function limited(c: Case): Case {
  return {
    name: c.name,
    fn: async (t) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no end after ${CASE_LIMIT / SECOND} s`)), CASE_LIMIT); });
      try { await Promise.race([c.fn(t), limit]); } finally { clearTimeout(timer); }
    },
  };
}
const ascii = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

async function rejection(p: Promise<unknown>, what: string): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error(`${what} should have been rejected`);
}
const problem = (e: any, outcome: string, what: string) => {
  ok(e && e.name === "Problem", `${what}: a Problem, got ${e && e.name}: ${e && e.message}`);
  equal(e.outcome, outcome, `${what}: outcome`);
  return e;
};
const netError = (e: any, code: string, what: string) => {
  ok(e && e.name === "NetError", `${what}: a NetError, got ${e && e.name}: ${e && e.message}`);
  equal(e.code, code, `${what}: code`);
  return e;
};
const wrongPin = (fp: string) => (fp.startsWith("00:") ? "FF" : "00") + fp.slice(2);

function contractCases(connector: Connector, cfg: NetSelfTestConfig, native: boolean): Case[] {
  const c = collector();
  // Without a control server the server of kind 'aiwb' is the real one: its handle has no function to script it, so the cases
  // that need one are skipped. With one it is the stand-in of @aiwb/conn's tests, driven from here, and the whole contract runs.
  const ctl = cfg.control ? new Control(cfg.control) : null;
  const start = async (kind: string) => {
    const none = async () => {};
    switch (kind) {
      case "aiwb": {
        if (!ctl) return { host: cfg.host, port: cfg.port, fingerprint: cfg.fingerprint, secret: cfg.secret, close: none };
        const st = await ctl.start(native, cfg.probe !== false);
        const id = st.id;
        const fire = (op: string, body: object = {}) => { void ctl.send(op, { id, ...body }); };
        return {
          host: cfg.host, port: st.port, fingerprint: st.fingerprint, secret: st.secret,
          close: () => ctl.stop(id),
          requests: () => ctl.requests,
          connections: () => ctl.connections,
          body: (path: string, bytes: Uint8Array) => fire("body", { path, bytes: Array.from(bytes) }),
          echo: (path: string) => fire("echo", { path }),
          hang: (path: string) => fire("hang", { path }),
          waitStream: () => ctl.send("waitStream", { id }),
          write: (text: string) => fire("write", { text }),
          endStreams: () => fire("endStreams"),
          cut: () => fire("cut"),
        };
      }
      case "h1": return { host: cfg.host, port: cfg.h1Port, fingerprint: cfg.h1Fingerprint, close: none };
      case "plain": return { host: cfg.host, port: cfg.plainPort, close: none };
      case "closed": return { host: cfg.host, port: cfg.closedPort, close: none };
      case "blackhole": return { host: cfg.host, port: cfg.blackholePort, close: none };
      default: throw new Error(`unknown kind ${kind}`);
    }
  };
  runConnectorContract(() => (ctl ? mirrored(connector, ctl) : connector), { test: c.test, start });
  return c.cases.map(limited);
}

function serverCases(connector: Connector, cfg: NetSelfTestConfig, native: boolean): Case[] {
  const cases: Case[] = [];
  const test = (name: string, fn: Case["fn"]) => cases.push({ name: `real server: ${name}`, fn });
  const port = String(cfg.port);
  const dial = { host: cfg.host, port, dialMs: 5 * SECOND, handshakeMs: 5 * SECOND };
  const headers = (extra: Record<string, string> = {}) => ({ "x-aiwb-secret": cfg.secret, "x-aiwb-client": CLIENT, "x-aiwb-level": "7", ...extra });
  const open = async (sessions: Session[], pin = cfg.fingerprint) => {
    const s = await connector.open({ ...dial, trust: { selfSigned: true, pin } });
    sessions.push(s);
    return s;
  };
  // Every case closes the sessions it opened, whatever happens.
  const withSessions = (fn: (open: () => Promise<Session>) => Promise<void>): Case["fn"] => async () => {
    const sessions: Session[] = [];
    try { await fn(() => open(sessions)); } finally { for (const s of sessions) { try { s.close(); } catch { /* gone */ } } }
  };

  test("open with the pin: the session names the certificate, and hello answers without the secret over h2", withSessions(async (open) => {
    const s = await open();
    equal(s.fingerprint, cfg.fingerprint, "the fingerprint of the session");
    const r = await s.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND });
    equal(r.status, 200, "hello");
    ok(/^application\/json/.test(r.headers["content-type"] ?? ""), `content-type ${r.headers["content-type"]}`);
    ok(r.body instanceof Uint8Array, "the body is a Uint8Array");
    ok(ascii(r.body).includes('"app":"ai-whiteboard"'), `the body of hello: ${ascii(r.body).slice(0, 80)}`);
  }));

  test("the secret goes only where the caller puts it: without it a route answers 401, with it 200", withSessions(async (open) => {
    const s = await open();
    equal((await s.fetch({ method: "GET", path: "/api/state", headers: { "x-aiwb-client": CLIENT, "x-aiwb-level": "7" }, body: null, limitMs: 10 * SECOND })).status, 401, "no secret");
    equal((await s.fetch({ method: "GET", path: "/api/state", headers: headers({ "x-aiwb-secret": "not-the-secret" }), body: null, limitMs: 10 * SECOND })).status, 401, "a wrong secret");
    const r = await s.fetch({ method: "GET", path: "/api/state", headers: headers(), body: null, limitMs: 10 * SECOND });
    equal(r.status, 200, "the secret");
    ok(r.body.length > 100, "the state is not empty");
  }));

  test("a wrong pin is cert_changed with the presented and the pinned fingerprint", async () => {
    const bad = wrongPin(cfg.fingerprint);
    const e = problem(await rejection(connector.open({ ...dial, trust: { selfSigned: true, pin: bad } }), "open with a wrong pin"), "cert_changed", "wrong pin");
    equal(e.fingerprint, cfg.fingerprint, "the presented fingerprint");
    equal(e.pinned, bad, "the pinned fingerprint");
  });

  test("the self-signed box with no pin is fingerprint", async () => {
    problem(await rejection(connector.open({ ...dial, trust: { selfSigned: true, pin: "" } }), "open with no pin"), "fingerprint", "no pin");
  });

  test("readCertificate answers the leaf's fingerprint", async () => {
    equal(await connector.readCertificate(dial), cfg.fingerprint, "the fingerprint");
  });

  test("a certificate that is self-signed is not trusted by the platform's roots (self_signed or cert_untrusted)", async () => {
    const e = await rejection(connector.open({ ...dial, trust: { selfSigned: false, pin: "" } }), "open without the box");
    ok(e && e.name === "Problem" && ["self_signed", "cert_untrusted", "cert_name"].includes(e.outcome), `a trust outcome, got ${e && e.name}: ${e && e.outcome} ${e && e.message}`);
  });

  test("the event stream of the server: hello, then the snapshot, in text; cancel ends it and the session serves on", withSessions(async (open) => {
    const s = await open();
    const r = await s.stream({ method: "GET", path: `/api/events?client=${CLIENT}`, headers: headers({ accept: "text/event-stream" }), body: null });
    equal(r.status, 200, "the stream's status");
    ok(/^text\/event-stream/.test(r.headers["content-type"] ?? ""), `content-type ${r.headers["content-type"]}`);
    let text = "";
    let ends = 0;
    r.body.onChunk((t) => { ok(typeof t === "string", "a chunk is a string"); text += t; });
    r.body.onEnd(() => { ends++; });
    const t0 = Date.now();
    while (!text.includes('"type":"snapshot"') && Date.now() - t0 < 20 * SECOND) await sleep(20);
    ok(text.includes('"type":"hello"'), `a hello event: ${text.slice(0, 120)}`);
    ok(text.indexOf('"type":"hello"') < text.indexOf('"type":"snapshot"'), "hello before the snapshot");
    ok(text.includes('"type":"snapshot"'), "the snapshot came");
    ok(text.endsWith("\n\n"), "the text stops at an event's end");
    r.body.cancel();
    const seen = text.length;
    await sleep(300);
    equal(text.length, seen, "no chunk after cancel");
    equal(ends, 0, "no end after cancel");
    equal(s.isClosed(), false, "the session goes on");
    equal((await s.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND })).status, 200, "and serves");
  }));

  test("a body above maxBytes is too_long, and the session serves on", withSessions(async (open) => {
    const s = await open();
    netError(await rejection(s.fetch({ method: "GET", path: "/api/state", headers: headers(), body: null, limitMs: 10 * SECOND, maxBytes: 50 }), "fetch above maxBytes"), "too_long", "maxBytes");
    equal(s.isClosed(), false, "the session goes on after too_long");
    equal((await s.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND })).status, 200, "and serves");
  }));

  test("close ends the session, and a request on it is closed", withSessions(async (open) => {
    const s = await open();
    let told = 0;
    s.onClose(() => { told++; });
    s.close();
    const t0 = Date.now();
    while (told === 0 && Date.now() - t0 < 5 * SECOND) await sleep(10);
    equal(told, 1, "onClose");
    equal(s.isClosed(), true, "isClosed");
    netError(await rejection(s.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null }), "fetch on a closed session"), "closed", "fetch on a closed session");
  }));

  test("two sessions to the server at once are two connections that both serve", withSessions(async (open) => {
    const [a, b] = [await open(), await open()];
    const [x, y] = await Promise.all([
      a.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND }),
      b.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND }),
    ]);
    equal(x.status + y.status, 400, "both answered");
  }));

  test("a POST body of UTF-8 bytes and its headers arrive whole", withSessions(async (open) => {
    const s = await open();
    const body = encode(JSON.stringify({ name: "net ünïcode ✓ 日本語", group: "__ungrouped__" }));
    const r = await s.fetch({ method: "POST", path: "/api/boards", headers: headers({ "content-type": "application/json" }), body, limitMs: 10 * SECOND });
    equal(r.status, 200, `status (${decode(r.body)})`);
    equal(JSON.parse(decode(r.body)).name, "net-ünïcode-✓-日本語", "the name the server kept");
  }));

  test("limitMs ends a fetch whose body never ends (the call is cancelled, the session serves on)", withSessions(async (open) => {
    const s = await open();
    // another client id: the server ends the earlier event stream of a client that opens a new one
    const h = headers({ accept: "text/event-stream", "x-aiwb-client": "00000000-0000-4000-8000-000000000001" });
    netError(await rejection(s.fetch({ method: "GET", path: "/api/events", headers: h, body: null, limitMs: 400, maxBytes: 1 << 30 }), "fetch of a stream"), "timeout", "limitMs");
    equal((await s.fetch({ method: "GET", path: "/api/hello", headers: {}, body: null, limitMs: 10 * SECOND })).status, 200, "and serves");
  }));

  test("the platform's own trust names its failure: a certificate no root signed, a name that does not fit", async () => {
    const dialed = async (host: string) => rejection(connector.open({ host, port, trust: { selfSigned: false, pin: "" }, dialMs: 5 * SECOND, handshakeMs: 5 * SECOND }), `open ${host}`);
    problem(await dialed(cfg.host), "self_signed", cfg.host);
    // localtest.me resolves to 127.0.0.1; the certificate of a server set up for 127.0.0.1 only does not name it (the scratch
    // server's lists it, so this is the name that does not fit only when the server was reached by its address)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(cfg.host) && cfg.host !== "127.0.0.1") problem(await dialed("localtest.me"), "cert_name", "localtest.me");
  });

  test("a name that does not resolve is name_not_found", async () => {
    problem(await rejection(connector.open({ host: "no-such-host.invalid", port: "443", trust: { selfSigned: true, pin: cfg.fingerprint }, dialMs: 8 * SECOND, handshakeMs: 5 * SECOND }), "open"), "name_not_found", "no such host");
  });

  test("a host that holds / @ ? # or a blank is refused: no address is built from it", async () => {
    for (const host of ["a/b", "u@h", "h?x", "h#x", "h h"]) {
      problem(await rejection(connector.open({ host, port, trust: { selfSigned: true, pin: cfg.fingerprint }, dialMs: 2 * SECOND, handshakeMs: 2 * SECOND }), `open ${host}`), "name_not_found", host);
    }
  });

  test("a dropped GET and a dropped POST each end in a reset (the attempts URLSession made are counted)", async (t) => {
    if (!cfg.control) return t.skip("no control server: the stand-in that resets connections is not there");
    const ctl = new Control(cfg.control);
    const st = await ctl.start(native, cfg.probe !== false);
    try {
      await ctl.send("drop", { id: st.id, path: "/api/drop" });
      for (const method of ["GET", "POST"] as const) {
        const s = await mirrored(connector, ctl).open({ host: cfg.host, port: String(st.port), trust: { selfSigned: true, pin: st.fingerprint }, dialMs: 5 * SECOND, handshakeMs: 5 * SECOND });
        const before = ctl.requests.filter((r) => r.path === "/api/drop").length;
        const e = await rejection(s.fetch({ method, path: "/api/drop", headers: { "x-aiwb-secret": st.secret, "x-aiwb-level": "7" }, body: method === "POST" ? encode("{}") : null, limitMs: 20 * SECOND }), `${method}`);
        await sleep(500);
        await ctl.refresh();
        const attempts = ctl.requests.filter((r) => r.path === "/api/drop").length - before;
        netError(e, "reset", `${method} dropped`);
        t.note(`RETRIES ${method} dropped: ${attempts} attempt(s) reached the server`);
        s.close();
      }
    } finally { await ctl.stop(st.id); }
  });

  return cases;
}

/** Cases of the native module itself, below the connector: they need the module (the screen gives it). */
function moduleCases(mod: NativeModuleLike, cfg: NetSelfTestConfig): Case[] {
  const cases: Case[] = [];
  const test = (name: string, fn: Case["fn"]) => cases.push({ name: `module: ${name}`, fn });

  test("the UTF-8 chunker joins every cut of a text with 2-, 3- and 4-byte characters and a combining mark", () => {
    const r = mod.selfTestUtf8("aé✓😀 日本語 e\u0301 \u{10FFFF}z");
    ok(r.startsWith("ok "), r);
  });

  test("localNetwork is granted once a session to a private address opened", async (t) => {
    if (!/^(127|10|192\.168)\./.test(cfg.host)) return t.skip("the host is not on the local network");
    const r = await mod.openSession({ request: "mod-1", host: cfg.host, port: cfg.port, selfSigned: true, pin: cfg.fingerprint, dialMs: 5000, handshakeMs: 5000 }) as { session: string };
    equal(r.session.length > 0, true, "a session id");
    try { equal(await mod.localNetwork(), "granted", "localNetwork"); } finally { mod.closeSession(r.session); }
  });

  test("a rejection has code AIWB_NET and the NetErr as the last {...} of its message", async () => {
    let raw: any;
    try {
      await mod.openSession({ request: "mod-2", host: cfg.host, port: cfg.port, selfSigned: true, pin: wrongPin(cfg.fingerprint), dialMs: 5000, handshakeMs: 5000 });
    } catch (e) { raw = e; }
    ok(raw, "rejected");
    equal(raw.code, "AIWB_NET", "code");
    const info = netInfoOf(raw);
    ok(info?.kind === "problem" && info.outcome === "cert_changed", `info ${JSON.stringify(info)} from ${raw.message}`);
    equal(info?.kind === "problem" ? info.pinned : "", wrongPin(cfg.fingerprint), "pinned as it was given");
  });

  return cases;
}

export type NetSelfTestResult = ReturnType<typeof summarize> & { outcomes: Outcome[] };

/** Runs the contract and the real-server cases over `connector`; `say` is told each outcome as it happens. */
export async function runNetSelfTest(connector: Connector, cfg: NetSelfTestConfig, say: (o: Outcome) => void = () => {}, mod?: NativeModuleLike): Promise<NetSelfTestResult> {
  const outcomes = await run([...contractCases(connector, cfg, !!mod), ...serverCases(connector, cfg, !!mod), ...(mod ? moduleCases(mod, cfg) : [])], say);
  // The contract has about twenty cases and, with a real server, runs about nine of them (the rest are skipped); ours are ten.
  return { ...summarize(outcomes, 15), outcomes };
}
