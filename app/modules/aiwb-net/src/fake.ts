// The JS fake of the native module (architecture AD-33): the module's API over the scripted server of
// @aiwb/conn (packages/conn/test/fakes/scripted-server.js), with the error mapping of README.md. The adapter
// (app/src/platform/net/nativeConnector.ts) over this fake must pass the same connector contract as the Node
// connector; that is the test of both.
//
// Nothing here imports the scripted server: the test gives it (or a fake network of several). The fake reads
// only what a Connector and a Session do, and tells their errors apart by name, as core/outcomes.js does.

import {
  netFailure, type AiwbNetEventName, type AiwbNetEvents, type AiwbNetModule, type FetchArgs, type FetchResult,
  type Headers, type LocalNetworkState, type NetCode, type NetErr, type OpenSessionArgs, type ProblemOutcome,
  type ReadCertificateArgs, type StreamArgs, type StreamHead, type Subscription,
} from "./AiwbNet.ts";

/** The part of a Session (packages/conn/ports.d.ts, test/fakes FakeSession) the fake drives. */
export interface FakeSessionPort {
  readonly fingerprint: string;
  fetch(r: {
    method: string; path: string; headers: Headers; body: Uint8Array | null; signal?: AbortSignal;
    headersMs?: number; maxBytes?: number;
  }): Promise<{ status: number; headers: Headers; body: Uint8Array }>;
  stream(r: {
    method: string; path: string; headers: Headers; body: Uint8Array | null; signal?: AbortSignal; headersMs?: number;
  }): Promise<{
    status: number; headers: Headers;
    body: { onChunk(f: (text: string) => void): void; onEnd(f: (err?: { code: string }) => void): void; cancel(): void };
  }>;
  isClosed(): boolean;
  onClose(f: () => void): void;
  close(): void;
}

/** One server, as the scripted server gives it: what `connect` and `readCertificate` of a Connector do for it. */
export interface FakeServer {
  host: string;
  port: number;
  connect(o: { selfSigned: boolean; pin: string; dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<FakeSessionPort>;
  readCertificate(o: { dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<string>;
}

/** Several servers: the fake Connector of @aiwb/conn's test/fakes (`fakeConnector()`), whose `lookup` answers the
 *  server at host:port or throws what dialing a name nothing answers throws. */
export interface FakeNetwork {
  lookup(host: string, port: number | string, o?: { signal?: AbortSignal }): Promise<FakeServer>;
}

export type FakeAiwbNet = AiwbNetModule & {
  /** Every call of a function of the module, in order: what the adapter asked, without the bodies. */
  readonly calls: ReadonlyArray<{ fn: string; args: unknown }>;
  /** What `localNetwork()` answers; the fake sets it as the platform does (README.md, "localNetwork"). */
  localNetworkState: LocalNetworkState;
  /** The sessions that are open, by id. */
  readonly sessions: ReadonlyMap<string, FakeSessionPort>;
};

const isNetwork = (s: FakeServer | FakeNetwork): s is FakeNetwork => typeof (s as FakeNetwork).lookup === "function";

// The README's mapping table, applied to the errors of the scripted server and of its Session.
function infoOf(err: unknown): NetErr {
  const e = (err ?? {}) as { name?: string; outcome?: ProblemOutcome; detail?: string; fingerprint?: string; pinned?: string; code?: string; message?: string };
  switch (e.name) {
    case "AbortError":
      return { kind: "aborted" };
    case "Problem": {
      const info: NetErr = { kind: "problem", outcome: e.outcome as ProblemOutcome, detail: e.detail ?? "" };
      if (e.fingerprint) info.fingerprint = e.fingerprint;
      if (e.pinned) info.pinned = e.pinned;
      return info;
    }
    case "NetError":
      return { kind: "net", code: e.code as NetCode };
    default:
      return { kind: "net", code: "reset", detail: String(e.message ?? err) };
  }
}

const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/** A fake of the module over one scripted server (it answers only its own host and port; any other is refused)
 *  or over a fake network of them. */
export function createFakeAiwbNet(source: FakeServer | FakeNetwork): FakeAiwbNet {
  const listeners = new Map<AiwbNetEventName, Set<(e: never) => void>>();
  const sessions = new Map<string, FakeSessionPort>();
  const requests = new Map<string, AbortController>();
  const calls: Array<{ fn: string; args: unknown }> = [];
  let sessionSeq = 0;

  const emit = <E extends AiwbNetEventName>(name: E, e: Parameters<AiwbNetEvents[E]>[0]) => {
    for (const f of [...(listeners.get(name) ?? [])]) (f as (e: unknown) => void)(e);
  };

  const serverOf = async (host: string, port: number, signal?: AbortSignal): Promise<FakeServer> => {
    if (isNetwork(source)) return source.lookup(host, port, { signal });
    if (source.host === host && Number(source.port) === port) return source;
    const err = new Error(`connect ECONNREFUSED ${host}:${port}`);
    err.name = "Problem";
    Object.assign(err, { outcome: "refused", detail: err.message });
    throw err;
  };

  const log = (fn: string, args: unknown) => { calls.push({ fn, args }); };
  const unknownSession = () => netFailure({ kind: "net", code: "closed" });

  const mod: FakeAiwbNet = {
    calls,
    sessions,
    localNetworkState: "unknown",

    async openSession(o: OpenSessionArgs) {
      log("openSession", o);
      if (o.selfSigned && !o.pin) throw netFailure({ kind: "problem", outcome: "fingerprint", detail: "" }); // nothing is dialed
      const ac = new AbortController();
      requests.set(o.request, ac);
      try {
        const server = await serverOf(o.host, o.port, ac.signal);
        const s = await server.connect({ selfSigned: o.selfSigned, pin: o.pin, dialMs: o.dialMs, handshakeMs: o.handshakeMs, signal: ac.signal });
        if (ac.signal.aborted) { s.close(); throw abortError(); }
        const id = `fake-s${++sessionSeq}`;
        sessions.set(id, s);
        s.onClose(() => { if (sessions.delete(id)) emit("closed", { session: id }); });
        mod.localNetworkState = "granted";
        return { session: id, fingerprint: s.fingerprint };
      } catch (err) {
        const info = infoOf(err);
        if (info.kind === "problem" && info.outcome === "local_network_denied") mod.localNetworkState = "denied";
        throw netFailure(info);
      } finally {
        requests.delete(o.request);
      }
    },

    async readCertificate(o: ReadCertificateArgs) {
      log("readCertificate", o);
      const ac = new AbortController();
      requests.set(o.request, ac);
      try {
        const server = await serverOf(o.host, o.port, ac.signal);
        return { fingerprint: await server.readCertificate({ dialMs: o.dialMs, handshakeMs: o.handshakeMs, signal: ac.signal }) };
      } catch (err) {
        throw netFailure(infoOf(err));
      } finally {
        requests.delete(o.request);
      }
    },

    async fetch(o: FetchArgs): Promise<FetchResult> {
      log("fetch", { ...o, body: o.body ? o.body.length : null });
      const s = sessions.get(o.session);
      if (!s) throw unknownSession();
      const ac = new AbortController();
      requests.set(o.request, ac);
      try {
        const r = await s.fetch({
          method: o.method, path: o.path, headers: o.headers, body: o.body, signal: ac.signal,
          headersMs: o.headersMs || undefined, maxBytes: o.maxBytes || undefined,
        });
        return { status: r.status, headers: r.headers, body: r.body };
      } catch (err) {
        throw netFailure(infoOf(err));
      } finally {
        requests.delete(o.request);
      }
    },

    async stream(o: StreamArgs): Promise<StreamHead> {
      log("stream", o);
      const s = sessions.get(o.session);
      if (!s) throw unknownSession();
      const ac = new AbortController();
      requests.set(o.request, ac);
      try {
        const r = await s.stream({
          method: o.method, path: o.path, headers: o.headers, body: null, signal: ac.signal, headersMs: o.headersMs || undefined,
        });
        const id = o.request;
        // From here the body is the events', until it ends or `cancel` ends it (no `end` then).
        r.body.onChunk((text) => emit("chunk", { request: id, text }));
        r.body.onEnd((err) => {
          requests.delete(id);
          emit("end", err ? { request: id, error: "reset" } : { request: id });
        });
        return { status: r.status, headers: r.headers };
      } catch (err) {
        requests.delete(o.request);
        throw netFailure(infoOf(err));
      }
    },

    cancel(request: string) {
      log("cancel", request);
      const ac = requests.get(request);
      if (!ac) return;
      requests.delete(request);
      ac.abort();
    },

    closeSession(session: string) {
      log("closeSession", session);
      sessions.get(session)?.close();
    },

    async localNetwork() {
      log("localNetwork", null);
      return mod.localNetworkState;
    },

    addListener<E extends AiwbNetEventName>(name: E, listener: AiwbNetEvents[E]): Subscription {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener as (e: never) => void);
      return { remove: () => { set.delete(listener as (e: never) => void); } };
    },
  };
  return mod;
}
