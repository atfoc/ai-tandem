// The type of `window.aiwbVoice`, the desktop app's voice face (architecture VC-5): the page asks the main process to make every call to
// the voice service, because the key stays in main (VC-3). `desktop/voice.js` is the other side. The page's `keystore.web.ts` and
// `net.web.ts` read this and nothing else of the window; where the property is missing (a browser, the checks' page) they take their
// own way (a memory key, the stand-in on the page's origin).

/** One request to the service. Only the paths and query keys of VC-5's table are allowed; main refuses the rest. */
export type VoiceBridgeRequest = {
  id: number;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  /** Test key with a key that is not stored yet. Used for this call and not stored. */
  key?: string;
};

/** The microphone's state as macOS says it. */
export type VoiceBridgeMicStatus = "granted" | "denied" | "undetermined" | "restricted";

/** What main sends back after `request` (its body follows as events) and `socket.open`. No text of the network library crosses. */
export type VoiceBridgeEvent =
  | { id: number; kind: "data"; bytes: Uint8Array }
  | { id: number; kind: "end" }
  | { id: number; kind: "error" }
  | { id: number; kind: "open" }
  | { id: number; kind: "message"; text: string }
  | { id: number; kind: "close"; code: number };

export type AiwbVoiceBridge = {
  key: { has(): Promise<boolean>; set(key: string): Promise<void>; clear(): Promise<void> };
  /** The answer's status; its body comes as `data` events, then `end` (or `error`). */
  request(req: VoiceBridgeRequest): Promise<{ status: number }>;
  cancel(id: number): void;
  socket: {
    open(o: { id: number; path: string; query: Record<string, string> }): Promise<void>;
    send(id: number, text: string): void;
    close(id: number): void;
  };
  /** A preview clip's bytes: no key, https only, a URL main saw in a voices answer it relayed. */
  preview(url: string): Promise<Uint8Array>;
  mic: {
    status(): Promise<VoiceBridgeMicStatus>;
    ask(): Promise<boolean>;
    openSettings(): Promise<void>;
  };
  /** Every event of every request and socket; returns the function that stops listening. */
  on(cb: (e: VoiceBridgeEvent) => void): () => void;
};

/** The part of the window voice reads. */
export type VoiceWindow = { aiwbVoice?: AiwbVoiceBridge };
