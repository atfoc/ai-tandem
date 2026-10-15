/** The native module's types. The error of every call has `code`: an outcome of desktop/conn/outcomes.js or a NetError code. */

export type StreamEvent =
  | { id: string; kind: 'chunk'; text: string }
  | { id: string; kind: 'end'; error: string }; // error '' = the server ended the stream

export type AiwbNetModuleEvents = {
  onStream: (e: StreamEvent) => void;
};

export type OpenedSession = { id: string; fingerprint: string; alpn: string };

export type RequestOptions = {
  session: string;
  id: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  limitMs?: number;
  headersMs?: number;
  maxBytes?: number;
  responseEncoding?: 'utf8' | 'base64';
};

export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  protocol: string;
  body: string;
  bytes: number;
};

export type StreamOptions = {
  session: string;
  id: string;
  path: string;
  headers?: Record<string, string>;
  headersMs?: number;
};

export type StreamHead = { status: number; headers: Record<string, string>; protocol: string };

export type MemoryInfo = { totalPssKb: number; javaHeapKb: number; nativeHeapKb: number };
