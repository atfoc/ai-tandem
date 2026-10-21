# Voice devices: the work packages

The goal is `voice-devices-goal.md`, the design is `architecture.md` (VD-n), the platform facts are in `platforms.md`, and
the rules are in `ORCHESTRATION.md`. Every package below is handed to one agent with the model named. Packages of one
wave touch disjoint files and run in parallel, each in its own worktree. A wave starts when the waves it depends on are
merged into `voice-devices`.

## What every package agent does (put this in each prompt)

1. Read `plans/voice-devices/ORCHESTRATION.md` first, then the goal, `architecture.md`, `platforms.md` and this
   package's section. Read the code it names before changing it.
2. Make its worktree from the parent's branch:
   `git -C <parent worktree> worktree add /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/vd-<id> -b vd-<id>`
   (e.g. `vd-d2-engine`). Clone the installed `node_modules` as ORCHESTRATION.md shows; never a full `npm install`.
3. Touch only the files the package lists. A needed change elsewhere means stop and report. Never touch `cmd/` or
   `internal/`. No new dependency. No call to ElevenLabs or a paid model.
4. Satisfy the interfaces exactly as written (they cross packages). A signature that seems wrong is reported, not
   changed.
5. Run the acceptance commands, in the foreground, and report their results. Follow `AGENTS.md` (no `-count=1` by
   habit, nothing run twice "to be sure"). A failure the change cannot have caused is run once alone and reported.
6. Commit on its branch with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or Opus 5.5), merge the
   parent branch in if it moved, and end with the report ORCHESTRATION.md describes.

"Root tests" below means, from the worktree root: `npm test && npm run check`.

---

## Wave 1: the foundation (one package, alone)

### D1: Shared types, pure logic, words, settings, fakes, native contract stubs (Sonnet 5.5, high)

**Build**

- `app/src/voice/ports.ts`: every type and member of **VD-1**, exactly. Also the `notSet` defaults of VD-1.
- `app/src/voice/logic/devices.ts` (new, pure, no imports but types and `../words.ts`):
  ```ts
  export const PSEUDO_IDS: readonly string[];                       // ["default", "communications"]
  export function matchSaved(saved: SavedDevice, devices: readonly AudioDevice[]): AudioDevice | null;           // VD-4
  export function privacyOfName(name: string): Privacy;                                                         // VD-11 word lists
  export function shouldPause(lost: AudioDevice | null, now: AudioDevice | null): boolean;                      // VD-11 (null lost = unknown)
  export function cutName(name: string, max?: number): string;                                                  // default 40, "…"
  export type NoticeKind = "start-mic" | "start-speaker" | "start-both" | "lost-mic" | "lost-speaker" | "paused";
  export function noticeText(kind: NoticeKind, names: { mic?: string | null; speaker?: string | null; device?: string | null }): string;  // VD-13 table
  export type DeviceOption = { key: string; label: string; device: SavedDevice | null; missing: boolean };
  export type DeviceChoice =
    | { show: "pick"; options: DeviceOption[]; selected: string; hiddenNote: boolean }
    | { show: "system"; line: string };
  export type DeviceChoices = { mic: DeviceChoice; speaker: DeviceChoice; linkedNote: boolean; neitherLine: string | null; loading: boolean };
  /** list null: not listed yet (loading: true, System default only). VD-17's rules. */
  export function choicesFor(list: DeviceList | null, settings: { mic: SavedDevice | null; speaker: SavedDevice | null }, ability: DeviceAbility): DeviceChoices;
  /** The web port's helper: MediaDeviceInfo-like entries → AudioDevice[] of one kind, pseudo-entries dropped, privacy by name. */
  export function fromMediaDevices(entries: readonly { kind: string; deviceId: string; label: string }[], kind: DeviceKind): AudioDevice[];
  ```
  The option key of System default is `"system"`; a device's is `"d:" + id`; a missing saved one's is `"missing:" + id`.
- `app/src/voice/logic/chime.ts` (new): `export function chimePcm(): Uint8Array`, by VD-15.
- `app/src/voice/logic/settings.ts`: `mic`, `speaker` (VD-3) with defaults and clamping.
- `app/src/voice/words.ts`: every sentence of VD-5, VD-7, VD-12, VD-13, VD-16, VD-17: the card title "Microphone and
  speaker", "Microphone", "Speaker", "System default", `System default (${name})`, `${name} (not connected)`, the
  follows-the-system line, the neither line, the linked note, the hidden note, "Test microphone", "Stop test", "Voice is
  listening.", "Test speaker", "Phone microphone", "Phone speaker", "Continue", "Continue reading", the orb's "Continue",
  and the notice sentences (which `noticeText` uses). **All words of the whole goal go in here now**, so later packages do
  not edit this file.
- `app/src/voice/index.ts`: **types only**: `SessionState.paused: { device: string } | null`,
  `ReadingState.paused: boolean`, re-export `VoiceNotice` (VD-13), `DeviceChoices`, `SavedDevice`, `AudioDevice`. And in
  `engine/state.ts`: `IDLE_SESSION.paused = null`, `NOT_READING.paused = false`, `noticeStore`
  (`createStore<VoiceNotice | null>`, reset by `resetEngine`), `waits.noticeMs = 6000`. No behaviour.
- `app/modules/aiwb-audio/src/AiwbAudio.ts`, `src/fake.ts`: the contract of **VD-18** and the fake's devices
  (`plug`, `unplug`, `route`, as VD-19 item 2). **Stubs** in `ios/AiwbAudioModule.swift` and
  `android/.../AiwbAudioModule.kt` only, so the names test passes: `listDevices` → `{devices: [], defaultInput: null,
  defaultOutput: null}`, `deviceAbility` → `{input: "system", output: "system", linked: false}`, `setBuiltInNames` no-op,
  `startMic` takes the third argument (optional String) and ignores it, answering `device: null`, `setOutput` → `{device:
  null}`, `playerHold` / `playerResume` no-op, `Events` gains `onDevices`, `onRoute`. Behaviour on the phones stays
  exactly as today.
- `app/src/voice/platform/audio.web.ts` and `audio.native.ts`: **stubs only** so the type check passes: `devices` with
  ability `"system"`/`"system"` and an empty list, `startMic` ignoring `device` with `opened: { device: null, missed:
  false }`, `player.useOutput` resolving `{ device: null, missed: false }`, `hold` / `resume` / `onRoute` doing nothing.
  Behaviour stays as today.
- `app/test/fixtures/voice/fakeports.ts`: fake devices, per VD-19 item 1.
- Tests: `app/test/voice.devices.logic.test.ts` (the logic rows of architecture §12.1) and the added cases of
  `app/test/voice.settings.test.ts`.

**Touches only** the files above. **Not**: engine behaviour, screens, the platform behaviour, `VoiceAudio.swift`, the
Kotlin engine files.

**Accept**: root tests (with `app/test/aiwbaudio.test.ts` and `app/test/noplainhttp.test.ts` passing unchanged in
substance). Android stub: `cd app && npx expo prebuild -p android --no-install && cd android && ./gradlew
:aiwb-audio:compileDebugKotlin` (the generated folder is git-ignored; if the SDK is missing, say so). The Swift stub is
compiled by D5.

**Depends on**: nothing.

---

## Wave 2 (in parallel: six packages, disjoint files)

### D2: The engine (Sonnet 5.5, high)

**Build** VD-6, VD-8, VD-9 (engine side), VD-10 (engine side), VD-11 (`shouldPause`), VD-12, VD-13, VD-15, VD-16:

- `app/src/voice/engine/devices.ts` (new): applying `opened`/`useOutput` results (notices for `missed`, one notice for
  both), the `onRoute` subscription while a session or utterance runs, turning events into a notice, the pause, or an
  end (`mic_blocked`), `resume`, the microphone test, Test speaker, `useDeviceChoices` data (list on mount and on
  `watch`, `choicesFor`).
- `session.ts` (pause state, gate closed while paused, countdown cancelled, `resume`), `listener.ts` (passes
  `device: settings.mic`, hands `opened` over), `speaker.ts` (`useOutput` once per utterance, and once per speech/pill
  session; Read aloud paused state), `player.ts` (passes `useOutput`, `hold`, `resume`), `state.ts` (notice lifetime),
  `testseam.ts` (`notice()`, the paused fields).
- `app/src/voice/index.ts`, the public face, exactly:
  ```ts
  voice.resume(): void;                       // Continue / Continue reading / the paused orb
  voice.testSpeaker(): Promise<void>;
  voice.startMicTest(anchor: string): Promise<void>;   // a refusal shows mic_blocked on `anchor`
  voice.stopMicTest(): void;
  export function useVoiceNotice(where: { kind: "chat"; chat: string } | { kind: "board"; board: string }): string | null;
  export function useDeviceChoices(): DeviceChoices;
  export function useMicTest(): { on: boolean; level: number; busy: boolean };   // busy: a session listens
  ```
- Test `app/test/voice.devices.engine.test.ts` (the engine row of architecture §12.1). The existing
  `voice.engine.test.ts` and `voice.session.test.ts` keep passing.

**Touches only** `app/src/voice/engine/**`, `app/src/voice/index.ts`, the new test (and `fakeports.ts` only to add a
helper, said in the report). **Not**: `platform/`, `logic/` (D1's; report a defect), screens, modules.

**Accept**: root tests.

**Depends on**: D1.

### D3: The web and desktop port (Sonnet 5.5, high)

**Build** VD-1/VD-2 for `audio.web.ts`: listing by `enumerateDevices` with `fromMediaDevices`, `hidden`, `defaults` from
the `default` entry, `watch` on `devicechange`; `startMic` with `deviceId: { exact }` after `matchSaved`
(`OverconstrainedError` → default + `missed`); `useOutput` by `setSinkId` on the player's context, made if needed (never
`sinkId` in the constructor: platforms.md §1), rejection → `setSinkId("")` + `missed`; `playClip` on the same context;
`hold`/`resume` by `suspend`/`resume`; VD-9 (track `ended` → reopen default into the same chunker, `input-lost` /
`input-failed`); VD-10 and VD-11 (on `devicechange`: sink gone or default changed → hold by `shouldPause`'s inputs, then
`setSinkId("")`, `output-lost`); ability output `"system"` when `AudioContext.prototype.setSinkId` is missing. Device
names never in `console.*`.

**Touches only** `app/src/voice/platform/audio.web.ts` (it may split out `audio.web.devices.ts` next to it) and the new
test `app/test/voice.audioweb.devices.test.ts` (fakes of `navigator.mediaDevices` and `AudioContext` in Node).

**Accept**: root tests; `cd web && npm run uicheck -- VC.3 VC.5` (nothing broke in capture and playback).

**Depends on**: D1.

### D4: The native adapter (Sonnet 5.5, high)

**Build** `app/src/voice/platform/audio.native.ts` over the VD-18 contract: `devices` (ability from `deviceAbility()`,
list from `listDevices()`, `watch` on `onDevices`), `setBuiltInNames` from `words.ts` once at load, `startMic` (list,
`matchSaved`, pass the id, compare the answer to tell `missed`), `useOutput` (the same with `setOutput`), `hold` /
`resume`, `onRoute` passing `onRoute` events on (mapping `NativeDevice` → `AudioDevice`). Added cases in
`app/test/aiwbaudio.test.ts` over `fake.ts`.

**Touches only** `app/src/voice/platform/audio.native.ts`, `app/test/aiwbaudio.test.ts`.

**Accept**: root tests.

**Depends on**: D1.

### D5: iOS native (**Opus 5.5, high**: native route handling; **needs a simulator**)

**Build** VD-18's iOS part, VD-9, VD-10, VD-11 in `VoiceAudio.swift` and `AiwbAudioModule.swift`: `listDevices`
(first establish on the simulator whether `availableInputs` is filled with the category set and the session inactive;
otherwise the brief `.mixWithOthers` activation; write the finding into `plans/voice-devices/d5-ios.md`),
`deviceAbility` `{pick, system, false}`, `startMic` with `setPreferredInput` after activation, `setOutput` answering the
current route, route changes split into `input-lost` / `input-failed` / `output-lost` (with an immediate
`playerNode.pause()` when the lost output was private and the new one is not private), `playerHold` / `playerResume`,
**keeping copies of scheduled, unplayed buffers and scheduling them again after an engine restart** (no `drained` for a
queue that was not played), `onDevices`. `onInterrupted("route")` is no longer sent for a lost device (calls and media
resets stay). Update `app/modules/aiwb-audio/README.md` (iOS sections).

**Touches only** `app/modules/aiwb-audio/ios/**`, the iOS parts of `app/modules/aiwb-audio/README.md`,
`plans/voice-devices/d5-ios.md`.

**Accept**: root tests (the names test, `noplainhttp`: no `URL(` in Swift). Make your own simulator
(`xcrun simctl create vd-d5 "iPhone 17"`), then `node app/e2e/run.mjs voice-mic --platform ios --device <udid> --build`
(the existing flow must still pass on the new module); delete the simulator after. Disk first (`df -h
/System/Volumes/Data`). Do not build while another agent builds (ORCHESTRATION).

**Depends on**: D1. Its JS behaviour is tested through D4's adapter tests over the fake.

### D6: Android native (**Opus 5.5, high**: native route handling)

**Build** VD-18's Android part, VD-9, VD-10, VD-11 in `VoiceAudio.kt`, `MicCapture.kt`, `PcmPlayer.kt` and
`AiwbAudioModule.kt`: `deviceAbility` by API level; `listDevices` grouped by VD-4's ids, built-ins named with
`setBuiltInNames`; `AudioRecord.setPreferredDevice`; `setCommunicationDevice(chosen speaker)` in communication mode,
cleared after; `AudioTrack.setPreferredDevice` for playback; `AudioDeviceCallback` → `onDevices` and the losses;
`BECOMING_NOISY` → held private loss; `playerHold`/`playerResume` (`pause()`/`play()` keep the written data); a lost
input → default routing or a new `AudioRecord`, else `input-failed`. Establish (by reading the platform source in
`~/Library/Android/sdk/sources/android-36.1` and, if the lock is free, on the emulator) whether `setPreferredDevice` holds
for `AudioRecord` in `MODE_IN_COMMUNICATION`, and write it into `plans/voice-devices/d6-android.md`. Update the Android
parts of `app/modules/aiwb-audio/README.md`.

**Touches only** `app/modules/aiwb-audio/android/**`, the Android parts of the README, `plans/voice-devices/d6-android.md`.

**Accept**: root tests; `cd app && npx expo prebuild -p android --no-install && cd android && ./gradlew
:aiwb-audio:compileDebugKotlin`; the emulator flow `voice-mic` only with the lock (`app/e2e/README.md`), otherwise say so.

**Depends on**: D1.

### D7: Browser and desktop stand-in devices (Sonnet 5.5, high)

**Build** VD-19 item 3: `web/dev/checks/devices.mjs` (`installDevices(page | context, { inputs, outputs, granted })`
via `addInitScript`; `window.__aiwbDevices` = `{ list(), plug(d), unplug(id), grant(), opened(), sinks(), calls() }`;
tones per input; blank list before `grant()`; `ended` + `devicechange` on unplug; the `setSinkId` wrapper with records
and `NotFoundError`). Its test `web/dev/checks/devices.test.mjs` runs the layer's page script in a fake global (Node),
added to `web/package.json`'s `test`. `web/dev/voicestandin.mjs`: `toneHz` per STT session in `log()` (zero crossings
of the received PCM), with a case in `web/dev/voicestandin.test.mjs`.

**Touches only** `web/dev/checks/devices.mjs`, `web/dev/checks/devices.test.mjs`, `web/package.json` (the `test`
line), `web/dev/voicestandin.mjs`, `web/dev/voicestandin.test.mjs`.

**Accept**: `cd web && npm test`; root tests (unchanged); `cd web && npm run uicheck -- VC.3` (the stand-in service still
serves the existing checks).

**Depends on**: D1 (only for the device shape; it imports nothing of the app).

---

## Wave 3 (in parallel: two packages)

### D8: Settings > Voice: the Microphone and speaker card (Sonnet 5.5, high)

**Build** VD-17 and the controls of VD-15/VD-16: `app/src/screens/voice/DevicesSection.tsx` (new) from `Section`,
`Row`, `Picker`, `Button` and the pill's `Waveform`; `SettingsDialog.tsx` places it between Voice and Auto-send;
pickers write `setVoiceSettings({ mic })` / `({ speaker })`; Test microphone (`vs-mic-test`, toggle, `ProblemPopover`
anchor `mictest`), the meter `vs-mic-level`, Test speaker `vs-speaker-test`; testIDs `vs-devices-section`, `vs-mic`,
`vs-speaker`, `vs-speaker-system`, `vs-devices-neither`, `vs-devices-note`. Update `web/dev/checks/VC.1-settings.mjs` for
the new card (order, contrast) and its header.

**Touches only** `app/src/screens/voice/DevicesSection.tsx`, `app/src/screens/voice/SettingsDialog.tsx`,
`web/dev/checks/VC.1-settings.mjs`.

**Accept**: root tests; `cd web && npm run uicheck -- VC.1`; `cd web && npm run uicheck:electron -- VC.1`.

**Depends on**: D2, D3.

### D9: Notices and the pause on the session's screens (Sonnet 5.5, high)

**Build** VD-12's looks and VD-14:

- The composer part `VoiceNotice` (`composer/parts.tsx`: type and null default; `composer/Composer.tsx`: drawn where
  `ModelNotice` is, above the box, the speech bar or the archived bar), the component
  `app/src/screens/voice/VoiceNotice.tsx` (`voice-notice`, `ModelNotice`'s look, `useVoiceNotice({kind: "chat"})`),
  registered in `screens/voice/composer.ts`.
- `SpeechBar.tsx`: `speech-paused` line, `speech-continue`.
- The pill: `pill/logic.ts` (`orbState` → `paused`), `pill/Orb.tsx` (the paused look, tap = `voice.resume`),
  `pill/Pill.tsx` (`pill-continue`, the notice caption `caption-notice` through `Captions.tsx`).
- Read aloud: `ReadAloudAction` (`chat/parts.tsx`) gains `paused: boolean; resume(): void`; `ReadAloud.tsx` fills them;
  `fork/Message.tsx` draws **Continue reading** (`voice-reading-continue`) beside Stop reading.
- Update the headers of the checks whose testIDs grew (`web/dev/checks/composer.mjs`, `VC.4`, `VC.5`, `VC.6`: comments
  only).

**Touches only** the files named. **Not**: the engine, `words.ts`, Settings.

**Accept**: root tests; `cd web && npm run uicheck -- VC.4 VC.5 VC.6 L16 L15 L24`.

**Depends on**: D2.

---

## Wave 4 (in parallel: four packages)

### D10: The browser check VC.8 (Sonnet 5.5, high)

**Build** `web/dev/checks/VC.8-devices.mjs` exactly as architecture §12.2 says, with `devices.mjs` and the stand-in
service's `toneHz`; a row in `web/dev/checks/README.md`.

**Touches only** `web/dev/checks/VC.8-devices.mjs`, `web/dev/checks/README.md`.

**Accept**: `cd web && npm run uicheck -- VC.8` at desktop, tablet and phone; `cd web && npm run uicheck -- VC`
(VC.1–VC.8 together); `cd web && npm run uicheck:electron -- VC.8`.

**Depends on**: D3, D7, D8, D9.

### D11: The desktop e2e's devices part (Sonnet 5.5, high)

**Build** the row of architecture §12.3 for `desktop/e2e/app.e2e.mjs`: the fake-device switches on the launch; listing,
the pick kept over a restart, `sinkId` and the track's `deviceId`; unplugging through `devices.mjs` (via the context's
`addInitScript`, or evaluate-and-reload if that is not available: say which). Update its header.

**Touches only** `desktop/e2e/app.e2e.mjs`.

**Accept**: `cd app && npm run build:web && cd ../desktop && npm test && npm run e2e`.

**Depends on**: D3, D7, D8, D9.

### D12: The voice e2e's device canaries (Sonnet 5.5, high)

**Build** the row of architecture §12.3 for `web/e2e/voice.e2e.mjs`: no `enumerateDevices` call on a page that never used
voice; the `CANARY-MIC-<random>` / `CANARY-OUT-<random>` run, chosen and used, searched for everywhere the key is searched.
Update its header and the line of `AGENTS.md` that describes it (only that line).

**Touches only** `web/e2e/voice.e2e.mjs`, that line of `AGENTS.md`.

**Accept**: `node web/e2e/voice.e2e.mjs`.

**Depends on**: D2, D3, D7, D8.

### D13: The iOS device flow (Sonnet 5.5, high; **needs a simulator**)

**Build** `app/e2e/maestro/voice-devices.yaml` as architecture §12.4 says, and the dev line's `mic=` field
(`app/src/screens/voice/DevLine.tsx`: the opened device's kind, `builtIn` or `external`, never a name).

**Touches only** `app/e2e/maestro/voice-devices.yaml`, `app/src/screens/voice/DevLine.tsx`, the flow's row in
`app/e2e/README.md`.

**Accept**: root tests; your own simulator, `node app/e2e/run.mjs voice-devices --platform ios --device <udid> --build`,
and the simulator deleted after. Not while another agent builds.

**Depends on**: D4, D5, D8. If it fails twice on Sonnet, it goes to Opus (ORCHESTRATION).

---

## Wave 5

### D14: The docs (Sonnet 5.5, high)

**Build** (goal 6.6): `docs/architecture.md`'s voice part: devices, the saved choice, the fallback and the notices, the
pause, what each platform allows (platforms.md §5's table), the stand-ins. `plans/voice-chats/architecture.md`: a dated
note under VC-8 and VC-10 that the route handling of `onInterrupted("route")` and the track's `ended` is superseded by
`plans/voice-devices/architecture.md` VD-9/VD-10. `AGENTS.md`'s voice row: `VC.1` to `VC.8`. `web/dev/checks/README.md`
if D10 left it short. `plans/voice-devices/status.md`: where the work stands.

**Touches only** documentation (the files named).

**Accept**: none (documentation only, `AGENTS.md`). A read-through that every testID and command named exists.

**Depends on**: waves 1–4.

### D15: The integrated verification (**Opus 5.5, high**)

On `voice-devices` with everything merged, run once, in this order, while nothing else tests on the machine:
`git diff main...voice-devices -- cmd internal` (empty); `go test ./...`; root tests; `cd web && npm test`; `cd desktop &&
npm test`; `cd web && npm run uicheck -- VC L15 L16 L24`; `cd web && npm run uicheck:electron -- VC.1 VC.5 VC.8`; `node
web/e2e/voice.e2e.mjs`; `cd app && npm run build:web && cd ../desktop && npm run e2e`; the device flow `voice-devices` (and
`voice-mic`) once on its own simulator. Write the results, what is left to the person (headsets and Bluetooth on a real
iPhone, iPad and Android phone; macOS/Windows/Linux desktops with real devices), and the checks that fail on `main` too,
into `plans/voice-devices/status.md`.

**Touches only** `plans/voice-devices/status.md` (fixes go back to the package that owns the file).

**Depends on**: D14.

---

## Summary

| Wave | Package | Model | Simulator | Depends on |
|---|---|---|---|---|
| 1 | D1 shared types, logic, words, settings, fakes, contract stubs | Sonnet | – | – |
| 2 | D2 engine | Sonnet | – | D1 |
| 2 | D3 web/desktop port | Sonnet | – | D1 |
| 2 | D4 native adapter | Sonnet | – | D1 |
| 2 | D5 iOS native | **Opus** | iOS | D1 |
| 2 | D6 Android native | **Opus** | (emulator only with the lock) | D1 |
| 2 | D7 browser/desktop stand-in devices | Sonnet | – | D1 |
| 3 | D8 Settings card | Sonnet | – | D2, D3 |
| 3 | D9 notices and pause on screens | Sonnet | – | D2 |
| 4 | D10 VC.8 | Sonnet | – | D3, D7, D8, D9 |
| 4 | D11 desktop e2e | Sonnet | – | D3, D7, D8, D9 |
| 4 | D12 voice e2e canaries | Sonnet | – | D2, D3, D7, D8 |
| 4 | D13 iOS device flow | Sonnet (→ Opus if it fails twice) | iOS | D4, D5, D8 |
| 5 | D14 docs | Sonnet | – | 1–4 |
| 5 | D15 integrated verification | **Opus** | iOS | D14 |

Only one simulator build runs at a time on the machine. D5 (wave 2) and D13 (wave 4) are never in the same wave.
