# Voice chats: the work packages

Each package follows `architecture.md` (the design: "arch" below, with its section and decision numbers) and
`ORCHESTRATION.md` (worktree `vc-<id>-<word>` from `voice-chats`, commit with the model's `Co-Authored-By`, report done /
failed / blocked). Every package is sized for **Sonnet 5.5, effort high** unless marked **Opus**. A package that finds the
design wrong for its part stops and reports; it does not change the design.

**Rules for every package** (not repeated below):

- Read `ORCHESTRATION.md`, the goal, `AGENTS.md`, arch §1 and the arch sections the package names, before any code.
- No change under `cmd/` or `internal/`. No call to `api.elevenlabs.io` or to a paid model; the stand-in voice service
  (arch §13) is the only voice service a test talks to. No real key exists or is needed.
- A user-facing sentence of voice is written in `app/src/voice/words.ts` and used from there.
- The key is never logged, never put in an error text, the kv, the settings or a test's output (arch §4).
- Comments and names follow the surrounding code (its plain, full-sentence comment style).
- Every package ends green on: from the repository root `npm test && npm run check`; plus its own commands below.
- A test of a file in `app/src/voice/logic/` or `engine/` imports no `react-native` and no `expo-*` (they run under
  `node --test`).
- Browser checks: Playwright is installed with `cd web && npm install --no-save playwright@1.64.1 && npx playwright install
  chromium` if missing; run only the checks named.

Fixed testIDs, paths and signatures are in arch §3, §7, §9–§13; a package uses those names.

---

## Wave 0

### P0 — Scaffold: the module's skeleton, the port types, the parts and slots

- **Build.** Exactly the types and empty places later packages fill, so that wave 1 runs in parallel without touching the
  same files:
  - `app/src/voice/ports.ts`: the types of arch §3.2 and `setVoicePorts`/`voicePorts` (a default set of ports that reject
    with "voice is not set up"), and `class VoiceProblemError extends Error { kind: VoiceProblemKind }`.
  - `app/src/voice/index.ts`: the types of arch §3.1 exported; `voice` as an object whose methods reject "not built yet";
    the hooks as stubs answering idle values. (P10/P11 replace the bodies, not the signatures.)
  - `app/src/voice/words.ts`: the six problem sentences and actions of arch §12 table, the Settings lines of arch §7, as
    named constants.
  - `app/src/voice/platform/bridge.types.ts`: the type of `window.aiwbVoice` (arch VC-5) and of its events.
  - `app/modules/aiwb-audio/src/AiwbAudio.ts`: the contract of arch VC-8 (types only), `expo-module.config.json`, a
    `README.md` stub naming the files to come.
  - Empty folders with one-line comment files: `app/src/voice/logic/`, `engine/`, `platform/` (no stub file that a later
    package would have to delete; just a `README.md` per folder naming what goes there, from arch §3).
  - Screens: `app/src/screens/voice/index.ts` importing four empty registration files `settings.ts`, `composer.ts`,
    `read.ts`, `pill.ts` (each a comment only); `import "./voice";` added to `app/src/screens/register.ts`.
  - Parts and slots, declared with a default that draws nothing (the area's existing mechanism):
    chat parts (`app/src/screens/chat/parts.tsx`): `MessageMark: ComponentType<{chat: ChatView; index: number; item: Item}>`
    and `useReadAloud: (chat: ChatView, branch: string, index: number, item: Item) => ReadAloudAction | null` with
    `type ReadAloudAction = { reading: boolean; title: string; run(): void; anchor: RefObject<View | null> }`;
    composer parts (`app/src/screens/composer/parts.tsx`): `VoiceButtons: ComponentType<{chatId: string; branch: string;
    place: "row" | "more"; disabled: string}> | null` and `SpeechBar: ComponentType<{chatId: string; branch: string}> | null`
    (null by default, as `AttachButton`);
    shell slot (`app/src/screens/shell/slots.tsx`): `BoardVoice: ComponentType<{board: string}>` (default nothing).
  - Icons in `app/src/ui/icons.tsx`: `MicIcon`, `WaveIcon` (speech mode), `SpeakerIcon` (read aloud), `StopIcon`,
    `GearIcon`, `SendUpIcon` (↑ badge), `CollapseIcon`, the style of the icons there.
- **Touches.** The files above only. Draws nothing new anywhere.
- **Interfaces.** arch §3.1, §3.2, VC-5, VC-8.
- **Check.** `npm test && npm run check` (root). `cd web && npm run uicheck -- L16 L15` (nothing on screen changed).
- **Not.** No logic, no drawing site (no edit of `Toolbar.tsx`, `ItemView.tsx`, `Message.tsx`, `BoardCanvas.tsx`).
- **Depends on.** Nothing. **Before** every other package.

---

## Wave 1 (all in parallel after P0)

### P1 — Speech text: the cleaner and the sentence splitter

- **Build.** `app/src/voice/logic/speech.ts` (arch VC-25) and `logic/sentences.ts` (arch VC-26), pure.
  Fixtures `app/test/fixtures/voice/*.md`: at least 8 real-shaped replies (a list, a reply that is mostly code, numbers and
  versions, links and paths, abbreviations, a table, quotes and headings, a user message with a `<selection>` ref), each with
  its expected sentences in a `.json` beside it.
- **Touches.** `app/src/voice/logic/{speech,sentences}.ts`, `app/test/voice.speech.test.ts`, `app/test/voice.sentences.test.ts`,
  `app/test/fixtures/voice/`.
- **Interfaces.** `speechText(markdown: string, o: { skipCode: boolean }): string` (a whole block or message → words);
  `createSplitter` of VC-26.
- **Check.** `cd app && node --test --experimental-strip-types test/voice.speech.test.ts test/voice.sentences.test.ts`; the
  test feeds every fixture whole and in 20 random cuts and gets the same sentences; `npm test && npm run check`.
- **Not.** No other file.
- **Depends on.** P0. **Parallel with** P2–P8.

### P2 — Protocol, problems, the turn machine, settings and marks

- **Build.** Pure modules of arch §3 `logic/`:
  - `protocol.ts`: the constants of arch §2 (paths, query keys, `TTS_MODELS`, `STT_MODELS`, `CHUNK_MS = 100`,
    `VAD_SILENCE_S = 0.6`); `sttQuery(settings)`, `ttsPath(voiceId)`, `ttsQuery()`, `ttsBody(text, settings)` (no
    speed: the app stretches the audio, small-improvements goal), `audioFrame(b64, commit)`, `parseSttEvent(text): SttEvent` (`session_started` | `partial` | `committed` | `error {type}`
    | `ignored`), `voicesQuery(o)`, `parseVoices(json): VoiceList`.
  - `problems.ts`: `problemOfStatus(status, bodyText)`, `problemOfSttError(type)`, `problemOfException(e)` — the table of
    arch §2.6, never reading a URL or header.
  - `turn.ts`: arch VC-20 as a reducer `step(state, input, now) → {state, effects}` with effects `send(text)`,
    `commit()`, `countdown(start|stop)`; `QUIET_MS = 400`.
  - `settings.ts`: `VoiceSettings`, `DEFAULTS`, `parseSettings(text|null)`, `clampSettings` (arch VC-14).
  - `marks.ts`: arch VC-23 model: `noteSent`, `matchArrived(items)`, `isMarked`, `prune(chatKeys)`, cap 500, serialise.
- **Touches.** `app/src/voice/logic/{protocol,problems,turn,settings,marks}.ts` and `app/test/voice.{protocol,turn,settings,marks}.test.ts`.
- **Check.** `cd app && node --test --experimental-strip-types test/voice.protocol.test.ts test/voice.turn.test.ts
  test/voice.settings.test.ts test/voice.marks.test.ts`; `npm test && npm run check`. The turn test runs on a fake clock and
  covers: 1.2 s countdown, Cancel keeps words, talk-on restarts, Auto-send off waits, Send commits a partial, dictation never
  emits `send`.
- **Not.** `words.ts` is P0's: add a missing sentence there only if the table of arch §12 lacks it, and say so.
- **Depends on.** P0. **Parallel with** P1, P3–P8.

### P3 — The stand-in voice service and the checks' browser

- **Build.** `web/dev/voicestandin.mjs` exactly as arch VC-31 (hand-written WebSocket server, no dependency), with a CLI
  (`node web/dev/voicestandin.mjs --port N [--prefix /voice]`, prints `Voice: http://127.0.0.1:<port>/voice`) and HTTP control
  at `<prefix>/_control/{script,fail,pace,log,reset}`. Mount it at `/voice` in the mock (`web/dev/mock.mjs`: HTTP and the
  server's `upgrade` event; its control reachable from `mockEval` as `voice`) and in the test host (`web/dev/hostface.mjs`
  takes an optional `voice`; `startHost({ voice: true })` makes one and returns it as `host.voice`). The mock's
  `flags.reply = { text, parts, pace }` (arch §13). `web/dev/shot.mjs`: launch Chromium with the three flags of arch §13 and
  grant `microphone` to every context. Rows for the stand-in and `flags.reply` in the mock's header and in
  `web/dev/checks/README.md`.
- **Touches.** `web/dev/voicestandin.mjs`, `web/dev/voicestandin.test.mjs`, `web/dev/mock.mjs`, `web/dev/hostface.mjs`,
  `web/dev/host.mjs`, `web/dev/shot.mjs`, `web/package.json` (test script), `web/dev/checks/README.md`.
- **Check.** `cd web && npm test` (the new test: tokens, voices paging, TTS chunk pacing and `cancelled`, WS handshake and
  frames of 125/126/65536 bytes from a Node 24 `WebSocket` client, scripts by chunk count, `commit`, each failure, the log
  never holding a key value, only `keyHeader: true`); `node --test web/dev/host.test.mjs`;
  `cd web && npm run uicheck -- L8 L16 P0.3` (the mock and the browser flags changed nothing).
- **Not.** No app code.
- **Depends on.** P0 (nothing of it in fact; it may start at once). **Parallel with** all of wave 1.

### P4 — The native audio module `aiwb-audio` (**Opus**)

- **Why Opus.** Real-time audio on two platforms (AVAudioEngine with voice processing and a player node on one engine;
  AudioRecord/AudioTrack threads, audio focus and communication mode), whose errors show only on a device build; the
  feedback loop is a native build, not a unit test.
- **Build.** Arch VC-8 in full: `ios/AiwbAudioModule.swift` + `ios/AiwbAudio.podspec`,
  `android/build.gradle` + `android/src/main/java/expo/modules/aiwbaudio/AiwbAudioModule.kt`, `src/AiwbAudioModule.ts`,
  `src/AiwbAudioModule.web.ts` (null), `src/fake.ts`, `README.md` (as `aiwb-keys`' README: files, contract, session rules);
  the adapter `app/src/voice/platform/audio.native.ts` (`audioOver(module): AudioPort`, lazy load; `voiceBargeIn` from
  `startMic`'s answer; `openMicSettings` = module `openSettings`; base64 passed through untouched); `app/app.config.ts`:
  `NSMicrophoneUsageDescription` and `android.permissions` (arch VC-8); tests `app/test/aiwbaudio.test.ts` (the adapter over
  the fake: chunk events, mute, marks, stop clears, interrupted; every function and event of the contract present in the
  Swift and the Kotlin, as `nativekeys.test.ts` does) and `app/test/appconfig.voice.test.ts`.
- **Touches.** `app/modules/aiwb-audio/**` (P0's contract file: only to correct it, said in the report),
  `app/src/voice/platform/audio.native.ts`, `app/app.config.ts`, the two tests.
- **Check.** `npm test && npm run check`; `app/test/noplainhttp.test.ts` passes unchanged (no `URL(` in the Swift). A device
  build: create `xcrun simctl create vc-p4 "iPhone 17"`, then `node app/e2e/run.mjs open --platform ios --device <udid>
  --build --once` (builds the development app with the module; the flow `open` only opens it), and delete the simulator
  after. Android: `cd app && npx expo prebuild -p android --no-install` then `cd android && ./gradlew
  :aiwb-audio:compileDebugKotlin` (the generated folder is git-ignored; do not commit it); if the Android SDK is not on the
  machine, say so. Disk: check `df -h /System/Volumes/Data` first.
- **Not.** No engine, no screen. No Maestro flow (P17).
- **Depends on.** P0. **Parallel with** wave 1. Do not build while another agent builds on a simulator (ORCHESTRATION).

### P5 — The desktop's voice face

- **Build.** `desktop/voice.js` (arch VC-3, VC-5): the key file (read at each call, `writeFileAtomic`/`ensureStateDir`
  from `@aiwb/conn/node`, exported there if they are not), the request relay (Node `fetch`, body streamed as events,
  `AbortController` per id), the socket relay (Node `WebSocket(url, { headers })`), the allowlist of paths and queries, the
  preview allowlist (URLs seen in relayed `/v2/voices` answers), `AIWB_VOICE_BASE` (unpackaged and loopback only), mic status /
  ask / settings (`systemPreferences`, `shell`), with the electron objects injected so `node --test` can load it.
  `desktop/ipcface.js` registers it (sender check as `aiwb:*`); `desktop/preload.js` exposes `window.aiwbVoice` (shape of P0's
  `bridge.types.ts`); `desktop/main.js` passes `app`, `systemPreferences`, the user data folder, and sets the
  permission handler of VC-5; `desktop/electron-builder.yml` `mac.extendInfo.NSMicrophoneUsageDescription`; `voice.js` in
  `files`.
- **Touches.** `desktop/{voice,ipcface,preload,main,lib}.js`, `desktop/electron-builder.yml`, `desktop/test/voice.test.js`,
  `desktop/test/preload.test.js` (the new face), `packages/conn/node/index.js` (export only, if needed).
- **Check.** `cd desktop && npm test` (new: 0600/0700, atomic, clear; refuses a path or query not allowed; the key in the
  header and nowhere in what goes back to the page; a preview URL not seen is refused; `AIWB_VOICE_BASE` ignored when
  packaged or not loopback; a cancelled request aborts; socket open/send/close relay against a local `ws`-free stand-in
  — `web/dev/voicestandin.mjs` if P3 is merged, else a tiny server in the test); `cd packages/conn && npm test` if
  `node/index.js` changed.
- **Not.** No app code.
- **Depends on.** P0. **Parallel with** wave 1.

### P6 — Web audio: the mic and the player of the web build and the desktop window

- **Build.** `app/src/voice/logic/pcm.ts` (resample Float32 at any rate to 16 kHz Int16, base64 of LE bytes, RMS, odd-byte
  carry, Int16 LE bytes → Float32 for the player) and `app/src/voice/platform/audio.web.ts` (arch VC-10): `AudioPort` with
  `getUserMedia` + `ScriptProcessorNode` + 100 ms chunks, the gapless `AudioContext(24000)` player with marks, level and
  `stop`, `playClip` by `decodeAudioData`, `mic_blocked` on `NotAllowedError`/`SecurityError`, Electron's
  `aiwbVoice.mic.ask()` before `getUserMedia` when `window.aiwbVoice` is there, `voiceBargeIn: false`.
- **Touches.** `app/src/voice/logic/pcm.ts`, `app/src/voice/platform/audio.web.ts`, `app/test/voice.pcm.test.ts`.
- **Check.** `cd app && node --test --experimental-strip-types test/voice.pcm.test.ts` (100 ms at 48 kHz → 1600 samples,
  base64 length 4268; 44.1 kHz; odd bytes carried across writes); `npm test && npm run check`. (Its behaviour in a browser is
  proven by VC.3/VC.4/VC.5 later; P6 may add a throwaway page under `/tmp` to try it, not committed.)
- **Not.** No engine.
- **Depends on.** P0. **Parallel with** wave 1.

### P7 — The toolbar's fit rule for the voice pair (core)

- **Build.** `fitWithTail` in `packages/core/src/logic/composerfit.ts` (arch VC-17): the voice pair placed as the insert
  button is (it takes nothing from the controls), the insert button gives way first, else the pair in the "more" popup
  bringing the chip; `held` for both. `fitWithInsert` stays (it is `fitWithTail` without a pair) and its tests stay green.
- **Touches.** `packages/core/src/logic/composerfit.ts`, `packages/core/test/composerfit.test.ts`.
- **Check.** `cd packages/core && node --test --experimental-strip-types test/composerfit.test.ts` (cases: wide row → pair
  in row; narrower → insert to "more" or nowhere, pair still in row; narrower → pair in popup, chip shown with no control in it;
  held keeps the pair in the popup; pair width unknown → drawn in the row to be measured); `npm test && npm run check`.
- **Not.** No app file (P13a draws it).
- **Depends on.** Nothing. **Parallel with** wave 1.

### P8 — One new-chat action for a board, with `open`

- **Build.** Arch VC-29: `newChat(where, o?: {open?: boolean}): Promise<ChatView | null>` in `app/src/screens/shell/nav.ts`;
  on a board: `lastChat.set`, `expandBoardRow(board)`; open only when `open !== false`. `app/src/screens/sidebar/rowsopen.ts`
  (the map of board rows' open state, `useBoardRowOpen`, `setBoardRowOpen`) and `BoardNode` in `rows.tsx` reading it instead
  of `useState(true)`; the sidebar registers `expandBoardRow` (as `setEditRow`). Callers of today unchanged in behaviour.
- **Touches.** `app/src/screens/shell/nav.ts`, `app/src/screens/sidebar/{rows.tsx,rowsopen.ts,Sidebar.tsx}`,
  `app/test/newchat.board.test.ts`.
- **Check.** `cd app && node --test --experimental-strip-types test/newchat.board.test.ts` (over a fake `api.newChat` and
  the store: `open:false` does not select, opens the row, sets the last chat; no option selects as before; a refusal answers
  null and reports); `npm test && npm run check`; `cd web && npm run uicheck -- L11 SEC.2` and the free
  `node web/e2e/newchat.e2e.mjs` (the five places that make a chat still do).
- **Not.** No voice code.
- **Depends on.** Nothing. **Parallel with** wave 1.

---

## Wave 2

### P9 — The keystore and the network ports

- **Build.** Arch VC-2, VC-3, VC-4, VC-6, VC-7: `platform/keystore.native.ts` (secure store, key `aiwb.voice.elevenlabs`,
  the options of `secretVault`), `keystore.web.ts` (Electron proxy over `window.aiwbVoice.key`, else memory),
  `platform/origin.ts`, `platform/net.native.ts` (RN `WebSocket` with the header; `fetch` of `expo/fetch` with the header and a
  streamed body; preview allowlist), `platform/net.web.ts` (Electron relay over `window.aiwbVoice`; HTTP way: page-direct to
  `location.origin + "/voice"`, the token for the socket), `platform/index.native.ts` / `index.web.ts` exporting
  `platformVoicePorts()`; `app/src/bootstrap.ts` calls `setVoicePorts(platformVoicePorts())` and starts nothing.
  `app/test/noplainhttp.test.ts` changed as arch VC-7 says.
- **Touches.** `app/src/voice/platform/{keystore.*,net.*,origin,index.*}.ts`, `app/src/bootstrap.ts`,
  `app/test/noplainhttp.test.ts`, `app/test/voice.keystore.test.ts`, `app/test/voice.net.test.ts`.
- **Check.** `cd app && node --test --experimental-strip-types test/voice.keystore.test.ts test/voice.net.test.ts
  test/noplainhttp.test.ts` (each store over fakes; the web net over a fake `window.aiwbVoice` and over a fake fetch/WebSocket:
  the header present, the token used for the socket only on the page-direct path, the key absent from every URL; `origin.ts`
  ignores the override without `__DEV__` and for a public host); `npm test && npm run check`. If P3 is merged:
  `node web/dev/voicestandin.mjs` + a small Node script of the test that runs `net.web.ts`'s page-direct path against it.
- **Not.** No engine, no screen.
- **Depends on.** P0, P2 (paths). Uses P5's bridge shape from P0's `bridge.types.ts`. **Parallel with** P10.

### P10 — The engine, part A: stores, the one player, speaking, Read aloud, keys and voices

- **Build.** Arch §3.1, VC-11, VC-12, VC-14, VC-32, §12's problem state: `engine/state.ts` (session store, settings store over
  the kv `aiwb.voice.settings`, problem, reading, `settingsOpen`; `subscribe`), `engine/player.ts`, `engine/speaker.ts`
  (≤ 2 TTS in flight, abort on `stopAll`, marks, voice chosen at first use), `engine/keycheck.ts` (`testKey`, `voices`,
  `playPreview`), Read aloud (`voice.readAloud`/`stopReading`: `has()` first → `no_key`; the text through `speechText` and the
  splitter with `skipCode`; one utterance), `engine/testseam.ts`. `index.ts`: the real bodies of `readAloud`, `stopReading`,
  `testKey`, `hasKey`, `setKey`, `removeKey`, `voices`, `playPreview`, `dismissProblem`, `useVoiceSettings`,
  `setVoiceSettings`, `useVoiceProblem`, `useReading`. The listening methods stay stubs (P11).
- **Touches.** `app/src/voice/engine/{state,player,speaker,keycheck,testseam}.ts`, `app/src/voice/index.ts`,
  `app/test/voice.engine.test.ts` (fake ports: `app/test/fixtures/voice/fakeports.ts`).
- **Check.** `cd app && node --test --experimental-strip-types test/voice.engine.test.ts`: one player; a second
  `readAloud` stops the first and aborts its open requests; ≤ 2 requests in flight; the first `write` happens before the
  fake service ends the first sentence; no key → `no_key` and no net or audio call; 401 → `key_rejected`; a fresh engine makes
  no call at all until a method is called; settings change is seen by every subscriber; `npm test && npm run check`.
- **Not.** No listening, no screen.
- **Depends on.** P0, P1, P2. **Parallel with** P9.

---

## Wave 3

### P11 — The engine, part B: listening, sessions, the reply, marks, barge-in (**Opus**)

- **Why Opus.** The session is a set of concurrent things that must end together and in the right order (mic, socket,
  turn timer, send, the reply follower, the speaker, barge-in, a problem in any of them), over three platforms' ports; the
  goal's "nothing sent without the person's act" and "no audio while muted" depend on it.
- **Build.** Arch VC-18 to VC-23, VC-9, §8: `engine/listener.ts`, `engine/session.ts` (dictation, speech, pill; one at a
  time; `end`, `mute`, `send`, `cancelCountdown`, `interrupt`), `engine/reply.ts` (follows `getState().items`, the splitter,
  no repeat), the marks store (`aiwb.voice.spoken`, `useSpokenMark`, record at send, match at arrival), sending through a
  `send` function given by the caller (the composer's `sendMessage`, the pill's own) so the engine imports no screen; voice
  barge-in only when `audio.voiceBargeIn` and the echo filter of VC-9; the bodies of `startDictation`, `startSpeech`,
  `startPill`, `end`, `mute`, `send`, `cancelCountdown`, `interrupt`, `useVoiceSession`, `useSpokenMark` in `index.ts`.
  `startSpeech` and `startPill` take the `send` (and the pill its `target`) of arch §3.1, so the engine imports no screen.
- **Touches.** `app/src/voice/engine/{listener,session,reply,marks}.ts`, `app/src/voice/index.ts`,
  `app/test/voice.session.test.ts`, the fake ports fixture.
- **Check.** `cd app && node --test --experimental-strip-types test/voice.session.test.ts test/voice.engine.test.ts`:
  dictation shows partials, appends committed, never sends; speech: send by auto after the pause, Cancel keeps and sends
  nothing, Auto-send off waits; Mute and End: no chunk after them, End closes the socket; the reply follower speaks each
  sentence once while the item grows, and flushes on `done`; a rewrite repeats nothing; barge-in by voice with
  `voiceBargeIn` only, and not by the echo of the sentence playing; a tap interrupts everywhere; a problem in the socket
  ends the session and leaves sending untouched; the mark is set on the arriving user item; `npm test && npm run check`.
- **Not.** No screen.
- **Depends on.** P10 (and P2, P1). **Parallel with** P12.

### P12 — Settings > Voice, the foot's button, the problem popover

- **Build.** Arch VC-13, VC-30: `screens/voice/SettingsDialog.tsx` (registered in `Overlays` by `screens/voice/settings.ts`),
  `SettingsButton.tsx` drawn in `Foot.tsx` between the library button and the theme picker, `openVoiceSettings()`,
  `ProblemPopover.tsx` (exported from `screens/voice` for the other screens). The sections, testIDs and behaviour of arch §7;
  the existing `SecretInput`, `Overlay`, `Menu`, `Button`, the foot's switch look for switches.
  Browser check `web/dev/checks/VC.1-settings.mjs` (arch §14.2).
- **Touches.** `app/src/screens/voice/{SettingsDialog,SettingsButton,ProblemPopover}.tsx`, `screens/voice/settings.ts`,
  `app/src/screens/sidebar/Foot.tsx`, `web/dev/checks/VC.1-settings.mjs`, the README row.
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.1 L11 P7.3 A6.4` (the foot still fits;
  contrast floors).
- **Not.** No composer, message or board file.
- **Depends on.** P9, P10, P3. **Parallel with** P11.

---

## Wave 4 (in parallel: their files are apart)

### P13a — The composer: Dictate and Speech mode buttons, dictation

- **Build.** Arch VC-17 (the buttons, their place by `fitWithTail`, the popup entries), §8.1 (dictation into the box through a
  `DictationSink`): `screens/voice/ComposerVoice.tsx` (registered as the composer part `VoiceButtons` by
  `screens/voice/composer.ts`), `Toolbar.tsx` measuring and placing the pair (`widthKey("voice")`, `more-row` entries),
  `Composer.tsx` giving the sink (the box's `set`, typing ends dictation) and the problem popover's anchor. Speech mode's
  button starts speech mode but the bar is P13b's: until then it shows the speech bar part if registered, else nothing new.
  Browser checks `VC.3-dictate.mjs` and `VC.7-fit.mjs`; `P0.6`'s widths fixture written again (`WRITE=1`) and its diff
  explained in the report.
- **Touches.** `app/src/screens/voice/{ComposerVoice.tsx,composer.ts}`, `app/src/screens/composer/{Toolbar,Composer}.tsx`,
  `web/dev/checks/{VC.3-dictate,VC.7-fit}.mjs`, `web/dev/checks/composer.mjs` (testIDs in its header),
  `app/test/fixtures/composer-widths.json`.
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.3 VC.7 A2.2 A2.3 A2.4 P0.1 P0.6 L16 S1.1`.
- **Not.** `fork/`, `board/`, `sidebar/`.
- **Depends on.** P7, P11, P12, P3, P6. **Parallel with** P14, P15a.

### P14 — Read aloud on every message

- **Build.** Arch VC-24: `screens/voice/ReadAloud.tsx` (the part `useReadAloud`, registered by `screens/voice/read.ts`; the
  `voice-reading` chip), `fork/Message.tsx` drawing it in the hover bar and the "⋯" menu, also when no fork action applies,
  never on a reply being written; the problem popover hung from it. Browser check `VC.5-readaloud.mjs`.
- **Touches.** `app/src/screens/voice/{ReadAloud.tsx,read.ts}`, `app/src/screens/fork/Message.tsx`,
  `web/dev/checks/VC.5-readaloud.mjs`, `web/dev/checks/fork.mjs` (if its `actsSeen` must know the new kind).
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.5 L15 A4.2 L22 L17`.
- **Not.** `composer/`, `board/`, `chat/ItemView.tsx` (P13b's).
- **Depends on.** P10, P12, P3, P6. **Parallel with** P13a, P15a.

### P15a — The board pill: shell, orb, sizes, the target chat, + New chat

- **Build.** Arch VC-28, VC-29 (using P8's `newChat`): `screens/voice/pill/{Pill,Orb,ChatChip,Waveform}.tsx`, registered as
  the shell slot `BoardVoice` by `screens/voice/pill.ts`; `BoardCanvas.tsx` draws the slot (canvas boards, not archived).
  The orb states from `useVoiceSession`, the three sizes and collapse (kv `aiwb.voice.pill`), the chip with the sidebar's list
  and Show all, the target (`lastChat`), `+ New chat` (`newChat({board}, {open:false})`), the first turn on an empty board
  making the chat, `startPill` with `target` and `send` (the composer's `sendMessage` from `screens/composer/send.ts`), the
  Auto-send toggle, countdown, Cancel, Send, the ↑ badge, the problem popover. Browser check `VC.6-pill.mjs` for what this
  package draws (states, sizes, target, new chat, chip, Auto-send shared with Settings).
- **Touches.** `app/src/screens/voice/pill/*`, `screens/voice/pill.ts`, `app/src/screens/board/BoardCanvas.tsx`,
  `web/dev/checks/VC.6-pill.mjs`.
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.6 L5 L24 HB.1 P7.4`.
- **Not.** `composer/`, `fork/`, `sidebar/` (P8 did the sidebar's part).
- **Depends on.** P8, P11, P12, P3, P6. **Parallel with** P13a, P14.

---

## Wave 5

### P13b — The speech bar, speech mode, the mic mark

- **Build.** Arch §9 (the speech bar: `SpeechBar.tsx`, the composer part `SpeechBar`, drawn by `Composer.tsx` in place of the
  box and toolbar while the composer's chat is in speech mode; ends when the chat leaves the screen), VC-21 (send with
  `sendMessage`), VC-23 (`MicMark.tsx` as the chat part `MessageMark`, drawn by `ItemView.tsx` in a user message). Browser
  check `VC.4-speech.mjs` (uses `flags.reply`).
- **Touches.** `app/src/screens/voice/{SpeechBar,MicMark}.tsx`, `screens/voice/composer.ts`,
  `app/src/screens/composer/Composer.tsx`, `app/src/screens/chat/ItemView.tsx`, `web/dev/checks/VC.4-speech.mjs`.
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.4 VC.3 L16 L10 L8 A6.3`.
- **Not.** `Toolbar.tsx` (done), `fork/`, `board/`.
- **Depends on.** P13a. **Parallel with** P15b.

### P15b — The pill: captions, the selection chip, hold Space, speaking

- **Build.** Arch VC-28's captions (`Captions.tsx`), the selection chip (`serializeRef` of the board's selection put before the
  words at send, removable), hold Space through the keys port (a tap = the orb; held = push-to-talk, release sends), the
  speaking state and tap-interrupt, the Thinking state while the agent works. `VC.6-pill.mjs` extended: captions, the
  selection's tag in the POST, Space (desktop), speaking and interrupt, edits showing on the board while Thinking (the mock's
  `rpc` knob).
- **Touches.** `app/src/screens/voice/pill/*`, `web/dev/checks/VC.6-pill.mjs`.
- **Check.** `npm test && npm run check`; `cd web && npm run uicheck -- VC.6 P7.4`.
- **Not.** Files outside `screens/voice/pill/` and its check (ask before touching `platform/keys`).
- **Depends on.** P15a. **Parallel with** P13b.

---

## Wave 6 (integration)

### P16 — End to end: the key, the real server, the popovers, the desktop

- **Build.** `web/e2e/voice.e2e.mjs` (arch §14.3: a scratch server through the host with `voice: true`, fake-claude, a
  spoken turn → an ordinary message, the reply spoken sentence by sentence, the canary key search, a page that never used
  voice makes no `/voice` request and no `getUserMedia` call — counted with an init script that wraps
  `navigator.mediaDevices.getUserMedia`). `web/dev/checks/VC.2-popovers.mjs` (arch §14.2: every control × no key, and each
  failure, the chat still sending text). The voice part of `desktop/e2e/app.e2e.mjs` (a standalone stand-in,
  `AIWB_VOICE_BASE`, the key file, no key on the page, Read aloud through main, Remove). The rows of these in `AGENTS.md`'s
  tables (free scripts).
- **Touches.** `web/e2e/voice.e2e.mjs`, `web/e2e/lib/ui.mjs` (voice selectors), `web/dev/checks/VC.2-popovers.mjs`,
  `desktop/e2e/app.e2e.mjs`, `AGENTS.md`.
- **Check.** `node web/e2e/voice.e2e.mjs`; `cd web && npm run uicheck -- VC.2`; `cd app && npm run build:web && cd ../desktop
  && npm run e2e`; `node web/e2e/newchat.e2e.mjs`.
- **Not.** App code, unless a check finds a defect: then report it with the failing line; fix only a one-line slip and say so.
- **Depends on.** Waves 0–5. **Parallel with** P17, P18.

### P17 — The device flow: the microphone and the audio session (goal 6.6)

- **Build.** `app/e2e/maestro/voice-mic.yaml` (arch §14.4), the runner's `needs=voice` (starts a standalone stand-in on the
  computer, passes `EXPO_PUBLIC_AIWB_VOICE_BASE` to Metro and `VOICE_CONTROL` to the flow, reads its log at the end and fails
  the run if the chunks are not 16 kHz / 100 ms), a dev-only status line `voice-dev` (`__DEV__` only) the flow reads for
  `drained`, the README row.
- **Touches.** `app/e2e/maestro/voice-mic.yaml`, `app/e2e/run.mjs`, `app/e2e/lib/*` (a stand-in starter),
  `app/e2e/README.md`, a dev-only line in `app/src/screens/voice/` (guarded by `__DEV__` and the env value).
- **Check.** Your own simulator: `xcrun simctl create vc-p17 "iPhone 17"`; `node app/e2e/run.mjs voice-mic --platform ios
  --device <udid>`; delete the simulator. Android only with the emulator lock (README); else say so.
  `cd app && node --test --experimental-strip-types test/getmaestro.test.ts` and `npm test && npm run check`.
- **Not.** No other flow.
- **Depends on.** P4, P9, P12, P13a, P14. **Parallel with** P16, P18.

### P18 — Documentation

- **Build.** `docs/architecture.md`: a section "Voice" (where the key is per platform, who calls ElevenLabs, the CSP unchanged
  and why, the one player, barge-in by tap everywhere and by voice where shipped, the mic mark on this device only, the
  stand-in); `docs/development.md`: running the stand-in, the device override, the checks' browser flags; the README's
  feature list. Plain words, the docs' own style.
- **Touches.** `docs/architecture.md`, `docs/development.md`, `README.md`.
- **Check.** None (documentation only). Read once against the code merged.
- **Depends on.** Waves 0–5. **Parallel with** P16, P17.

---

## The waves

| Wave | Packages (parallel inside a wave) |
|---|---|
| 0 | P0 |
| 1 | P1, P2, P3, P4 (Opus), P5, P6, P7, P8 |
| 2 | P9, P10 |
| 3 | P11 (Opus), P12 |
| 4 | P13a, P14, P15a |
| 5 | P13b, P15b |
| 6 | P16, P17, P18 |

Files shared between packages, and how they are kept apart: `app/src/voice/index.ts` (P0 → P10 → P11, in sequence);
`Composer.tsx` (P13a → P13b); `screens/voice/pill/*` (P15a → P15b); `chat/parts.tsx`, `composer/parts.tsx`,
`shell/slots.tsx`, `register.ts`, `icons.tsx` (P0 only); `web/dev/mock.mjs`, `shot.mjs` (P3 only);
`web/dev/checks/README.md` (P3 makes the section; each UI package adds its row: a one-line merge). P7 (core) and P8
(sidebar, nav) touch nothing of the others. P4 is the only package that builds natively in waves 1–5.

## Final integration checks (goal §6), after wave 6

Run once on the integrated branch `voice-chats`, nothing else testing on the machine:

1. `git diff --stat main...voice-chats -- cmd internal` is empty; `go test ./...` passes (6.7).
2. From the root `npm test && npm run check`; `cd web && npm test`; `cd desktop && npm test`; `cd packages/conn && npm test`
   (6.7).
3. `cd web && npm run uicheck -- VC` (VC.1–VC.7, at their viewports) and the existing checks of the screens changed: `A2 P0.1
   P0.3 P0.6 L5 L8 L10 L11 L15 L16 L17 L22 L24 HB.1 P7 S1.1 A6.4` (6.1, 6.2, 6.4, 6.5, 6.6, 6.7).
4. `cd web && npm run uicheck:electron -- VC.1 VC.5` (the desktop's Chromium draws them).
5. `node web/e2e/voice.e2e.mjs` (6.1, 6.3, 6.7); `node web/e2e/newchat.e2e.mjs` (the shared new-chat action);
   `cd app && npm run build:web && cd ../desktop && npm run e2e` (6.3 on the desktop).
6. The device flow once, on a simulator you name: `node app/e2e/run.mjs voice-mic --platform ios --device <udid>` (6.6); the
   Android compile of P4.
7. By the person, on devices (not automated, written in the final report as left to do): a run against the real ElevenLabs
   with their own key on an iPhone, an Android phone and the desktop app (Test key, dictation, speech mode, read aloud, the
   pill); voice barge-in on the phones with the speaker (VC-9); the microphone prompt on macOS.
