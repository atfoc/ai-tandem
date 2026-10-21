# D5: iOS native devices and route handling

Package D5 of `packages.md`, branch `vd-d5-ios`, written by Opus 5.5 on 2026-10-21. It implements VD-18's iOS part, VD-9, VD-10 and
VD-11 in `app/modules/aiwb-audio/ios/VoiceAudio.swift` and `AiwbAudioModule.swift`, and the iOS section of the module's `README.md`.

## 1. `availableInputs` with the session inactive (the question of platforms.md §3)

A probe (a command-line Swift program built for the simulator SDK and run inside the simulator with `xcrun simctl spawn`, so it has
the same `AVAudioSession` as an app there) on an **iPhone 17 simulator, iOS 26.3 (23D8133)**, with the record permission
**undetermined**:

| Session | `availableInputs` | `currentRoute.inputs` | `currentRoute.outputs` |
|---|---|---|---|
| inactive, as the system leaves it (`soloAmbient`) | 1: `MicrophoneBuiltIn` (uid `MicrophoneBuiltIn`) | none | `Speaker` |
| inactive, `.playAndRecord` / `.voiceChat` set | 1: the same | `MicrophoneBuiltIn` | `Speaker` |
| inactive, `.playback` / `.spokenAudio` set | 1: the same | none | `Speaker` |
| active, `.playAndRecord` + `.mixWithOthers` (activation took 26 ms) | 1: the same | `MicrophoneBuiltIn` | `Speaker` |

- **On the simulator the list is filled with the session inactive, in every category, before any permission.** Apple's documentation
  says a `.playback` category lists nothing; the simulator does not follow it. So the simulator cannot tell which of the fallbacks a
  real iPhone needs. A real device can.
- `setPreferredInput` with the listed port succeeded on the active session; `preferredInput` read back its uid.
- The simulator's input port type is `MicrophoneBuiltIn` (`.builtInMic`) and its uid is the same string. Only one input and one output
  exist; nothing can be plugged in.

**What the module does** (all three steps are kept, because a real device may need the later ones):

1. It reads `availableInputs` as the session is. On the simulator this is what answers.
2. If that is empty and the session is inactive, it sets `.playAndRecord` / `.voiceChat` on the inactive session, reads, and puts the
   category back.
3. If that is still empty **and the microphone is already allowed**, it activates briefly with `.mixWithOthers`, reads, and deactivates.
   It does not activate before the permission. Apple: "the first time your app's audio session attempts to use an audio input route
   while using a category that enables recording, the system automatically prompts the user", and goal 4.8 forbids a prompt for a
   listing.

While a playback session is active (Read aloud), its category lists no input on a device, so the last list that was not empty is
answered. Each listing writes a debug trace line, `devices <as is|category|activation|kept>: <port types>` (no names). On a real
iPhone it
shows which step answered.

## 2. What was built

- `listDevices`: inputs only (output ability "system"), `defaultInput`, `defaultOutput` (section 1 and README).
- `deviceAbility`: `{ input: "pick", output: "system", linked: false }`.
- `startMic(chunkMs, echoCancel, inputId)`: `setPreferredInput` after activation and before the engine is made. On a kept listening
  engine (the next turn) the preference is applied too, and a resulting format change goes through `restart`. It answers `device`, the
  route's input. The preference goes back to `nil` when the session is given back.
- `setOutput`: answers the route's output and changes nothing. `setBuiltInNames`: ignored.
- `playerHold` / `playerResume`: pause and play the node (and a clip). Writes are still scheduled while held. The marks and the level
  of a start wait for the resume. `playerStop` ends a hold. A hold outlasts the engine being taken down, as in the fake.
- **Route changes**:
  - `onDevices` fires on `newDeviceAvailable` / `oldDeviceUnavailable`.
  - `onRoute` fires only while something is in use (the microphone, queued sound, a clip):
    - `output-lost`, with an immediate `pause()` on the notification's own thread under a lock, when a private (or unknown) output gives
      way to one not private. Otherwise `held: false`.
    - `input-lost` when the input that was listened to is no longer available and the route has another.
    - `input-failed` when there is none.
  - A restart and the notification that see the same change report it once (both compare with the last route seen).
  - A hold made on the notification thread while nothing was in use (an engine idling before it is taken down) is let go at once. This
    keeps the next Read aloud from staying silent.
- **Buffers kept across a restart**: every scheduled buffer stays in `unplayed` until its `.dataPlayedBack` completion. Completions are
  taken in under a lock on the audio thread, with a generation number. After a format change the node's buffers are dropped (their
  completions ignored) and the unplayed ones are scheduled again in order, with their marks. `drained` is no longer emitted for a queue
  that did not play.
- `onInterrupted("route")` is no longer sent for a lost device. It remains only for an engine of the player alone that will not start
  again (with the microphone on, that is `input-failed`). Calls and media resets are unchanged.
- No device name is written to the log. Traces name port types.

## 3. Commands and results

| Command | Result |
|---|---|
| `xcrun swiftc -typecheck` of `VoiceAudio.swift` for `arm64-apple-ios15.1-simulator` | clean (the app's minimum iOS) |
| `npm test` (root) | pass, 0 failures (app 907 of 908 pass, 1 skipped; every other workspace all pass). Includes `aiwbaudio.test.ts`: the Swift defines the 17 functions and 5 events, and the payload keys. |
| `npm run check` (root) | pass |
| `node app/e2e/run.mjs voice-mic --platform ios --device <vd-d5 udid> --build` | the first build failed on my own Swift error (fixed). The second build passed; the flow **failed**, see section 4. |

The simulator `vd-d5` (iPhone 17, iOS 26.3) was made for this package and deleted after. Its build folders (`app/ios`, its
DerivedData) were removed. Maestro's tools are in the worktree's git-ignored `app/e2e/.tools`.

## 4. The device flow

What ran, in order (evidence in `/tmp/vd-d5-run/`, not committed):

1. **`voice-mic --build`, attempt 1.** The new module built and the app started. The scratch server was added, Settings > Voice took the
   key (Test key: "Works: 6 voices found.") and the chat opened. Dictate was tapped, and then **the flow itself went wrong**: since
   `e59ad9c` ("the composer keeps the voice pair longest") `voice-dictate` is in the phone's toolbar. `_voice-dictate.yaml` taps it, and
   its second branch ("`voice-dictate` not visible") then sees the system's microphone alert covering the composer. It looks for
   `more-chip`, which is not there. Attempt 2 failed at `side-tree`, because that alert was still up. **This is a problem in the flow
   file, not in the module.** It needs a fix in `app/e2e/maestro/_voice-dictate.yaml`, which is not a D5 file. I tested the fix below
   locally and did not commit it: the "more" branch runs only when the alert and the "can't hear you" popover are not visible.
2. **The pending alert stays.** The simulator's system UI kept that unanswered microphone alert over the app across app restarts and a
   cleared data folder. The log shows a single `kTCCServiceMicrophone` request, at the run 1 tap, and none at later launches, so the app
   does not ask at launch. Only a shutdown and boot of the simulator cleared it. Worth knowing for D13 and D15.
3. **`voice-mic`, with the local fix of `_voice-dictate.yaml`.** The prompt with the app's words passed, then Allow. Then the app was
   aborted by CoreAudio: `Initialize: RPC timeout. Apparently deadlocked. Aborting now.`, and the stand-in saw no transcription socket.
   This is the finding of `plans/voice-chats/p17-device-flow.md`. **A plain command-line program run in the same simulator (no module
   code: activate `.playAndRecord`, read `AVAudioEngine().inputNode`) aborts the same way** (signal 6). So this session cannot open the
   Mac's microphone through the simulator, and nothing of the module's microphone path could run here: chunks, the preferred input, the
   answered `device`.
4. **A copy of the flow with "Don't Allow" in place of Allow** (temporary, deleted): Maestro passed every step after it. That covers:
   - the refusal popover;
   - **Read aloud on the answer, played to its end through the new player**: `voice-dev` `reading=none` with `drained` and `marks`
     above 0; the stand-in logged `tts: 6 chunks, 88800 bytes, read to its end`, the same as P17;
   - the revoke and relaunch, Dictate showing "The app can't hear you…" with "Open system settings", and Remove key.

   The runner marked the run FAILED for one reason only: "the stand-in saw no transcription socket" (point 3). The module's trace showed
   `built playback`, then `taken down` 3.5 s later. So after the queue drained, the engine and the session were given back with the
   new completion handling. The list of devices (section 1) was established with the probe, since no JavaScript calls `listDevices`
   yet (D4, D8).

**So on the simulator, with the new module:** it builds, the permission prompt and refusal work, and the native player plays a stream
to its end with marks and `drained`. Its session is given back after the reading. The input list of section 1 holds. The microphone
path could not run in this session; it needs a run from a terminal the person has allowed to use the Mac's microphone, as P17 said.

## 5. What only a real iPhone or iPad can confirm

- Which step of section 1 answers on a device, especially that the inactive session lists a wired or Bluetooth headset (and whether
  the activation fallback ever shows the orange microphone dot).
- Whether `uid`s stay the same across reconnects and reboots (VD-4 falls back to the name).
- A headset chosen in Settings and used by Dictate: `setPreferredInput` with a Bluetooth HFP port (`.allowBluetoothHFP` is set) and a
  wired headset mic.
- Headphones pulled while a reply is spoken: no sound from the speaker (the pause on the notification thread comes before the system
  plays out loud), `output-lost` with `held: true`, and Continue plays on from where it stopped.
- A Bluetooth headset switched off while listening: `input-lost` to the built-in microphone, and chunks continue into the same socket.
- The engine's restart after a format change (Bluetooth A2DP to HFP, a USB interface at another rate): the queue played on with no
  sentence twice.
- Whether iOS posts `oldDeviceUnavailable` for a headset whose input alone is lost (a USB microphone without output).

## 6. Deviations from the contract

None in the signatures: `AiwbAudio.ts` is unchanged, and the Swift defines its 17 functions and 5 events.
