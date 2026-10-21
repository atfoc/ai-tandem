# Voice devices: the architecture

The design every package of the voice-devices goal (`voice-devices-goal.md`, "the goal") follows. It builds on the voice
design of today (`plans/voice-chats/architecture.md`, "VC-n") and changes only what devices need. What each platform
allows is in `platforms.md`, and this document relies on it. The work packages are in `packages.md`.

Decisions are numbered **VD-n**. Marks are as in the goal; everything decided here is `[proposed]` until the person
says otherwise. Decisions the person should confirm are also listed in `status.md` under "Choices to confirm". A package
that finds a decision wrong stops and reports; it does not change the decision silently.

**Bounds kept everywhere:** no change under `cmd/` or `internal/` (goal 4.1); no new dependency (none is needed:
everything below is the platforms' own APIs and the app's own code); no call to the voice service because of a device
(4.7); no device name in a log line, a request or the aiwb server's traffic (4.7, 6.1).

---

## 1. What changes, in one picture

```
Settings > Voice ──► voice.* (public face) ──► engine/devices.ts ──► AudioPort.devices / startMic / player.useOutput / onRoute
   Microphone ▾  Test microphone ▮▮▮▯                       │                   │
   Speaker    ▾  Test speaker                     logic/devices.ts (pure)   platform/audio.web.ts     (Web Audio, Electron + web build)
                                                  match, privacy, loss      platform/audio.native.ts  (over app/modules/aiwb-audio)
Speech bar, pill, composer line, Read aloud ◄── noticeStore, SessionState.paused, ReadingState.paused
```

- **Pure logic** (`app/src/voice/logic/devices.ts`): finding a saved device again, sorting and labelling the lists,
  reading "private", deciding what a lost device does, and the words of the notices. Tested under `node --test` with
  no audio at all (goal 4.11).
- **The engine** (`app/src/voice/engine/devices.ts` and small changes to `session.ts`, `listener.ts`, `speaker.ts`,
  `player.ts`, `state.ts`): applies the saved choice when a session or an utterance starts, turns the port's route
  events into a notice, a pause or an end, runs the microphone test and the speaker test. It knows no platform.
- **The ports**: `AudioPort` gains a device port, a device for `startMic`, an output for the player, hold and resume,
  and route events. Each platform answers them in its own file and in the native module.
- **The screens**: a Devices card in Settings > Voice, one notice component, and the pause in the speech bar, the pill
  and Read aloud.

---

## 2. The port the engine uses (goal 4.11)

**VD-1. The device port is part of `AudioPort` (`app/src/voice/ports.ts`).** These types and members are added
(exactly, in package D1):

```ts
export type DeviceKind = "input" | "output";
/** Whether sound on this device is heard by the person alone. "unknown": the platform cannot tell (read as private when it is lost, goal 7.5). */
export type Privacy = "private" | "public" | "unknown";

/** A device as the platform reports it. `id` is the platform's id or one the port makes (VD-4); `name` is the system's name (VD-5). */
export type AudioDevice = { id: string; name: string; kind: DeviceKind; privacy: Privacy; builtIn: boolean };

/** A saved choice (VD-3): what is needed to find the device again. Never a whole AudioDevice: privacy and builtIn are read anew each time. */
export type SavedDevice = { id: string; name: string };

export type DeviceList = {
  inputs: AudioDevice[];                 // without the platform's pseudo-entries ("default", "communications")
  outputs: AudioDevice[];
  /** The system hides devices until the microphone is allowed (the web build before the permission). Only System default can be offered. */
  hidden: boolean;
  /** What "System default" is now, where the system says it (Electron's "Default - …" entry, the iOS route, Android's routed device). */
  defaults: { input: AudioDevice | null; output: AudioDevice | null };
};

/** What the platform lets voice choose (platforms.md §5). Fixed for the life of the port. */
export type DeviceAbility = {
  input: "pick" | "system";
  output: "pick" | "system";
  /** Android 12+: a headset chosen as the speaker brings its own microphone while voice talks to a chat. */
  linked: boolean;
};

/** What a start or a change of output got. `device`: what listens or plays (null: the default, whose name the port does not know).
 *  `missed`: a saved device was asked for and was not there, so the default is used (goal 3.3). */
export type Opened = { device: AudioDevice | null; missed: boolean };

/** A device in use went away during a session (goal 3.3). The port has already done the mechanical part:
 *  input-lost:  capture goes on from the system default (`now`), into the same onChunk;
 *  input-failed: capture could not go on, and the microphone is stopped;
 *  output-lost: sound goes to the system default (`now`). When `held`, the port paused the sound before any of it came out of `now`
 *               (it waits for player.resume(), or player.stop()); the engine decides whether it stays paused (VD-12). */
export type RouteEvent =
  | { kind: "input-lost"; lost: AudioDevice | null; now: AudioDevice | null }
  | { kind: "input-failed"; lost: AudioDevice | null }
  | { kind: "output-lost"; lost: AudioDevice | null; now: AudioDevice | null; held: boolean };

export interface DevicePort {
  readonly ability: DeviceAbility;
  /** The devices now. Never asks for a permission, never opens a device, never activates an audio session that would stop another app's sound. */
  list(): Promise<DeviceList>;
  /** Told when the list may have changed (plugged, unplugged, a permission given). Watching lists nothing by itself. */
  watch(f: () => void): () => void;
}

// changed members
export interface MicHandle { readonly echoCancel: boolean; readonly opened: Opened; mute(on: boolean): void; stop(): Promise<void> }
export interface PcmPlayer {
  write(pcm: Uint8Array): void;
  mark(id: number): void;
  stop(): void;
  on(f: (e: PlayerEvent) => void): () => void;
  /** Where the next sound goes: a saved device, or null for the system default. Applies to what is queued too; playClip uses the same output.
   *  Resolves with what it got; never rejects for a missing device (missed: true, the default is used). "system" output ability: resolves
   *  { device: null, missed: false } and does nothing. */
  useOutput(d: SavedDevice | null): Promise<Opened>;
  /** Pauses the sound where it is and keeps the queue (writes are still queued). */
  hold(): void;
  /** Plays on from where hold() (or a held output-lost) stopped, on the current output. */
  resume(): void;
}
export interface AudioPort {
  // … as today, and:
  /** device: the saved microphone, or null for the system default. A saved one that is not there gives the default and opened.missed. */
  startMic(o: { chunkMs: number; echoCancel: boolean; device: SavedDevice | null; onChunk(b64: string, level: number): void }): Promise<MicHandle>;
  readonly devices: DevicePort;
  /** Devices lost while the microphone or the player is in use. Not told when nothing is in use. */
  onRoute(f: (e: RouteEvent) => void): () => void;
}
```

The `notSet` ports answer `ability: { input: "system", output: "system", linked: false }`, an empty list, a
`useOutput` that resolves `{ device: null, missed: false }`, and do-nothing `hold`, `resume`, `watch` and `onRoute`.

**VD-2. The matching is done in the port's adapter, with the shared pure function.** `audio.web.ts` and
`audio.native.ts` call `matchSaved` (VD-4) from `logic/devices.ts` against their own fresh list, then open the device
found or the default. So the engine never handles platform ids, and the rule is written once. A port whose `input` or
`output` ability is `"system"` ignores the saved device and answers `missed: false`. Nothing is announced for a choice
the platform cannot make, and Settings does not offer it (§9).

---

## 3. The saved choice (goal 3.1, 4.10, 7.2)

**VD-3. Two new fields of `VoiceSettings`** (`logic/settings.ts`), in the one stored value `aiwb.voice.settings` (kv
port: MMKV on a phone, `localStorage` in the desktop window and the web build). They are kept on the device, never sent,
and read and written only through the settings store, so Settings and every session read the same value (VC-14, goal
4.10):

```ts
mic: SavedDevice | null;       // default null = System default
speaker: SavedDevice | null;   // default null = System default
```

`clampSettings` keeps a value only if it is `{id: string 1..512, name: string 0..200}` (trimmed), else null. A stored
value without the fields reads as null: no migration. **A saved choice is changed only by the person in Settings**
(goal 4.3): nothing in the engine or a port writes these fields. Not even an id refreshed after a match by name: the
match is made again at every start.

**VD-4. Finding a saved device again: `matchSaved(saved, devices)`**, pure, in `logic/devices.ts`:

1. A device with `id === saved.id` → that one.
2. Otherwise the devices whose `name === saved.name` (after trimming, case kept). The first of them in the system's
   order → that one. (Two devices with the same name and neither with the id: the first is taken, and no notice is
   shown. It is the same model of device, and the goal's notice is for a missing device.)
3. Otherwise → none: the default is used and the start is "missed".

Ids per platform (platforms.md):

| Platform | `AudioDevice.id` |
|---|---|
| Desktop window, web build | `MediaDeviceInfo.deviceId` (stable per profile; changes when the person's data is cleared, then step 2 finds it by name) |
| iOS, iPadOS | `AVAudioSessionPortDescription.uid` |
| Android | made by the module: `<family>:<address>`, or `<family>:<productName>` when the address is empty; family ∈ `builtin`, `wired`, `bt`, `ble`, `usb`, `hdmi`, `hearing`, `other`. A Bluetooth headset's SCO and A2DP entries share one id. The `AudioDeviceInfo` behind an id is kept by the module, refreshed at each listing |

**VD-5. Names.** `AudioDevice.name` is the system's name, except for **Android's built-in devices**. The system gives
those the phone's model ("Pixel 8") for the microphone, the speaker and the earpiece alike, so the module names them
from words the app passes (`"Phone microphone"`, `"Phone speaker"`; `words.ts`). A choice to confirm. Names longer than
60 characters are cut with "…" where they are shown, never where they are matched.

---

## 4. When voice lists devices (goal 3.5, 4.8, 6.6)

**VD-6. The port lists only:** (a) while Settings > Voice is open, on opening and on every `watch` signal; (b) when a
session or an utterance starts **and** a saved choice of that kind exists (the adapter's `matchSaved`); (c) during a
session, inside the port, to understand a change (web: `devicechange`; native: the route notification). A person who
never opens the choices has `mic: null` and `speaker: null`: (b) never happens, (c) happens only inside a session the
person started, and no permission is asked that was not asked before (goal 3.5, 6.6). The web build's check "a page that
never used voice makes no `getUserMedia` call" gains "and no `enumerateDevices` call" (§12.3).

**VD-7. Names behind a permission.** Only the web build in a browser hides names (`hidden: true` before the
microphone permission). Settings then offers System default alone, with the line "Allow the microphone to see your
other devices." and the **Test microphone** control. That control is the person's own tap: it asks for the permission
through `startMic` exactly as Dictate does, and then the list is read again. The desktop window, iOS and Android list
names without any permission (platforms.md), so `hidden` is false there. No permission is asked to list.

---

## 5. Starting a session or an utterance (goal 3.1, 3.3 "at the start")

**VD-8. The saved choice is applied at each start and kept for that session or utterance.**

- **Listening** (dictation, speech mode, the pill): `listener.ts` passes `device: getSettings().mic` to `startMic`. The
  `MicHandle.opened` it gets back is handed to `engine/devices.ts`. When `missed`, one notice (VD-13) names
  `settings.mic.name`.
- **Speaking** (speech mode's and the pill's replies, Read aloud, a voice's preview, Test speaker): the speaker
  (`speaker.ts` `begin`) and `playClipOnce` call `player.useOutput(getSettings().speaker)` once, before the first
  write of the utterance. When `missed`, one notice names `settings.speaker.name`. Speech mode and the pill call it
  once at session start, not once per reply: the session keeps its output.
- **Both missing at one start** (speech mode or the pill: microphone and speaker): one notice naming both (VD-13).
- **A choice changed in Settings during a session** is not applied to it (goal 3.1). The session read the settings at
  its start. A new utterance of Read aloud reads them anew.
- **The default also unavailable** (no microphone at all): `startMic` fails as it does today, and the session ends with
  `mic_blocked`, "The app can't hear you" (goal 3.3, 6.3). There is no second notice: the problem popover says it. No
  output at all is not reported by any platform here. A player that cannot open behaves as today (iOS answers
  `drained`, and the utterance ends as played).

---

## 6. Losing a device during a session (goal 3.3, 7.3)

**VD-9. The microphone: the port reopens capture on the default; the engine keeps everything else.**

- The STT socket, the turn machine (words already committed, the partial) and the session live in the engine and are
  not touched. Only capture changes, inside the port, into the **same `onChunk`**. So "words already heard are kept"
  holds by construction. What is lost is the audio of the gap (a moment: the time to reopen capture).
- Web (`audio.web.ts`): the track's `ended` event is now "input lost", no longer "the system took the audio". The port
  calls `getUserMedia` again **without a `deviceId`** (the default), connects the new source to the same processor and
  chunker (chunker reset), stops the old stream, lists to name both devices, and emits `input-lost`. If `getUserMedia`
  fails it emits `input-failed`. The context's `"interrupted"` state stays "interrupted" (a call, as today).
- iOS: an `oldDeviceUnavailable` whose previous route's input is the one in use, or a configuration change that leaves
  the tap on another input, → the existing `restart()` puts the tap on the new input and emits `input-lost`. If the
  engine cannot start again → `input-failed` (today it emits `onInterrupted("route")`).
- Android: the `AudioRecord`'s routing listener (or the device callback naming the preferred device as removed) → the
  record goes on with default routing, or is made again with no preferred device → `input-lost`. If that fails →
  `input-failed`.
- **Engine:** `input-lost` → one notice (VD-13), and the session goes on. `input-failed` → the session ends with
  `mic_blocked`, exactly as a microphone that cannot start today (goal 3.3: "the way it ends today").
- During the pause (VD-12) the gate is closed, so nothing captured then is sent.

**VD-10. The speaker: the port moves the queue to the default; nothing is fetched or written again.**

- The rule every player keeps (the contract of `PcmPlayer`): **what has played is not played again; what was queued and
  not played plays on the new output; at most the one piece playing at the moment of the change is cut or played again
  from its own start.** A piece is one `write` of the speaker: a network chunk of a sentence, a fraction of a second.
  The speaker in JS writes nothing again and asks for no sentence again, so no sentence is said twice (goal 6.4).
- Web: on `devicechange` the port lists. If its `sinkId` is no longer listed (or the `default` entry's device changed
  while no sink is chosen), it decides `held` by VD-11. Held → `ctx.suspend()` (the clock stops, scheduled sources keep
  their places), then `setSinkId("")`. Not held → `setSinkId("")` on the running context. Then it emits `output-lost`.
  `resume()` → `ctx.resume()`. The player's context is the only one that plays speech and clips (VC-10), so one
  `setSinkId` moves everything.
- iOS: `oldDeviceUnavailable` whose previous route's output was private (VD-11) → `playerNode.pause()` at once, on the
  notification's own thread before anything else, then `output-lost` with `held: true`. **The module keeps a copy of
  every buffer scheduled and not yet completed** (`.dataPlayedBack`). When the engine has to be started again (the
  format changed), it schedules those copies again after the restart, in order, with their marks. Today it drops them
  and emits `drained`; that changes, and `drained` is emitted only when the queue really ran out. A public loss →
  `output-lost` with `held: false`, and the sound goes on (the system has already moved it).
- Android: `ACTION_AUDIO_BECOMING_NOISY`, or the device callback removing the output in use → if private by VD-11,
  `AudioTrack.pause()` (keeps the written data), then `output-lost` with `held: true`. `resume()` → `play()`. A public
  loss → the track follows default routing, or is made again on it with the unplayed queue written again, and
  `output-lost` goes out with `held: false`. In communication mode the chosen communication device is cleared
  (`clearCommunicationDevice`), and the platform has already dropped it on disconnect.
- The level, the marks and `drained` keep their meaning across the move, so the speech bar and the captions are not
  disturbed.

**VD-11. Private or public, and when the port holds.** `privacyOf` in `logic/devices.ts`:

- Native: the module answers `privacy` from the port type (platforms.md §3, §4). Android's `BECOMING_NOISY` counts as a
  private loss whatever the types say.
- Web and desktop: `privacyOfName(name)`, case-insensitive on words. Private: `headphone(s)`, `headset`, `earphone(s)`,
  `earbud(s)`, `buds`, `airpods`, `hands-free`, `handsfree`, `hearing`. Public: `speaker(s)`, `display`, `hdmi`,
  `displayport`, `tv`, `monitor`. Private words win when both match (e.g. "Headset Speaker"). No match → `unknown`. The
  list is a constant with its own tests, extended as the person reports names.
- **A port holds** when the lost output is `private` or `unknown`, **and** what the sound moves to is not known to be
  `private`. Moving from one pair of headphones to another (`now.privacy === "private"`) does not hold. The engine
  applies the same rule with `shouldPause` and resumes at once when the port held and the rule says no (a port that holds
  too often costs a few milliseconds of silence, never a sound out loud).

**VD-12. The pause** (goal 3.3 "private listening that would become public", 4.6; answers goal §8).

- **When:** an `output-lost` for which `shouldPause` is true, while a session that speaks is running: speech mode or the
  pill **in any phase** (listening too, because the next reply would be heard out loud), or Read aloud while a message
  is read. Dictation speaks nothing and never pauses. A preview or Test speaker that loses its output just stops (they
  are short, and replaying them is a tap).
- **What it does:** the player stays held (nothing comes out of the loudspeaker). The listening gate closes (no chunk
  goes up while paused; the socket stays, as with Mute). The turn machine's timer stops (a countdown is cancelled and its
  words kept, as Cancel does). The reply follower keeps taking the reply's text and the speaker keeps fetching (at most
  two sentences ahead, VC-12), into the held queue. So when the person goes on, nothing is missing and nothing is fetched
  twice.
- **State:** `SessionState.paused: { device: string } | null` (the lost device's name, "" when it had none), and
  `ReadingState.paused: boolean`. One new controller method, `voice.resume()`: `player.resume()`, `paused` cleared, the
  gate and the turn's timer back as the phase says. `voice.end()` and `voice.stopReading()` end a paused session as they
  end any session.
- **How it looks** (the app's components, no new pattern):
  - Speech bar: the status line shows the pause sentence (`speech-paused`, tone `warn`), and the foot shows **Continue**
    (`speech-continue`, the primary `Button`, where Send stands) beside Mute and End. The waveform is flat.
  - Pill: the orb takes a new state `paused` (`pill-orb` `dataSet.state="paused"`, a pause glyph, its tooltip and label
    "Continue"); a tap on the orb is Continue. The listening bar's words line shows the pause sentence and its foot shows
    **Continue** (`pill-continue`). Collapsed, the orb alone shows the paused state.
  - Read aloud: the message's reading chip (`voice-reading`) shows **Continue reading** (`voice-reading-continue`) beside
    **Stop reading**, and the composer's notice line (VD-14) shows the pause sentence.
- **There is no time limit on a pause.** It lasts until Continue, End or Stop reading, or until the session's chat
  leaves the screen, which ends it as today. The tap continues on the system's output **out loud, on purpose**: that is
  the person's decision (goal 3.3).
- A device that comes back during the pause or the session is not switched to (goal 3.3, §5). The next session uses it,
  because the saved choice was never erased.

---

## 7. Notices (goal 3.3, 4.5; answers goal §8)

**VD-13. One notice at a time, from the engine, with words from `words.ts`.** `noticeStore: VoiceNotice | null`
(`engine/state.ts`):

```ts
export type VoiceNotice = {
  text: string;
  /** Who shows it: the composer of this chat (dictation, speech mode, Read aloud of a message of the chat), or the board's pill. */
  where: { kind: "chat"; chat: string } | { kind: "board"; board: string } | { kind: "settings" };   // settings: the devices card of Settings > Voice (D16)
  at: number;                 // ports.now(), to replace an older one
};
```

The wording (a choice to confirm; a start differs from a loss in its verb). The name is in curly quotes and cut at 40
characters:

| When | Sentence |
|---|---|
| start, microphone missing | `“{mic}” isn't connected. Using the system microphone.` |
| start, speaker missing | `“{speaker}” isn't connected. Using the system speaker.` |
| start, both missing | `“{mic}” and “{speaker}” aren't connected. Using the system's own.` |
| microphone lost | `“{name}” was disconnected. Listening with the system microphone.` (no name known: `The microphone was disconnected. Listening with the system microphone.`) |
| speaker lost | `“{name}” was disconnected. Speaking through the system speaker.` (no name: `The speaker was disconnected. Speaking through the system speaker.`) |
| pause | `“{name}” was disconnected. Paused so nothing is played out loud.` (no name: `Your headphones were disconnected. Paused so nothing is played out loud.`) |

Rules: shown for `NOTICE_MS = 6000` ms (an overridable `waits.noticeMs`), or until the session or utterance ends,
whichever is first; never needs a tap; a newer notice replaces the older one; the pause sentence stays as long as the
pause (it is the pause's own line, not a notice that fades). A notice text is never logged and never put in a problem.

**VD-14. Where a notice shows, with existing components.**

- **A chat** (dictation, speech mode, Read aloud of a message of that chat): the composer's notice line, the place and
  look of `ModelNotice` (`Text` 11.5, tone `warn`, above the box; `composer/Notices.tsx`). It is drawn by a new composer
  part `VoiceNotice` (`setComposerPart("VoiceNotice", …)`, null by default, registered by the voice screens), testID
  `voice-notice`. In speech mode the speech bar stands where the box was, and the line stands above the bar in the same
  place. When the box is replaced by the archived bar, the line still stands above it.
- **A board** (the pill): a caption above the pill, the `Caption` look of `pill/Captions.tsx` (testID
  `caption-notice`), fading as captions do.
- A Read aloud of a chat that is not on screen (the person moved away) shows nothing. The sound goes on and the next
  look at that chat shows nothing old (the notice was tied to an utterance that has ended).

---

## 8. Test speaker and the level meter (goal 3.2; answers goal §8)

**VD-15. Test speaker plays a chime the app makes itself.** The app has no sound asset, and a voice preview needs the
service and a key, so the sound is generated: `logic/chime.ts` makes a 0.6 s two-note chime (660 Hz then 880 Hz, 24 kHz
s16le mono, 10 ms fades, peak −12 dBFS) as a `Uint8Array`. `voice.testSpeaker()` stops whatever plays (`stopAll`), calls
`player.useOutput(getSettings().speaker)`, writes the chime to the PCM player (the same path as speech, so the test
proves speech's output), and resolves when the player drains. No request is made and no key is needed: it works with no
key. Test speaker is shown on every platform with an audio module (where the speaker follows the system, it plays where
the system routes). testID `vs-speaker-test`.

**VD-16. Test microphone and the meter, in Settings only.** **Test microphone** (`vs-mic-test`, a toggle) starts the
port's microphone with `device: getSettings().mic`, `echoCancel: false`, `chunkMs: 100`, and an `onChunk` that keeps
**only the level**: no chunk goes anywhere, no socket opens, no key is needed. The meter (`vs-mic-level`) is the pill's
`Waveform` component fed by the level. It stops on a second tap, when Settings closes (unmount), when a voice session
starts, and when the microphone choice changes (it restarts on the new one). It is off while a voice session listens:
the control is disabled, with the tooltip "Voice is listening.". The first tap asks the microphone permission if it was
never asked (VD-7). A refusal shows the `mic_blocked` popover hung from the control, as Dictate does. Engine API:
`voice.startMicTest(anchor)`, `voice.stopMicTest()`, `useMicTest(): { on: boolean; level: number; busy: boolean }`. The first-use flow gets
neither control (goal §8: Settings only).

---

## 9. Settings > Voice (goal 3.1, 3.2, 3.4, 4.9)

**VD-17. One new card, "Microphone and speaker" (`vs-devices-section`), between "Voice" and "Speech mode sends my
turn"**, made of the existing parts of `SettingsParts.tsx` (`Section`, `Row`, `Picker`) and `Button`, at the same
spacing as the other cards. Its file is `app/src/screens/voice/DevicesSection.tsx`. Its data comes from one hook,
`useDeviceChoices()` (engine), which lists while the card is mounted and on `watch`, and answers the pure
`choicesFor(list, settings, ability)`:

```ts
export type DeviceOption = { key: string; label: string; device: SavedDevice | null; missing: boolean };
export type DeviceChoice =
  | { show: "pick"; options: DeviceOption[]; selected: string; hiddenNote: boolean }  // options[0] is System default
  | { show: "system"; line: string };                                                // "Follows the system: …"
export type DeviceChoices = { mic: DeviceChoice; speaker: DeviceChoice; linkedNote: boolean; neitherLine: string | null; loading: boolean };
```

- **Microphone** row: `Picker` `vs-mic` (options: "System default" first, labelled `System default (<name>)` where
  `defaults.input` is known; then every input; then, if the saved one is not listed, `<name> (not connected)` selected.
  So the saved choice still shows (goal 6.3)), then **Test microphone** and the meter.
- **Speaker** row: `Picker` `vs-speaker` (same rule) or, where the output follows the system, the line `vs-speaker-system`
  "Follows the system: headphones or a headset when connected, otherwise the speaker."; then **Test speaker**.
- The note under the card's title: on Android 12+ "A headset is used for both listening and speaking while you talk to
  a chat." (`linkedNote`); on the web build before the permission "Allow the microphone to see your other devices."
  (`hiddenNote`).
- Neither can be picked (a build without the module): the card holds the one line "Voice uses the system's microphone
  and speaker. Change them in the system's settings." and no control.
- Picking writes `setVoiceSettings({ mic })` / `({ speaker })` (null for System default). The pickers refresh
  without closing Settings when a device comes or goes (goal 3.2, 6.2).
- `VC.1`'s order of sections gains this card (its check is updated in the same package).

---

## 10. The native module (`app/modules/aiwb-audio`)

**VD-18. The contract gains (in `src/AiwbAudio.ts`, `src/fake.ts`, `README.md`):**

```ts
export type NativeDevice = { id: string; name: string; kind: "input" | "output"; privacy: "private" | "public" | "unknown"; builtIn: boolean };
export interface AiwbAudioNative {
  // … as today, and:
  /** Inputs (and outputs where outputAbility is "pick"), without pseudo-entries; never prompts; never interrupts another app's audio. */
  listDevices(): Promise<{ devices: NativeDevice[]; defaultInput: string | null; defaultOutput: string | null }>;
  /** "pick" or "system" for each kind, and whether a headset is linked (Android 12+). Synchronous, a constant of the build and OS version. */
  deviceAbility(): { input: "pick" | "system"; output: "pick" | "system"; linked: boolean };
  /** Names for the built-in devices the system names after the phone (Android); ignored where the system names them. */
  setBuiltInNames(names: { mic: string; speaker: string }): void;
  /** startMic now takes the id to prefer (null: the default). Answers what it opened. */
  startMic(chunkMs: number, echoCancel: boolean, inputId: string | null): Promise<{ echoCancel: boolean; device: NativeDevice | null }>;
  /** Where the player (and the clip) plays from now on; null: default. Answers what it got. */
  setOutput(outputId: string | null): Promise<{ device: NativeDevice | null }>;
  playerHold(): void;
  playerResume(): void;
}
export type AiwbAudioEvents = {
  // … as today (onInterrupted keeps "call" | "other"; "route" is no longer sent for a lost device), and:
  onDevices: (e: {}) => void;    // the list may have changed
  onRoute: (e: { kind: "input-lost" | "input-failed" | "output-lost"; lost: NativeDevice | null; now: NativeDevice | null; held: boolean }) => void;
};
```

The adapter (`platform/audio.native.ts`) lists, matches (VD-2) and passes the id. `startMic` and `setOutput` with an id
that has gone away use the default: the module answers the device it got, and the adapter compares to tell `missed`.

- **iOS (`VoiceAudio.swift`)**: `listDevices` = `availableInputs` (the category `.playAndRecord` set without
  activation; if the list is empty, a brief activation with `.mixWithOthers`, see platforms.md §3) plus the current
  route's output for `defaultOutput`. `deviceAbility` = `{input: "pick", output: "system", linked: false}`.
  `startMic(…, inputId)` → `setPreferredInput` after activation (and `setPreferredInput(nil)` for the default). Route
  changes → VD-9, VD-10, VD-11. The re-scheduling of unplayed buffers after a restart (VD-10). `setOutput` resolves the
  current route and changes nothing (output "system"). `onDevices` on `newDeviceAvailable` / `oldDeviceUnavailable`.
- **Android (`VoiceAudio.kt`, `MicCapture.kt`, `PcmPlayer.kt`)**: `deviceAbility` = API ≥ 31 → `{pick, pick, linked:
  true}`, else `{pick, system, false}`. `listDevices` from `getDevices` (inputs) and `getAvailableCommunicationDevices()`
  minus the earpiece (outputs, API 31+), grouped by VD-4's id. `startMic(…, inputId)` →
  `AudioRecord.setPreferredDevice`. In communication mode with a chosen speaker → `setCommunicationDevice(speaker)`
  instead of today's "speaker unless a headset" rule; with none chosen, today's rule stays. Playback-only →
  `AudioTrack.setPreferredDevice`. `AudioDeviceCallback` → `onDevices` and the losses. `BECOMING_NOISY` → a private
  output loss (held). Every communication device it set is cleared when listening ends (as today).
- Both keep today's rules: no prompt outside `requestMic`, the session given back when nothing runs, `shutdown` silent.

---

## 11. Stand-in devices (goal 4.11, 4.12, 6)

**VD-19. Four stand-ins, one per kind of test; none touches a real device's audio.**

1. **Unit tests: fake ports** (`app/test/fixtures/voice/fakeports.ts`). `createFakePorts` gains
   `devices: FakeDevices` with `inputs`, `outputs`, `ability`, `hidden`, `plug(d)`, `unplug(id, {held?})` (emits the
   right `RouteEvent` when the device was in use and a `watch` signal), `failReopen()`, and records `opened`
   (`startMic`'s device), `outputs` (`useOutput` calls), `holds`, `resumes` and `lists` (how many listings). Every engine
   test of §12.1 runs on it.
2. **The native module's fake** (`app/modules/aiwb-audio/src/fake.ts`): the same idea at the module's level (devices,
   `plug`, `unplug`, `route(…)`), for the adapter's tests.
3. **Browser checks: a stand-in `navigator.mediaDevices`** (`web/dev/checks/devices.mjs`, no dash so the runner does not
   take it for a check), installed with `page.addInitScript` before the app loads:
   - `enumerateDevices()` answers the stand-in list (each with an id, a label and a group). Until the stand-in's
     permission is "granted" it answers one blank entry per kind, as Chromium does (platforms.md §2).
   - `getUserMedia({audio})` honours `deviceId.exact` (`OverconstrainedError` for an unknown one) and answers a stream
     of an oscillator at **the device's own frequency** (e.g. 300 Hz and 700 Hz). Its track's `getSettings()` gives
     `deviceId` and `label`. Unplugging a device ends its live tracks (`ended`) and fires `devicechange`.
   - `AudioContext.prototype.setSinkId` is wrapped: it records each context's sink, rejects `NotFoundError` for an id
     not listed, and the context's `sinkId` reads back. An unplugged output fires `devicechange`. The context keeps
     "playing" (it is the real context underneath) and the record says the sink is gone.
   - Control, from the check: `window.__aiwbDevices = { list(), plug(d), unplug(id), grant(), opened(), sinks(), calls() }`
     (`calls`: how many `enumerateDevices` / `getUserMedia` calls, for VD-6).
   - It takes the place of `mic.mjs`'s synthetic microphone in the device check. The other VC checks keep `mic.mjs`.
   - **The stand-in voice service** (`web/dev/voicestandin.mjs`) adds `toneHz` to each STT session in its log (the
     frequency of the audio it received, by zero crossings). So a check proves that **the audio that reached the
     service came from the chosen microphone** (goal 6.1), not just that the page asked for it.
4. **Desktop e2e:** Electron with Chromium's own fake devices (`--use-fake-device-for-media-stream
   --use-fake-ui-for-media-stream` added to the launch: two inputs and two outputs, verified in platforms.md §1). The
   choice, its use (`getSettings().deviceId`, the context's `sinkId`) and its persistence over a restart are proved on
   Chromium's own fake devices. Unplugging is proved with the same `devices.mjs` layer added through the Electron
   context's `addInitScript` [not verified that `_electron`'s context takes init scripts; if it does not, the layer is
   evaluated and the page reloaded].
5. **Device flow (iOS simulator):** the simulator's real input and output (platforms.md §3). No stand-in can unplug
   there.

The test seam (`window.__aiwbVoice`, VC-32) gains `notice()` and, in `state()`, `session.paused` and `reading.paused`.

---

## 12. Tests, mapped to goal §6

All free: no test calls ElevenLabs or a paid model (4.12). Commands per `AGENTS.md`.

### 12.1 Unit tests (`npm test && npm run check` at the root)

| Test | Proves | Goal |
|---|---|---|
| `app/test/voice.devices.logic.test.ts` | `matchSaved` (id, name, same names, none), `privacyOfName` table, `shouldPause` matrix, `choicesFor` (System default first, pseudo-entries gone, missing saved shown, hidden note, linked note, "system" lines, neither), notice words (start/loss/both/no name, cut at 40), the chime's length, rate and peak | 3.1, 3.3, 3.4, 7.2, 7.5 |
| `app/test/voice.settings.test.ts` (added cases) | `mic`/`speaker` default null, clamp, a stored value without them | 4.10 |
| `app/test/voice.devices.engine.test.ts` | over fake devices: no listing and no notice with nothing saved; the saved mic and speaker used by dictation, speech mode, the pill, Read aloud, preview, Test speaker; a Settings change does not move a running session; missing at start → default + one notice, both → one notice; the choice not erased, and used again when back; default unavailable → `mic_blocked`; input-lost → notice, words kept, socket not reopened; input-failed → `mic_blocked` end; output-lost public → notice, no TTS request repeated, no sentence written twice; output-lost private (held) → paused, no write reaches an unheld player, gate closed, countdown cancelled, `resume()` plays on; private→private → no pause; a device back mid-session ignored; notice fades after `noticeMs` and is gone at session end; mic test keeps levels only, opens no socket, stops on session start; Test speaker makes no request | 6.1–6.4, 6.6 |
| `app/test/voice.audioweb.devices.test.ts` | `audio.web.ts` over a fake `navigator.mediaDevices` and a fake `AudioContext` (node): pseudo-entries filtered, `hidden` before the permission, `deviceId.exact` asked, `OverconstrainedError` → default + `missed`, `setSinkId` rejection → default + `missed`, `ended` → reopen on default + `input-lost`, reopen failure → `input-failed`, `devicechange` with the sink gone → hold by name + `setSinkId("")` + `output-lost`, `resume` → `ctx.resume()`, ability "system" without `AudioContext.setSinkId` | 3.4, 6.4, 7.3 |
| `app/test/aiwbaudio.test.ts` (added cases) | the adapter over the fake module: matching, `missed`, route events passed on, `hold`/`resume`; the new function and event names against the Swift and Kotlin sources | 6.5 |
| `web/dev/checks/devices.test.mjs` (`cd web && npm test`) | the stand-in `mediaDevices` layer's own rules (blank before the grant, exact ids, `ended` on unplug, sink records) | 4.11 |
| `web/dev/voicestandin.test.mjs` (added case) | `toneHz` of a 300 Hz and a 700 Hz stream | 6.1 |

### 12.2 Browser checks (`cd web && npm run uicheck -- VC`)

`VC.8-devices.mjs` (new), desktop, tablet and phone, on the mock with the stand-in voice service and `devices.mjs`
(two microphones "Desk Mic" 300 Hz and "Stand-in Headset" 700 Hz; outputs "Desk Speakers" (public) and "Stand-in
Headphones" (private)):

- **choosing (6.1):** both pickers list System default first then the two devices. Before the grant, System default alone
  with the note, and Test microphone grants and fills the lists. Picking is kept over a reload. The next dictation opens
  the chosen microphone (`opened()`), and the stand-in service's `toneHz` is that device's. The next Read aloud's context
  sink is the chosen speaker. Nothing chosen → the default for both, no notice, and no `enumerateDevices` call before
  Settings opened. The chosen names are in no request through the mock and no console line.
- **checking (6.2):** Test speaker: the player wrote the chime with the chosen sink and the stand-in service saw no
  request. Test microphone: the meter moves (`vs-mic-level` peak) and stops when Settings closes. Plug and unplug while
  Settings is open change the pickers.
- **missing at start (6.3):** the saved microphone unplugged → dictation starts on the default, `voice-notice` names it.
  Settings still shows it as "(not connected)". Plugged again → the next dictation uses it.
- **lost during a session (6.4):** speaker (public) unplugged while a reply is spoken → `setSinkId("")`, a notice, the
  stand-in's TTS log has no sentence twice and the player no mark twice. Microphone unplugged while listening → the
  default reopens, the words in the box stay, a notice. Headphones (private) unplugged while a reply is spoken → `paused`,
  no write after the hold until **Continue**, the speech bar's Continue, the pill's orb `paused`, Read aloud's Continue
  reading. A device plugged back mid-session → the sink is not moved. After each, a typed message still sends and a new
  session works.

`VC.1` is updated for the new card. The checks of the screens touched also run: `VC.1`–`VC.7`, `L16-composer` (the
notice line), `L15-fork` (the reading chip), `L24-boardui` (the pill).

### 12.3 End to end (free)

| Script | Adds | Goal |
|---|---|---|
| `web/e2e/voice.e2e.mjs` | a page that never used voice made no `enumerateDevices` call (with the `devices.mjs` layer counting); a run with stand-in devices named `CANARY-MIC-<random>` and `CANARY-OUT-<random>`, chosen and used: neither name in the host's traffic, the socket, the server's folders and log, the console | 6.1, 6.6 |
| `desktop/e2e/app.e2e.mjs` (devices part) | Electron with Chromium's fake devices: Settings lists "Fake Audio Input 1/2" and "Fake Audio Output 1/2"; a pick is kept after quitting and starting again on the same `AIWB_USER_DATA`; Read aloud's context `sinkId` is the chosen output's id; dictation's track `deviceId` is the chosen input's; with `devices.mjs`, the chosen output unplugged during Read aloud gives the notice (public) or the pause (private) | 6.1, 6.4, 6.5 |

### 12.4 Device flow (goal 6.5, 6.6)

`app/e2e/maestro/voice-devices.yaml` on **your own iOS simulator** (`node app/e2e/run.mjs voice-devices --platform ios
--device vd-<name>`), with the stand-in service as in `voice-mic`: Settings > Voice shows the Microphone picker with the
simulator's input(s) and the Speaker line "Follows the system…"; Test speaker plays (the dev line counts `drained`);
picking the input and starting the app again keeps it; Dictate opens it (the dev line gains `mic=builtIn` or
`mic=external`, never a name). Loss and pause on the phone are proved by the unit tests over the fake module, and by the person
with a wired or Bluetooth headset on a real iPhone, iPad and Android phone (in the final report). Android: `./gradlew
:aiwb-audio:compileDebugKotlin`, and the same flow on the emulator if its lock is free.

### 12.5 Nothing else moved (6.6)

`git diff voice-devices...HEAD -- cmd internal` is empty; `go test ./...` passes unchanged; the root, `web` and `desktop`
unit tests; `VC.1`–`VC.8`; `node web/e2e/voice.e2e.mjs`; `cd app && npm run build:web && cd ../desktop && npm run e2e`.

---

## 13. Answers to goal §8 (all `[proposed]`)

1. **Notice wording:** the table of VD-13. A start ("isn't connected") differs from a loss ("was disconnected").
2. **Test speaker and the level meter:** Settings > Voice only, not the first-use flow (VD-15, VD-16).
3. **The pause:** VD-12. A line plus Continue on the speech bar, a `paused` orb whose tap continues, and **it applies to
   Read aloud** (its reading chip gets Continue reading).
4. **A returning device:** not offered mid-session, and no tap to switch back. The next session uses it (goal 3.3). If
   the person wants such a tap, it is a later change to VD-12's UI and the engine's `resume` with a device.

## 14. Points for the person

1. Android's built-in devices are named by the app ("Phone microphone", "Phone speaker"), because the system names them
   after the phone's model (VD-5).
2. On iOS and iPadOS the speaker is not a choice: the system decides, and the app does not use the system's route picker,
   because it would change the route for the whole device (goal 4.4).
3. On Android 7–11 only the microphone is a choice. On Android 12+ a headset chosen for one is used for both while voice
   talks to a chat.
4. On the desktop, an output whose kind cannot be told from its name (e.g. "USB Audio Device") is treated as private when
   it is unplugged: voice pauses rather than play out loud (goal 7.5).
5. Test microphone asks for the microphone permission if it was never asked: it is the person's tap in Settings > Voice
   (goal 4.8).
6. Speech mode and the pill pause even while listening when headphones go, because the next reply would be heard out
   loud.
7. Two devices with the same name and neither with the saved id: the first is used, with no notice (VD-4).
