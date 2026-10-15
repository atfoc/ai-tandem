// The native module's API as built (see ios/AiwbNetModule.swift).

/** The code of a failure: an outcome of desktop/conn/outcomes.js or a NetError code. */
export type FailureCode =
  | 'fingerprint' | 'cert_changed' | 'tls_error' | 'not_https' | 'refused' | 'name_not_found' | 'no_route'
  | 'timeout' | 'reset' | 'too_long' | 'closed' | 'aborted';

/** What a native call rejects with: `message` is the JSON of this. */
export type NetFailureJson = { code: FailureCode; detail: string; fingerprint: string; pinned: string };

export type CallOptions = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  /** most bytes of the answer's body (request); above it the call rejects with too_long */
  maxBytes?: number;
  /** time of the whole call (request) */
  limitMs?: number;
  /** time of the answer's headers (stream) */
  headersMs?: number;
};

export type Head = { status: number; headers: Record<string, string> };
export type Answer = Head & { body: string; protocol: string; reused: boolean };

export type StreamChunkEvent = { requestId: string; text: string };
export type StreamEndEvent = { requestId: string; error: string; protocol?: string; reused?: boolean; bytes?: number; status?: number };

export type AiwbNetModuleEvents = {
  onStreamChunk: (e: StreamChunkEvent) => void;
  onStreamEnd: (e: StreamEndEvent) => void;
};
