// The contract of the native module `aiwb-net` (architecture AD-30; README.md is the long form).
//
// The module dials, does TLS under a trust rule, speaks HTTP/2 through the system's stack and reports. It
// holds no decision of the app (hello, levels, retries, waits, route checks): those are @aiwb/conn's. This
// file is only types and two helpers on the shape of an error; it imports nothing at run time, so the fake
// (fake.ts), the adapter (app/src/platform/net/nativeConnector.ts) and their tests run under node.

import type { ProblemOutcome } from "@aiwb/conn";

export type { ProblemOutcome };

export type NetCode = "timeout" | "reset" | "too_long" | "closed";

/** What a failed call of the module says. `problem` is why no session was made (the Problem of @aiwb/conn),
 *  `net` is why a request on a session got no usable answer (its NetError), `aborted` is a request that
 *  `cancel` ended (an AbortError). `fingerprint`: the one presented, `pinned`: the one given, both in the text
 *  the platform has (the presented in the normal form, the pinned as it was given). */
export type NetErr =
  | { kind: "problem"; outcome: ProblemOutcome; detail: string; fingerprint?: string; pinned?: string }
  | { kind: "net"; code: NetCode; detail?: string }
  | { kind: "aborted" };

/** The `code` of the Error every function of the module rejects with when the failure is one of NetErr. */
export const AIWB_NET = "AIWB_NET";

/** Every function that can fail rejects with this (or, on a platform whose bridge cannot carry `info`, with an
 *  error whose message ends in the JSON text of NetErr: see netInfoOf). */
export interface AiwbNetError extends Error {
  code: typeof AIWB_NET;
  info: NetErr;
}

export type Headers = Record<string, string>;

/** `request` is made by the caller and unique among the requests of the module (the sessions' fetches and streams
 *  included): `cancel` and the events name the request by it. */
export type OpenSessionArgs = {
  /** `cancel(request)` ends the attempt: the promise rejects `aborted`, and a session that was made at that
   *  moment is closed (nothing is left open). */
  request: string;
  host: string;
  port: number;
  /** true: accept the leaf whose fingerprint equals `pin` and no other certificate. false: the platform's roots and the name. */
  selfSigned: boolean;
  /** The fingerprint the trust wants (SHA-256 of the leaf's DER, upper-case pairs joined by ':'), compared as text;
   *  "" with selfSigned rejects `problem` `fingerprint` without dialing. Ignored when selfSigned is false. */
  pin: string;
  dialMs: number;
  handshakeMs: number;
};

export type ReadCertificateArgs = { request: string; host: string; port: number; dialMs: number; handshakeMs: number };

export type FetchArgs = {
  session: string;
  request: string;
  method: string;
  path: string;
  /** Sent as they are. The module adds none (no cookie, no user agent of its own beyond what the stack adds). */
  headers: Headers;
  body: Uint8Array | null;
  /** The time the answer's headers may take after the request was written; 0: no limit. */
  headersMs: number;
  /** The most the body may hold; 0: no limit. Above it: `net` `too_long`. */
  maxBytes: number;
};

export type StreamArgs = {
  session: string;
  request: string;
  method: string;
  path: string;
  headers: Headers;
  headersMs: number;
};

export type FetchResult = { status: number; headers: Headers; body: Uint8Array };
export type StreamHead = { status: number; headers: Headers };

export type LocalNetworkState = "granted" | "denied" | "unknown";

/** The events of the module. */
export type AiwbNetEvents = {
  /** The stream's body as text, in order. */
  chunk: (e: { request: string; text: string }) => void;
  /** Once per stream that ended by itself: no `error` when the server ended it, `error: "reset"` when it was cut
   *  (the network, a reset of the stream, `closeSession`, the session gone). Never after `cancel`. */
  end: (e: { request: string; error?: "reset" }) => void;
  /** The session ended for any reason (a GOAWAY, the network, closeSession). Once per session. */
  closed: (e: { session: string }) => void;
};

export type AiwbNetEventName = keyof AiwbNetEvents;

/** The handle `addListener` answers; Expo's EventSubscription. */
export type Subscription = { remove(): void };

/** The module: the native one (AiwbNetModule.ts), the fake (fake.ts) and the stand-in of the web build. */
export interface AiwbNetModule {
  /** A session to host:port after a TLS handshake whose certificate passed the trust, and that negotiated h2.
   *  Nothing but what the platform needs to learn the protocol is written before the trust was judged, and the
   *  secret and every app header never go out in `openSession` (README.md, "What the module writes"). */
  openSession(o: OpenSessionArgs): Promise<{ session: string; fingerprint: string }>;
  /** The handshake that takes any certificate, answers the leaf's fingerprint, and writes nothing. */
  readCertificate(o: ReadCertificateArgs): Promise<{ fingerprint: string }>;
  /** A request and its whole body. */
  fetch(o: FetchArgs): Promise<FetchResult>;
  /** A request whose body is read as text: resolves at the headers, then `chunk` and `end` events carry the body. */
  stream(o: StreamArgs): Promise<StreamHead>;
  /** Ends a request: its `openSession`, `readCertificate`, `fetch` or `stream` (before its headers) rejects
   *  `aborted`; a stream after its headers ends with no `end` event. Nothing for a request that is over or unknown. */
  cancel(request: string): void;
  /** Ends the session and every request on it (README.md, "closeSession"). Nothing for a session that is gone. */
  closeSession(session: string): void;
  localNetwork(): Promise<LocalNetworkState>;
  addListener<E extends AiwbNetEventName>(name: E, listener: AiwbNetEvents[E]): Subscription;
}

/** An Error of the contract: what a function of the module rejects with. */
export function netFailure(info: NetErr, message?: string): AiwbNetError {
  const text = message ?? (info.kind === "problem" ? `${info.outcome}: ${info.detail}` : info.kind === "net" ? `net ${info.code}${info.detail ? `: ${info.detail}` : ""}` : "aborted");
  const err = new Error(text) as AiwbNetError;
  err.code = AIWB_NET;
  err.info = info;
  return err;
}

const KINDS = ["problem", "net", "aborted"];

function isNetErr(v: unknown): v is NetErr {
  return !!v && typeof v === "object" && KINDS.includes((v as { kind?: unknown }).kind as string);
}

/** The NetErr of an error a function of the module rejected with, or null when it is none (a bug, a platform
 *  failure, the "not implemented" of a stub). Reads `info`; failing that the JSON object that ends the message,
 *  which is how a native bridge that cannot carry `info` says it ("... Caused by: AiwbNetError: {json} (at ...)"
 *  was what Expo's wrapped message looked like in the spike: the object is cut between the first "{" and the last "}"). */
export function netInfoOf(err: unknown): NetErr | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { info?: unknown; message?: unknown };
  if (isNetErr(e.info)) return e.info;
  if (typeof e.message !== "string") return null;
  const a = e.message.indexOf("{");
  const b = e.message.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(e.message.slice(a, b + 1));
    return isNetErr(v) ? v : null;
  } catch {
    return null;
  }
}
