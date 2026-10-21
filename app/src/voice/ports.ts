// The ports of voice (architecture §3.2): what the engine needs of the platform and does not have itself (the key's store, the calls to
// the voice service, the microphone and the player). The app gives its own once, in bootstrap, without starting anything (a port opens no
// socket, asks for no microphone and makes no player before the person's tap); the tests give fakes. Until a client does, every port
// rejects with "voice is not set up", so a screen that runs before bootstrap cannot reach the network or the microphone by accident.

export type VoiceProblemKind = "no_key" | "key_rejected" | "no_credits" | "mic_blocked" | "offline" | "service";

/** A voice problem that stopped a call, as an exception (the port throws it; `problems.ts` turns the rest into one). The message names the
 *  kind only: it never carries a URL, a header or a key. */
export class VoiceProblemError extends Error {
  readonly kind: VoiceProblemKind;
  constructor(kind: VoiceProblemKind) {
    super(`voice problem: ${kind}`);
    this.name = "VoiceProblemError";
    this.kind = kind;
  }
}

/** The network was not reached (no route, a timeout, a cut socket). Carries no text of the network library: it could name the URL. */
export class VoiceNetError extends Error {
  constructor() {
    super("voice: the network was not reached");
    this.name = "VoiceNetError";
  }
}

export interface Keystore {                       // goal 4.2: get, set, clear
  has(): Promise<boolean>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Native and the web build's memory store only. Electron's page has none: the key stays in main (VC-3). */
  get?(): Promise<string | null>;
}

export type NetRequest = {
  method: "GET" | "POST";
  path: string;                                   // "/v1/text-to-speech/<id>/stream", "/v2/voices", …
  query?: Record<string, string>;
  json?: unknown;
  /** Test key with a key that is not stored yet. Never logged. */
  key?: string;
};
export type NetAnswer = { status: number; body: AsyncIterable<Uint8Array>; text(): Promise<string> };
export type SocketEvents = {
  open(): void;
  message(text: string): void;
  close(code: number): void;                      // no reason text: it could echo the key or token
  error(): void;
};
export interface VoiceSocket { send(text: string): void; close(): void }

export interface VoiceNet {
  /** One call, the key added by the port (header), the answer as a stream. Rejects with VoiceNetError on no network. */
  request(r: NetRequest, signal: AbortSignal): Promise<NetAnswer>;
  /** The STT socket: path + query; the port adds the key (header) or a token (query) itself. */
  socket(path: string, query: Record<string, string>, on: SocketEvents): VoiceSocket;
  /** A preview clip's bytes; only a URL that came in a voices answer through this port (VC-5). */
  preview(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

// ---- Devices (voice-devices architecture VD-1): the types and members the engine uses to choose, find and lose a microphone or a speaker.

export type DeviceKind = "input" | "output";
/** Whether sound on this device is heard by the person alone. "unknown": the platform cannot tell (read as private when it is lost, goal 7.5). */
export type Privacy = "private" | "public" | "unknown";

/** A device as the platform reports it. `id` is the platform's id or one the port makes (VD-4); `name` is the system's name (VD-5). */
export type AudioDevice = { id: string; name: string; kind: DeviceKind; privacy: Privacy; builtIn: boolean };

/** A saved choice (VD-3): what is needed to find the device again. Never a whole AudioDevice: privacy and builtIn are read anew each time. */
export type SavedDevice = { id: string; name: string };

export type DeviceList = {
  inputs: AudioDevice[];                 // without the platform's pseudo-entries ("default", "communications")
  outputs: AudioDevice[];
  /** The system hides devices until the microphone is allowed (the web build before the permission). Only System default can be offered. */
  hidden: boolean;
  /** What "System default" is now, where the system says it (Electron's "Default - …" entry, the iOS route, Android's routed device). */
  defaults: { input: AudioDevice | null; output: AudioDevice | null };
};

/** What the platform lets voice choose (platforms.md §5). Fixed for the life of the port. */
export type DeviceAbility = {
  input: "pick" | "system";
  output: "pick" | "system";
  /** Android 12+: a headset chosen as the speaker brings its own microphone while voice talks to a chat. */
  linked: boolean;
};

/** What a start or a change of output got. `device`: what listens or plays (null: the default, whose name the port does not know).
 *  `missed`: a saved device was asked for and was not there, so the default is used (goal 3.3). */
export type Opened = { device: AudioDevice | null; missed: boolean };

/** A device in use went away during a session (goal 3.3). The port has already done the mechanical part:
 *  input-lost:  capture goes on from the system default (`now`), into the same onChunk;
 *  input-failed: capture could not go on, and the microphone is stopped;
 *  output-lost: sound goes to the system default (`now`). When `held`, the port paused the sound before any of it came out of `now`
 *               (it waits for player.resume(), or player.stop()); the engine decides whether it stays paused (VD-12). */
export type RouteEvent =
  | { kind: "input-lost"; lost: AudioDevice | null; now: AudioDevice | null }
  | { kind: "input-failed"; lost: AudioDevice | null }
  | { kind: "output-lost"; lost: AudioDevice | null; now: AudioDevice | null; held: boolean };

export interface DevicePort {
  readonly ability: DeviceAbility;
  /** The devices now. Never asks for a permission, never opens a device, never activates an audio session that would stop another app's sound. */
  list(): Promise<DeviceList>;
  /** Told when the list may have changed (plugged, unplugged, a permission given). Watching lists nothing by itself. */
  watch(f: () => void): () => void;
}

export interface MicHandle { readonly echoCancel: boolean; readonly opened: Opened; mute(on: boolean): void; stop(): Promise<void> }
export type PlayerEvent = { kind: "mark"; id: number } | { kind: "level"; level: number } | { kind: "drained" };
export interface PcmPlayer {
  /** PCM s16le mono at 24 000 Hz, queued after what is queued; plays as soon as it has enough (no gap between writes). */
  write(pcm: Uint8Array): void;
  /** A point in the queue: `mark` is emitted when playback reaches it (the start of a sentence). */
  mark(id: number): void;
  /** Stops at once and clears the queue. */
  stop(): void;
  on(f: (e: PlayerEvent) => void): () => void;
  /** Where the next sound goes: a saved device, or null for the system default. Applies to what is queued too; playClip uses the same output.
   *  Resolves with what it got; never rejects for a missing device (missed: true, the default is used). "system" output ability: resolves
   *  { device: null, missed: false } and does nothing. */
  useOutput(d: SavedDevice | null): Promise<Opened>;
  /** Pauses the sound where it is and keeps the queue (writes are still queued). */
  hold(): void;
  /** Plays on from where hold() (or a held output-lost) stopped, on the current output. */
  resume(): void;
}
export interface AudioPort {
  micPermission(): Promise<"granted" | "denied" | "undetermined">;
  /** Asks the system when undetermined; starts capture of 16 kHz mono s16le in chunks of `chunkMs`, each as base64 with its
   *  RMS level. Throws VoiceProblemError("mic_blocked") when refused. echoCancel: turn on the platform's voice processing.
   *  device: the saved microphone, or null for the system default. A saved one that is not there gives the default and opened.missed. */
  startMic(o: { chunkMs: number; echoCancel: boolean; device: SavedDevice | null; onChunk(b64: string, level: number): void }): Promise<MicHandle>;
  player: PcmPlayer;
  /** A preview clip (MP3 or WAV bytes), through the same output; resolves when it ends or is stopped. */
  playClip(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readonly canOpenMicSettings: boolean;
  openMicSettings(): Promise<void>;
  /** The system took the audio (a call, another app): the engine ends listening and speaking quietly. */
  onInterrupted(f: () => void): () => void;
  readonly devices: DevicePort;
  /** Devices lost while the microphone or the player is in use. Not told when nothing is in use. */
  onRoute(f: (e: RouteEvent) => void): () => void;
}
export type VoicePorts = { keystore: Keystore; net: VoiceNet; audio: AudioPort; now(): number; openLink(url: string): void };

/** What a port answers when the platform lets voice choose nothing: the ports until a client gives its own, and a build without the module. */
export const NO_DEVICES: DevicePort = {
  ability: { input: "system", output: "system", linked: false },
  list: () => Promise.resolve({ inputs: [], outputs: [], hidden: false, defaults: { input: null, output: null } }),
  watch: () => () => {},
};

const NOT_SET_UP = "voice is not set up";
const notSetUp = (): never => { throw new Error(NOT_SET_UP); };
const rejects = (): Promise<never> => Promise.reject(new Error(NOT_SET_UP));

/** The ports until a client gives its own: every call that would reach the network, the key or the microphone rejects (or throws, where the
 *  call is synchronous). What only stops or unsubscribes does nothing, so a clean-up after a failed start cannot fail in its turn. */
const notSet: VoicePorts = {
  keystore: { has: rejects, set: rejects, clear: rejects },
  net: { request: rejects, socket: notSetUp, preview: rejects },
  audio: {
    micPermission: rejects,
    startMic: rejects,
    player: {
      write: notSetUp, mark: notSetUp, stop() {}, on: () => () => {},
      useOutput: () => Promise.resolve({ device: null, missed: false }), hold() {}, resume() {},
    },
    playClip: rejects,
    canOpenMicSettings: false,
    openMicSettings: rejects,
    onInterrupted: () => () => {},
    devices: NO_DEVICES,
    onRoute: () => () => {},
  },
  now: () => Date.now(),
  openLink: notSetUp,
};

let ports: VoicePorts = notSet;

/** Gives voice its ports (once, in bootstrap, before any voice control is used). */
export function setVoicePorts(p: VoicePorts): void { ports = p; }

/** The ports now. */
export function voicePorts(): VoicePorts { return ports; }
