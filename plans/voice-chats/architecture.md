# Voice chats: the architecture

The design every package of the voice-chats goal (`voice-chats-goal.md`, "the goal") follows. It settles, against the code
of branch `voice-chats` (commit `9bcf6ca`), where voice lives, its interfaces, the facts of the voice service, the native
audio, the key, the tests and the stand-in voice service. Work packages: `packages.md`. How the work is run:
`ORCHESTRATION.md`.

Decisions are numbered **VC-n** (the numbers have gaps; they are names, not an order). A decision that departs from the goal's words is marked **(departs from goal x.y)** and is
listed again in "Points for the user" at the end. A package that finds a decision wrong stops and reports; it does not
change the decision silently.

Marks as in the goal: `[user]`, `[standing]`, `[proposed]`, `[not verified]`. Everything decided here is `[proposed]` until
the user says otherwise.

---

## 1. What the code has today (the facts this design stands on)

| Need of the goal | What exists | Where |
|---|---|---|
| A "settings" page | **None.** The app has no Settings screen. The sidebar's foot has "Show archived", the Servers button, the prompt library button and the theme picker. Choices are kept in the kv port (`aiwb.theme`, `aiwb.widths`, …) | `app/src/screens/sidebar/Foot.tsx`, `app/src/platform/kv.*.ts`, `packages/core/src/state/store.ts` (`safeGet`/`safeSet`) |
| The app's settings store | The kv port: MMKV `aiwb.page` on a phone, `localStorage` on the web build (the desktop window too), read through `safeGet`/`safeSet` | `app/src/platform/kv.native.ts`, `kv.web.ts` |
| Secure store for server secrets (phone) | `expo-secure-store`, `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, keys `aiwb.secret.<entry id>` | `app/src/platform/serverstore.native.ts` (`secretVault`) |
| Secrets on the desktop | Main process only: `<userData>/client/servers.json`, 0600 in a 0700 folder, atomic write; **no secret reaches the page**; the page asks over IPC (`window.aiwbTransport`) and main adds the secret | `packages/conn/node/store.js` (`writeFileAtomic`, `ensureStateDir`), `desktop/main.js`, `desktop/ipcface.js`, `desktop/preload.js` |
| The existing secret input | `SecretInput` (hidden text, iOS bullet masking, no password autofill) | `app/src/ui/SecretInput.tsx` |
| Composer toolbar + overflow | `Toolbar.tsx` with core's fit rule (`fitWithInsert`): left controls leave in `LEAVING` order for the "more" popup; after the spacer: insert button (row/more/nowhere), attach, Stop, Send | `app/src/screens/composer/Toolbar.tsx`, `packages/core/src/logic/composerfit.ts` |
| Send path | `sendMessage(chat, text, picked, refs, images)` → `sendAt` → `api.send` with the board context (`boardApp.buildContext`) | `app/src/screens/composer/send.ts` |
| Message actions | **No Copy action on a message.** The actions are the fork actions (Branch, Branch and edit, Fork, Fork and edit, Label): a bar on mouse hover, a "⋯" menu on touch | `app/src/screens/fork/Message.tsx` (`MessageExtras`), `packages/core/src/logic/forkmessage.ts` |
| Reply stream | `chat_items` events update `State.items[branchKey(chat, branch)]` (only for a loaded list); a reply is a `text` item whose `text` grows, `done` when finished | `packages/core/src/state/conn.ts` (`applyItems`, `loadItems`), `packages/core/src/types.ts` (`Item`) |
| Stored form of a sent message | `{kind:"user", text, context?, references?, images?}`; the server drops `context` of a plain chat and gives a board chat's `context` to the agent | `internal/chats/manager.go` (read only) |
| Board screen | `BoardCanvas` draws `BoardHost` and the overlays (`FlashLayer`, `Presence`, `RoleBar`, `SaveBanner`, `DroppedNote`) | `app/src/screens/board/BoardCanvas.tsx`, `Overlays.tsx` |
| Sidebar "+" on a board row | `newChat({board})` in the shell's nav, which also **opens** the chat (`openChat`); the row's expanded state is local `useState(true)` | `app/src/screens/shell/nav.ts`, `app/src/screens/sidebar/rows.tsx` (`BoardNode`) |
| The board's chats as the sidebar lists them | `boardChats(chats, board, showArchived)` | `packages/core/src/logic/tree.ts` |
| Last used chat of a board | `lastChat` (kv `aiwb.lastChat`), set by `select` | `packages/core/src/state/store.ts` |
| Selection reference | `boardApp.selectionRefOn(board)` → `Ref`; written into the text as a tag by `serializeRef` | `packages/core/src/board/side.ts`, `packages/core/src/logic/refs.ts` |
| Popovers, dialogs, sheets | `Overlay` (popover on wide layouts, sheet on the phone), `Popover`, `Dialog`, `Menu` | `app/src/ui/*` |
| The app's own native modules | `aiwb-net` (pinned HTTP/2), `aiwb-keys` (hardware keys): contract `src/*.ts`, `requireOptionalNativeModule`, `.web.ts` = null, `fake.ts`, Swift, Kotlin, a test that checks the lists against the native sources | `app/modules/*` |
| Audio libraries | **None** in `app/package.json`. `expo/fetch` (streaming bodies) is part of `expo`. `react-native-mmkv`, `expo-secure-store` are there | `app/package.json` |
| "No plain HTTP" | `app/test/noplainhttp.test.ts` fails on any `fetch(`, `new WebSocket`, `new XMLHttpRequest`, `http://` text in `app/src` and `app/modules/*/src`, and on `URL(` in Swift outside `httpsURL` | `app/test/noplainhttp.test.ts` |
| Microphone today | Deliberately **none**: tests assert `microphonePermission: false` for the camera and image picker plugins | `app/app.config.ts`, `app/test/appconfig.s12.test.ts`, `appconfig.k4.test.ts` |
| CSP | `connect-src 'none'` shipped, `'self'` with `--connect-self` (tests); no `media-src` (falls back to `default-src 'none'`) | `app/scripts/export-web.mjs` (`cspFor`) |
| Test page and mock | The web build in Playwright, its transport over HTTP (`/host/*`) to the test host (`web/dev/host.mjs`) or the mock (`web/dev/mock.mjs`), both through `web/dev/hostface.mjs`; checks in `web/dev/checks`, driver `web/dev/shot.mjs` | `web/dev/*` |
| Device tests | Maestro flows `app/e2e/maestro/*.yaml`, runner `app/e2e/run.mjs`, build-time `EXPO_PUBLIC_AIWB_*` variables (`app/src/dev/selftestEnv.ts`) | `app/e2e/*` |

Checked by a quick spike on this machine (`/tmp/vc-arch-spike`, removed): Node 24's and **Electron 44's** (Node 24.21) global
`WebSocket` send a custom `xi-api-key` header (`new WebSocket(url, { headers })`); React Native 0.86's `WebSocket` takes
`new WebSocket(url, protocols, { headers })` and passes the headers to the native socket (read in
`node_modules/react-native/Libraries/WebSocket/WebSocket.js`).

---

## 2. The voice service: what ElevenLabs offers (goal 7.6)

Read on 2026-10-20 from ElevenLabs' public documentation; **no call was made to the service**. Every name here is a constant
of `app/src/voice/logic/protocol.ts` (and of the stand-in, §13), so a change of the service is a change in one file.

### 2.1 Realtime speech to text (Scribe) — a WebSocket

Source: <https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime>

- **URL:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
- **Auth:** header `xi-api-key: <key>`, **or** query `token=<single-use token>` (for a browser).
- **Query** (the ones voice uses): `model_id=scribe_v2_realtime` (the only value of the enum, and the default);
  `audio_format=pcm_16000` (default); `language_code=<ISO 639-1/3>` (omitted for auto-detect); `commit_strategy=vad`
  (`manual` | `vad` | `turn_prediction`); `vad_silence_threshold_secs=<seconds>`; `include_timestamps=false` (default).
  Others exist (`vad_threshold`, `min_speech_duration_ms`, `min_silence_duration_ms`, `keyterms`, `keepalive_interval_ms`
  500–10000, `enable_logging`, …); voice does not send them.
- **Client → service:** text frames, JSON:
  `{"message_type":"input_audio_chunk","audio_base_64":"<base64 PCM>","commit":false,"sample_rate":16000}` — all four
  fields required. `commit: true` asks the service to commit what it has (voice sends it at Send with an empty
  `audio_base_64`). `previous_text` may be sent with the first chunk only; voice does not send it.
- **Service → client:** text frames, JSON, by `message_type`:
  - `session_started` `{session_id, config}`;
  - `partial_transcript` `{text}` — a live guess that may change;
  - `committed_transcript` `{text}` — stable text of a segment;
  - `committed_transcript_with_timestamps`, `committed_transcript_entities`, `edited_transcript` — not asked for, ignored;
  - `warning` `{warning}` — ignored (logged without content);
  - errors, each `{message_type, error}`: `error`, `auth_error`, `quota_exceeded`, `commit_throttled`, `unaccepted_terms`,
    `rate_limited`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`, `input_error`,
    `invalid_request`, `chunk_size_exceeded`, `insufficient_audio_activity`, `transcriber_error`.
- Chunk size: the docs give none; their examples send 4096 samples (256 ms) every 50 ms or 8 KB per 100 ms. **Voice sends
  100 ms chunks** (1600 samples, 3200 bytes, 4268 base64 characters) `[proposed]`, inside the goal's 100–250 ms.

### 2.2 Single-use token (for a browser socket)

Source: <https://elevenlabs.io/docs/api-reference/tokens/create>

- `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe` with `xi-api-key`; types `realtime_scribe`,
  `batch_scribe`, `tts_websocket`. Answer `{"token":"sutkn_…"}`; it expires after 15 minutes and is consumed on use.
- Used **only by the web build's page-direct path** (tests, §5). Phones and Electron set the header (VC-4).

### 2.3 Streaming text to speech — one HTTP request per sentence

Source: <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>

- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000`
- Headers `xi-api-key`, `Content-Type: application/json`.
- Body: `{"text": "<one sentence>", "model_id": "eleven_flash_v2_5", "language_code"?: "<iso>",
  "voice_settings"?: {"speed": <0.7–1.2>}}`. Other fields (`previous_text`, `next_text`, `previous_request_ids`,
  `apply_text_normalization`) are **not sent** (goal 4.8: only the sentence).
- Answer 200: a chunked body of raw PCM, signed 16-bit little-endian, mono, 24 000 Hz, no header, no JSON wrapper. A chunk may
  end in the middle of a sample: the player keeps the odd byte for the next chunk.
- `output_format` values include `pcm_8000 … pcm_48000`, `mp3_*`, `opus_*`, `ulaw_8000`, `alaw_8000`; `pcm_44100` needs a
  Pro tier, `pcm_24000` does not.
- `voice_settings` "overrides stored voice settings for this request only" `[not verified]` whether the others fall to
  their defaults when only `speed` is sent: **voice sends `voice_settings` only when the speed is not 1.0.**

### 2.4 Voices (Test key, the list, preview clips)

Source: <https://elevenlabs.io/docs/api-reference/voices/search>

- `GET https://api.elevenlabs.io/v2/voices?page_size=<1–100>&next_page_token=…&search=…&sort=name&include_total_count=true`
- Answer: `{voices: [{voice_id, name, description, labels, preview_url, category, …}], has_more, total_count,
  next_page_token}`. `preview_url` is a public clip (an MP3, today on a Google Cloud Storage host): playing it costs no
  credits (goal 4.9).
- **Test key** = `GET /v2/voices?page_size=1&include_total_count=true`: 200 → "works, N voices" (`total_count`), else the
  problem of §2.6.

### 2.5 Model ids

Source: <https://elevenlabs.io/docs/overview/models>

| Use | Id | Note |
|---|---|---|
| TTS default ("Flash v2.5, fastest and cheapest") | `eleven_flash_v2_5` | ~75 ms, 32 languages |
| TTS alternative in Advanced ("v4 Turbo") | `eleven_v4_turbo` | the real-time v4 model, ~100 ms median inference, 90+ languages; takes `language_code` |
| TTS alternative in Advanced ("Multilingual v2") | `eleven_multilingual_v2` | richer, slower; ignores `language_code` |
| STT realtime ("Scribe v2 Realtime") | `scribe_v2_realtime` | the only realtime model |
| Deprecated, not offered | `eleven_turbo_v2_5`, `eleven_turbo_v2`, `scribe_v1` | |

The Advanced list is fixed in code (`protocol.ts` `TTS_MODELS`, `STT_MODELS`) `[proposed]`: three TTS models (Flash v2.5, v4 Turbo, Multilingual v2, in that order), one STT model.
`eleven_v3` and `eleven_v4` are not offered: their streaming latency for one sentence is not documented.

### 2.6 Errors

Sources: <https://elevenlabs.io/docs/eleven-api/resources/errors>,
<https://elevenlabs.io/docs/help-center/technical/api-error-code-400-or-401>,
<https://elevenlabs.io/docs/help-center/technical/api-error-code-429>

Body: `{"detail": {"type", "code", "message", "status" (legacy), "request_id", "param"}}`. The older docs show
`{"detail": {"status": "invalid_api_key" | "quota_exceeded", "message"}}` with HTTP 401. Voice reads `detail.code`, then
`detail.status`, then the HTTP status:

| HTTP / message | code / status | Voice problem (§12) |
|---|---|---|
| 401 | `quota_exceeded` (legacy) | `no_credits` |
| 401 | `invalid_api_key`, `missing_api_key`, anything else | `key_rejected` |
| 403 | `insufficient_permissions`, … (a key without the voices or TTS permission) | `key_rejected` |
| 402 | `insufficient_credits` | `no_credits` |
| 429 | `rate_limit_exceeded`, `concurrent_limit_exceeded`, `system_busy` | `no_credits` (the goal's one sentence for "out of credits, or rate limited") |
| 5xx, network error, abort by timeout | | `offline` |
| STT `auth_error` | | `key_rejected` |
| STT `quota_exceeded`, `rate_limited`, `commit_throttled`, `queue_overflow`, `resource_exhausted` | | `no_credits` |
| STT `session_time_limit_exceeded`, `insufficient_audio_activity` | | no problem: the listener reopens the socket at the next audio (VC-19) |
| STT `unaccepted_terms` | | `no_credits` words are wrong for it: `service` (see §12) with action Open ElevenLabs |
| STT `error`, `input_error`, `invalid_request`, `chunk_size_exceeded`, `transcriber_error` | | `offline` ("Can't reach ElevenLabs." / Try again) |
| A socket that fails before `session_started` (no status is visible to a WebSocket) | | classified by one `GET /v2/voices?page_size=1`: 401/403 → `key_rejected`, 402/429 → `no_credits`, network → `offline`, 200 → `offline` |

CORS for a page calling `api.elevenlabs.io` with `xi-api-key` is **not documented** `[not verified]`; ElevenLabs tells
browsers to use single-use tokens. This is one reason for VC-4.

---

## 3. Where voice lives (goal 4.5)

**VC-1. Voice is one module of the app, `app/src/voice/`, with its screens in `app/src/screens/voice/`, one native module
`app/modules/aiwb-audio/`, and the desktop's half in `desktop/voice.js`.** Nothing of voice goes into `@aiwb/core` except the
toolbar's fit rule (VC-17), which is core's already. The Go server is not touched (goal 4.1).

```
app/src/voice/
  index.ts              the public face: `voice` (the controller) and the hooks; screens import from here only
  words.ts              every sentence voice shows (English; goal §8)
  logic/                pure TypeScript, no React, no react-native, no ports: runs under `node --test`
    speech.ts           markdown → words to say (VC-25)
    sentences.ts        the streaming sentence splitter (VC-26)
    protocol.ts         ElevenLabs constants, URLs, query, frames, event parsing (§2)
    problems.ts         answer/event/exception → VoiceProblem (§2.6)
    turn.ts             the turn machine: words, quiet, countdown, send (VC-20)
    settings.ts         VoiceSettings: type, defaults, parse, clamp (VC-14)
    marks.ts            the device-local mic marks: model and pruning (VC-23)
    pcm.ts              Float32 → Int16 16 kHz, base64, RMS level, odd-byte carry (web)
  ports.ts              the port types and `setVoicePorts`/`voicePorts` (as core's ports.ts does)
  platform/             one file per platform, chosen by Metro's `.native.ts` / `.web.ts`
    keystore.native.ts  expo-secure-store (VC-3)
    keystore.web.ts     Electron: the main process over `window.aiwbVoice`; else memory (VC-3)
    net.native.ts       RN WebSocket with header + expo/fetch streaming (VC-4)
    net.web.ts          Electron: relayed by main over `window.aiwbVoice`; else page-direct to the stand-in (VC-4)
    origin.ts           the one place an address of the voice service is made (VC-6)
    audio.native.ts     over `app/modules/aiwb-audio` (VC-8)
    audio.web.ts        Web Audio: getUserMedia + ScriptProcessor, AudioContext player (VC-10)
  engine/               platform-free, uses only the ports: tested under `node --test` with fakes
    state.ts            the voice store (session, problem, reading) and the settings store, with subscribe
    player.ts           the one audio queue (VC-11)
    speaker.ts          sentences → TTS requests → player (VC-12)
    listener.ts         the STT socket session (VC-19)
    session.ts          dictation, speech mode, the pill: one session at a time (VC-18)
    reply.ts            follows a chat's reply in the store and feeds the speaker (VC-22)
    keycheck.ts         Test key and the voice list
    testseam.ts         `window.__aiwbVoice` in a build for the checks (VC-32)
app/src/screens/voice/  the screens (register themselves as the other areas do)
  index.ts              registers the Settings dialog in the `Overlays` slot, the chat parts, the board pill
  SettingsDialog.tsx    Settings > Voice (VC-13)
  SettingsButton.tsx    the foot's gear button
  ProblemPopover.tsx    the "needs your key" popover and every failure (VC-30)
  ComposerVoice.tsx     Dictate and Speech mode controls (VC-17)
  SpeechBar.tsx         the speech bar (VC-17)
  ReadAloud.tsx         the message action (VC-24)
  MicMark.tsx           the mic mark in the thread (VC-23)
  pill/Pill.tsx, Orb.tsx, ChatChip.tsx, Captions.tsx, Waveform.tsx   the board pill (VC-28)
app/modules/aiwb-audio/ the native microphone, audio session and PCM player (VC-8)
desktop/voice.js        the key file and the relay of voice calls in the main process (VC-3, VC-4)
web/dev/voicestandin.mjs  the stand-in voice service (VC-31)
```

### 3.1 The public face (`app/src/voice/index.ts`)

```ts
export type VoiceProblemKind = "no_key" | "key_rejected" | "no_credits" | "mic_blocked" | "offline" | "service";
export type VoiceProblem = { kind: VoiceProblemKind; /** where the popover hangs: the control that was tapped */ anchor: string; retry?: () => void };

export type SessionOwner =
  | { kind: "dictation"; chat: string; branch: string }
  | { kind: "speech"; chat: string; branch: string }
  | { kind: "pill"; board: string };

export type Phase =
  | "idle" | "starting"          // asking for the mic / opening the socket
  | "listening"                  // words may come; no countdown
  | "countdown"                  // Auto-send: the pause ran, the turn goes when it ends (Cancel stops it)
  | "waiting"                    // Tap to send: words wait for Send (the ↑ badge)
  | "sending" | "thinking"       // the turn is on its way / the agent works and nothing is spoken yet
  | "speaking";                  // the reply is being spoken

export type SessionState = {
  owner: SessionOwner | null;
  phase: Phase;
  committed: string;             // finished words of the turn
  partial: string;               // the live guess
  level: number;                 // 0..1, the mic's while listening, the player's while speaking (the waveform, the orb's ring)
  muted: boolean;
  countdown: { startedAt: number; ms: number } | null;
  spoken: string;                // the sentence being spoken (speech bar, captions)
  target: string | null;         // pill: the chat the turn goes to
};

export type ReadingState = { key: string | null };   // "read:<chat>:<branch>:<index>" of the message being read

export const voice: {
  startDictation(o: { chat: string; branch: string; anchor: string; sink: DictationSink }): Promise<void>;
  /** send: the composer's `sendMessage(chat, text)` (VC-21); the engine imports no screen. */
  startSpeech(o: { chat: string; branch: string; anchor: string; send(text: string): Promise<unknown> }): Promise<void>;
  /** target: the chat the turn goes to, made by `newChat({board}, {open: false})` when the board has none (VC-29);
   *  send: `sendMessage(chat, text)` with the selection's tag before the words when the chip is on (VC-28). */
  startPill(o: { board: string; anchor: string; target(): Promise<string | null>; send(chat: string, text: string): Promise<unknown> }): Promise<void>;
  end(): void;                   // End: stops listening and speaking, closes the socket
  mute(on: boolean): void;       // Mute: no audio is sent; the socket stays
  send(): void;                  // Send / the ↑ badge
  cancelCountdown(): void;       // Cancel: keeps the words, no send
  interrupt(): void;             // tap barge-in: stops speaking, back to listening
  readAloud(o: { chat: string; branch: string; index: number; text: string; anchor: string }): Promise<void>;
  stopReading(): void;
  testKey(key?: string): Promise<{ ok: true; voices: number } | { ok: false; problem: VoiceProblemKind }>;
  hasKey(): Promise<boolean>;
  setKey(key: string): Promise<void>;
  removeKey(): Promise<void>;
  voices(o?: { all?: boolean; search?: string; cursor?: string }): Promise<VoiceList>;
  playPreview(voiceId: string): Promise<void>;
  dismissProblem(): void;
};

export type DictationSink = {
  /** The box's text is base + committed + partial: called on every change; the composer puts it into the box. */
  show(text: { committed: string; partial: string }): void;
  /** Dictation ended; `committed` is final. */
  done(committed: string): void;
};

export function useVoiceSession<T>(select: (s: SessionState) => T): T;
export function useVoiceSettings<T>(select: (s: VoiceSettings) => T): T;
export function setVoiceSettings(patch: Partial<VoiceSettings>): void;
export function useVoiceProblem(): VoiceProblem | null;
export function useReading(): ReadingState;
export function useSpokenMark(chat: string, branch: string, index: number): boolean;
export type VoiceList = { voices: VoiceInfo[]; total: number; cursor: string | null };
export type VoiceInfo = { id: string; name: string; about: string; previewUrl: string | null };
```

The screens call `voice.*` and the hooks and nothing below them (goal 4.5: "the screens call it; they do not each carry a
piece of it").

### 3.2 The ports (`app/src/voice/ports.ts`)

```ts
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

export interface MicHandle { readonly echoCancel: boolean; mute(on: boolean): void; stop(): Promise<void> }
export type PlayerEvent = { kind: "mark"; id: number } | { kind: "level"; level: number } | { kind: "drained" };
export interface PcmPlayer {
  /** PCM s16le mono at 24 000 Hz, queued after what is queued; plays as soon as it has enough (no gap between writes). */
  write(pcm: Uint8Array): void;
  /** A point in the queue: `mark` is emitted when playback reaches it (the start of a sentence). */
  mark(id: number): void;
  /** Stops at once and clears the queue. */
  stop(): void;
  on(f: (e: PlayerEvent) => void): () => void;
}
export interface AudioPort {
  micPermission(): Promise<"granted" | "denied" | "undetermined">;
  /** Asks the system when undetermined; starts capture of 16 kHz mono s16le in chunks of `chunkMs`, each as base64 with its
   *  RMS level. Throws VoiceProblemError("mic_blocked") when refused. echoCancel: turn on the platform's voice processing. */
  startMic(o: { chunkMs: number; echoCancel: boolean; onChunk(b64: string, level: number): void }): Promise<MicHandle>;
  player: PcmPlayer;
  /** A preview clip (MP3 or WAV bytes), through the same output; resolves when it ends or is stopped. */
  playClip(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Speaking may interrupt the model here (VC-9): the platform gives echo cancellation. */
  readonly voiceBargeIn: boolean;
  readonly canOpenMicSettings: boolean;
  openMicSettings(): Promise<void>;
  /** The system took the audio (a call, another app): the engine ends listening and speaking quietly. */
  onInterrupted(f: () => void): () => void;
}
export type VoicePorts = { keystore: Keystore; net: VoiceNet; audio: AudioPort; now(): number; openLink(url: string): void };
export function setVoicePorts(p: VoicePorts): void;
export function voicePorts(): VoicePorts;
```

`app/src/bootstrap.ts` gives the ports (`setVoicePorts(platformVoicePorts())`) **without starting anything**: no port opens a
socket, asks for the mic or makes a player before the person's tap (goal 3.9, 6.7). `audio.native.ts` loads the native
module lazily on first use.

---

## 4. The key (goal 4.2)

**VC-2. One keystore interface, four stores; the rest of voice does not know where the key is.**

| Platform | Store | Where the key is used |
|---|---|---|
| iOS, iPadOS | `expo-secure-store`, key `aiwb.voice.elevenlabs`, `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (the same options as `secretVault`): not in an iCloud backup or a transfer | the page's JS: read by `net.native.ts` when a call starts, put in the header, dropped |
| Android | `expo-secure-store` (Android Keystore, hardware-backed where the phone has it), same key; the app already keeps the secure store out of auto backup (`configureAndroidBackup: true`) | as iOS |
| Desktop (Electron) | `<userData>/client/voice-key`, the key and a newline, mode 0600, folder 0700, written atomically by the main process with `writeFileAtomic`/`ensureStateDir` of `@aiwb/conn/node` (exported from `node/index.js` if they are not yet) | **only in the main process** (VC-3) |
| Web build (tests only) | a variable in memory; gone on reload; nothing in `localStorage`, `sessionStorage`, IndexedDB or a cookie | `net.web.ts` page-direct |

**VC-3. On the desktop the key never enters the page** (departs from goal 7.4's premise, see VC-4). This is "the same flow the
server secrets use now" (goal 4.2): the page asks the main process over IPC, the main process reads the file and makes the
call with the header, the page gets the answer. The page's keystore on Electron is `{has, set, clear}` with no `get`. The key
typed in Settings crosses once, page → main, in `voice.key.set`; the page drops it from its state as soon as the call
returns.

**When the key is read.** At the start of each voice call: `net.*` asks the keystore (`get()` on native and web memory;
main's `readKey()` on Electron) for every `request` and `socket`, uses it for that call and keeps no copy. Nothing reads the
key at start-up. `has()` is read when a voice control is tapped (to show the no-key popover) and when Settings > Voice opens.

**Never elsewhere.** The key is never in `VoiceSettings`, the kv, a log line (`console.*` of voice prints codes and
statuses only), the text of an error (`problems.ts` builds problems from status and code, never from a URL or a header), the
aiwb server's traffic, a board or a chat. `Remove key from this device` calls `clear()`: secure store delete / file unlink /
memory reset. The test of 6.3 (§14.3) proves it with a recognisable key.

---

## 5. Reaching the voice service (goal 4.3, 7.2, 7.4)

**VC-4. Who makes the calls, per platform** (departs from goal 4.4 and 7.4: the page's CSP is **not** changed).

| Platform | STT socket | TTS, voices, preview | Why |
|---|---|---|---|
| iOS, Android | RN `new WebSocket(url, [], { headers: { "xi-api-key": key } })` | `fetch` of `expo/fetch` (streamed body) with the header | RN sockets take headers (§1); no CORS on a phone |
| Desktop | **main process**: Node's global `WebSocket(url, { headers })` (checked in Electron 44) | main process: Node `fetch`, the body streamed to the page over IPC | the key stays in main (VC-3); a browser socket cannot set a header; CORS of `api.elevenlabs.io` is undocumented |
| Web build (tests) | page: `POST /v1/single-use-token/realtime_scribe` (key header) then `new WebSocket(url + "&token=…")` | page: `fetch` with the header, to the stand-in on the page's own origin | the goal's token path (4.3) is exercised here |

Consequences:

- **No CSP change.** The Electron page talks only to main (IPC), as today; the web build talks to the stand-in on its own
  origin, which `connect-src 'self'` of a `--connect-self` build already allows. The shipped export keeps
  `connect-src 'none'`. `getUserMedia` and Web Audio need no CSP source; clips are decoded from bytes (`decodeAudioData`), so
  no `media-src` is needed. The goal's "allow `api.elevenlabs.io` over https and wss and nothing wider" is met by allowing
  nothing. If the user wants the page to call ElevenLabs itself instead, the change is `cspFor({ voice: true })` adding
  `https://api.elevenlabs.io wss://api.elevenlabs.io` to `connect-src` and the page holding the key: a point for the user (§16).
- The desktop's voice traffic goes `page → IPC → main → api.elevenlabs.io`; audio chunks cross IPC (32 KB/s up, 48 KB/s down:
  small).

**VC-5. The desktop's IPC face for voice** (`desktop/voice.js`, registered by `ipcface.js`, exposed by `preload.js` as
`window.aiwbVoice`). Every channel checks the sender as `aiwb:*` does (`fromAppWindow`).

```
window.aiwbVoice = {
  key: { has(): Promise<boolean>; set(key: string): Promise<void>; clear(): Promise<void> },
  request(req: { id, method, path, query?, json?, key? }): Promise<{ status }>   // body chunks follow as events
  cancel(id): void
  socket: { open({ id, path, query }): Promise<void>; send(id, text): void; close(id): void },
  preview(url): Promise<Uint8Array>,
  mic: { status(): Promise<"granted"|"denied"|"undetermined"|"restricted">; ask(): Promise<boolean>; openSettings(): Promise<void> },
  on(cb: (e) => void): () => void      // e: { id, kind: "data", bytes } | { id, kind: "end" } | { id, kind: "error" }
                                       //    | { id, kind: "open" | "message" | "close", text?, code? }
}
```

Channels: `aiwb:voice` (invoke `{op, args}`), `aiwb:voice-cancel`, `aiwb:voice-send` (`ipcRenderer.send`), events
`aiwb:voice-event`. Main allows only these calls, and nothing else is ever sent with the key:

| Op | Method and path | Query keys allowed |
|---|---|---|
| request | `POST /v1/text-to-speech/{voice_id}/stream` (`voice_id` `^[A-Za-z0-9]{1,64}$`) | `output_format` |
| request | `GET /v2/voices` | `page_size`, `next_page_token`, `search`, `sort`, `sort_direction`, `include_total_count` |
| socket | `/v1/speech-to-text/realtime` | `model_id`, `audio_format`, `language_code`, `commit_strategy`, `vad_silence_threshold_secs`, `include_timestamps` |
| preview | `GET <preview_url>` with **no key**, https only, and only a URL main saw in a `/v2/voices` answer it relayed (it reads the body anyway); at most 2 MB | |

Main reads the key file at each `request`/`socket` (VC-3). `key` in `request` (Test key of a typed key) is used for that call
and not stored. An answer's body is streamed as `data` events (no copy kept). Errors cross as `{status}` or `error` with no
text from the network library (it could name the URL). macOS microphone: `systemPreferences.getMediaAccessStatus` /
`askForMediaAccess`; Info.plist `NSMicrophoneUsageDescription` through `electron-builder.yml` `mac.extendInfo`; a
`session.setPermissionRequestHandler` that grants `media` with audio only to the app's own page and leaves every other
permission as Electron answers it today. `openSettings` opens
`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` with `shell.openExternal`.

**VC-6. One place makes an address of the voice service: `app/src/voice/platform/origin.ts`.**

```ts
export const VOICE_HTTP = "https://api.elevenlabs.io";
export const VOICE_WS = "wss://api.elevenlabs.io";
export function voiceURL(kind: "http" | "ws", path: string, query: Record<string, string>): string;
```

- **Native:** the base is `VOICE_HTTP`/`VOICE_WS`, unless the build has `EXPO_PUBLIC_AIWB_VOICE_BASE` **and** `__DEV__` is
  true **and** its host is `127.0.0.1`, `localhost`, `10.0.2.2` or a private IPv4 address: then the stand-in (§13) at that
  base (`ws` from `http`). A Release build ignores it. The value comes from the environment at bundle time, so the source
  holds no `http://` text.
- **Electron main:** `AIWB_VOICE_BASE`, honoured only when `!app.isPackaged` and the host is loopback; else the constants.
- **Web build:** page-direct only exists in the HTTP way (the test host and the mock), and there the base is always
  `location.origin + "/voice"`: the shipped page (file://, IPC way) never takes this path.

**VC-7. "No plain HTTP" gets one named second way out.** `app/test/noplainhttp.test.ts` is changed to allow `fetch(` and
`new WebSocket` in exactly `app/src/voice/platform/net.native.ts` and `net.web.ts`, and adds checks that those two files
contain no `http://` and build every address with `voiceURL` (`origin.ts`) or a preview URL from the allowlist. AD-36's rule
for the servers (`aiwb-net` only) is unchanged. `aiwb-audio`'s Swift builds no `URL(` (clips are bytes), so the Swift rule
stands.

---

## 6. Native audio (goal 7.1, 7.3, 8)

**VC-8. The app builds its own Expo module, `app/modules/aiwb-audio`** `[proposed]` (goal §8: "which module, whether the app
builds its own"). Not a library: the app needs voice-processing I/O on the same engine that plays (echo cancellation for
voice barge-in), exact 16 kHz s16 chunks, a PCM queue with marks and no gap, and audio-session control — a small surface
that no installed library gives, and that the app's practice (`aiwb-net`, `aiwb-keys`) already builds. Considered and not
chosen: `react-native-audio-api` (a large C++ audio engine; compatibility with RN 0.86 / Expo 57 unchecked), `expo-audio`
(records to a file, no PCM stream, no PCM playback), `@siteed/expo-audio-studio` (capture only).

Layout as `aiwb-keys`: `src/AiwbAudio.ts` (the contract), `src/AiwbAudioModule.ts`
(`requireOptionalNativeModule("AiwbAudio")`, null in an older build), `src/AiwbAudioModule.web.ts` (null), `src/fake.ts`,
`ios/AiwbAudioModule.swift` (+ podspec), `android/src/main/java/expo/modules/aiwbaudio/AiwbAudioModule.kt`,
`expo-module.config.json`, `README.md`; the adapter `app/src/voice/platform/audio.native.ts` (`audioOver(module): AudioPort`);
test `app/test/aiwbaudio.test.ts` (adapter over the fake; event and function names against the Swift and Kotlin sources).

```ts
// app/modules/aiwb-audio/src/AiwbAudio.ts
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
```

**iOS** (`AVAudioEngine`, one engine for capture and playback):
- Session: while listening, category `.playAndRecord`, mode `.voiceChat`, options `.defaultToSpeaker`, `.allowBluetoothHFP`;
  while only playing (Read aloud, preview), `.playback` with mode `.spokenAudio`. Activated at start, deactivated with
  `.notifyOthersOnDeactivation` when nothing runs. Interruption and route-change notifications end the session
  (`onInterrupted`).
- Capture: `inputNode.setVoiceProcessingEnabled(true)` when `echoCancel` (Apple's echo cancellation of what the same engine
  plays); a tap on the input node; `AVAudioConverter` to 16 kHz mono Int16; chunks of `chunkMs`; RMS per chunk.
- Playback: an `AVAudioPlayerNode` on the same engine, `scheduleBuffer` of 24 kHz Int16 → the mixer's format; buffers are
  scheduled back to back, so there is no gap; a mark is a completion callback on the buffer it precedes.
- Permission: `AVAudioApplication.requestRecordPermission`. `Info.plist` `NSMicrophoneUsageDescription` (app.config).
- Clips: `AVAudioPlayer(data:)`.

**Android** (`AudioRecord` + `AudioTrack`):
- Capture: `AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, 16000, MONO, PCM_16BIT)`;
  `AcousticEchoCanceler.create(sessionId)` and `NoiseSuppressor` when `isAvailable()`; `echoCancel` in the answer is whether
  the canceller was created. `AudioManager.MODE_IN_COMMUNICATION` while listening with echo cancellation, back to
  `MODE_NORMAL` after; speaker routing with `setCommunicationDevice` (API 31+) or `isSpeakerphoneOn`.
- Playback: `AudioTrack` `MODE_STREAM`, 24 kHz mono PCM 16, usage `USAGE_VOICE_COMMUNICATION` while listening, else
  `USAGE_ASSISTANT`; a writer thread drains a queue; marks by frame position (`setNotificationMarkerPosition` or polling
  `playbackHeadPosition`).
- Audio focus: `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` while listening, `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` while playing;
  loss → `onInterrupted`.
- Permissions: `RECORD_AUDIO` (runtime), `MODIFY_AUDIO_SETTINGS` (app.config `android.permissions`).
- Clips: `MediaPlayer` with a `MediaDataSource` over the bytes.

**App config.** `ios.infoPlist.NSMicrophoneUsageDescription`: "AI Whiteboard listens only while you dictate or talk to a
chat, and sends what it hears to ElevenLabs with your own key." `android.permissions: ["RECORD_AUDIO",
"MODIFY_AUDIO_SETTINGS"]`. The camera and image picker plugins keep `microphonePermission: false` (their own audio is still
not wanted); the tests of S12 and K4 stay, and a new test asserts the voice texts and permissions. No `UIBackgroundModes`:
no listening in the background (goal §5).

**VC-9. Echo cancellation and voice barge-in (goal 7.3).** `AudioPort.voiceBargeIn` is true on iOS and on an Android device
whose `startMic` answered `echoCancel: true`; false on the desktop and the web build. Tap barge-in ships everywhere.

2026-10-21: superseded. Voice barge-in is removed on every platform, and `AudioPort.voiceBargeIn` with it, because the echo
of the reply was transcribed as the person's words. The mic sends nothing until the reply is over or tapped
(`docs/architecture.md`, "Interrupting").

- **Shipped where `voiceBargeIn`:** in speech mode and the pill, while the reply is spoken, the mic keeps sending chunks (with
  voice processing on); a `partial_transcript` of at least 2 words that is not mostly the words being spoken (fewer than
  half its words are in the current sentence: the echo that leaked) interrupts: the player stops, the queue clears, the TTS
  requests are cancelled, and the partial starts the next turn. `[not verified]` on devices: the person confirms it on a
  phone (§14.4).
- **Not shipped on the desktop and the web build:** Chromium's `echoCancellation: true` is documented to cancel what the
  browser plays, but whether it cancels Web Audio output on macOS is not established; a model that interrupts itself is worse
  than no voice barge-in. There, while the reply is spoken, **no chunk is sent** (the mic is muted by the engine), and the
  person interrupts with a tap. The speech bar's and the orb's tooltips say "Tap to interrupt". This is written in
  `docs/architecture.md` by P18.

**VC-10. Web and Electron audio (`audio.web.ts`).**
- Mic: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })`
  → `AudioContext` → `MediaStreamAudioSourceNode` → `ScriptProcessorNode(4096, 1, 1)` → `pcm.ts` resamples to 16 kHz
  Int16 and cuts 100 ms chunks. Not an AudioWorklet: its module would load from a `file://` page under `script-src 'self'`,
  which is not sure in Electron; `ScriptProcessorNode` is deprecated but present in Chromium 152/156. A
  `NotAllowedError`/`SecurityError` is `mic_blocked`. Electron asks `aiwbVoice.mic.ask()` first (the macOS prompt) and
  `openMicSettings` is `aiwbVoice.mic.openSettings()`; the web build has `canOpenMicSettings: false`.
- Player: one `AudioContext({ sampleRate: 24000 })`; each written chunk becomes an `AudioBuffer` started at
  `max(ctx.currentTime + 0.03, cursor)`, `cursor += duration`: gapless; a mark is a time on the cursor, emitted by a timer when
  `currentTime` passes it; `stop()` stops every source and resets the cursor; level from an `AnalyserNode`. The context is made
  at the first `write` (after a tap: autoplay allows it).
- Clips: `decodeAudioData(bytes)` → a buffer source on the same context.

### 6.1 The one player queue (goal 3.5)

**VC-11. One player for the app (`engine/player.ts`) over `AudioPort.player`.** Exactly one utterance plays at a time:

```ts
export type Utterance = { key: string; owner: "read" | "speech" | "pill" };
export interface Speaker {
  begin(u: Utterance): SpeakHandle;          // stops whatever plays (it is a barge-in) and starts u
  stopAll(): void;                            // stops sound, clears the queue, aborts every TTS request still open
  current(): Utterance | null;
}
export interface SpeakHandle {
  say(sentence: string): void;                // queued; its TTS request starts when fewer than 2 run (VC-12)
  end(): void;                                // no more sentences
  readonly done: Promise<"played" | "stopped" | VoiceProblem>;
}
```

A second request never overlaps the first: `begin` stops the first. A tap on the orb, on the waveform, on a Read aloud
control, or speaking (VC-9), calls `stopAll` (barge-in). A preview clip is played by `playClip` after `stopAll`.

**VC-12. TTS per sentence (`engine/speaker.ts`).** For each sentence: `POST /v1/text-to-speech/{voice}/stream
?output_format=pcm_24000` with `{text, model_id, language_code?, voice_settings?: {speed}}` (§2.3). At most **2 requests
in flight** (the free plan's concurrency is 2; one streams into the player while the next is fetched); each has its own
`AbortController`; `stopAll` aborts them (goal 4.9: a cancelled turn stops its requests at once). Chunks are written to the
player as they arrive, with `mark(n)` before sentence n's first chunk: **playback starts before the service has finished the
sentence** (goal 6.2). The voice is `settings.voiceId`; with none chosen yet, the first speak takes the first voice of
`GET /v2/voices?page_size=1&sort=name` and stores it.

**Playback speed (3.5)** is sent as `voice_settings.speed` (0.7–1.2, the service's range), not done by the player:
the settings offer 0.8×, 0.9×, 1.0×, 1.1×, 1.2× `[proposed]`.

---

## 7. Settings (goal 3.7, 4.6)

**VC-13. Settings is a new dialog with one section, "Voice"** (the app has no Settings screen today; §16). A gear button
`settings-btn` ("Settings") in the sidebar's foot, between the library button and the theme picker, opens it; on the phone
`Overlay` makes it a sheet, as the Servers dialog. It shows itself from the voice store's `settingsOpen` and is registered in
the shell's `Overlays` slot. `openVoiceSettings()` (used by the popover's Open Settings) opens it at Voice. Layout: a rounded
page with the goal's sections in order, testIDs `vs-*`:

1. **ElevenLabs API key** (`vs-key`): the app's `SecretInput` with **Show** (`vs-key-show`), **Test key** (`vs-key-test`),
   the result line (`vs-key-result`: "Works: 42 voices found." / the problem's sentence), the line "Stored on this device
   only. Sent only to elevenlabs.io.". With a key stored the box is empty with the placeholder "A key is saved on this
   device"; typing a new key and pressing Enter or **Save** (`vs-key-save`) replaces it. Test key tests the typed key, else
   the stored one (`voice.testKey(typed || undefined)`). The stored key is never shown again (on the desktop the page never
   has it): Show shows what is being typed.
2. **Remove key from this device** (`vs-key-remove`), with the confirm dialog.
3. **Voice** (`vs-voices`): the first **4** voices (goal §8, `[proposed]`): the chosen one first, then the service's order
   (`sort=name`); each row: name, "a few words" (`description`, else the `labels` joined: "British, calm, narration"), a play
   button (`vs-voice-play`) that plays `preview_url` (no credits), the radio (`vs-voice`). **Show all voices**
   (`vs-voices-all`) opens the full list with search and paging. Without a key: "Add your key to choose a voice."
4. **Speech mode sends my turn** (`vs-autosend`): Auto-send / Tap to send.
5. **Advanced options** (`vs-advanced`, collapsed): speech model (Flash v2.5 / v4 Turbo / Multilingual v2), transcription model
   (Scribe v2 Realtime — one choice, shown), language (Auto-detect / a list of ISO 639-1 codes the models share), pause before
   auto-send (0.6–3.0 s, step 0.2), playback speed (0.8×–1.2×), skip code blocks when reading (switch).

**VC-14. The voice settings are one stored value, `aiwb.voice.settings` in the kv port** (JSON), read and written only through
`engine/state.ts`'s settings store (`useVoiceSettings`, `setVoiceSettings`): Settings, the speech bar and the pill read and write
the same value, so a change in one shows at once in the others (goal 4.6). Type (`logic/settings.ts`):

```ts
export type VoiceSettings = {
  autoSend: boolean;            // default true
  voiceId: string | null;       // null: the first voice at first use
  voiceName: string;
  ttsModel: "eleven_flash_v2_5" | "eleven_v4_turbo" | "eleven_multilingual_v2";   // default flash
  sttModel: "scribe_v2_realtime";
  language: string | null;      // null = auto-detect
  pauseMs: number;              // default 1200, clamp 600..3000
  speed: number;                // default 1.0, one of 0.8..1.2
  skipCode: boolean;            // default true
};
```

The key is not in it (goal 3.7, 4.2). A stored value that does not parse is read as the defaults; nothing else is migrated.

---

## 8. Listening, the turn and sending

**VC-18. One session at a time** (`engine/session.ts`): one mic, one socket. Starting dictation, speech mode or the pill ends
the session running (and its speech). Read aloud does not end a session; it barge-ins the player only.

**VC-19. The STT session (`engine/listener.ts`).** Opened at the first start of a session, with `model_id`,
`audio_format=pcm_16000`, `commit_strategy=vad`, `vad_silence_threshold_secs=0.6`, `language_code` when set. Mic chunks of
100 ms go as `input_audio_chunk` frames while the session listens and is not muted. **Mute** stops sending (the socket stays,
`muted: true`); **End** stops the mic, closes the socket and ends speaking. A socket closed by the service for time or
inactivity is opened again at the next audio to send. Speech mode and the pill keep the socket between turns; while
thinking (and while speaking where voice barge-in is not shipped) no chunk is sent. No audio is ever sent while muted or
after End (goal 4.8).

**VC-20. The turn machine (`logic/turn.ts`), pure, with an injected clock.** Inputs: partial, committed, a tick, Send,
Cancel, talk-on (a new partial after Cancel), the settings `autoSend` and `pauseMs`. The words are `committed` (segments
joined by a space) and `partial`.

- **Quiet.** The pause starts when the turn has words and either a `committed_transcript` arrived with no partial after it, or
  no partial changed for `QUIET_MS = 400` ms.
- **Auto-send on:** at quiet, phase `countdown` for `pauseMs` (1.2 s by default); a new non-empty partial ends the countdown
  (talking on); **Cancel** ends it and keeps the words, phase `waiting`; then Send, or talking on and a new quiet, go on.
  When the countdown ends, the turn is sent.
- **Auto-send off:** phase `waiting` until Send (or the ↑ badge).
- **Send:** if a partial is not committed, a frame with `commit: true` is sent and the machine waits up to 1 s for the
  `committed_transcript`; then the text sent is `committed` + the last partial if none came.
- **Dictation** uses the same machine with sending off: it never sends (goal 4.7).

**VC-21. Sending a spoken turn is the typed path.** Speech mode sends with the composer's `sendMessage(chat, text)` (`send.ts`)
for the branch the composer is on, the pill with the same function (a board chat: `buildContext` is added there as for a
typed message). Nothing else is sent to the aiwb server; the message is an ordinary chat message (goal 4.1).

**VC-22. The reply is spoken (`engine/reply.ts`).** After a spoken turn is sent, the follower watches
`getState().items[branchKey(chat, branch)]` (`subscribe` of core's store). It takes the `text` items after the sent user
message, in order; for each it feeds the **new** part of `text` to the sentence splitter (VC-26); `done` or the next item
flushes the item's last sentence. A `text` whose new value does not start with what was fed (a rewrite) is fed from the end of
what was fed, so nothing is repeated (goal 4.7). The follower ends when the branch's turn ends (the `end` item, or the chat no
longer busy) and the speaker has played the last sentence; the session goes back to listening. Speech mode always speaks the
reply (goal 3.1). The pill makes sure the target's list is loaded (`loadItems(chat)` of `conn.ts`), as the chat view does.

### 8.1 Dictation (goal 3.2)

The composer gives a `DictationSink`: at start it keeps the box's text as `base`; on each change it sets the box to
`base + sep + committed + " " + partial` through the box's own `set` (so the draft saver sees an ordinary edit); `done` leaves
`base + committed`. Typing in the box while dictating ends dictation and keeps the box as it is. The box shows the guess as
ordinary text (`[proposed]`; the box cannot style a part of its value).

---

## 9. The composer, the speech bar and the mic mark

**VC-17. Dictate and Speech mode are two buttons after the toolbar's spacer, before the attach button, and leave together
for the "more" popup when the row has no room** (goal 3.4, 4.5, 4.10). The row's order: `[insert] [Dictate] [Speech mode]
[attach] [Stop] [Send]`. Core's fit rule gains them (`packages/core/src/logic/composerfit.ts`):

```ts
export type VoicePlace = "row" | "more";
/** fitWithInsert, and where the voice pair (Dictate + Speech mode, one width) is: in the row when, placed with it, every
 *  control is where it is without it and the meter keeps what it says (it takes nothing, as the insert button); else in the
 *  "more" popup as two entries, bringing the "more" chip if the row had none. The insert button gives way first. held: the
 *  open popup holds the pair. */
export function fitWithTail(r: Row, w: { insert?: number; voice?: number }, held: { insert: boolean; voice: boolean }):
  { fit: Fit; insert: InsertPlace; voice: VoicePlace };
```

`Toolbar.tsx` measures the pair with `Measure` (`widthKey("voice")`), draws `ComposerVoice` in the row or two rows
`more-row` `{control: "dictate" | "speech"}` in the popup (as `MoreInsert`). testIDs: `voice-dictate`
(`dataSet.on`), `voice-speech` (`dataSet.on`). The controls are off (and say why) when the composer cannot send (the same
`sendOff`/`boxOff` reasons). With voice never used, the composer and its sending are as before (goal 3.4).

**The speech bar (`SpeechBar.tsx`, testID `speech-bar`)** takes the place of the composer's box and toolbar while speech
mode is on; End gives them back. It shows: the words so far (`speech-words`: committed, then the partial in the muted
colour), the live waveform (`speech-wave`; the mic's level while listening, the player's while speaking; a tap while speaking
is `voice.interrupt()`), the sentence being spoken (`speech-spoken`), **Mute** (`speech-mute`), **End** (`speech-end`), the
**Auto-send** toggle (`speech-autosend`, the settings' one value), and either the countdown bar with the seconds left and
**Cancel** (`speech-countdown`, `speech-cancel`) or **Send** (`speech-send`). Speech mode ends when its chat leaves the screen.

**VC-23. The mic mark is kept on this device only** — goal 3.1/6.1 cannot be met in the chat's stored form client-only (§16).
The server stores a user message as `{text, context?, references?, images?}`; it drops `context` for a plain chat and gives a
board chat's `context` to the agent; so no field carries a mark to other devices without changing the text the agent reads
or the server. The closest option: `logic/marks.ts` keeps, in the kv (`aiwb.voice.spoken`), for each chat key and branch,
the item indexes of the user messages this app sent by voice. The engine records `{chat, branch, before: itemCount, text}`
at send and marks the first `user` item at an index ≥ `before` whose text equals the sent text, when it arrives. At most 500
marks, the oldest dropped; marks of a chat that is gone are pruned at snapshot. `MicMark.tsx` (testID `msg-mic`) draws a
small mic glyph at the corner of a marked user message (a chat part `MessageMark`, drawn by `ItemView` in a user message). A
fork or a branch does not carry the mark; another device does not show it. Alternatives for the user: an invisible marker
in the text (changes what the agent reads), or a server field (out of scope).

---

## 10. Read aloud (goal 3.3)

**VC-24. Read aloud is a message action in the fork actions' bar and menu** (`fork/Message.tsx`), on user and assistant
messages, from a chat part `useReadAloud(chat, branch, index, item)` that the voice screens register (default: none), so the
fork code does not import voice. On a mouse it is a button `fk-act` `{kind: "read"}` in the hover bar; on touch an item of
the "⋯" menu. While a message is read its control says **Stop reading** and stays shown on the message (not only on hover:
`voice-reading` chip) until it ends. The bar and the menu are drawn for Read aloud even when no fork action applies
(archived, read-only, a chat whose server is away: reading needs no server). A reply still being written has no Read aloud.
A tap starts `voice.readAloud`, which `stopAll`s first (barge-in). (The goal names "Copy, Fork" as the existing actions:
there is no Copy action today, §16.)

**VC-25. The cleaner (`logic/speech.ts`).** Line and block based, the same for a whole message and for a stream:

| Markdown | Said |
|---|---|
| headings, paragraphs, quotes (`>`) | their words; a heading ends a sentence |
| list items (`-`, `*`, `1.`), task boxes | their words, each item a sentence; markers dropped |
| `**`, `*`, `_`, `~~`, `` ` `` | dropped, words kept (inline code is said as its words `[proposed]`) |
| fenced code ```` ``` ```` and indented code | skipped when `skipCode` (default); else its lines, symbols as they are |
| `[text](url)`, `<url>`, bare `https://…` | the text; a bare URL is dropped |
| images `![alt](src)` | dropped |
| tables | each row: its cells joined by ", " (the separator row dropped) |
| HTML tags | dropped, text kept |
| `<selection …>`/`<point …>` refs (user messages) | the ref's label (`plainText` of `logic/refs.ts`) |
| horizontal rules, footnote marks | dropped |

**VC-26. The splitter (`logic/sentences.ts`).**

```ts
export function createSplitter(o: { skipCode: boolean; onSentence(s: string): void }): {
  push(markdown: string): void;   // the new text of a reply, in order
  flush(): void;                  // the end of the item: the rest is a sentence
};
```

It keeps a buffer, tracks fenced code across pushes, and emits a sentence when it sees, outside code: `.` `!` `?` `…` (and
`。！？`) followed by whitespace or the end of a block, after closing quotes and brackets; a blank line; the end of a heading
or list item. It does **not** cut: after a known abbreviation (`e.g.`, `i.e.`, `etc.`, `vs.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`,
`Prof.`, `St.`, `No.`, `Fig.`, `approx.`) followed by a lower-case word; inside a number (`3.14`, `1.5x`, `v2.5`); after a
single capital initial (`J. R. R.`); inside a URL, a path or a file name (`index.ts`); on `...` inside a sentence. A fragment
of under 12 characters joins the next; a sentence of over 300 characters is cut at the last `;`, `:` or `, ` before 250, else
at a space. Every emitted sentence goes through the cleaner; an empty one is not emitted. Fixtures of real replies (lists,
code, numbers, links, a reply that is mostly code) are in `app/test/fixtures/voice/` and the test pins their sentences
(goal 7.5).

---

## 11. The board pill (goal 3.6)

**VC-28. The pill is a floating control in `BoardCanvas`, outside the board view** (goal 4.5: no change to the board
view's engine, messages or file). `BoardCanvas` draws the shell slot `BoardVoice` (`<slots.BoardVoice board={board} />`, registered by the voice
screens; default nothing) after `Presence`, for a board shown as `canvas` and not archived. Bottom centre, above the canvas,
clear of the `RoleBar` and `SaveBanner`; on the phone above the bar. testIDs: `pill` (`dataSet {size: "compact" |
"listening" | "orb", state}`), `pill-orb` (`dataSet.state`: `idle` | `listening` | `thinking` | `speaking` | `countdown` |
`waiting`), `pill-chip`, `pill-new`, `pill-collapse`, `pill-wave`, `pill-words`, `pill-countdown`, `pill-cancel`,
`pill-send`, `pill-badge` (↑), `pill-autosend`, `pill-selection`, `caption-said`, `caption-spoken`.

- **Orb states** (goal 3.6) map to `Phase`: idle; listening (a ring scaled by `level`); thinking (`sending`/`thinking`);
  speaking (tap = `voice.interrupt()`); countdown (the ring fills over `pauseMs`); waiting (the ↑ badge sends).
- **Sizes:** compact (chat chip, **+ New chat**, orb) → the listening bar while listening or while words wait (waveform,
  words, countdown + Cancel or Send, the Auto-send toggle) → collapsed to the orb alone (`pill-collapse`; kept in
  `aiwb.voice.pill` in the kv). Collapsed, the orb still shows its ring or badge.
- **Captions** (`Captions.tsx`): what the person said (the turn's words, kept until the reply starts) and the sentence
  being spoken, floating above the pill; they fade 4 s after the last change.
- **Hold Space** (desktop and web, where a keyboard is the page's): through the keys port (`platform/keys`), only when the
  focus is not in a text box and the board is on screen. A tap of Space (< 300 ms) is a tap on the orb; **holding** is
  push-to-talk: listening while held, and the release **sends** the turn at once (the release is the person's act, goal 4.7)
  `[proposed]` (goal §8). Not on iPad or Android keyboards: `aiwb-keys` takes only shortcuts, never typing keys.
- **The target chat.** `ChatChip` names the target and, opened, lists `boardChats(chats, board, showArchived)` — the same
  call the sidebar's board row makes — with **Show all** that lists them with the archived ones (`showArchived: true`). The
  target is the chat used last: `lastChat.get(board)` when it is still a chat of the board, else the newest of the list; a
  pick sets `lastChat.set(board, chat)` (one value with the panel's). With no chat, the first sent turn makes one.
- **VC-29. The shared new-chat action is the shell's `newChat`.** Every place that makes a chat on a board already calls
  `newChat({board})` of `screens/shell/nav.ts`: the sidebar's "+" on the board's row (`rows.tsx`), the board bar's "+ Chat on
  this board" (`BoardBar.tsx`) and ⌘N on a board (`shortcuts.ts`). The pill's "+ New chat" and its first turn on a board with
  no chat call it too, so there is one action and no copy. It changes to

  ```ts
  /** "New chat": made at once where it was asked for, in a group or on a board. On a board the chat is shown under the
   *  board's row at once (the row opens) and becomes the board's last chat. It is opened (selected, the chat view shown) unless
   *  `open` is false. Answers the chat, or null when it was refused (the refusal is reported as before). */
  export async function newChat(where: ChatPlace, o?: { open?: boolean }): Promise<ChatView | null>;
  ```

  `open` defaults to true, so every caller of today behaves as today. The pill passes `open: false` (goal 3.6: "the chat view
  opens only if the person opens it"). On a board it calls `upsertChat`, `lastChat.set(board, c.id)` and `expandBoardRow(board)`
  — registered by the sidebar as `setEditRow` is; the board row's `open` moves from the row's `useState(true)` to a small map in
  `screens/sidebar/rowsopen.ts` with `useBoardRowOpen(board)` — then `openChat(c)` only when `open`.
- **The selection chip** (`pill-selection`): when the board on screen has a selection (`State.selection.count > 0` and
  `boardApp.selectionRefOn(board)` answers), the pill shows "n selected" with ×; at send, unless removed, the turn's text is
  `serializeRef(ref) + " " + words` — exactly what ⌘L puts in a typed message (`addSelection`), so the agent reads the same
  tag (goal 3.6: "as with a typed one").
- **Thinking:** nothing to build: the agent's edits reach the board as today (the writer's canvas, or a reader following
  saves).

---

## 12. Errors and the popover (goal 3.8)

**VC-30. One popover for every voice problem (`ProblemPopover.tsx`, testID `voice-problem`, `dataSet.kind`)**, an
`Overlay kind="popover"` hung from the control that was tapped (`anchor` id; each voice control renders
`<ProblemPopover anchor="dictate:<chat>" ref={…} />`), with one sentence and two buttons: the action (`voice-problem-act`)
and **Not now** (`voice-problem-dismiss`).

| `kind` | Sentence (`words.ts`) | Action |
|---|---|---|
| `no_key` | "Voice needs your ElevenLabs key. It stays on this device." | Open Settings → `openVoiceSettings()` |
| `key_rejected` | "ElevenLabs did not accept this key." | Open Settings |
| `no_credits` | "Your ElevenLabs plan has no credits left." | Open ElevenLabs → `https://elevenlabs.io/app/subscription` (link port) |
| `mic_blocked` | "The app can't hear you. Turn on the microphone in system settings." | Open system settings (`audio.openMicSettings`; the web build: none, Not now only) |
| `offline` | "Can't reach ElevenLabs." | Try again (`problem.retry`) |
| `service` | "ElevenLabs refused this. Open your account to see why." | Open ElevenLabs |

`has()` is checked before anything else when a voice control is tapped: with no key, the popover shows and nothing else
happens (no mic, no socket). A problem ends the voice session quietly: the chat keeps working in text, the composer is as it
was, a turn already sent is not touched (goal 3.8).

---

## 13. The stand-in voice service (goal 4.11, 6)

**VC-31. `web/dev/voicestandin.mjs`**: plain Node, no dependency (the WebSocket handshake and frames are written by hand: text
frames, masked client frames, lengths 7/16/64 bits, ping/pong, close). It answers the paths of §2 under a prefix:

```js
export function createVoiceStandin({ prefix = "/voice", keys = (k) => /^sk_test_/.test(k), log = () => {} } = {}) → {
  handle(req, res): boolean,                 // HTTP under prefix; false when not its path
  upgrade(req, socket, head): boolean,       // the STT socket under prefix
  control: {
    script(steps),     // STT: [{ after: <chunks received>, partial?: string, committed?: string }] for the next session
    fail(what),        // { http: { status, code, legacyStatus? } } | { socket: messageType } | { offline: true } | null
    pace({ chunkMs, chunks }),   // TTS: chunks per sentence and the time between them (default 100 ms, 6 chunks)
    log(),             // every request: { at, kind, path, query, keyHeader: bool, token: bool, text?, chunks, bytes,
                       //   sampleRates, chunkMsMin, chunkMsMax, startedAt, finishedAt, cancelled }
    reset(),
  },
  routes(server),      // standalone: listen on 127.0.0.1:<port>, with the control over HTTP at <prefix>/_control/*
}
```

- `POST /v1/single-use-token/realtime_scribe` → `{token: "sutkn_<random>"}`, one use, 15 min.
- `GET /v2/voices` → six fixed voices (`vsAlice` … with names, descriptions, labels) and `preview_url` =
  `<origin><prefix>/_preview/<id>.wav` (a 0.5 s WAV tone, decodable everywhere); paging by `page_size`; `total_count`.
- `POST /v1/text-to-speech/:voice/stream` → checks `output_format=pcm_24000`, `model_id`, the voice; answers chunked PCM
  (a sine whose length follows the text, `pace` chunks apart); records `finishedAt` and `cancelled` (the request closed
  before the end).
- `GET <prefix>/v1/speech-to-text/realtime` (upgrade) → checks the key header or a valid token, `model_id`,
  `audio_format=pcm_16000`; sends `session_started`; counts `input_audio_chunk` frames, checks `sample_rate: 16000`, the
  base64 and the chunk's length (records its ms), and answers the script by chunk count; `commit: true` commits the current
  partial.
- **Keys:** `sk_test_*` works; any other key → 401 `{detail: {code: "invalid_api_key", status: "invalid_api_key"}}`, on the
  socket `auth_error` then close.
- **Failures** (`fail`): `key_rejected` (401), `no_credits` (402 `insufficient_credits`; or legacy 401 `quota_exceeded`;
  socket `quota_exceeded`), `rate_limited` (429 `rate_limit_exceeded`; socket `rate_limited`), `offline` (every request
  destroyed, sockets refused).
- **Mounted** at `/voice` by the mock (`web/dev/mock.mjs`, its control at `mockEval`'s `voice`) and by the test host
  (`web/dev/hostface.mjs` takes an optional `voice` standin; `startHost({ voice: true })` makes one). Standalone
  (`node web/dev/voicestandin.mjs --port N`) for the desktop e2e (`AIWB_VOICE_BASE`) and the device flow
  (`EXPO_PUBLIC_AIWB_VOICE_BASE`).
- **The mock's reply.** The mock's canned reply is "a Read, a sentence"; speech mode needs a reply of several sentences that
  streams. The mock gains `flags.reply = { text, parts, pace }`: the next reply's text, sent as that many growing updates of
  one `text` item, `pace` ms apart (deleted after use). The e2e on a real server uses the stand-in agent
  `internal/agenttest/fake-claude`, whose reply the message's own directives shape (its header lists them).
- **The microphone is scripted at the service:** the page captures real audio (Chromium's fake device in the checks, the
  simulator's input on a device), the stand-in checks its format and timing and answers the script. The checks launch
  Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`
  and grant `microphone` (`web/dev/shot.mjs`); a blocked mic is `window.__aiwbVoice.denyMic(true)` (VC-32).

**VC-32. The test seam.** In a build for the checks (`EXPO_PUBLIC_AIWB_VERSION === "uicheck"`, as `__aiwbView`),
`engine/testseam.ts` sets `window.__aiwbVoice = { state(), settings(), player() /* { writes, marks, firstWriteAt, stops } */,
denyMic(on), setKey(k), clearKey() }`. No other build has it.

---

## 14. Tests, mapped to goal §6

All free: no test calls `api.elevenlabs.io` or a paid model (goal 4.11).

### 14.1 Unit tests (`npm test && npm run check` at the root)

| Test | Proves | Goal |
|---|---|---|
| `app/test/voice.speech.test.ts` | the cleaner's table (VC-25), skip code on/off | 6.2 |
| `app/test/voice.sentences.test.ts` + `app/test/fixtures/voice/*.md` | the splitter's rules, streamed in random cuts gives the same sentences as whole | 6.1, 7.5 |
| `app/test/voice.protocol.test.ts` | URLs, queries, frames, event parsing, `problems.ts` table of §2.6 | 6.4, 7.6 |
| `app/test/voice.turn.test.ts` | quiet, countdown (1.2 s), Cancel keeps words, talk-on, tap to send, dictation never sends | 6.1 |
| `app/test/voice.settings.test.ts` | defaults, parse, clamp, one value | 6.5 (toggle) |
| `app/test/voice.marks.test.ts` | marking after send, pruning, cap | 6.1 |
| `app/test/voice.pcm.test.ts` | resampling to 16 kHz, base64 size per 100 ms, odd-byte carry | 6.1 |
| `app/test/voice.engine.test.ts` | over fake ports: one player, `stopAll` aborts requests and clears, ≤ 2 in flight, playback before the sentence ends, read aloud stops speech, no key → problem without mic or net, no request before a tap, Mute/End send no chunk and close the socket, voice barge-in only with `voiceBargeIn`, the reply follower speaks each sentence once | 6.1, 6.2, 6.4, 6.7 |
| `app/test/voice.keystore.test.ts` | each store over fakes: set, get, clear; memory store gone with a new instance; nothing in the kv | 6.3 |
| `app/test/aiwbaudio.test.ts` | the native adapter over `fake.ts`; names in the contract against Swift and Kotlin | 6.6 |
| `app/test/appconfig.voice.test.ts` | the mic usage text and Android permissions | 6.6 |
| `app/test/noplainhttp.test.ts` (changed) | the voice net files are the only other way out, with no `http://` and `voiceURL` only | 4.2 |
| `packages/core/test/composerfit.test.ts` (added cases) | `fitWithTail`: the pair in the row, in the popup, the insert first, held | 6.6 |
| `app/test/newchat.board.test.ts` (new) | `newChat({board}, {open:false})` makes the chat, opens the board's row, sets the last chat and does not select it; with no option it selects as today | 6.5 |
| `desktop/test/voice.test.js` | key file 0600/0700, atomic, clear; allowlist of paths and queries; the key only in the header; preview only for seen URLs; no key on the page side | 6.3 |
| `web/dev/voicestandin.test.mjs` (`cd web && npm test`) | the stand-in's routes, WS framing, scripts, failures, log | 4.11 |

### 14.2 Browser checks (`cd web && npm run uicheck -- VC`)

New IDs, at the viewports named:

| Check | Viewports | Proves | Goal |
|---|---|---|---|
| `VC.1-settings.mjs` | desktop, tablet, phone | the foot's gear opens Settings > Voice; key in `SecretInput`, Show, Test key (working: "N voices"; rejected: the 401 sentence), Save, Remove; the voice list (4 + Show all), the preview plays (`__aiwbVoice.player()`), no TTS request for a preview; Auto-send and Advanced persist; key gone after reload (web) | 3.7, 6.3 |
| `VC.2-popovers.mjs` | desktop, phone | with no key each of Dictate, Speech mode, Read aloud, orb shows "needs your key", Open Settings lands on Voice, Not now; 401, no credits, rate limited, blocked mic, offline each show their sentence and action; the chat still sends text after each | 3.8, 6.4 |
| `VC.3-dictate.mjs` | desktop, tablet, phone | partial words in the box, committed appended, nothing sent after a long silence, stop; chunks 16 kHz 100 ms in the stand-in's log | 3.2, 6.1 |
| `VC.4-speech.mjs` | desktop, phone | speech mode: words → message by the ordinary POST; the reply spoken sentence by sentence, first sentence's playback before the reply ended and before the stand-in finished it; Auto-send after the pause, Cancel keeps words and sends nothing; Auto-send off waits for Send; Mute and End send no chunk and close the socket; the mic mark on the spoken turn and not on a typed one; tap on the waveform interrupts | 3.1, 3.5, 6.1, 6.2 |
| `VC.5-readaloud.mjs` | desktop, phone | Read aloud on a user and an assistant message (bar on hover, "⋯" on touch); the TTS texts carry no markdown marks, no code (skip on), no URL; skip off reads the code; Stop reading; a second Read aloud stops the first (one player, requests cancelled) | 3.3, 6.2 |
| `VC.6-pill.mjs` | desktop, tablet, phone | every orb state reachable (`pill-orb` state); compact → listening → collapsed and back; ring/badge when collapsed; no chat → first turn makes one under the board's row, the chat view not opened; last used is the target; + New chat and the sidebar's + give the same; the chip lists the sidebar's chats; Auto-send changed in the pill shows in the speech bar and Settings and back; the selection chip's tag in the POST; captions | 3.6, 6.5 |
| `VC.7-fit.mjs` | desktop, tablet, phone | the voice pair in the row on a wide composer, in the "more" popup on a narrow row (a 300 px window, the phone), the insert button leaving first; both work from the popup | 3.4, 6.6 |

Each check's first comment names what it proves (the folder's rule). `web/dev/checks/README.md` gets a row for VC.1–VC.7 and
`composer.mjs`'s header the new testIDs.

### 14.3 End-to-end (free)

| Script | Proves | Goal |
|---|---|---|
| `web/e2e/voice.e2e.mjs` (new; about 20 s) | a scratch Go server through the test host with the stand-in mounted: a spoken turn becomes an ordinary message on the server (its stored items have the text and nothing else), the reply of the server's stand-in agent (`internal/agenttest/fake-claude`, as `newchat.e2e.mjs` uses) is spoken sentence by sentence; then the **key search** with `sk_test_CANARY_<random>`: the page's `localStorage`, the host's recorded `/host/call` bodies, the server's data folder and log, the page's console and every error text shown hold no canary; the stand-in's log has it only as the `xi-api-key` header of the token request and the TTS/voices calls, and the socket only with a token; a page that never used voice made no request to `/voice` and no `getUserMedia` call | 6.1, 6.3, 6.7 |
| `desktop/e2e/app.e2e.mjs` (a voice part) | the Electron app with `AIWB_VOICE_BASE` at a standalone stand-in: Settings stores the key into `<userData>/client/voice-key` (0600), the page's JS never has it (`window` searched), Read aloud plays through main's relay, Remove deletes the file | 6.3, 6.6 |

### 14.4 The device flow (goal 6.6)

One flow, `app/e2e/maestro/voice-mic.yaml`, on **your own iOS simulator** (`node app/e2e/run.mjs voice-mic --platform ios
--device vc-<name>`), a development build with `EXPO_PUBLIC_AIWB_VOICE_BASE=http://127.0.0.1:<port>/voice` at a standalone
stand-in the runner starts: Settings > Voice, key `sk_test_…`, Test key; Dictate on a chat → the system's microphone alert →
Allow → the stand-in's log has 16 kHz chunks of 100 ms → the scripted words are in the box; Read aloud on a message → the
stand-in's TTS was read to its end and the module emitted `drained` (a dev-only line `voice-dev` the flow reads); then
`xcrun simctl privacy <udid> revoke microphone <bundle>` → Dictate → the "can't hear you" popover with Open system settings;
Remove key. Android: the same flow runs on the emulator only if the lock is free; otherwise the Android module is proven by
`./gradlew :aiwb-audio:compileDebugKotlin` (P4) and on a device by the person. Echo cancellation and voice barge-in are
confirmed by the person on a real iPhone and Android phone (a simulator has no acoustic echo): written in the final report.

### 14.5 What stays as it was (goal 6.7)

`go test ./...` unchanged and nothing under `cmd/` or `internal/` in the diff (`git diff --stat voice-chats...HEAD -- cmd
internal` is empty); the existing checks of the composer (`A2.2-fits`, `A2.3-places`, `A2.4-popups`, `P0.1-overflow`,
`P0.6-widths`, `L16-composer`), the message actions (`L15-fork`), the board (`L24-boardui`, `HB.1-reader`) and the sidebar
(`L11-sidebar`) pass; `P0.6`'s widths fixture is written again with the voice pair (`WRITE=1`) and the diff reviewed.

---

## 15. Answers to goal §8 (all `[proposed]`)

1. **How voice reaches the native microphone and speaker:** the app's own Expo module `aiwb-audio` (VC-8); Web Audio on the
   desktop window and the web build (VC-10).
2. **The length of the list of voices before "Show all":** 4, the chosen voice first (VC-13).
3. **Hold Space:** a tap of Space is a tap on the orb; holding is push-to-talk and the release sends the turn (VC-28). Desktop
   and web only.
4. **Translations of the error sentences:** all voice words are in `app/src/voice/words.ts`, English only; when the app gets
   translations, that file is the one to translate. Nothing else now.

---

## 16. Points for the user (contradictions, departures, decisions to know)

1. **No Settings screen exists** (goal 3.7, 6.4 "lands on Settings > Voice"). VC-13 adds a Settings dialog with one section,
   Voice, opened by a new gear button in the sidebar's foot.
2. **The mic mark cannot be in the chat's stored form client-only** (goal 3.1, 6.1 vs 4.1 and its §5). VC-23 keeps it on the device
   that sent the turn. Another device, a fork or a reinstall does not show it.
3. **The CSP is not changed** (departs from goal 4.4, 7.4). The desktop's voice calls are made by the main process, where the
   key stays, as the server secrets do (VC-3, VC-4); the web build reaches the stand-in on its own origin. The goal's CSP
   change becomes unnecessary; it is one function (`cspFor`) if the user wants page-direct calls.
4. **The key is sent as a header in Electron by the main process, not by the page** (goal 7.2's question answered: Electron's
   main-process socket and React Native's socket both set the header; only the web build uses a token).
5. **"Copy" is not a message action today** (goal 3.3 names "Copy, Fork"). Read aloud joins the fork actions' bar and menu
   (VC-24).
6. **The sidebar's "+" opens the new chat today; the pill's must not** (goal 3.6). One action, the shell's `newChat`, gets an
   `open` flag (VC-29); the sidebar, the board bar and ⌘N keep opening the chat.
7. **"The new chat shows under the board's row at once"** needs the row opened: its open state leaves the row's local state
   (VC-29).
8. **Voice barge-in ships on iOS and Android only** (VC-9); the desktop and the web build interrupt by a tap.
9. **The microphone permission is added to the app** (iOS usage text, Android `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`; macOS
   usage text). Earlier work kept the app free of any microphone permission on purpose (S12, K4); their plugins stay without
   one.
10. **"No plain HTTP" (AD-36) gets a second, named way out** for the voice service (VC-7).
11. **Playback speed is the service's `speed`** (0.8×–1.2×), not a local time-stretch (VC-12).
12. **A new runtime dependency: none.** `expo/fetch` is part of `expo`. The native module and the stand-in are the app's own
    code.
