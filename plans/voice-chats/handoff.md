# Voice chats: handoff notes between packages

Notes that packages left for the packages after them. Read the ones that touch your package. The orchestrator adds to
this file as packages are merged.

## From P0 (scaffold)

- `VoiceSettings` is written out in `app/src/voice/index.ts`; P10 replaces it with
  `export type { VoiceSettings } from "./logic/settings.ts"` and drops the copied defaults.
- `VoiceNetError`, `VoiceProblemKind`, `VoiceProblemError` live in `app/src/voice/ports.ts`.
- The void methods of `voice` (`end`, `mute`, `send`, `cancelCountdown`, `interrupt`, `stopReading`, `dismissProblem`)
  never throw.

## From P2 (logic)

- Turn machine (`logic/turn.ts`): inputs `partial`, `committed`, `tick`, `send`, `cancel`, `settings`, `reset`. The engine
  must call `reset` after a turn is sent (the phase stays `sent` until then), and must `step` a `tick` at
  `deadline(state)`. A `countdown start` effect while one runs means restart. Phase `committing`: Send waits up to 1 s
  (`COMMIT_WAIT_MS`) for the committed segment.
- `ttsBody` omits `language_code` for `eleven_multilingual_v2` (arch §2.5 says it is ignored there).
- `voicesQuery`: 4 voices for the short list, 30 per page for the full list.
- Marks (`logic/marks.ts`): `matchArrived(state, chat, branch, items)`, `prune(state, chatIds)`; text compared trimmed.
  The engine must note the text exactly as `sendMessage` stores it (e.g. with a prepended selection tag), or the mark
  will not match. A noted turn that never arrives is dropped after 20 newer ones.
- Unknown STT socket error types map to `offline`.
- Settings clamp: speed snaps to 0.5/1/1.5/2 (was 0.8 to 1.2 before the small-improvements goal; old values read as 1); language a 2–3 letter code; voice id `^[A-Za-z0-9]{1,64}$`.

## From P1 (speech text)

- `speechText(markdown, {skipCode})` adds a "." to a heading, list item or table row without end punctuation (a pause).
- `<selection>` / `<point>` refs are spoken as their label without brackets; a point's coordinates are read.
- `createSplitter`: `Mr. Mrs. Ms. Dr. Prof. St. e.g. i.e. vs.` never end a sentence; fragments under 12 characters join
  the next sentence. `flush()` starts a fresh reader (an unclosed fence does not carry into the next item).

## From P5 (desktop face)

- The TTS path's voice id regex is `^[A-Za-z0-9]{1,64}$` (VC-5): stand-in voice ids must have no `_` or `-`.
- A bridge call that fails before it opens rejects with one word: `voice_refused`, `voice_no_key`, `voice_unreachable`,
  `voice_cancelled` or `voice_failed`. A `request` with no stored key and no `req.key` rejects `voice_no_key` (no status).
- Body and socket events may arrive before the promise of the call that started them settles: buffer by id in the page.
- A socket that fails to open rejects `socket.open` and sends no event; once open, `close` always arrives (code, or 1006).
- Plain-http preview URLs are learnt only from the loopback `AIWB_VOICE_BASE` origin; everything else must be https.
- `writeFileAtomic` and `ensureStateDir` are exported from `@aiwb/conn/node`.
- The session permission handler refuses `media` for video or for any page but the app's own.

## From P6 (web audio)

- `audioWeb(): AudioPort` makes no context and asks for no mic until called. The player's `AudioContext(24000)` is made
  at the first write.
- `getUserMedia` errors other than `NotAllowedError` / `SecurityError` (e.g. `NotFoundError`, no microphone) are
  rethrown as they are: the engine maps them (treat as `mic_blocked` or a generic problem; say which).
- The mic always asks `echoCancellation: true`; `MicHandle.echoCancel` reports the track's setting.
- `player.stop()` also stops a playing clip (one output).
- `level` is raw RMS 0–1 for mic and player; a screen wanting a livelier waveform scales it.
- Marks / drained come from a 40 ms timer (late in a hidden tab).
- Real `getUserMedia` with Chromium's fake-device flags hung in P6's sandbox try; VC.3/VC.4/VC.5 must prove real capture
  in the checks' browser (P3's flags). If it hangs there, report it with the exact flags.

## From P3 (stand-in voice service)

- Stand-in voice ids: `vsAlice`, `vsBob`, `vsCarol`, `vsDave`, `vsErin`, `vsFrank` (no underscore; the orchestrator
  renamed them from `vs_*` to satisfy the desktop's path rule).
- In `/mock/eval`, `voice` is the stand-in's `control` object (`voice.script(...)`, `voice.log()`); in the test host,
  `host.voice` is the whole stand-in (`host.voice.control.script(...)`).
- `fail` takes `key_rejected`, `no_credits`, `no_credits_legacy`, `rate_limited`, `offline`, and
  `{ socket, after: n, once: true }` (a socket failing after n chunks, or once).
- Each log entry has `problems`: what the client sent against the protocol (wrong sample rate, bad base64, wrong
  `output_format`, any `voice_settings`: voice sends no speed). Tests can assert it is empty. Keys never reach the log
  (`keyHeader: true`).
- TTS chunks are cut on odd bytes at every second boundary (exercises the player's odd-byte carry).
- `web/dev/electron/index.mjs` ignores launch arguments and `permissions`: `uicheck:electron` gets neither the
  fake-microphone flags nor the microphone grant. A package that runs VC checks under Electron must add that.
- The host CLI (`host.mjs`) has no `--voice` flag.
- Known, not caused by voice: `uicheck -- P0.3` fails on `A2.board-selected`, `A6.board`, `SEC.board` (they wait for an
  edit-mode toolbar and boards now open as readers in view mode). Same failure without P3's change.

## From P4 (native audio)

- `audioNative()` in `platform/audio.native.ts` (as `audioWeb()` of P6); the module loads on first use.
- The camera and image-picker plugins now carry voice's microphone text instead of `microphonePermission: false`
  (with `false`, Expo deletes `NSMicrophoneUsageDescription` and blocks RECORD_AUDIO). The camera keeps
  `recordAudioAndroid: false`. A machine that prebuilt Android before must `npx expo prebuild -p android --clean`.
- `drained` fires whenever the native queue empties, also mid-utterance when bytes arrive slower than they play, and
  when the module drops the queue itself. `playerStop` emits no `drained`. The engine must not take `drained` alone as
  the end of an utterance: use the utterance's marks and its own "all written" state.
- Starting the mic while Read aloud plays cuts the playback (and emits `drained`): both platforms rebuild the audio path
  to switch on echo cancellation.
- `voiceBargeIn` is false until `startMic` has answered; then it is what the device gave.
- Android: after a first refusal `micPermission` answers `"undetermined"` (one more ask allowed); then `"denied"`.
- Error code `MIC_BLOCKED` from the module.

## From P10 (engine part A)

- Start sound with `speaker.begin({ key, owner: "speech"|"pill", anchor, retry, onSentence, onLevel })`, then `say`,
  `end`, `done`. `stopAll()` is the barge-in. `player.busy()` is false until something is written. An utterance ends
  only when it is closed, every sentence is written and the player is not busy (a mid-utterance `drained` does not end it).
- Check `hasKey()` before the mic or socket. Popover: `showProblem({ kind, anchor, retry })`. Check `flags.denyMic`
  before `startMic` and throw `VoiceProblemError("mic_blocked")`.
- Session: `sessionStore.set` (`IDLE_SESSION` exported); hooks with `useSyncExternalStore` like the others.
- Tests: `setVoicePorts(f.ports)` then `resetEngine()`; `f.calls` logs port calls without keys; `f.net.sockets[i]` has
  `open`, `receive`, `serverClose`, `fail`, `sent`, `closedByEngine`; `f.audio.mics[i].chunk(b64)`; `f.audio.auto = false`
  gives manual `reach(id)` and `drain()`; `serveVoice(net, opts)` and `ERR.*` scripts in `app/test/fixtures/voice/fakeports.ts`.
- kv goes through core's `safeGet`/`safeSet`; every new kv key needs its line in `app/test/storagescan.test.ts`'s write
  list (the marks store: right after `app/voice/engine/state.ts SETTINGS_KEY`).
- Dictation must not call `speaker.begin`. Read aloud does not end a session (VC-18): `readAloud` only stops the speaker.
- `readAloud` resolves when reading ends, is stopped or fails (a failure is the popover, not a rejection). `voices()`
  rejects with `VoiceProblemError` (no popover); `testKey` returns a result (no popover). `setKey("")` does nothing.
- Extra exports for P12: `openVoiceSettings`, `closeVoiceSettings`, `useVoiceSettingsOpen`. A failed preview shows its
  popover on the anchor `preview:<voiceId>`.
- `Utterance` gained `anchor`, `retry`, `onSentence`, `onLevel`.

## From P9 (keystore and net)

- `platformVoicePorts()` from `platform/index.{native,web}.ts`; `bootstrap.ts` sets the ports and starts nothing.
- Logic shared and testable under Node: `platform/keystore.core.ts`, `platform/net.core.ts`.
- After `close()` on a socket the port says nothing more: no `close` event, on every path. A frame sent before `open`
  is dropped. No key, or a socket that cannot open: `error()` then `close(1008)` for no key, `close(1006)` otherwise.
- A refused token (web page-direct) reaches the socket's owner as a synthetic `auth_error` / `quota_exceeded` /
  `rate_limited` frame.
- `NetAnswer.text()` and the body iterator are each single-use: read one. Every answer must be read or aborted (a
  bridge request never read leaves its listener on the bridge). A voices answer must be read through this net for
  `preview()` to know its URLs.
- `Keystore.set` with a malformed key (not trimmed printable ASCII, spaces, > 256 chars) rejects (before main on
  Electron); the key input shows its own message for that.
- **Open issue:** `parseVoices` (P2) drops a non-https `preview_url`, so the stand-in's same-origin
  `http://…/voice/_preview/*.wav` previews come out `previewUrl: null` on the web build. P12 fixes this (keep an http
  preview URL only for a loopback/local host, as `origin.ts` judges one).
- `EXPO_PUBLIC_AIWB_VOICE_BASE` counts only in `__DEV__` and for a local host (localhost, 127.x, 10.0.2.2, private IPv4).

## From P11 (engine part B) — the screens' contract

**Starts.** None ever rejects. A problem shows the popover on `anchor` and leaves the session idle.

```ts
voice.startDictation({ chat, branch, anchor, sink }): Promise<void>
voice.startSpeech({ chat, branch, anchor, send: (text) => sendMessage(chat, text) }): Promise<void>
voice.startPill({ board, anchor,
  target: async () => /* lastChat of the board if still its chat, else (await newChat({board}, {open:false}))?.id ?? null */,
  send: (chat, text) => sendMessage(chat, chipOn ? serializeRef(ref) + " " + text : text) }): Promise<void>
```

- When `send` rejects, the words come back (phase `waiting`) and no voice popover shows: the screen reports the failure
  as it would for a typed send.
- `target()` is called at each send, never at start (opening the pill makes no chat). `null` gives the words back. If
  the target's list is not loaded the engine loads it first (≤ 3 s). End before the target resolves sends nothing.

**`DictationSink`.** `show({committed, partial})` on every change; `done(text)` once when the session ends for any
reason (`text` = committed + last guess, what the box showed). If the person typed and that ended dictation, the sink
may ignore `done`.

**`useVoiceSession(select)`** re-renders only when the selected value changes (`Object.is`): select only what you draw.

| phase | committed / partial | other fields |
|---|---|---|
| `idle` | "" / "" | `owner` null |
| `starting` | "" / "" | `owner` set |
| `listening` | the turn's words / live guess | `level` = mic RMS 0..1 |
| `countdown` | words / guess | `countdown {startedAt, ms}` (`startedAt` from `Date.now()`) |
| `waiting` | words / guess | show Send or the ↑ badge |
| `sending` | sent words / "" | includes the ≤ 1 s wait for the last segment after Send |
| `thinking` | sent words / "" | |
| `speaking` | "" / "" | `spoken` = current sentence; `level` = player's |

- `muted` true after `mute(true)`; `level` then 0. `target` is set once a pill turn's chat is known (null before): the
  chip shows its own `lastChat`.
- `voice.interrupt()` also stops a message read aloud. `voice.end()` ends whichever session runs.
- Marks are noted by the engine at every spoken send; screens do nothing. `MicMark` calls
  `useSpokenMark(chat, branch, index)` with the branch the thread shows (`""` and `"main"` both mean main). Marks are
  compared without the leading reference tags (so the pill's selection tag does not hide the mark).
- A mic error naming no problem (no microphone) shows as `mic_blocked`.
- Where voice barge-in does not ship, no audio goes up while a message is read aloud.

## From P12 (Settings > Voice, the popover)

Showing the problem popover from a control:

```tsx
import { ProblemPopover } from "../voice";
const ref = useRef<View>(null);
<View ref={ref} collapsable={false}><Pressable … /></View>
<ProblemPopover anchor={`dictate:${chat}`} target={ref} align="right" up />
```

- `anchor` is the same string the control gave the engine (`voice.startDictation({ anchor })`); the popover shows
  itself only while the problem in the store names that anchor, so the control keeps no state for it. `target` is
  what it hangs from (a phone sheet ignores it). Draws `voice-problem` (with `data-kind`), the sentence,
  `voice-problem-act`, `voice-problem-dismiss`. "Open system settings" is left out where the platform cannot; "Try
  again" when the problem has no `retry`.
- Open Settings: `openVoiceSettings()` from `app/src/voice/index.ts`. Settings testIDs: see `web/dev/checks/VC.1-settings.mjs`.
- The gear is `settings-btn` in the sidebar foot. The foot now wraps at the default sidebar width (264): library, gear
  and theme sit on a second row; `PL4.1` asserts reading order instead of one line.
- New shared `app/src/ui/Switch.tsx` (the foot's switch look).
- `parseVoices` keeps an `http:` preview URL for a local host only (`isLocalHost` of `origin.ts`).
- Known, not caused by voice: `uicheck -- P7.3` fails (waits for an edit-mode board canvas; boards open in view mode)
  on the unmodified branch too, like `P0.3`'s three board states.

## From P14 (Read aloud)

- `fork/Message.tsx` draws Read aloud last in the hover bar and the "⋯" menu; a `voice-reading` chip sits under the
  words while reading. The hover bar is now `width: max-content` and grows left (it was clipped on short messages).
- `fork/Message.tsx` imports `ReadAloudProblem` from `screens/voice` (a departure from VC-24's "fork imports no voice":
  `ReadAloudAction` has no place for the popover).
- `fork.mjs`'s `actsSeen` leaves out `kind: "read"`; SEC.10 allows Read aloud alone on a chat shown as it was.
- The player's `stops` counter only counts while sound is queued: prove a stop by "no more requests and no more
  writes".
- A message whose speech cleans to nothing still offers Read aloud (speaks nothing).

## From P15a (the pill)

- **Chromium 153's fake microphone hangs** (`getUserMedia` with the fake-device flags times out, in every variant tried).
  VC.6 replaces `getUserMedia` with a tone from the page's own `AudioContext`, which then flows through the real capture
  path to the stand-in. VC.3 and VC.4 need the same (or Chromium 156 as the checks' README states; to be tried at the
  final integration).
- Selection tag: `screens/voice/pill/control.ts` `turnText(board, words)` is the one place to put
  `serializeRef(ref) + " "` before the words; the pill's `send` goes through it.
- Captions: the pill is an absolutely positioned row at `zIndex` 5; captions go above it as a sibling, or above the card.
- Hold Space: call `startPill(board)` from `control.ts`; release-sends with `voice.send()`. The key handler should use
  `useVoiceSession(s => s.owner?.kind === "pill" && s.owner.board === board)`.
- Mute is not drawn in the pill (arch §11 lists none); `voice.mute` exists.
- The orb's thinking state covers `sending` and `thinking`. After a reply the session returns to listening (bar grows
  back); a tap on the orb ends it.
- The listening bar is 380 px wide, capped at 94% of the canvas; bottom 62 (78 on the phone).

## From P13a (composer buttons, dictation)

- **The fake microphone never answers `getUserMedia` on this machine** (Chromium 153 and 156; suspect: a virtual audio
  input driver "NDI Audio"). `web/dev/checks/mic.mjs` probes in a separate browser and, where the probe hangs, puts an
  oscillator stream into the page and says so. `AIWB_MIC=device` never falls back; `AIWB_MIC=synthetic` never probes.
  Use `useMic(page, note)` after opening the page.
- `fitWithTail` now puts the optional default Subagents chip in the popup when the pair is there and no control is.
- `composer/dictation.ts` holds a context the composer gives to the control (neither imports the other).
- **For P13b:** `ChipInput` holds the draft: hide the box and the toolbar/`ComposerVoice` while the speech bar shows,
  do not unmount them (the draft and the popover target would be lost). Speech session owner is set from `starting`;
  the toolbar's `voiceOn` waits for `listening`; the button state uses `useVoiceSession` with
  `owner.kind === "speech"` and the same chat and branch. Speech send calls `sendMessage(chatId, text)`. Popover
  anchors `dictate:<chat>`, `speech:<chat>`; the bar's own problems need their own anchor. `parts.SpeechBar` is still
  null and unused in `Composer.tsx`.
- VC.4: open a new page after a short wait (the previous page saves its draft as it closes; the mock may apply it
  after the next seed). Wait for the toolbar's place to settle before pressing (the pair is drawn in the row until its
  width is kept).
- **Regression to fix (P14F):** A2.2/A2.3 desktop "move" states fail since P14: the click on Branch is intercepted by
  the sidebar resizer (P14 made the hover bar `width: max-content`, growing left).
- A2.2/A2.3/P0.6 `board-selected` fail on desktop: the known view-mode board failure.

## From P18 (docs) and the orchestrator

- `EXPO_PUBLIC_AIWB_VOICE_BASE` now accepts the stand-in's plain path (`http://127.0.0.1:5710/voice`) as VC-6 names it
  (commit `f53c4c6`); before, a value with a path was silently ignored and a dev build fell back to the real service.
  A stand-in started with `--prefix /` and an origin with no path still work.
- Open for the final pass: VC-9's "Tap to interrupt" tooltip text on the speech bar's waveform and the orb is not in
  `words.ts`; `docs/limitations.md` has no voice line yet (English only, the mic mark on one device, voice barge-in on
  the phones only). Hold Space exists only in the desktop window and the web build (`holdkeys.native.ts` is a no-op).

## From P17 (device flow)

- `node app/e2e/run.mjs voice-mic --platform ios --device <udid>` is built (runner `needs=voice`, the dev line
  `voice-dev`, findings in `plans/voice-chats/p17-device-flow.md`). On the simulator it proved: Settings > Voice, Test
  key against the stand-in, the system microphone alert with the app's text, the denied path's popover, Read aloud
  (one `pcm_24000` TTS request played to the end), revoke and relaunch, Remove key.
- **Not proven here:** the microphone starting. This session's terminal has no answer to the Mac's microphone
  permission ("not determined"), so CoreAudio deadlocks and the app ends after Allow. The person must run `voice-mic`
  once from a terminal allowed to use the Mac's microphone. Android not run (no emulator; only P4's Kotlin compile).
- iOS ends the app when its permission changes (`tcc`), also on a `simctl` revoke.
