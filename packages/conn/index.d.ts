// The types of @aiwb/conn: the Client of every server (createClient) and the answers it gives. The ports the
// platform fills are in ports.d.ts.

import type { Connector, LocalInfo, LocalPort, NetError as NetErrorShape, Problem as ProblemShape, ProblemOutcome, Store } from './ports';

export * from './ports';

/** A partial timing in milliseconds (core/timing.js DEFAULT_TIMING): what a test or AIWB_APP_WAITS lowers. */
export type Timing = {
  dial: number; handshake: number; headers: number; hello: number; firstEvent: number; testStep: number;
  silence: number; backoff: number[]; jitter: number; stable: number; tooOld: number;
  call: number; start: number; scene: number; imageCall: number; delete: number; dirs: number; usage: number; unfollow: number;
  launch: number; relaunch: number; secret: number; status: number;
};

export type ClientOptions = {
  connector: Connector;
  store: Store;
  /** null (a client of remote servers only, as on a phone) or this computer's server. */
  local?: LocalPort | null;
  timing?: Partial<Timing>;
  /** Never given a secret. */
  log?: (line: string) => void;
  /** Fills a Uint8Array with random bytes (the ids of entries); crypto.getRandomValues when unset. */
  random?: (bytes: Uint8Array) => unknown;
};

/** The state of an entry as the page is told it. */
export type ServerState = 'connecting' | 'connected' | 'unreachable' | 'not_started' | 'certificate_not_accepted'
  | 'secret_not_accepted' | 'fingerprint_not_accepted' | 'certificate_changed' | 'name_not_known' | 'not_aiwb'
  | 'too_old' | 'another_server';

/** An entry as the page gets it: never a secret. */
export type ServerView = {
  id: string; name: string; local?: true; address?: string; selfSigned?: true; pin?: string; instanceId?: string;
  state: ServerState; detail?: string; fingerprint?: string; version?: string; agents?: string[];
};

export type AppEvent = { type: 'servers'; servers: ServerView[]; notice: string } | { type: 'server_state'; server: ServerView };

/** One thing the subscription carries: an event of a server's own stream, or one about the list of servers. */
export type Envelope = { server: string; event: unknown } | { app: AppEvent };

export type CallRequest = {
  server: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: { json: string } | { bytes: Uint8Array; type?: string } | null;
  signal?: AbortSignal;
};

/** A server's answer as it came, or one of the module's own ({"error", "code"}). */
export type CallAnswer = { status: number; text: string; sceneRev: number | null };

export type PictureRequest = { server: string; chat: string; image: string; signal?: AbortSignal };

export type PictureAnswer =
  | { ok: true; type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: Uint8Array }
  | { ok: false; status: number; text: string };

/** The answer of an operation of the app (servers.*, owner.*): never rejects. */
export type AppAnswer = { status: number; body: any };

export interface Client {
  readonly clientId: string;
  /** Opens the streams: the list and every state first, then the events of each server. A new one ends the old one. */
  subscribe(onEnvelope: (e: Envelope) => void): { close(): void };
  /** Rejects only with an AbortError. */
  call(req: CallRequest): Promise<CallAnswer>;
  /** Rejects only with an AbortError. */
  picture(req: PictureRequest): Promise<PictureAnswer>;
  app(op: string, args?: unknown): Promise<AppAnswer>;
  /** Every connection in its back-off tries now (the app came back to the foreground). Nothing else changes. */
  wake(): void;
  localInfo(): LocalInfo | null;
  close(): Promise<void>;
}

export function createClient(options: ClientOptions): Client;

/** Reads AIWB_APP_WAITS ("silence=3.5s,backoff=3s"): a partial timing; "" gives {}. Throws on a bad value. */
export function parseAppWaits(value: string | undefined | null): Partial<Timing>;

export const DEFAULT_TIMING: Readonly<Timing>;

/** The outcomes of a test and of an attempt: [step, message]. */
export const OUTCOMES: Readonly<Record<string, readonly [number, string]>>;

export class Problem extends Error implements ProblemShape {
  name: 'Problem';
  outcome: ProblemOutcome;
  detail: string;
  fingerprint: string;
  pinned: string;
  constructor(outcome: ProblemOutcome, detail?: string, extra?: { fingerprint?: string; pinned?: string });
}

export class NetError extends Error implements NetErrorShape {
  name: 'NetError';
  code: NetErrorShape['code'];
  constructor(code: NetErrorShape['code'], detail?: string);
}

/** An Error named AbortError: what an aborted operation rejects with. */
export function abortError(): Error;

/** A SHA-256 fingerprint in its normal form (upper-case pairs joined by ':'), or null. */
export function normalFingerprint(s: unknown): string | null;
