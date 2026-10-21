# D13A: the voice device flows on the Android emulator

Written by package D13A (`vd-d13a-android`) on 2026-10-21. Emulator `Medium_Phone_API_36.1` (Android 16, API 36), lock `/tmp/aiwb-android-emulator.lock` taken and released.

## Result

Both flows pass on Android with no change to the app.

| Command | Result | Evidence |
|---|---|---|
| `node app/e2e/run.mjs voice-mic --platform android --device emulator-5554 --build` | first run failed at Read aloud (below); `PASSED` on the rerun | `/tmp/d13a-voice-mic.log` (failed), `/tmp/d13a-voice-mic2.log` (passed) |
| `node app/e2e/run.mjs voice-devices --platform android --device emulator-5554` | first run failed at Test microphone (below); `PASSED` on the rerun, 415 s | `/tmp/d13a-voice-devices.log` (failed), `/tmp/d13a-voice-devices2.log` (passed) |
| root `npm test && npm run check` | pass | |

## What each flow proves on Android

`voice-mic`: the build and install of the module; the system's runtime permission dialog after Dictate; **the emulator's built-in microphone runs through `aiwb-audio` (`AudioRecord`) and the stand-in hears 138 chunks of 16 kHz, 100 ms, 13.8 s of audio in 13.8 s**; the scripted words reach the box; Dictate again stops it (`phase=idle`); Read aloud plays the stand-in's speech through `PcmPlayer` to its end (`tts: 6 chunks, read to its end`, `drained`/`marks` above zero); after `pm revoke` and a relaunch Dictate asks again, "Don't allow" gives "The app can't hear you…" with "Open system settings"; Remove key. The runner's log check (16 kHz, 100 ms, real time, key header, closed, no protocol problem) passes.

`voice-devices` (API 36): the card "Microphone and speaker" lists **both pickers** (D6's `deviceAbility` on API 31+): Microphone "System default (Phone microphone)" and "Phone microphone"; Speaker "System default (Phone speaker)" and "Phone speaker"; the note "A headset is used for both…" is shown; no `vs-speaker-system`, `vs-mic-system` or "neither" line; listing asks for no permission; both picks are shown and kept after the app is closed and opened again; Test speaker plays the chime through the native player (`mic=none tested=<n≥1>`, no microphone opened); with the key saved Dictate opens the saved built-in microphone (`mic=builtIn`, no `voice-notice`), 169 chunks to the stand-in; Test microphone shows the level meter (`vs-mic-level`) and stops it; both choices and the key are put back. The device log has no `FATAL`/`AndroidRuntime` line.

## What was fixed in the flows (no app change)

1. `_voice-dictate.yaml`'s double branch (D13's fix) is enough: with it the first press is made and the `more-chip` branch is skipped under Android's dialog.
2. The permission step was iOS-only text ("Would Like to Access the Microphone", "OK|Allow", the app's own words). Android's dialog is "Allow <app> to record audio?" with "While using the app" / "Only this time" / "Don't allow", and no app words: `runFlow when: platform: Android` branches in both flows. The iOS lines are unchanged inside `when: platform: iOS`.
3. After `pm revoke` the app is asked again (the permission is not user-fixed), so on Android the refusal step taps "Don't allow" before the "can't hear you" popover.
4. Read aloud's "⋯" tap at 92%,20% (the iPhone 17's place) missed on the emulator, where the answer's "⋯" is at about 15% of the height (`fk-more` bounds `[970,353][1022,382]` of 1080×2400): Android taps 92%,15%.
5. `voice-devices` branches: the Speaker row (iOS: the follows-the-system line, as before; Android: picker, note, a speaker pick that is kept, restored at the end); on Android the card is taller, so a `scrollUntilVisible` brings Test microphone into view in part 2.

## Limits

- The emulator has one built-in microphone and one speaker (`dumpsys media.audio_policy`, D6): a pick can only be the built-in one. It shows listing, the picker, the persistence, that `startMic` with a saved built-in id opens `mic=builtIn`, and that the real `AudioRecord` and `AudioTrack` carry audio. It cannot show a preference winning over another device, a loss, the pause or a headset.
- The flow assumes API 31+ for the Speaker picker. On API 24–30 the Speaker is the "Follows the system" line (platforms.md §5); not run here (no such emulator image).
- The flow does not assert the content of `voice-dev-devices` for the speaker (there is no field).

## Left to a real Android phone

As D6 §5: wired, Bluetooth (HFP + A2DP) and USB headsets; the built-in microphone chosen with a wired headset connected, dictation and speech mode; a Bluetooth microphone's call link; Read aloud on a chosen A2DP speaker; the pause when a wired headset is unplugged or Bluetooth is switched off, and Continue; the microphone of a USB headset pulled while dictating; the communication device and mode given back after a session; Android 11 or older (the Speaker as a line); real names of devices without a name of their own; echo.
