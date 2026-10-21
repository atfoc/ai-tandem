# aiwb-audio

The microphone, the audio session and the PCM player of voice chats on iOS and Android (goal 7.1, architecture VC-8, VC-9). The
module hears 16 kHz mono s16le in chunks and plays the voice service's 24 kHz mono s16le as it arrives, on one audio path, so that the
platform's echo cancellation can take what is played out of what is heard. Everything above it (the turn, the sentences, the requests
to the voice service) is the engine's, in `app/src/voice`; the module knows nothing of ElevenLabs, of a key or of a chat.

| File | What |
|---|---|
| `src/AiwbAudio.ts` | the contract: `AiwbAudioNative` (the functions), `AiwbAudioEvents` (`onMic`, `onPlayer`, `onInterrupted`), `AiwbAudioModule` (the two with Expo's `addListener`) and `MIC_BLOCKED` |
| `expo-module.config.json` | the Expo module's registration, for both platforms |
| `src/AiwbAudioModule.ts` | the native module, `requireOptionalNativeModule("AiwbAudio")` (null in a build made before the module) |
| `src/AiwbAudioModule.web.ts` | null: the web build and the desktop window have their own audio (`app/src/voice/platform/audio.web.ts`) |
| `src/fake.ts` | the module in JS, for the tests of the adapter: the rules below, and `hear`, `play`, `interrupt` for what the device does by itself |
| `ios/AiwbAudioModule.swift`, `ios/VoiceAudio.swift`, `ios/AiwbAudio.podspec` | the module's functions; one AVAudioEngine with voice processing and a player node |
| `android/build.gradle`, `android/src/main/java/expo/modules/aiwbaudio/AiwbAudioModule.kt` | the module's functions and RECORD_AUDIO through Expo's permissions |
| `android/.../VoiceAudio.kt`, `MicCapture.kt`, `PcmPlayer.kt` | the audio focus, the communication mode and the speaker; AudioRecord on a thread; AudioTrack fed by a thread |
| `../../src/voice/platform/audio.native.ts` | the adapter `audioOver(module): AudioPort` (the audio port of voice, `app/src/voice/ports.ts`) and `audioNative()`, the app's port |
| `../../test/aiwbaudio.test.ts` | the adapter over the fake; the functions, events, payload keys and error code of the contract against the Swift and Kotlin sources |
| `../../test/appconfig.voice.test.ts` | the Info.plist text and the Android permissions, as written and as Expo makes them |

## The contract

| Call | What it does |
|---|---|
| `micPermission()` | `"granted"`, `"denied"` or `"undetermined"`. Asks nobody. On Android a first refusal is still `"undetermined"` (Android lets the app ask once more), a second one is `"denied"`. |
| `requestMic()` | Asks the person (the system's alert) and answers the state after. |
| `startMic(chunkMs, echoCancel)` | Starts the microphone: `onMic` with `{ pcm, level }` for every `chunkMs` of sound, `pcm` the base64 of 16 kHz mono s16le (`16 × chunkMs` samples), `level` its RMS from 0 to 1. Resolves with `{ echoCancel }`: whether the platform's echo cancellation runs (asked for, and the device has it). Rejects with the code `ERR_AIWB_MIC_BLOCKED` when the system gives the app no microphone, with another code when the device cannot start it. A second start replaces the first. |
| `setMicMuted(muted)` | While muted no chunk is emitted, and what is heard is dropped (it does not come out when the mute ends). |
| `stopMic()` | Stops the microphone; no chunk after it resolves. |
| `playerWrite(pcm)` | Queues 24 kHz mono s16le after what is queued and plays it as soon as it can, with no gap of its own between writes. An odd trailing byte is kept for the next write. |
| `playerMark(id)` | A point in the queue: `onPlayer` `{ kind: "mark", id }` when playback reaches it. A mark with nothing queued is reached when the next write starts to play. |
| `playerStop()` | Stops at once and empties the queue (bytes, marks, a kept odd byte). Emits no `drained`: the caller knows. |
| `playClip(bytes)` / `stopClip()` | A preview clip (MP3 or WAV) from memory; resolves when it ends, is stopped, or is replaced by another clip. |
| `openSettings()` | The app's page in the system settings, where the microphone's switch is. |

`onPlayer` also carries `{ kind: "level", level }` (the RMS of what plays now, 0 when nothing does) about every 20 to 100 ms while
something plays, and `{ kind: "drained" }` each time the queue has played to its end. `drained` can come between two writes when the bytes
come slower than they play (the engine writes the next sentence after it), and it also comes when the module itself had to drop the
queue: the microphone started while Read aloud played (below). `onInterrupted` `{ reason }` says that the module stopped the microphone,
the player and the clip by itself: `"call"` (a call, Siri, an alarm, the app going to the background), `"route"` (headphones taken off,
the output changed under the engine) or `"other"` (another app took the audio for good, the audio server restarted, the microphone died).
After it nothing runs until the next call.

Nothing starts before a call: no session, no focus, no engine or track, no permission alert. The adapter loads the module itself only on
the first call that needs it (`audio.native.ts`).

## The session rules

**iOS** (`VoiceAudio.swift`, one serial queue for every change, one `AVAudioEngine` at a time):

- **Listening** (from `startMic` until the microphone has stopped and the last of what was queued has played): the session's category is
  `.playAndRecord`, mode `.voiceChat`, options `.defaultToSpeaker` and `.allowBluetoothHFP`. With `echoCancel` the input node gets
  `setVoiceProcessingEnabled(true)` before anything is connected (Apple's echo cancellation of what the same engine plays); a tap on the
  input node is converted by an `AVAudioConverter` to 16 kHz mono Int16 and cut into chunks. The player node is attached to the same engine
  and connected to its main mixer at 24 kHz mono Float32 (the mixer resamples).
- **Playback** (Read aloud, a reply with the microphone off): `.playback`, mode `.spokenAudio`, an engine with the player node only: the
  input node is not touched, so no microphone is used or shown.
- Voice processing can be switched only with the engine stopped, so a `startMic` while a playback engine plays builds the engine again:
  what played is cut and `drained` is emitted. A `startMic` on a listening engine of the same kind (the reply still plays, the next turn
  starts) keeps it and only puts the tap back.
- Buffers are scheduled back to back on the player node (`scheduleBuffer`, completion `.dataPlayedBack`); a mark is reached when the buffer
  before it has played. `playerStop` stops the node; the completions of the dropped buffers are ignored (a generation number).
- The engine is taken down and the session deactivated with `.notifyOthersOnDeactivation` (the music of another app comes back) at once
  when listening ends, 1.5 s after a playback queue drained (the next sentence of Read aloud finds the engine running).
- An interruption (`AVAudioSession.interruptionNotification`, began), a route change whose reason is `.oldDeviceUnavailable` and media
  services reset end everything: `onInterrupted`.
- The engine stopping by itself on a format change (`AVAudioEngineConfigurationChange`) is no end: voice processing does it just after
  the engine starts (the input and the output take its formats), and so does a headset plugged in. The engine is started again on the new
  formats, with the tap put back for the input's new format (muted if it was); what the player had queued is dropped (`drained`). Only an
  engine that does not start again, or that stops a fourth time within two seconds, ends everything (`onInterrupted` `"route"`).
- Permission: `AVAudioApplication` on iOS 17 and later, `AVAudioSession`'s record permission before. The Info.plist text is
  `NSMicrophoneUsageDescription` of `app.config.ts`. No background mode: the app does not listen in the background (goal §5).
- Clips: `AVAudioPlayer(data:)`, through the session of the engine when one runs, else a `.playback` session.

**Android** (`VoiceAudio.kt`, a looper thread "aiwb-audio" for every change; `MicCapture` reads on its own thread, `PcmPlayer` writes on
its own):

- **Listening**: audio focus `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` (refused, e.g. during a call: `startMic` fails); `AudioRecord` from
  `VOICE_COMMUNICATION` at 16 kHz mono PCM 16; with `echoCancel`, `AcousticEchoCanceler` and `NoiseSuppressor` on its session when
  `isAvailable()`, and the mode `MODE_IN_COMMUNICATION` with the built-in speaker as the communication device when no headset is there
  (`setCommunicationDevice` on API 31+, `isSpeakerphoneOn` before), since that mode would use the earpiece. `startMic`'s `echoCancel` is
  whether the canceller was made and enabled. The player's track has the usage `USAGE_VOICE_COMMUNICATION`.
- **Playback**: focus `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` (other apps duck), the track's usage `USAGE_ASSISTANT`.
- A track's usage is fixed when it is made, so a `startMic` while Read aloud plays cuts it (`drained`) and the next track is made for
  listening.
- The player: one `AudioTrack` in `MODE_STREAM` at 24 kHz mono PCM 16, written by a thread from a queue (blocking writes: no gap of its own).
  A mark is the number of frames written when the writer reached it; the playback head is read every 40 ms while something plays (marks,
  the level, `drained` when the head reaches the end of what was written and nothing waits). A track may not start until its buffer holds
  enough: when the head stands still before the end with nothing more to come, one buffer of silence pushes the rest out. `playerStop`
  pauses, flushes and releases the track (the next write makes another).
- When nothing runs the track is released, the communication device cleared, the mode put back to `MODE_NORMAL` and the focus abandoned: at
  once when listening ends, 1.5 s after a playback queue drained.
- `AUDIOFOCUS_LOSS_TRANSIENT` is `"call"`, `AUDIOFOCUS_LOSS` is `"other"`, `ACTION_AUDIO_BECOMING_NOISY` (headphones taken off) is
  `"route"`, a read error of the microphone (the audio server died) is `"other"`: each ends everything with `onInterrupted`. A duck for
  another app's short sound is not an end.
- Permissions: `RECORD_AUDIO` (asked at run time through Expo's permissions) and `MODIFY_AUDIO_SETTINGS` (for the mode and the speaker),
  both in `app.config.ts` `android.permissions`. The camera and the image picker plugins carry voice's microphone text, not `false`:
  `false` makes the image picker block `RECORD_AUDIO` in the manifest (`tools:node="remove"`) and both delete the Info.plist text. A
  generated `android/` of an older config keeps that block: make it again with `npx expo prebuild -p android --clean`.
- Clips: `MediaPlayer` over a `MediaDataSource` of the bytes.

## What only a device shows

A simulator or an emulator proves that the module builds, that the session starts and that chunks and playback flow. The echo
cancellation (`setVoiceProcessingEnabled`, `AcousticEchoCanceler`) has no acoustic echo to cancel there, so voice barge-in (VC-9) is
confirmed by the person on an iPhone and an Android phone with the speaker. The speaker routing in communication mode, a Bluetooth headset,
a call that interrupts, and the start threshold of the Android track on a short reply are device matters too.
