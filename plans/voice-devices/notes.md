# Notes between packages

Every package agent reads this after packages.md. The orchestrator adds what a merged package's report says others must know.

## D1

- In `app/test/fixtures/voice/fakeports.ts`, `FakeDevices.outputs` is the device list; the `useOutput` calls are recorded in `used` (not `outputs`). Other records: `opened`, `holds`, `resumes`, `lists`. Helper `dev(...)` builds a device.
- `VoiceNotice` type is defined in `app/src/voice/logic/devices.ts` and re-exported from `index.ts`. `NO_DEVICES` (empty DevicePort) is exported from `ports.ts`.
- The fake native module (`app/modules/aiwb-audio/src/fake.ts`) has `plug`, `unplug`, `route`, `failReopen`; its `listening()` still returns the three old events, the device events are counted by `listeningDevices()`. A held fake player plays nothing (no marks, no drained); `FakeAudio.writes[i].held` says whether it was held at each write.
- `engine/state.ts` `updateSettings` now compares with `sameSettings` (saved devices are fresh objects).
- `engine/listener.ts` currently passes `device: null` to `startMic` (D2 replaces it with `settings.mic`).
- `choicesFor`: a hidden or loading list shows System default only and selects it; the saved value is untouched.
- The Android Kotlin compile needs Homebrew `openjdk@17` (JAVA_HOME); `expo prebuild` rewrites the `android`/`ios` scripts of `app/package.json` — revert that, never commit it. Do not run `gradlew --stop` (other agents' builds).

## D4

- `listDevices()` must return only the device kinds the ability allows; a `defaultOutput` not in `devices` gives `defaults.output = null` (D5, D6).
- If `listDevices` fails during a start, the adapter asks the module for the saved id directly; the module's answer decides `missed`.
- `useOutput(null)` makes no native call until a saved output was applied once in the app's life.
- On `input-failed` the adapter drops its microphone; late chunks and `stop()` do nothing.
- Fake limit: `fake.unplug(id)` reports a loss only for the first device with that id (shared Bluetooth ids need two calls).
- Loading the module calls `setBuiltInNames` first.

## D7 (stand-in devices for the browser checks and the desktop e2e)

- `installDevices(target, { inputs, outputs, granted=false, persist=true, setSinkId=true })` (`web/dev/checks/devices.mjs`), async, before `goto`; `target` a Playwright page or context. Defaults `STANDIN_DEVICES`: mics "Desk Mic" (`mic-desk`, 300 Hz), "Stand-in Headset" (`mic-headset`, 700 Hz); outputs "Desk Speakers" (`out-desk`), "Stand-in Headphones" (`out-headphones`).
- `persist: true` keeps devices and grant in the tab's `sessionStorage` (survives a reload): device names are then in `sessionStorage` — D12's canary search must use `persist: false` or allow for it.
- `window.__aiwbDevices`: `list()`, `plug(d)`, `unplug(id)` (ends live tracks, fires `devicechange` a task later), `grant()` (fires no event), `granted()`, `opened()` → `[{requested, deviceId, label, hz, live}]`, `sinks()` → `[{index, state, sinkId, default, gone, calls}]`, `calls()` → `{enumerateDevices, getUserMedia, setSinkId}`.
- A successful `getUserMedia` grants, with no `devicechange` (as Chromium): the app must relist after its own grant rather than rely on `watch`.
- Stand-in voice service log: per STT session `toneHz` (whole session) and `toneHzLast` (latest chunk), null until a tone is heard.

## D3 (web and desktop port)

- The engine must subscribe `onRoute` **before** `player.useOutput`: the web port takes its baseline of outputs inside `useOutput` only when a route listener exists; otherwise the first loss while following the default goes unnoticed.
- `useOutput(null)` with a route listener calls `enumerateDevices` once (Read aloud / speech mode with nothing chosen list devices once at their start; Dictation does not). VC.8's "no `enumerateDevices` before Settings opened" must count only calls outside a session, or be stated so.
- `output-lost` with `held: true` keeps the context suspended until `resume()` or `stop()`; `stop()` releases it.
- The `devicechange` handler suspends the context for a few ms while it decides.
- After a successful `startMic`, `devices.watch` listeners fire (the lists refresh after Test microphone grants the permission).
- Before the permission (web build only): `startMic` with a saved mic opens the default first, then lists again; `useOutput` with a saved speaker answers `missed: true` (Chromium rejects every sink id before the permission).
- With no `onRoute` subscriber, a track that ends and cannot be reopened gives the old `onInterrupted`.
- Capture still always asks for echo cancellation / noise suppression / AGC (the web ignores `echoCancel: false`).

## D2 (engine)

- Public face as in packages.md D2. Extra internal exports: `noticeDeps`, `showNotice`, `endNotice` (state.ts), `Listener.opened`, `Utterance.onOutput`, `player.hold/resume/noteHeld/held`.
- Test speaker lives in `speaker.ts` (`testSpeaker`), not `devices.ts` (import cycle).
- The engine makes **no** `useOutput` call for a person who never chose a speaker; after one was asked for in this run it calls `useOutput(null)` to go back. Ports must make `useOutput(null)` cheap and tolerate `resume()` after `stop()`.
- Route order: `enterRoute` (subscribes `onRoute`) comes before `applyOutput`. 
- D8: preview / Test speaker show no notice for a missing saved speaker (Settings has no chat/board for `useVoiceNotice`); the picker's "(not connected)" is the only sign. `useMicTest().busy` is true while any voice session exists. Closing Settings via `settingsOpenStore` stops the mic test, but call `stopMicTest()` on unmount too. `useDeviceChoices()` lists on mount and on `watch`; the last list stays in the store.
- D9: the speech bar and pill pause sentence comes from `session.paused.device` with `noticeText("paused", { device })`; no notice for a session pause (no duplicate). Read aloud's pause is a sticky notice on the chat's `voice-notice` plus `reading.paused`. A pause cancels a countdown into `waiting`; `voice.send()` does nothing while paused. `voice.resume()` resumes every paused route with one `player.resume()`.

## Orchestrator: D3F (fix)

- D2 never calls `useOutput` for a person on System default, and D3's web port learnt its baseline of outputs only in `useOutput`: headphones removed while following the default went unnoticed. D3F makes the web port learn its baseline when the first `onRoute` listener subscribes.
- D3F merged: the first `onRoute` listener makes the port list outputs once (every session that subscribes, Dictation included, lists once at its start). A `default` entry that moves to another device while the old one is still listed also counts as a loss. A loss seen before any context exists sets the hold, so a later context starts suspended.

## D8 (Settings card)

- testIDs: `vs-devices-section`, `vs-mic`, `vs-speaker`, `vs-mic-system` (added: mic follows the system), `vs-speaker-system`, `vs-devices-neither`, `vs-devices-note`, `vs-mic-test` (`data-on`, `data-busy`; disabled with "Voice is listening." while a session listens), `vs-mic-level` (only while the test runs; `data-level`, `data-peak`), `vs-speaker-test` (`data-playing`).
- VC.1 now installs the stand-in devices and covers the card (permission note, meter, switching mic, Test speaker sink, plug/unplug, "(not connected)", test stops on close).
- `web/dev/checks/README.md` still describes VC.1 without the card: D10/D14 update it.

## D6 (Android native)

- Ids `<family>:<address>`; a Bluetooth headset's call and media entries share one id; built-ins are one per kind (`builtin:mic`, `builtin:speaker`).
- Devices with no own name are named by kind in Kotlin ("Wired headset", "USB audio": English outside `words.ts`; choice to confirm).
- In communication mode a chosen headset mic wins over a chosen non-headset speaker; `setOutput` still answers the chosen speaker.
- `aiwbaudio.test.ts` still requires the text `"route"` in the Android sources (now only a comment): can be dropped.
- The shared parts of `app/modules/aiwb-audio/README.md` (contract table, `onInterrupted` paragraph) are not updated: D14.
- `node app/e2e/run.mjs voice-mic --platform android` fails in the flow (Android's permission dialog after Dictate, then `more-chip`): the flow never ran on Android; it needs an `app/e2e` fix.

## D9 (notices and the pause on screens)

- `voice-notice` (composer, `ModelNotice` look), `speech-paused`, `speech-continue`, `pill-orb[data-state="paused"]` (tap = `voice.resume`), `pill-words[data-paused]`, `pill-continue`, `caption-notice` (board), `voice-reading-continue`.
- `orbState(phase)` kept; `orbStateFor(phase, paused)` added; `pillSize(phase, collapsed, paused = false)`. A paused pill is the listening bar in every phase but idle, unless collapsed.
- Read aloud's pause sentence shows on the composer's `voice-notice`.
- `L16` fails at tablet on `voice-devices` before D9 too (`tchip[data-kind="effort"]` never appears): not ours.
- Hold Space while paused followed the phase (a tap in `speaking` interrupted): fixed by D9F (orchestrator): a Space tap while paused resumes.

## D11 (desktop e2e), D12 (voice e2e), D9F

- Desktop e2e: Chromium's fake devices (launch switches) and `devices.mjs` through `app.context().addInitScript`; macOS media access answered "granted" in main for the run. System default shows as "System default (<device>)". The pickers show System default alone for a moment until the list is read. The Read aloud step now compares sentences sorted (the player asks two ahead).
- Voice e2e: 60 checks; device canaries found only in `localStorage` `aiwb.voice.settings`. Its microphone probe can choose Chromium's fake device on this machine and hang: `AIWB_MIC=synthetic` avoids it.
- D9F: a Space tap while paused resumes; a hold does nothing.

## D13 (iOS device flow)

- `voice-devices` and `voice-mic` pass on the iOS simulator (iPhone 17, iOS 26.3); the microphone worked in that session (D5's CoreAudio abort did not recur).
- The dev line's device fields are a second text `voice-dev-devices` (`mic=none|builtIn|external`, `tested=<n>`), so `voice-mic`'s patterns stay intact.
- `_voice-dictate.yaml`: the "more" branch runs only when the toolbar press was not made (`output.dictatePressed`).

## D10 (VC.8)

- `web/dev/checks/VC.8-devices.mjs`: scenarios `nothing`, `choose`, `missing`, `mic` ×2, `speaker`, `pause`, `pill` ×2; `ONLY=choose,pause` runs named scenarios. Passes at desktop, tablet, phone, in the whole `VC` run (9 of 9) and in Electron.
- macOS has no `timeout` command: wait with a `for … sleep` loop.
