// The contract of `aiwb-audio` (architecture VC-8, goal 7.1): the microphone, the audio session and the PCM player of voice chats, on
// iOS and on Android. This file has no run-time import of the native module: it is the types. README.md says how each platform makes
// the calls and the events.

export type MicPermission = "granted" | "denied" | "undetermined";

/** A device as the module reports it (voice-devices VD-1, VD-18). `id` is the platform's, or the one the module makes (Android: `<family>:<address>`). */
export type NativeDevice = { id: string; name: string; kind: "input" | "output"; privacy: "private" | "public" | "unknown"; builtIn: boolean };

export interface AiwbAudioNative {
  micPermission(): Promise<MicPermission>;
  requestMic(): Promise<MicPermission>;
  /** 16 kHz mono s16le chunks of chunkMs ms, as base64, with RMS 0..1. inputId: the device to prefer (null: the default); one that has gone
   *  away gives the default. Resolves with whether voice processing is on and the device it opened (null: not known). */
  startMic(chunkMs: number, echoCancel: boolean, inputId: string | null): Promise<{ echoCancel: boolean; device: NativeDevice | null }>;
  setMicMuted(muted: boolean): void;             // no chunk is emitted while muted
  stopMic(): Promise<void>;
  playerWrite(pcm: Uint8Array): void;            // 24 kHz mono s16le; an odd trailing byte is kept for the next write
  playerMark(id: number): void;
  playerStop(): void;
  playClip(bytes: Uint8Array): Promise<void>;    // MP3 or WAV, from memory
  stopClip(): void;
  openSettings(): Promise<void>;                 // the app's page in the system settings
  /** Inputs (and outputs where the output ability is "pick"), without pseudo-entries; never prompts; never interrupts another app's audio. */
  listDevices(): Promise<{ devices: NativeDevice[]; defaultInput: string | null; defaultOutput: string | null }>;
  /** "pick" or "system" for each kind, and whether a headset is linked (Android 12+). Synchronous: a constant of the build and the OS version. */
  deviceAbility(): { input: "pick" | "system"; output: "pick" | "system"; linked: boolean };
  /** Names for the built-in devices the system names after the phone (Android); ignored where the system names them. */
  setBuiltInNames(names: { mic: string; speaker: string }): void;
  /** Where the player (and the clip) plays from now on; null: the default. Answers the device it got (null: not known). */
  setOutput(outputId: string | null): Promise<{ device: NativeDevice | null }>;
  playerHold(): void;                            // pauses the sound where it is and keeps the queue
  playerResume(): void;                          // plays on from where playerHold (or a held output loss) stopped
}

export type AiwbAudioEvents = {
  onMic: (e: { pcm: string; level: number }) => void;
  onPlayer: (e: { kind: "mark"; id: number } | { kind: "level"; level: number } | { kind: "drained" }) => void;
  /** "route" is no longer sent for a lost device (onRoute says that); calls and other apps' audio stay. */
  onInterrupted: (e: { reason: "call" | "route" | "other" }) => void;
  /** The list of devices may have changed. */
  onDevices: (e: {}) => void;
  /** A device in use went away; the module has done the mechanical part (see RouteEvent in src/voice/ports.ts). `held`: output-lost only. */
  onRoute: (e: { kind: "input-lost" | "input-failed" | "output-lost"; lost: NativeDevice | null; now: NativeDevice | null; held: boolean }) => void;
};

/** The handle `addListener` answers; Expo's EventSubscription. */
export type Subscription = { remove(): void };

/** The module as JS sees it: the functions above and Expo's `addListener` for the events. The native one (AiwbAudioModule.ts), the
 *  fake (fake.ts) and the absence of it (null) are the three a client can be given. */
export type AiwbAudioModule = AiwbAudioNative & {
  addListener<E extends keyof AiwbAudioEvents>(name: E, listener: AiwbAudioEvents[E]): Subscription;
};

/** The code of the error `startMic` rejects with when the system gives no microphone to the app (the permission is off, or was taken
 *  back while the app ran). Every other rejection is a failure of the device. */
export const MIC_BLOCKED = "ERR_AIWB_MIC_BLOCKED";
