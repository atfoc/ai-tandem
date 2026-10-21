// The contract of `aiwb-audio` (architecture VC-8, goal 7.1): the microphone, the audio session and the PCM player of voice chats, on
// iOS and on Android. This file has no run-time import of the native module: it is the types. README.md says how each platform makes
// the calls and the events.

export type MicPermission = "granted" | "denied" | "undetermined";

export interface AiwbAudioNative {
  micPermission(): Promise<MicPermission>;
  requestMic(): Promise<MicPermission>;
  /** 16 kHz mono s16le chunks of chunkMs ms, as base64, with RMS 0..1. Resolves with whether voice processing is on. */
  startMic(chunkMs: number, echoCancel: boolean): Promise<{ echoCancel: boolean }>;
  setMicMuted(muted: boolean): void;             // no chunk is emitted while muted
  stopMic(): Promise<void>;
  playerWrite(pcm: Uint8Array): void;            // 24 kHz mono s16le; an odd trailing byte is kept for the next write
  playerMark(id: number): void;
  playerStop(): void;
  playClip(bytes: Uint8Array): Promise<void>;    // MP3 or WAV, from memory
  stopClip(): void;
  openSettings(): Promise<void>;                 // the app's page in the system settings
}

export type AiwbAudioEvents = {
  onMic: (e: { pcm: string; level: number }) => void;
  onPlayer: (e: { kind: "mark"; id: number } | { kind: "level"; level: number } | { kind: "drained" }) => void;
  onInterrupted: (e: { reason: "call" | "route" | "other" }) => void;
};

/** The handle `addListener` answers; Expo's EventSubscription. */
export type Subscription = { remove(): void };

/** The module as JS sees it: the functions above and Expo's `addListener` for the three events. The native one (AiwbAudioModule.ts), the
 *  fake (fake.ts) and the absence of it (null) are the three a client can be given. */
export type AiwbAudioModule = AiwbAudioNative & {
  addListener<E extends keyof AiwbAudioEvents>(name: E, listener: AiwbAudioEvents[E]): Subscription;
};

/** The code of the error `startMic` rejects with when the system gives no microphone to the app (the permission is off, or was taken
 *  back while the app ran). Every other rejection is a failure of the device. */
export const MIC_BLOCKED = "ERR_AIWB_MIC_BLOCKED";
