# P17: the device flow for the microphone and the audio session (goal 6.6)

Branch `vc-p17-device`. The flow is `app/e2e/maestro/voice-mic.yaml` (iOS simulator, development build, phone layout); the runner's `needs=voice`
(`app/e2e/lib/voice.mjs`) starts `web/dev/voicestandin.mjs` alone on a free port, gives Metro `EXPO_PUBLIC_AIWB_VOICE_BASE`, gives the flow
`VOICE_CONTROL`, resets the microphone's answer before each attempt, and after the flow fails the run unless every transcription socket got only
16 kHz chunks of exactly 100 ms at about real time (`checkLog`; the log is `voice-log.json` in the run's folder). The dev line `voice-dev`
(`src/screens/voice/DevLine.tsx`, registered only when `__DEV__` and the variable are set) tells `phase`, `reading`, and how many marks and drained
events came while a message was read aloud.

## What was run, on an iPhone 17 simulator (iOS 26.3), and what it showed

| Part of the flow | Result |
|---|---|
| Scratch server added, chat with the stand-in agent's answer, Settings > Voice: key `sk_test_…`, Test key | passed: "Works: 6 voices found." from the stand-in over the native network (`ws`/`http` to 127.0.0.1 is allowed by the development build); Save |
| Dictate: the system's microphone alert with the app's own words ("AI Whiteboard listens only while you dictate or talk to a chat…") | passed, every run |
| Don't Allow, then the "The app can't hear you…" popover with "Open system settings" | passed |
| Read aloud on the answer | passed: first-speak voice lookup, one TTS request (`pcm_24000`, 6 chunks, 88,800 bytes, finished, not cancelled, no protocol problem), `voice-dev` `reading=none` with drained and marks above zero |
| `simctl privacy revoke microphone`, relaunch, Dictate, popover; Remove key | passed (the revoke ends the app, as Settings does; the app reopens on its last chat) |
| **Allow, then 16 kHz / 100 ms chunks reaching the stand-in and the scripted words in the box** | **not run to the end: the app is aborted by CoreAudio when the engine starts (below)** |

## The finding: the microphone cannot start in this session

After Allow the app reaches `phase=starting`, then CoreAudio logs `Initialize: RPC timeout. Apparently deadlocked. Aborting now.` (9 s later) and the process ends.
Not the module's voice processing: the same abort with `setVoiceProcessingEnabled` skipped on the simulator (tried, reverted; the module is unchanged).
A plain Swift program on this Mac, started from the same session, hangs at the first `AVAudioEngine.inputNode` call, and `AVCaptureDevice.authorizationStatus(for: .audio)` is
`notDetermined`: the Mac's own microphone prompt for the process that runs the simulator was never answered (nobody is at the screen), and the simulator proxies the Mac's input.
The Mac also has the virtual drivers NDI Audio and Zoom's, as the P13a handoff noted for Chromium's fake microphone. So the chunk rate, the scripted words and the stand-in's
`stt` entry are **not confirmed on a simulator here**; they need one run from a terminal that has the Mac's microphone permission (README, "The Mac must let the process…").

## Other things found

- Design note: arch §14.4 says `EXPO_PUBLIC_AIWB_VOICE_BASE=http://127.0.0.1:<port>/voice`, but `origin.ts` accepts an origin with no path, so the stand-in runs with an empty prefix.
- After a revoke the app is ended by the system (exit domain `tcc`) and reopens on the chat it had open, not on the sidebar.
- The development client's floating button covers the first message's "⋯" on the phone (the runner hides it for the app's plist; here it still showed).
- Android: no emulator was attached and the lock was not taken, so the flow was not run there (`./gradlew :aiwb-audio:compileDebugKotlin` is P4's proof). The flow's header is platform-neutral except
  the "OK|Allow" button text and the point tap, which are the iPhone's.
