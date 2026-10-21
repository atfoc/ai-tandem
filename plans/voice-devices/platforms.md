# Voice devices: what each platform allows (goal 7.1, 7.2, 7.5, 3.4)

Written by the architecture package (`vd-architecture`) on 2026-10-21, against branch `voice-devices` (commit `a550fd9`).
Each fact has a mark:

- **[verified]**: run on this machine. The spike scripts are in `spikes/`, and each one's header says how to run it.
- **[docs]**: read in the platform's primary documentation, with the source named. For Android this is the javadoc of the
  SDK sources installed here (`~/Library/Android/sdk/sources/android-36.1`).
- **[assumed]**: from what is generally known of the platform, not checked here. The package that builds it checks it
  first and reports.

Versions in the repository: Electron **44.4.5** (Chromium **152.0.7977.130**) [verified]. The browser checks run on
Playwright 1.63.0 / Chromium **153.0.8010.12** [verified]; `AGENTS.md` names 1.64.1 / 156 as the reference. iOS
minimum **15.1** (React Native 0.86) and Android `minSdk` **24** (Android 7.0) [verified in
`node_modules/react-native`].

---

## 1. The desktop window (Electron 44, Chromium 152): macOS, Windows, Linux

### What the page can list and pick

| | Input | Output |
|---|---|---|
| List | `navigator.mediaDevices.enumerateDevices()`: `audioinput` entries | `audiooutput` entries |
| Pick | `getUserMedia({ audio: { deviceId: { exact: id } } })` | `AudioContext.prototype.setSinkId(id)` (the player and the clip go through one context); `HTMLMediaElement.setSinkId` exists too |

- **Both kinds can be picked** [verified on macOS]. `spikes/electron-devices.js` found `setSinkId` on `AudioContext` and on
  `HTMLMediaElement`, `sinkId` and `onsinkchange` on `AudioContext`, and `ondevicechange` on `mediaDevices`.
  `selectAudioOutput` does not exist and is not needed.
- `setSinkId(listedId)` resolves and `sinkId` becomes that id. `setSinkId("default")` and `setSinkId("")` resolve.
  `setSinkId({ type: "none" })` resolves. An unknown id rejects with **`NotFoundError`** [verified].
- `new AudioContext({ sinkId: "bogus" })` **does not throw**: the context is made and stays `suspended` [verified].
  **So the port never passes `sinkId` to the constructor.** It makes the context, then calls `setSinkId`, and a
  rejection means "missing".
- `getUserMedia` with `deviceId: { exact: <listed id> }` opens that device: the track's `getSettings().deviceId` equals the
  id asked for. An exact id that is not listed rejects with **`OverconstrainedError`** (`constraint: "deviceId"`)
  [verified with Chromium's fake devices].
- The track's `getSettings()` carries `deviceId` and `groupId` [verified].
- **Windows** lists the pseudo-entries `default` *and* `communications` (each names a real device again). **macOS and
  Linux** list `default` only [assumed for Windows/Linux; macOS verified: one `default` per kind, no `communications`].
  The app shows neither pseudo-entry. Its own "System default" stands for them.
- Linux: Chromium goes through PulseAudio (PipeWire answers it). `setSinkId` and `devicechange` work there [assumed].

### Ids and names

- **Names are shown without any permission.** On macOS, with no `getUserMedia` call and no permission check handler,
  every entry has its label and id [verified, `spikes/electron-devices.js`, modes "" and "check"]. Electron answers
  `media` permission *checks* with "granted" when no check handler is set, and `desktop/main.js` sets only a request
  handler. The macOS microphone permission (TCC) gates capture, not the list.
- **Ids are stable from run to run** of the app on one profile (`userData`). A new profile gives new ids for the same
  devices. **`groupId` changes on every run** [verified, `spikes/electron-ids.js`: two runs on one profile gave the same
  ids, a third profile different ones, and every run new group ids]. So a saved choice is found again by id, and by name
  after the person's data is cleared (or a reinstall that clears `userData`). `groupId` is useless for matching.
- The same physical device may have the same id as input and as output (seen on this Mac) [verified]. Ids are only
  compared within one kind.
- Two devices may have the same name (two identical USB headsets) [assumed]. Matching handles it (architecture VD-4).

### Added, removed, route changes

- `navigator.mediaDevices.ondevicechange` fires when a device is added or removed. The event carries no detail, so the
  port lists again and compares [docs: MDN *MediaDevices: devicechange event*; not triggered here because nothing could
  be plugged in].
- A capture track whose device goes away **ends** (`ended` event). Today `audio.web.ts` takes that as "the system took
  the audio" and ends the session [code]. The design reopens capture on the default instead (VD-9).
- **What Chromium does with an `AudioContext` whose chosen sink is removed is not documented** [not verified: searched
  MDN, the Chrome blog post on `AudioContext.setSinkId`, the spec drafts]. The design does not rely on it. On
  `devicechange` the port lists again, and if its sink id is no longer listed it holds the sound, or moves it to the
  default with `setSinkId("")` (VD-10).
- A context with no sink chosen follows the system's default output when that changes [assumed]. So when the default
  changes (headphones unplugged while "System default" is chosen), the only sign is `devicechange` plus the label of the
  `default` entry: Chromium names it `Default - <device>` on macOS and Windows [assumed for the wording; the entry
  itself verified].

### Private or loudspeaker

- No API says what kind a device is. The only information is the **name**. The design classifies by name (VD-11):
  "headphones", "headset", "AirPods", "earbuds", "buds", "hands-free" and the like → private; "speaker(s)", "display",
  "HDMI", "TV", "monitor" → public; anything else → **unknown, which is read as private** when it is lost (goal 7.5). The
  name of the `default` entry tells what the sound moves to.

### Permissions

- Listing: none [verified]. Capture: the macOS microphone permission, already asked by `aiwbVoice.mic.ask()` before
  `getUserMedia` (voice-chats VC-10). On Windows it is the privacy switch for the microphone [assumed]. `setSinkId`: no
  prompt. The app's permission request handler grants `media` (audio) to its own page only, and `setSinkId` worked with
  exactly that handler in the spike [verified]. **`desktop/main.js` and `desktop/voice.js` need no change.**

### Test stand-ins

- Electron started with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` lists **"Fake Default Audio
  Input", "Fake Audio Input 1", "Fake Audio Input 2"** and **"Fake Default Audio Output", "Fake Audio Output 1", "Fake
  Audio Output 2"**. `getUserMedia` answers (it did not hang in Electron here), `deviceId: { exact }` opens the one asked
  for, and `setSinkId` on a fake output resolves [verified]. Devices cannot be added or removed this way: the e2e adds
  the page-level stand-in for that (architecture §11).

---

## 2. The web build in Chromium (tests only)

The same Web APIs as the desktop window, with the browser's own permission rules:

- **Before the microphone permission the list is one `audioinput` and one `audiooutput` entry with an empty label and
  an empty id.** `setSinkId(anything)` rejects with `NotFoundError` [verified: Playwright Chromium 153 without
  `--use-fake-ui-for-media-stream`, `spikes/playwright-devices.mjs` with `NO_FAKE_UI=1`]. This matches MDN
  (*enumerateDevices*: labels and ids are withheld until a permission is granted).
- After the permission (or with `--use-fake-ui-for-media-stream`, as the checks launch) the fake devices are listed with
  labels and ids. `setSinkId` on a fake output resolves and an unknown id rejects with `NotFoundError` [verified, Chromium
  153 headless]. `getUserMedia` answered in a fresh page of the spike. `web/dev/checks/mic.mjs` records that it never
  answers in the app's page on this machine; the device checks use the stand-in layer of architecture §11 anyway, because
  they need to add and remove devices.
- **Other browsers** (not shipped, but the code must not break): Safari and Firefox have no `AudioContext.setSinkId`
  [assumed, MDN compatibility tables]. The web port then answers output `"system"` by feature detection, so the Speaker
  choice is not shown.
- Private or public: by name, as on the desktop. Before the permission everything is "unknown", read as private (pause).
  This only happens in the tests' web build, during Read aloud without the microphone allowed.

---

## 3. iPhone and iPad (iOS / iPadOS 15.1+), over `aiwb-audio` (`AVAudioSession`, `AVAudioEngine`)

### Input: can be picked

- `AVAudioSession.availableInputs` lists the input ports (`AVAudioSessionPortDescription`: `portType`, `portName`,
  `uid`, `dataSources`). "The active audio session category and mode determine the number of inputs this property
  returns … if the session's category is playback, this property returns an empty array" [docs: Apple,
  *availableInputs*].
- `setPreferredInput(_:)`: "The value of the inPort parameter must be one of the … objects in the availableInputs array
  … You must set a preferred input port only after setting the audio session's category and mode and activating the
  session" [docs: Apple, *setPreferredInput(_:)*]. **So the input is applied inside `startMic`**, after
  `.playAndRecord` / `.voiceChat` is set and active, which `VoiceAudio.swift` does today.
- **Listing in Settings without disturbing other apps.** Setting the category to `.playAndRecord` without activating does
  not interrupt other apps' audio [assumed]. Whether `availableInputs` is filled while the session is **inactive** is
  [not verified]. If it is empty, the module activates with `.mixWithOthers` (which interrupts no other app), reads the
  list and deactivates. The native package D5 checks this on the simulator and keeps whichever works.
- Input port types: `builtInMic`, `headsetMic` (wired), `bluetoothHFP`, `usbAudio`, `carAudio`, `lineIn` [docs:
  `AVAudioSession.Port`]. An iPad has several built-in microphones as data sources of one `builtInMic` port. The app
  lists ports, not data sources (goal §5: nothing beyond what the system reports as devices).
- **Ids:** `uid`, "a system-assigned unique identifier (UID) for the port" [docs: Apple, *uid*]. Stability across
  reconnects and reboots is not documented [not verified]. The built-in microphone's uid is a fixed string, and
  Bluetooth uids carry the device's address [assumed]. Matching falls back to the name (VD-4).
- **Coupling:** a Bluetooth HFP or wired headset chosen as the input takes the output too, because iOS routes a headset as
  a pair [assumed]. The design does not fight it: the output follows the system on iOS anyway.

### Output: cannot be picked

- There is no API to choose an output port. The only control is `overrideOutputAudioPort(.speaker)`, which forces the
  built-in speaker "until the current route changes" (and the `.defaultToSpeaker` category option, which the module
  uses already) [docs: Apple, *overrideOutputAudioPort(_:)*]. Apple points to `MPVolumeView` / `AVRoutePickerView`
  for route choice: these are the system's own picker, and they change the route for the device, not for voice alone.
  Using them would break goal 4.4.
- **So on iOS and iPadOS the speaker follows the system:** headphones or a headset when connected, otherwise the speaker
  (with `.defaultToSpeaker`, never the earpiece).

### Added, removed, route changes

- `AVAudioSession.routeChangeNotification` with the reason `newDeviceAvailable`, `oldDeviceUnavailable` ("the previous
  audio output path is no longer available" [docs]), `categoryChange`, `override`, `routeConfigurationChange`, … and
  the previous route (`AVAudioSessionRouteChangePreviousRouteKey`) [docs]. `currentRoute.inputs/outputs` give the new
  route.
- Today the module ends the session on `oldDeviceUnavailable` (`interrupted("route")`), and a change of hardware format
  stops the engine, which `restart()` starts again **while dropping the player's queue** [code: `VoiceAudio.swift`]. The
  design changes both (VD-9, VD-10, VD-15).

### Private or loudspeaker

- Exact from the port type of the previous and current output [docs: `AVAudioSession.Port`]: private = `headphones`,
  `bluetoothA2DP`, `bluetoothHFP`, `bluetoothLE`, `builtInReceiver`. Public = `builtInSpeaker`, `HDMI`, `airPlay`,
  `carAudio`. Unknown = `usbAudio`, `lineOut`, anything else.

### Permissions

- The input list does not need the microphone permission [assumed: port names are not described as private]. The
  record permission gates capture only. The design lists inputs without asking (`hidden: false`), so an app whose
  person opens Settings > Voice is asked nothing until a tap on Test microphone or a voice control.

### Simulator

- The simulator has the Mac's audio behind one built-in input and output. It cannot plug or unplug a headset. The device
  flow proves the list, the choice kept over a restart and the choice applied (architecture §12). Loss, the pause and
  Bluetooth are proved by the unit tests over the fake module, and by the person on a real iPhone and iPad.

---

## 4. Android (API 24+), over `aiwb-audio` (`AudioManager`, `AudioRecord`, `AudioTrack`)

### Listing

- `AudioManager.getDevices(GET_DEVICES_INPUTS | GET_DEVICES_OUTPUTS)` → `AudioDeviceInfo[]` with `getType()`,
  `getProductName()`, `getId()`, `getAddress()` (API 23) [docs: SDK sources].
- **`getProductName()` of a built-in device is the phone's model.** The source returns the port name, or
  `android.os.Build.MODEL` when that is empty [docs: `AudioDeviceInfo.java`]. So the built-in microphone, speaker and
  earpiece are all called e.g. "Pixel 8". The port names built-ins by their type ("Phone microphone", "Phone speaker")
  (VD-5, a choice to confirm).
- **`getId()` is "the internal device ID"**, a port handle [docs]. It is not kept across a reconnect or a reboot
  [assumed]. The port makes its own id from the type family and the address (or the name when the address is empty),
  and keeps the `AudioDeviceInfo` behind it in memory (VD-4).
- `getAddress()`: "generally contains device-specific parameters" [docs]. For Bluetooth it is the device's address,
  possibly anonymized on recent versions without `BLUETOOTH_CONNECT` [not verified]. Anonymized or not, it is the same
  value for the same device on the same phone [assumed].
- A Bluetooth headset appears twice among the outputs: `TYPE_BLUETOOTH_SCO` (calls) and `TYPE_BLUETOOTH_A2DP` (media),
  with the same address. The port shows it once.
- Types used (API level): `BUILTIN_MIC` (23), `BUILTIN_SPEAKER`, `BUILTIN_EARPIECE`, `WIRED_HEADSET`,
  `WIRED_HEADPHONES`, `BLUETOOTH_SCO`, `BLUETOOTH_A2DP`, `HDMI`, `USB_DEVICE` (23), `USB_HEADSET` (26), `HEARING_AID`
  (28), `BLE_HEADSET`, `BLE_SPEAKER` (31) [assumed for the levels; the constants are in the source]. Not listed:
  telephony, remote submix, FM, bus, echo reference.

### Picking

- **Input:** `AudioRecord.setPreferredDevice(info)` (API 23): "Specifies an audio device … to route the input to this
  AudioRecord … If deviceInfo is null, default routing is restored" [docs: `AudioRecord.java`]. Whether it is honoured
  while the mode is `MODE_IN_COMMUNICATION` (speech mode with echo cancellation) is [not verified]. D6 checks it.
- **Output, API 31+ (Android 12):** `setCommunicationDevice(info)` "selects the audio device that should be used for
  communication use cases … Note that only devices in a sink role (AKA output devices) can be specified. **The matching
  source device is selected automatically by the platform.** The selection is active as long as the requesting
  application process lives, until clearCommunicationDevice is called or until the device is disconnected … If the
  requested device is not currently available, the request will be rejected" [docs: `AudioManager.java`]. It replaces
  `startBluetoothSco` and `setSpeakerphoneOn`. The module already uses it for the speaker in communication mode.
  Choices are `getAvailableCommunicationDevices()`.
- **Output for plain playback** (Read aloud, the preview, Test speaker: `USAGE_ASSISTANT`, `MODE_NORMAL`):
  `AudioTrack.setPreferredDevice(info)` (API 23) [docs].
- **Consequence:** in speech mode and the pill (communication mode), a headset chosen as the speaker brings its own
  microphone: the two choices are **linked** for headsets there. On Android 7–11 the output in communication mode can
  only be the speaker or the earpiece (`setSpeakerphoneOn`) or Bluetooth SCO, so an output choice would not hold for
  speech mode.

### Added, removed, route changes

- `registerAudioDeviceCallback` (API 23): `onAudioDevicesAdded` / `onAudioDevicesRemoved` [docs].
- `addOnRoutingChangedListener` on `AudioRecord` / `AudioTrack` (API 24) reports the device a stream is routed to
  [assumed]. A stream whose preferred device is removed falls back to default routing [assumed]. D6 checks both.
- `addOnCommunicationDeviceChangedListener` (API 31) [docs].
- `ACTION_AUDIO_BECOMING_NOISY`: "may be sent when a wired headset is unplugged, or when an A2DP audio sink is
  disconnected, and the audio system is about to automatically switch audio route to the speaker. Applications … may
  consider pausing … so as not to surprise the user with audio from the speaker" [docs: `AudioManager.java`]. This is
  the platform's own "private would become public" signal. Today the module ends the session on it [code].

### Private or loudspeaker

- By type: private = wired headset/headphones, Bluetooth SCO/A2DP, BLE headset, hearing aid, USB headset, earpiece.
  Public = built-in speaker, HDMI, BLE speaker, dock. Unknown = USB device, anything else. `BECOMING_NOISY` counts as
  "private lost" whatever the types say.

### Permissions

- Listing needs no permission [assumed: `getDevices` has none in its javadoc]. Capture needs `RECORD_AUDIO` (asked
  today at the first voice tap). No new permission: `BLUETOOTH_CONNECT` is not asked, and an anonymized address is
  enough.

### Emulator

- The emulator has the built-in microphone and speaker. It cannot plug a headset [assumed], so Bluetooth is impossible
  there. The Kotlin is proven by `./gradlew :aiwb-audio:compileDebugKotlin` and, if the lock is free, one emulator run.
  Real headsets are left to the person.

---

## 5. What Settings shows on each platform (goal 3.4)

| Platform | Microphone | Speaker | Test speaker | Level meter |
|---|---|---|---|---|
| Desktop window, macOS / Windows / Linux | **choice** (System default + every input, names shown at once) | **choice** (System default + every output) | plays through the chosen output | yes |
| Web build in Chromium | **choice**; before the permission only System default, with "Allow the microphone to see the others" (Test microphone asks) | **choice** (same rule) | yes | yes |
| Web build in a browser without `AudioContext.setSinkId` | choice | line: "Follows the system." | yes (system output) | yes |
| iPhone, iPad | **choice** (System default + `availableInputs`) | line: "Follows the system: headphones or a headset when connected, otherwise the speaker." | yes (where the system routes) | yes |
| Android 12+ (API 31+) | **choice** | **choice** (System default + communication outputs without the earpiece), with the note "A headset is used for both listening and speaking while you talk to a chat." | yes | yes |
| Android 7–11 (API 24–30) | **choice** | line: "Follows the system: headphones or a headset when connected, otherwise the speaker." | yes | yes |
| A build without the audio module (an old native build) | line: "Voice uses the system's microphone and speaker. Change them in the system's settings." (one line for both) | (same line) | no | no |

No platform falls into "neither" on a current build. That case's line exists for a native build made before the module
learnt devices (the `audioOver(null)` path).

---

## 6. Summary of the risks of the goal (§7) after this work

| Risk | Finding |
|---|---|
| 7.1 what can be picked | Above. Desktop and web: both [verified]. iOS: input only [docs]. Android: input on 24+, output on 31+ with headsets linked [docs + assumed]. |
| 7.2 ids | Desktop: stable per profile, new after the data is cleared [verified]. iOS: system uid, stability not documented. Android: no persistent id, the port makes one. Names are the second key everywhere. Same names possible. |
| 7.3 switching mid-stream | Listening: the socket and the turn stay in the engine; only capture is reopened, and a moment of audio is lost. Speaking: the player keeps what it has not played, so no sentence is fetched again; at most the piece playing at the switch is cut or played again from its start (VD-10). [not verified on devices] |
| 7.4 Bluetooth quality | Not detectable by the app in any API read here. Nothing is promised. |
| 7.5 private | iOS and Android: exact by port type plus the platform's own signals. Desktop and web: by name, unknown read as private. |
| 7.6 echo | Unchanged: speech mode does not send while the reply is spoken. |
