# aiwb-audio

The microphone, the audio session and the PCM player of voice chats on iOS and Android (goal 7.1, architecture VC-8, VC-9). The
module hears 16 kHz mono s16le in chunks and plays the voice service's 24 kHz mono s16le as it arrives, on one audio path, so that the
platform's echo cancellation can take what is played out of what is heard. Everything above it (the turn, the sentences, the requests
to the voice service) is the engine's, in `app/src/voice`; the module knows nothing of ElevenLabs, of a key or of a chat.

| File | What |
|---|---|
| `src/AiwbAudio.ts` | the contract: `AiwbAudioNative` (the functions), `AiwbAudioEvents` (`onMic`, `onPlayer`, `onInterrupted`, `onDevices`, `onRoute`), `NativeDevice`, `AiwbAudioModule` (the two with Expo's `addListener`) and `MIC_BLOCKED` |
| `expo-module.config.json` | the Expo module's registration, for both platforms |
| `src/AiwbAudioModule.ts` | the native module, `requireOptionalNativeModule("AiwbAudio")` (null in a build made before the module) |
| `src/AiwbAudioModule.web.ts` | null: the web build and the desktop window have their own audio (`app/src/voice/platform/audio.web.ts`) |
| `src/fake.ts` | the module in JS, for the tests of the adapter: the rules below, and `hear`, `play`, `interrupt` for what the device does by itself, and `plug`, `unplug`, `route`, `failReopen` for the devices a person plugs in and pulls out |
| `ios/AiwbAudioModule.swift`, `ios/VoiceAudio.swift`, `ios/AiwbAudio.podspec` | the module's functions; one AVAudioEngine with voice processing and a player node |
| `android/build.gradle`, `android/src/main/java/expo/modules/aiwbaudio/AiwbAudioModule.kt` | the module's functions and RECORD_AUDIO through Expo's permissions |
| `android/.../VoiceAudio.kt`, `MicCapture.kt`, `PcmPlayer.kt` | the audio focus, the communication mode and its device, the losses of a device in use; AudioRecord on a thread; AudioTrack fed by a thread, with hold and resume |
| `android/.../Devices.kt` | the devices (voice-devices VD-4, VD-5, VD-11): what is listed, the ids the module makes, the names, private or public, the system's default |
| `../../src/voice/platform/audio.native.ts` | the adapter `audioOver(module): AudioPort` (the audio port of voice, `app/src/voice/ports.ts`) and `audioNative()`, the app's port |
| `../../test/aiwbaudio.test.ts` | the adapter over the fake; the functions, events, payload keys and error code of the contract against the Swift and Kotlin sources |
| `../../test/appconfig.voice.test.ts` | the Info.plist text and the Android permissions, as written and as Expo makes them |

## The contract

| Call | What it does |
|---|---|
| `micPermission()` | `"granted"`, `"denied"` or `"undetermined"`. Asks nobody. On Android a first refusal is still `"undetermined"` (Android lets the app ask once more), a second one is `"denied"`. |
| `requestMic()` | Asks the person (the system's alert) and answers the state after. |
| `startMic(chunkMs, echoCancel, inputId)` | Starts the microphone, on the input of that id (`null`: the system's; an id that is no longer connected gives the system's too): `onMic` with `{ pcm, level }` for every `chunkMs` of sound, `pcm` the base64 of 16 kHz mono s16le (`16 × chunkMs` samples), `level` its RMS from 0 to 1. Resolves with `{ echoCancel, device }`: whether the platform's echo cancellation runs (asked for, and the device has it), and the input it listens to (`null`: not known); the adapter compares `device` with the id asked for to tell that a saved device was missing. Rejects with the code `ERR_AIWB_MIC_BLOCKED` when the system gives the app no microphone, with another code when the device cannot start it. A second start replaces the first. |
| `setMicMuted(muted)` | While muted no chunk is emitted, and what is heard is dropped (it does not come out when the mute ends). |
| `stopMic()` | Stops the microphone; no chunk after it resolves. |
| `playerWrite(pcm)` | Queues 24 kHz mono s16le after what is queued and plays it as soon as it can, with no gap of its own between writes. An odd trailing byte is kept for the next write. |
| `playerMark(id)` | A point in the queue: `onPlayer` `{ kind: "mark", id }` when playback reaches it. A mark with nothing queued is reached when the next write starts to play. |
| `playerStop()` | Stops at once and empties the queue (bytes, marks, a kept odd byte). Emits no `drained`: the caller knows. |
| `playClip(bytes)` / `stopClip()` | A preview clip (MP3 or WAV) from memory; resolves when it ends, is stopped, or is replaced by another clip. |
| `openSettings()` | The app's page in the system settings, where the microphone's switch is. |
| `listDevices()` | `{ devices, defaultInput, defaultOutput }`: the inputs, and the outputs where `deviceAbility().output` is `"pick"`, each a `NativeDevice` (`id`, `name`, `kind`, `privacy` `"private"`, `"public"` or `"unknown"`, `builtIn`), without the platform's pseudo-entries; `defaultInput` and `defaultOutput` the ids of what the system uses now (`null`: not known). Never asks a permission, never interrupts another app's audio. |
| `deviceAbility()` | `{ input, output, linked }`, synchronously: `"pick"` or `"system"` for each kind (whether the app may choose it), and `linked`: a headset chosen as the speaker brings its own microphone (Android 12+). A constant of the build and the OS version. |
| `setBuiltInNames({ mic, speaker })` | The words for the built-in microphone and speaker, which Android's system names after the phone's model; ignored where the system names them. |
| `setOutput(outputId)` | Where the player and the clips play from now on (`null`: the system's), applied to what is queued too. Resolves with `{ device }`, where the sound goes (`null`: not known); where the output is `"system"` it changes nothing and answers the route's. |
| `playerHold()` / `playerResume()` | Pauses the player where it is, keeping the queue (writes are still queued; no mark, level or `drained` while held), and plays on from there. `playerStop()` ends a hold. |

`onPlayer` also carries `{ kind: "level", level }` (the RMS of what plays now, 0 when nothing does) about every 20 to 100 ms while
something plays, and `{ kind: "drained" }` each time the queue has played to its end. `drained` can come between two writes when the bytes
come slower than they play (the engine writes the next sentence after it), and it also comes when the module itself had to drop the
queue: the microphone started while Read aloud played (below). `onInterrupted` `{ reason }` says that the module stopped the microphone,
the player and the clip by itself: `"call"` (a call, Siri, an alarm, the app going to the background) or `"other"` (another app took the
audio for good, the audio server restarted, the microphone died). After it nothing runs until the next call. `"route"` stays in the type
but is no longer sent for a device that was lost (headphones taken off, a microphone pulled): that is `onRoute`, and the session goes on
(voice-devices VD-9, VD-10); only an iOS engine that will not start again with nothing but the player to run still ends with `"route"`.

`onDevices` `{}` says that the list of devices may have changed (plugged in, unplugged), whether anything runs or not; the app lists again.
`onRoute` `{ kind, lost, now, held }` says that a device **in use** went away, after the module has done the mechanical part, and only
while the microphone, queued sound or a clip is in use: `"input-lost"` (listening goes on from `now`, the system's input, into the same
`onMic`; a moment of sound is lost), `"input-failed"` (no input could be kept, and the microphone has stopped) or `"output-lost"` (the sound
goes to `now`, the system's output). `held` (`output-lost` only) is true when the player was paused before any sound came out of `now`,
because the lost output was private (or of unknown kind) and `now` is not: it waits for `playerResume()` or `playerStop()`, and the app
decides whether to go on (the pause, voice-devices VD-12). What has played is not played again; what was queued and not played plays on the
new output; at most the piece playing at the moment is cut or played again from its start.

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
- An interruption (`AVAudioSession.interruptionNotification`, began) and media services reset end everything: `onInterrupted` (`"call"`,
  `"other"`). A lost device does not (below, `onRoute`).
- The engine stopping by itself on a format change (`AVAudioEngineConfigurationChange`) is no end: voice processing does it just after
  the engine starts (the input and the output take its formats), and so does a headset plugged in or taken off. The engine is started again
  on the new formats, with the tap put back for the input's new format (muted if it was). The player keeps every buffer it scheduled until
  its completion (`.dataPlayedBack`) has come, and schedules the ones not played again after the restart, in order, with their marks
  (voice-devices VD-10): nothing played is played again but, at most, the piece that was playing, from its own start, and no `drained` is
  emitted for a queue that did not play. Only an engine that does not start again, or that stops a fourth time within two seconds, ends
  what runs: with the microphone on, `onRoute` `input-failed` (and `drained` if sound was queued); the player alone, `onInterrupted` `"route"`.
- **Devices** (voice-devices VD-9, VD-10, VD-11, VD-18; platforms.md §3). `deviceAbility()` is `{ input: "pick", output: "system", linked:
  false }`: iOS lets an app prefer an input, and has no choice of output but the system's route picker, which would change the route of the
  whole device (goal 4.4); the output follows the system (headphones or a headset when connected, else the speaker, `.defaultToSpeaker`).
  - `listDevices()`: the session's `availableInputs` (a port each: `uid` the id, `portName` the name; an iPad's several built-in microphones
    are data sources of one port and are not listed), `defaultInput` the route's input when the module prefers none (else the last
    non-built-in input listed, else the built-in microphone), `defaultOutput` the route's output. The list is read as the session is; if it is
    empty and the session inactive, with `.playAndRecord` set on the inactive session (the category it had is put back); if still empty and
    the microphone is allowed, with a short activation with `.mixWithOthers` (no other app's sound is interrupted, and no permission is
    asked: an activation for recording is never made before the permission). While a playback session is active (its category lists no
    input) the last list that was not empty is answered. No outputs are listed.
  - `startMic(chunkMs, echoCancel, inputId)`: `setPreferredInput` with the port of that `uid` once the session is active and before the
    engine takes its formats (none, or an id no longer listed: `nil`, the system's); a listening engine that is kept (the next turn) gets the
    preference too, and the engine's restart puts the tap on the new input. Answers `device`, the route's input it listens to. The preference
    is taken back (`nil`) when the session is given back.
  - `setOutput(id)` changes nothing and answers the route's output. `setBuiltInNames` is ignored (iOS names its built-in ports).
  - `playerHold()` pauses the player node (and a clip) where it is; writes are still scheduled, and the marks and level of a start wait for
    `playerResume()`, which plays on. `playerStop()` ends a hold. A hold outlasts the engine being taken down.
  - `onDevices` on every route change whose reason is `.newDeviceAvailable` or `.oldDeviceUnavailable`, whether anything runs or not.
  - `onRoute`, only while something is in use (the microphone, queued sound, a clip): **`output-lost`** when the route's output went away
    (`.oldDeviceUnavailable`), or when a private output gave way to one not known to be private on any change. Private by the port type:
    `headphones`, `bluetoothA2DP`, `bluetoothHFP`, `bluetoothLE`, `builtInReceiver`; public: `builtInSpeaker`, `HDMI`, `airPlay`, `carAudio`;
    anything else unknown. A private or unknown output lost to one not private is **held**: the player node and the clip are paused on the
    notification's own thread before anything else, and `held: true`. A public loss goes on (the system has moved the sound). **`input-lost`**
    when the input the microphone listened to is no longer among the available inputs and the route has another: the tap is on it already
    (the engine follows the route, or its restart put the tap back), chunks go on into the same `onMic`. **`input-failed`** when no input is
    left: the microphone stops. A device plugged in moves nothing that is told; a restart and the notification that see the same change tell
    it once.
  - Names are sent to JS only: the module's debug trace names a port by its type.
- Permission: `AVAudioApplication` on iOS 17 and later, `AVAudioSession`'s record permission before. The Info.plist text is
  `NSMicrophoneUsageDescription` of `app.config.ts`. No background mode: the app does not listen in the background (goal §5).
- Clips: `AVAudioPlayer(data:)`, through the session of the engine when one runs, else a `.playback` session.

**Android** (`VoiceAudio.kt`, a looper thread "aiwb-audio" for every change; `MicCapture` reads on its own thread, `PcmPlayer` writes on
its own):

- **Listening**: audio focus `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` (refused, e.g. during a call: `startMic` fails); `AudioRecord` from
  `VOICE_COMMUNICATION` at 16 kHz mono PCM 16; with `echoCancel`, `AcousticEchoCanceler` and `NoiseSuppressor` on its session when
  `isAvailable()`, and the mode `MODE_IN_COMMUNICATION` with the built-in speaker as the communication device when no headset is there
  and nothing is chosen (`setCommunicationDevice` on API 31+, `isSpeakerphoneOn` before), since that mode would use the earpiece.
  `startMic`'s `echoCancel` is whether the canceller was made and enabled. The player's track has the usage `USAGE_VOICE_COMMUNICATION`.
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
- `AUDIOFOCUS_LOSS_TRANSIENT` is `"call"`, `AUDIOFOCUS_LOSS` is `"other"`, a read error of the microphone that is not a lost device (the
  audio server died) is `"other"`: each ends everything with `onInterrupted`. A duck for another app's short sound is not an end. Android
  sends no `"route"` any more: a lost device is `onRoute` (below).
- **Devices: what is listed** (`Devices.kt`). `deviceAbility()`: Android 12+ (API 31) `{ input: "pick", output: "pick", linked: true }`,
  before `{ input: "pick", output: "system", linked: false }`. `listDevices()` answers the inputs of `getDevices(GET_DEVICES_INPUTS)` and,
  on API 31+, the outputs of `getAvailableCommunicationDevices()` without the earpiece (only those can carry speech mode); no permission
  is asked, nothing is opened, and telephony, remote submix, FM, tuners, bus and echo reference are left out. The id is the module's:
  `<family>:<address>`, or `<family>:<name>` when the address is empty (`builtin`, `wired`, `bt`, `ble`, `usb`, `hdmi`, `hearing`, `other`);
  a Bluetooth headset's SCO and A2DP entries share it. The built-ins are one entry per kind, `builtin:mic` and `builtin:speaker` (a phone
  reports two or three microphones, "bottom", "back"), named with `setBuiltInNames` (the system names them after the phone's model; until
  it is called, "Phone microphone" and "Phone speaker"). A device whose port has no name of its own (the system then answers the phone's
  model, e.g. a wired headset) is named by its kind: "Wired headset", "Wired headphones", "USB audio", "Bluetooth headset", "HDMI".
  `privacy` by type: wired headset and headphones, Bluetooth SCO and A2DP, LE headset, hearing aid, USB headset, earpiece are private;
  the built-in speaker, HDMI, LE speaker and broadcast, dock are public; a USB device, a line and the rest unknown. `defaultInput` and
  `defaultOutput`: in communication mode the communication device (and its microphone); otherwise where Android 13+ routes speech
  (`getAudioDevicesForAttributes`), or before it the system's order of what is connected. `onDevices` comes from an `AudioDeviceCallback`
  registered when the module is first used.
- **Devices: choosing.** `startMic(…, inputId)` makes the input the record's preferred device (`AudioRecord.setPreferredDevice`, before
  `startRecording`); an id not connected gives the system's routing, and the answer's `device` is where the record is routed. `setOutput(id)`
  (API 31+; before, it changes nothing and answers the default) is found once: in communication mode it is the communication device;
  for plain playback (Read aloud, a preview, Test speaker) the track's and the clip's preferred device (`AudioTrack.setPreferredDevice`, of a
  Bluetooth headset the A2DP entry). In communication mode a headset is used for both: the communication device is the chosen output, else
  the chosen input's own headset, else the rule above (the speaker unless a headset is there); the platform takes the microphone of that
  device, and the chosen input stays the record's preferred one. A chosen Bluetooth microphone gives sound only over the headset's call link,
  so it gets it even for dictation: the communication device on API 31+, `startBluetoothSco` before. Everything the module set is cleared
  when listening ends.
- **Devices: a device in use that goes away** (`onRoute`; seen from `onAudioDevicesRemoved`, the record's and the track's routing listeners,
  and `ACTION_AUDIO_BECOMING_NOISY`, whichever comes first, once per device). The output: when it was private or unknown and what the sound
  moves to is not private, the track is paused at once (`AudioTrack.pause()` keeps what was written) and a preview clip is stopped,
  then `output-lost` goes out with `held: true`; `playerResume` plays on (`play()`), `playerStop` empties it. `BECOMING_NOISY` is sent before
  the system moves the sound, so a wired headset or an A2DP one is held before anything comes out of the speaker; it counts as a private
  loss unless the sound was on the loudspeaker already. A public loss goes on (`held: false`) on the system's routing. In communication
  mode the module sets the route again without the lost device (the speaker unless another headset is there). While held the writer waits
  instead of dropping what the paused track does not take, and no `drained` or silence is sent. The input: the record is made again with no
  preferred device, into the same `onMic`, muted if it was (`input-lost`, a moment of sound is lost), or, when the system has moved it
  already, it goes on there; if no record can be made the microphone stops and `input-failed` goes out.
- Permissions: `RECORD_AUDIO` (asked at run time through Expo's permissions) and `MODIFY_AUDIO_SETTINGS` (for the mode and the speaker),
  both in `app.config.ts` `android.permissions`. The camera and the image picker plugins carry voice's microphone text, not `false`:
  `false` makes the image picker block `RECORD_AUDIO` in the manifest (`tools:node="remove"`) and both delete the Info.plist text. A
  generated `android/` of an older config keeps that block: make it again with `npx expo prebuild -p android --clean`.
- Clips: `MediaPlayer` over a `MediaDataSource` of the bytes.

## What only a device shows

A simulator or an emulator proves that the module builds, that the session starts and that chunks and playback flow. The echo
cancellation (`setVoiceProcessingEnabled`, `AcousticEchoCanceler`) has no acoustic echo to cancel there, so voice barge-in (VC-9) is
confirmed by the person on an iPhone and an Android phone with the speaker. The speaker routing in communication mode, a Bluetooth headset,
a call that interrupts, and the start threshold of the Android track on a short reply are device matters too. The iOS simulator has one
input and one output and cannot plug or unplug a device: the device list beyond the built-in microphone, a chosen headset, `input-lost`,
`output-lost`, the hold and the buffers scheduled again after a restart are confirmed on a real iPhone and iPad with a wired and a Bluetooth
headset (`plans/voice-devices/d5-ios.md`). On Android the emulator has
only its built-in microphone and speaker: choosing another device, a headset unplugged (the hold before the speaker), a Bluetooth
microphone (its call link), and whether the preferred input holds in communication mode (`plans/voice-devices/d6-android.md`) are for a
phone with a wired and a Bluetooth headset.
