# D6: Android native devices: findings

Written by package D6 (`vd-d6-android`) on 2026-10-21. Marks as in `platforms.md`: **[verified]** run on this machine, **[docs]** read
in the SDK sources installed here (`~/Library/Android/sdk/sources/android-36.1`), **[assumed]** from what is known of the platform and
not checked here.

## 1. Does `AudioRecord.setPreferredDevice` hold in `MODE_IN_COMMUNICATION`?

**Answer: the app side has no mode check, the decision is the native audio policy's, and the SDK sources do not contain it. The module
is built so that it is right either way, and so that a preference that is not honoured is announced, never silent.**

What the SDK sources show [docs]:

- `AudioRecord.setPreferredDevice(info)` (`android/media/AudioRecord.java`, the "Explicit Routing" part) checks only `info.isSource()`,
  then passes the port id to `native_setInputDevice(id)`. There is no test of the audio mode, the source or the communication device.
  Its `true` means that the native layer took the id, not that the record is routed there.
- `AudioRouting.getPreferredDevice()`: "Note that this is not guaranteed to correspond to the actual device being used for
  playback/recording." `getRoutedDevice()` is the device in use (valid while recording).
- `AudioManager.setCommunicationDevice(info)`: "only devices in a sink role (AKA output devices) can be specified. **The matching source
  device is selected automatically by the platform.**" So in communication use cases the platform picks the microphone from the
  communication device by itself.
- The platform's own way of routing a capture source, `setPreferredDeviceForCapturePreset`, is `@SystemApi` with
  `MODIFY_AUDIO_ROUTING`: not for an app.
- The choice between an explicit device and the policy's own is made in `frameworks/av` (`AudioPolicyManager::getInputForAttr`), C++ that
  is not part of the SDK sources (`sources/android-36.1/cpp` holds only the audio policy configuration's schema).

What AOSP does there [assumed, not verified here]: `getInputForAttr` takes the explicitly selected device when it is an available input,
before the engine's choice for the source; the engine's choice for `VOICE_COMMUNICATION` in communication mode follows the communication
device. If that holds on a given phone, the preference wins in communication mode for a wired, USB or built-in microphone. A Bluetooth
(SCO or LE) microphone gives sound only while the headset's call link is up, which an explicit input preference does not bring up.

What the emulator can say [verified, `dumpsys media.audio_policy` on `Medium_Phone_API_36.1`]: its available inputs are "Built-In Mic"
(address `bottom`), "Telephony Rx", "Remote Submix In" and "FM Tuner"; its outputs "Speaker" and "Telephony Tx". So one real microphone
(the module lists only `builtin:mic`) and no headset: it cannot show a preference winning over another device. The `voice-mic` flow did
not reach the microphone (§4).

So the module does not rely on the answer:

1. **A headset is used for both** in communication mode (Android 12+, `commTarget` in `VoiceAudio.kt`): the communication device is the
   chosen output when it is a headset or no headset microphone is chosen, else the chosen microphone's own headset, else today's rule
   (the speaker unless a headset is there). So for a headset, the policy's own choice and the explicit one name the same device.
2. **A Bluetooth microphone gets its call link**, in speech mode and in dictation alike: the communication device on API 31+,
   `startBluetoothSco` before. Cleared when listening ends.
3. **`startMic` answers the record's routed device** (`getRoutedDevice()` after `startRecording`), not the one asked for. If a phone does
   not honour the preference, the adapter sees another id and reports `missed`, and the person gets the start notice ("… isn't connected.
   Using the system microphone."). The words are not exact for that case, but the fallback is announced (goal 4.5).

The cases where the two could still disagree, for a real phone (`What only a phone can confirm` below): the built-in microphone chosen
while a wired headset is connected, in speech mode (explicit: built-in; communication device: the headset, by the platform); and a
wired-headset microphone chosen with a Bluetooth headset chosen as the speaker (explicit: wired; communication device: Bluetooth).

## 2. What was built (VD-18's Android part, VD-9, VD-10, VD-11)

- `Devices.kt` (new): `deviceAbility()` (API 31+ `{pick, pick, linked: true}`, before `{pick, system, false}`); the listed inputs
  (`getDevices(GET_DEVICES_INPUTS)`) and outputs (API 31+: `getAvailableCommunicationDevices()` without the earpiece), one entry per id;
  ids `<family>:<address>` or `<family>:<name>`; names; privacy by type; the default input and output.
- `AiwbAudioModule.kt`: the stubs replaced: `startMic` passes `inputId` and answers the routed device, `listDevices`, `deviceAbility`
  (a constant, makes nothing), `setBuiltInNames` (kept for the process, makes nothing), `setOutput`, `playerHold`, `playerResume`.
- `MicCapture.kt`: the preferred device set before `startRecording`; a routing listener on the engine's thread; `routedDevice()`;
  `preferDefault()`; what it was started with, so a new one can be made the same way.
- `PcmPlayer.kt`: `prefer(device)` for the track now and the next; a routing listener; `hold()` / `resume()` / `clearHold()`. While held
  the writer does not write into the paused track: it waits on the lock, so nothing is dropped and nothing is stuck in a native write;
  `stop()` moves the generation on and calls `AudioTrack.stop()` too (a `pause()` of an already paused track does not wake a writer). No
  `drained` and no padding while held.
- `VoiceAudio.kt`: the route (`applyRoute`, `commTarget`, `clearRoute`), `setOutput`, `listDevices`, an `AudioDeviceCallback` registered
  when the module is first used (`onDevices`), and the losses: from `onAudioDevicesRemoved`, the record's and the track's routing listeners
  and `ACTION_AUDIO_BECOMING_NOISY`, whichever comes first, once per device. Output: held when the lost one was private or unknown and the
  next is not private (`BECOMING_NOISY` counts as private unless the sound was on the loudspeaker already); in communication mode the route
  is set again without the lost device. Input: the record is made again with no preference into the same `onMic` (`input-lost`), or goes
  on where the system moved it; `input-failed` when no record can be made. `onInterrupted("route")` is no longer sent.
- `README.md`: the Android rules (devices: listing, choosing, losses) and the file table.

## 3. Deviations from the letter of the design (reported, for the orchestrator)

1. **Built-in ids.** VD-4 says `<family>:<address>` or `<family>:<productName>`. A phone may report two or three built-in microphones
   (addresses "bottom", "back"); by the letter they would be two "Phone microphone" entries. The module makes them one per kind:
   `builtin:mic`, `builtin:speaker` (and `builtin:earpiece`, never listed). Every other family follows VD-4.
2. **Names of devices whose port has no name.** `getProductName()` answers the phone's model when the port's name is empty, which is
   the case of a wired headset on many phones. Such a device is named by its kind in Kotlin ("Wired headset", "Wired headphones",
   "Bluetooth headset", "Bluetooth speaker", "USB audio", "HDMI", "Hearing aid", "Audio device"). These are English words outside
   `app/src/voice/words.ts`, which `setBuiltInNames` carries only for the two built-ins. If they should come from `words.ts`, the contract's
   `setBuiltInNames` would need more names: a change of D1's contract, not made here.
3. **Linked rule in detail.** VD-18 says "with a chosen speaker → `setCommunicationDevice(speaker)`". The module lets a chosen headset
   microphone win over a chosen non-headset speaker (e.g. a Bluetooth microphone with the phone speaker), since otherwise the Bluetooth
   microphone has no call link and hears nothing. It is what the linked note says ("A headset is used for both…"). `setOutput` still answers
   the chosen speaker when it is connected, so no "missing" notice is shown for it.
4. **`'"route"'` in the contract test.** `app/test/aiwbaudio.test.ts` still requires the text `"route"` in the Android sources. It is now
   only in a comment of `VoiceAudio.kt` ("route" is no longer sent). D4 (the adapter and its test) may drop it from that list.
5. **The shared parts of `README.md`** (the contract table: `startMic`'s `inputId` and the six new calls; the `onInterrupted` paragraph that
   still says `"route"` for headphones) were not changed: they are neither the iOS nor the Android part. D4 or D14 should update them.

## 4. Checks run

| Command | Result |
|---|---|
| `cd app && npx expo prebuild -p android --no-install` (then `git checkout app/package.json`) | made `app/android` (ignored); the script rewrite reverted |
| `cd app/android && JAVA_HOME=<openjdk@17> ANDROID_HOME=~/Library/Android/sdk ./gradlew :aiwb-audio:compileDebugKotlin` | BUILD SUCCESSFUL, no warning in the module (rerun with `--rerun` after the last change) |
| root `npm test && npm run check` | pass (`app/test/aiwbaudio.test.ts` 18/18: the Kotlin functions and events against the contract) |
| `node app/e2e/run.mjs voice-mic --platform android --device emulator-5554 --build` (lock held, after D5's run ended) | **failed in the flow, before the module was reached**: the build, the install, the server, Settings > Voice and the key test passed; after the Dictate tap Android's permission dialog covers the app, so `_voice-dictate.yaml`'s second `runFlow` (`when notVisible voice-dictate`) also runs and fails on `more-chip` (screenshot `step-066`: the dialog "Allow AI Whiteboard to record audio?", the dev line `phase=starting`). On iOS the alert does not hide the composer. The flow had never run on Android (voice-chats P17 skipped it); the two conditions of `_voice-dictate.yaml` need to be made exclusive (or the dialog answered first) by whoever owns `app/e2e`. No microphone chunk was taken, so this run proves the build and the module's load, not the audio path. |

`ANDROID_HOME` must be set for the Gradle build of a fresh worktree (`local.properties` is not made by prebuild).

## 5. What only a real Android phone can confirm

With a wired headset, a Bluetooth headset (HFP + A2DP) and, if possible, a USB headset, on Android 12+ and on Android 11 or older:

- The lists: one entry per headset (SCO and A2DP as one), the built-ins as "Phone microphone" / "Phone speaker", names of Bluetooth
  devices as the system shows them (and whether the address is anonymized without `BLUETOOTH_CONNECT`: the id must stay the same over a
  reconnect).
- Choosing: the built-in microphone with a wired headset connected, in dictation and in speech mode (the case of §1); a Bluetooth
  microphone in dictation (the call link comes up; the first moment may be silent until SCO connects) and in speech mode; a speaker chosen
  for Read aloud (the A2DP entry) and for speech mode (the communication device).
- Losses: a wired headset unplugged while Read aloud plays and while speech mode speaks (held before any sound from the speaker: the
  `BECOMING_NOISY` path); a Bluetooth headset switched off in speech mode (the loss seen from the device list: whether a moment comes out
  of the speaker before the hold); the microphone of a USB headset pulled while dictating (listening goes on from the phone's microphone,
  the words kept); Continue after a pause playing on from where it stopped with nothing lost.
- That the communication device and the mode are given back after a session (another app's call audio is normal afterwards).
