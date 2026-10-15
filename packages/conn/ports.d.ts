// The ports of @aiwb/conn (architecture AD-11): what a platform gives the shared code. The Node ports
// are in node/ (`@aiwb/conn/node`); the phone's are the native module aiwb-net (Session, Connector)
// and the app's storage (Store). The implementations copy these names.

/** A header map with lower-case names. */
export type Headers = Record<string, string>;

/** Why a request on a session got no usable answer. code: 'timeout' | 'reset' (the connection or stream ended) |
 *  'too_long' (above maxBytes) | 'closed' (the session is gone). Thrown by Session methods. The core tells it by its
 *  name and code; `NetError` of the package root makes one. */
export interface NetError extends Error { name: 'NetError'; code: 'timeout' | 'reset' | 'too_long' | 'closed' }

/** An outcome a Connector may throw (core/outcomes.js OUTCOMES, steps 2 and 3, and 'not_aiwb'). */
export type ProblemOutcome = 'refused' | 'name_not_found' | 'no_route' | 'local_network_denied' | 'tls_timeout' | 'not_https'
  | 'fingerprint' | 'cert_changed' | 'cert_name' | 'cert_expired' | 'self_signed' | 'cert_untrusted' | 'tls_error'
  | 'not_aiwb';

/** Why no session was made: an outcome (step 2 or 3, or 'not_aiwb' for a server that does not speak HTTP/2), its text,
 *  and for 'cert_changed' the presented and the pinned fingerprint; for 'fingerprint' the presented one. Thrown by
 *  Connector methods. The core tells it by its name; `Problem` of the package root makes one. */
export interface Problem extends Error {
  name: 'Problem';
  outcome: ProblemOutcome;
  detail: string; fingerprint: string; pinned: string;
}

/** The trust rule of a connection. selfSigned: accept by the pin (SHA-256 of the leaf's DER, upper-case hex pairs
 *  joined by ':') and by nothing else; otherwise by the platform's roots and the host name. */
export type Trust = { selfSigned: boolean; pin: string };

/** The body of a streamed answer, read as text (UTF-8). Chunks come in order once onChunk is set; end comes once,
 *  after the last chunk, with an error when the stream did not end cleanly (a NetError 'reset'), also when it came
 *  before onEnd was set. cancel() ends it: no chunk and no end callback after it; after the end it does nothing. */
export interface TextStream {
  onChunk(f: (text: string) => void): void;
  onEnd(f: (err?: NetError) => void): void;
  cancel(): void;
}

export type SendRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                 // path and query of the client API
  headers: Headers;             // the secret among them: only ever sent on a session whose trust was judged
  body: Uint8Array | null;
  signal?: AbortSignal;         // abort cancels the request: before the answer's headers it rejects with an AbortError
  headersMs?: number;           // time for the answer's headers after the request was written (NetError 'timeout')
};

/** One session per server entry: every call, the stream and the pictures of that server go over it (HTTP/2). */
export interface Session {
  readonly fingerprint: string;   // of the certificate the trust accepted
  isClosed(): boolean;
  onClose(f: () => void): void;   // once, when the session ended for any reason (at once if it has)
  /** A request and its whole body. limitMs: the whole of it (NetError 'timeout'); maxBytes: the body's most
   *  (NetError 'too_long'). */
  fetch(r: SendRequest & { limitMs?: number; maxBytes?: number }): Promise<{ status: number; headers: Headers; body: Uint8Array }>;
  /** A request whose body is read as text as it comes (the event stream). Resolves at the headers; an abort of
   *  r.signal after them cancels the body. */
  stream(r: SendRequest): Promise<{ status: number; headers: Headers; body: TextStream }>;
  close(): void;                  // ends the session and every request on it
}

export interface Connector {
  /** A session to host:port whose certificate passed `trust`, after a TLS handshake that negotiated h2. Nothing is
   *  written to the server before the trust was judged, and the secret is never sent by open itself. Throws a Problem
   *  or an AbortError. A selfSigned trust with no pin throws Problem 'fingerprint' without dialing. */
  open(o: { host: string; port: string; trust: Trust; dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<Session>;
  /** The handshake that reads the server's certificate and sends no request: any certificate, its leaf's fingerprint.
   *  Throws a Problem or an AbortError. */
  readCertificate(o: { host: string; port: string; dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<string>;
}

/** An entry of the server list as stored, secret included. */
export type StoredEntry = { id: string; name: string; address: string; secret: string; selfSigned: boolean; pin: string; instanceId: string };

/** Where the server list and the client id are kept. Synchronous: the List writes before it changes (as today). */
export interface Store {
  /** For the notice: "/…/servers.json", or "the app's storage". */
  readonly where: string;
  /** The saved list: null when none was saved; { version, servers } as saved (core/list.js checks every entry and
   *  refuses a later version). Throws when it cannot be read (the List then calls setAside, with the error's `code`,
   *  else its message, as the reason). */
  read(): { version: number; servers: unknown[] } | null;
  /** Saves the whole list (version is core's FILE_VERSION) atomically, or throws and keeps the old one. */
  write(list: { version: number; servers: StoredEntry[] }): void;
  /** Puts an unreadable saved list out of the way; answers the name it now has (for the notice), or throws. */
  setAside(why: string): string;
  /** The app's id: a lower-case UUID v4, made once and kept. */
  clientId(): string;
}

/** The Manager of the shared code as a LocalPort sees it (core/manager.js). Opaque to a platform. */
export type Manager = object;
/** A connection of the shared code (core/conn.js Conn); the LocalPort's is a subclass of it. */
export type Conn = object;

/** What the app tells of this computer's server (client.localInfo()). */
export type LocalInfo = { home: string; address: string; version: string; pid: number };

/** This computer's server (desktop and test host only; null on a phone). It is the Node module's Starter, LocalConn
 *  and ownerOp (node/local.js), unchanged: the Manager makes this computer's connection with it and sends it the
 *  owner's operations. */
export interface LocalPort {
  /** Makes this computer's connection (a Conn whose loop finds or starts the server first). Called once, by the Manager. */
  connect(mgr: Manager): Conn;
  /** Answers an owner.* operation, or null for one it does not know (the Manager then answers 404 no_op). Without a
   *  LocalPort every owner.* answers 404 no_owner. */
  ownerOp(mgr: Manager, op: string, args: unknown): Promise<{ status: number; body: unknown } | null>;
  /** What the last launch said of the server, or null before one. */
  info(): LocalInfo | null;
}
