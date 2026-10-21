# Voice devices: where the work stands

## Where the work stands

- 2026-10-21, architecture (`vd-architecture`): `platforms.md` (what each platform allows, with spikes run on this
  machine), `architecture.md` (VD-1 to VD-19) and `packages.md` (D1 to D15 in five waves) are written. No feature code
  yet. Nothing under `cmd/` or `internal/` is touched.
- Spikes (in `spikes/`): Electron 44.4.5 / Chromium 152 can pick both the input and the output (`getUserMedia` with an
  exact `deviceId`, `AudioContext.setSinkId`), lists names without any permission, and keeps device ids from one run to
  the next on one profile. Chromium's fake devices give two inputs and two outputs in Electron and in Playwright's
  Chromium 153. Before the permission, a browser lists one blank entry per kind.
- 2026-10-21, built and merged into `voice-devices`: D1 (types, pure logic, words, settings, fakes, contract stubs), D2 (the
  engine), D3 and D3F (the web and desktop port; the fix that makes it learn its outputs when the first route listener
  subscribes), D4 (the native adapter), D5 (iOS), D6 (Android), D7 (the stand-in devices and `toneHz`), D8 (the Settings card),
  D9 and D9F (notices and the pause on the screens; the fix that a Space tap while paused continues), D10 (`VC.8`), D11 (the
  desktop e2e), D12 (the voice e2e's canaries), D13 (the iOS device flow `voice-devices`). Nothing under `cmd/` or `internal/`
  is touched. What each package built and where it deviated is in `notes.md`, `d5-ios.md` and `d6-android.md`.
- 2026-10-21, D13A (`vd-d13a-android`, merged): `voice-mic` and `voice-devices` **pass on the Android emulator** (`Medium_Phone_API_36.1`,
  Android 16, API 36, lock taken and released) with no change to the app: the flows got `when: platform:` branches for Android's own
  permission dialog ("While using the app" / "Don't allow"), the answer's "⋯" (92%,15%), and the Speaker picker with its linked note. On the
  emulator the built-in microphone runs through `AudioRecord` into the stand-in (16 kHz, 100 ms, real time), Read aloud plays through
  `PcmPlayer` to its end, both pickers list the built-ins, the picks are kept over a relaunch and Dictate opens the saved built-in input
  (`mic=builtIn`, no notice). The emulator has one microphone and one speaker: no preference over another device, no loss, no pause, no
  headset (`d13a-android.md`). Android 7–11 (the Speaker as a line) was not run (no such image).
- 2026-10-21, D14 (`vd-d14-docs`): the docs say what is now true: `docs/architecture.md` (the voice part: devices, the fallback,
  the notices, the pause, the platforms' limits, the stand-ins), `plans/voice-chats/architecture.md` (dated notes under VC-8 and
  VC-10), `AGENTS.md` (the voice row: `VC.1` to `VC.8`; the desktop e2e's devices part), `app/modules/aiwb-audio/README.md` (the
  contract and `onInterrupted`/`onRoute`), and this file. `web/dev/checks/README.md` already described `VC.1` and `VC.8`.
- 2026-10-21, D15 (`vd-d15-verify`): the integrated verification of `voice-devices` at `691dcd0` (every package merged) passed, except
  `L16` at tablet, which fails the same way on `main`. Its commands, the review against the goal's §3 and §4, and what is left are below.
- 2026-10-21, D16 (`vd-d16-fixes`): the three fixes of the integrated review (departures 2, 3 and 4 below, struck): Settings announces a fallback,
  one pause sentence for a session and Read aloud, no listing before a key is saved. `app/e2e/maestro/voice-devices.yaml` was brought in line in D17
  (`vd-d17-flowkey`), see "Left to the person".
- **Known, not ours:** `L16` fails at tablet (`tchip[data-kind="effort"]` never appears), on `main` too (D15 ran it there); the voice
  e2e's microphone probe can choose Chromium's fake device on this machine and hang (`AIWB_MIC=synthetic` avoids it; it did not hang in
  D15's run); in the iOS simulator of D5's session CoreAudio aborted when the Mac's microphone was opened (it did not recur in D13's or
  D15's).

## D15: the integrated verification

Run once on `vd-d15-verify` (= `voice-devices` at `691dcd0`), in this order, on 2026-10-21. Playwright 1.63.0 with Chromium 153 (the
folder's reference is 1.64.1 / 156; the two checks `web/dev/checks/README.md` names for older Chromium, L8 and L14, were not in this run).

| Command | Result |
|---|---|
| `git diff main...voice-devices -- cmd internal` | empty (0 bytes): the Go server is not touched (goal 4.1, 6.6) |
| `go test ./...` | pass, every package (16 s) |
| root `npm test && npm run check` | pass: app 1021 tests (1020 pass, 1 skipped, 0 fail), the other workspaces 62, 40, 79, 204, 1581, 50, all pass; every type check clean |
| `cd web && npm test` | pass, 99 of 99 |
| `cd desktop && npm test` | pass, 172 of 172 |
| `cd web && npm run uicheck -- VC L15 L16 L24` | 11 of 12: `VC.1`–`VC.8` (both `VC.5`), `L15`, `L24` pass at their viewports; `VC.8` ran all nine scenarios at desktop, tablet and phone. **`L16` fails at tablet** (`locator.tap: Timeout 30000ms exceeded`, waiting for `[data-testid="tchip"][data-kind="effort"]`, `L16-composer.mjs:358`). |
| the same `L16` on `main` (`a1e18d9`, a detached worktree made for it and removed after) | **fails the same way** (tablet, the same locator): not this work's |
| `cd web && npm run uicheck:electron -- VC.1 VC.5 VC.8` | 4 of 4 pass (Electron's Chromium 152) |
| `node web/e2e/voice.e2e.mjs` | pass, 60 checks (the device canaries `CANARY-MIC-…`/`CANARY-OUT-…` only in `localStorage` `aiwb.voice.settings`; the service heard the chosen microphone's tone, 520 Hz for 523; no request of the voice service for choosing, listing or testing) |
| `cd app && npm run build:web && cd ../desktop && npm run e2e` | pass, every step (the voice part and the devices part, Chromium's fake devices and the stand-in devices). The script finds Playwright only in `desktop/node_modules` or the npx cache; neither has it on this machine, so it ran with `PLAYWRIGHT=<worktree>/web/node_modules/playwright` (the lookup is as on `main`) |
| `node app/e2e/run.mjs voice-devices --platform ios --device <vd-d15> --build` (simulator `vd-d15`, iPhone 17, iOS 26.3) | **PASSED** (320 s): part 1 (the picker "System default (…)", the Speaker line, Test speaker `mic=none tested=≥1`, the pick kept over a relaunch) and part 2 (Dictate `mic=builtIn`, 97 chunks of 16 kHz / 100 ms to the stand-in in real time, Test microphone's meter). D13A's `when: platform: iOS` branches ran on iOS and passed |
| `node app/e2e/run.mjs voice-mic --platform ios --device <vd-d15>` | **PASSED** (123 s): the app's permission words and Allow, 90 chunks, Read aloud to its end (`tts: 6 chunks, read to its end`; the "⋯" tap needed its retry once, as the flow allows), the revoke, "can't hear you", Remove key. The microphone worked in this session (no CoreAudio abort) |

The simulator was deleted after the runs, and so were `app/ios` and its DerivedData.

### The goal's §3 and §4 against the code and the tests

A read of the integrated code (`app/src/voice`, `app/src/screens/voice`, `app/modules/aiwb-audio`), not a rewrite. "Holds" names where;
"left to the person" is what only a real device shows.

| Goal | Verdict |
|---|---|
| 3.1 two choices, System default first, the system's names | holds: `DevicesSection.tsx` over `choicesFor` (`logic/devices.ts`); `VC.1`, `VC.8 choose`, the desktop e2e |
| 3.1 nothing changes for a person who never chooses | holds for the start: no `useOutput` call (`outputWanted`), no listing outside a session or Settings, no notice at a start (`VC.8 nothing`, voice e2e). See departure 1 for a device lost mid-session |
| 3.1 every way of using voice | holds: `startMic` gets `settings.mic` (listener, mic test); `applyOutput` in the session start, Read aloud (`onOutput`), `playClipOnce` (preview) and `playPcmOnce` (Test speaker) |
| 3.1 a running session keeps its device | holds: the session reads the settings once at its start; engine tests |
| 3.1 kept on the device, never sent | holds: `aiwb.voice.settings` only; the voice e2e's canaries and the desktop e2e |
| 3.2 Test speaker, no request; the meter only after a tap, only in Settings; the lists refresh | holds: `testSpeaker` (a chime made in code), `startMicTest` keeps the level only and ends when Settings closes; `watchDevices` on mount and on `watch`; `VC.8 choose`, voice e2e "no request of the voice service" |
| 3.3 missing at the start: the default and one notice naming it; the choice not erased | holds: `matchSaved` in the adapters, `announceStart` (one notice, both in one); nothing but `DevicesSection` writes `mic`/`speaker`; `VC.8 missing`. Preview and Test speaker: see departure 2 |
| 3.3 speaker lost: on at once, a notice, nothing again | holds on the web and desktop (`VC.8 speaker`, the desktop e2e: no sentence twice); native by the fake module's tests; left to the person on a phone |
| 3.3 microphone lost: on from the default, words kept, a notice; else today's end | holds (`VC.8 mic` ×2, engine tests: `input-failed` → `mic_blocked`); left to the person on a phone |
| 3.3 private would become public: pause, reason, tap to go on | holds (`VC.8 pause`, `pill`, the desktop e2e's headphones step; iOS pauses the node on the notification's own thread, Android on `BECOMING_NOISY`); left to the person: no sound out of a phone's loudspeaker before the hold |
| 3.3 a device back mid-session is not switched to | holds (`VC.8`, engine tests) |
| 3.3 a notice never blocks, needs no tap, ends with the session | holds: `NOTICE_MS`, `endNotice` in `leave()`; the pause's line stays only as long as the pause |
| 3.4 no control that does nothing | holds: `deviceAbility`/`webAbility` → a picker or the "Follows the system" line; iOS Speaker line (D13, D15), Android 12+ both pickers (D13A); Android 7–11, Safari/Firefox and "neither" by the unit tests only |
| 3.5 the rest of voice the same; no listening before a tap; speech mode stops listening while the reply is spoken | holds: the unit tests and `VC.1`–`VC.7` pass unchanged in what they test; the gate also closes while paused |
| 3.5 / 6.6 no new notice, prompt or request for a person who never opens the choices | holds for prompts and requests (voice e2e: no `/voice` request, no `getUserMedia`, no `enumerateDevices` call on a page that never used voice). Notices: departure 1. A listing happens once at the start of each session (choice 25) and while Settings > Voice is open, key or not (VD-6 a): no prompt, no request |
| 4.1 client only | holds: the diff under `cmd/` and `internal/` is empty |
| 4.2 the default is the fallback, no second choice | holds: `matchSaved` is id, then the same name, then the default |
| 4.3 a saved choice is never erased | holds: only the pickers write `mic`/`speaker`; `clampSettings` keeps a well-formed value |
| 4.4 the system's settings never changed | holds by the code: iOS sets `setPreferredInput(nil)` when it gives the session back (`deactivateIfIdle`), puts the category back after a listing, never uses the route picker; Android clears the communication device, turns the speakerphone flag and SCO off and the mode back to normal in `settle()`/`stopAll()` after every listening (dictation's Bluetooth link included), and its track and record preferences are the app's own; the web uses the page's own `setSinkId`. **Left to the person**: that another app's call audio is normal after a session on a real Android phone and iPhone |
| 4.5 small honest notices in the existing place | holds: `voice-notice` in the `ModelNotice` look, `caption-notice` on the board; words in `words.ts`. Departure 2 (preview, Test speaker) and choice 19 (Android preference not honoured) |
| 4.6 private audio not public without the person | holds as 3.3 above; an output whose kind is unknown pauses (choice 11) |
| 4.7 nothing sent because of a device; names never logged | holds: the native traces name port types and flags only (`trace`, `Log.d`); the web port writes no `console.*` with a name; the voice e2e found the canary names in no request, answer, socket, console, voice-service log, server folder or log, host state or agent input |
| 4.8 permissions no earlier | holds: listing asks nothing (iOS activates to list only once the microphone is allowed; Android `getDevices`; the web `enumerateDevices`); the web build before the permission shows System default and the note; Test microphone asks only on its tap |
| 4.9 existing components | holds: `Section`, `Row`, `Picker`, `Button`, the pill's `Waveform`, `ModelNotice`'s look, `Caption`. Android's names of nameless devices are English in Kotlin, outside `words.ts` (choice 16) |
| 4.10 one setting, every place | holds: `settingsStore` |
| 4.11 the engine knows no platform | holds: `engine/*.ts` imports `ports.ts` and `logic/*` only; every engine test runs on `FakeDevices` |
| 4.12 nothing paid | holds: every run above used the stand-in voice service; no paid test was run |

### Departures from the goal (for the person)

1. **A device lost mid-session also counts when the person never chose one** (goal 3.3 against 3.5): headphones or a default device
   that goes away during a session give the notice or the pause to a person who never opened the choices, where before the session ended
   (`onInterrupted("route")`) or the sound moved on silently. It is what 3.3 and 4.6 ask; it is a new line for that person.
2. ~~**Preview and Test speaker announce no missing saved speaker** (choice 24)…~~ **Fixed in D16:** a preview, Test speaker and Test
   microphone that fall back to the system default say so in the devices card (`vs-devices-notice`, the start sentence naming the device,
   the usual timer, gone when Settings closes); `useVoiceNotice({ kind: "settings" })`, `SettingsNotice`; engine test and `VC.8 settingsnotice`.
3. ~~**Read aloud's pause sentence says "the reply"**~~ **Fixed in D16:** one sentence for a session and for Read aloud: "“X” was
   disconnected. Paused so nothing is played out loud." (`words.ts`, tests, `VC.8`, the desktop e2e, the docs).
4. ~~**Settings > Voice lists the devices whenever it is open**, also before a key is saved (VD-6 a)~~ **Fixed in D16:** with no key saved the
   devices card shows its title and "Add your key to choose a microphone and a speaker." (`vs-devices-nokey`, as the voices' section shows
   "Add your key to choose a voice.") and does not mount `useDeviceChoices`: no `enumerateDevices`, no native listing. `VC.1`, `VC.8 nokey`.

### Left to the person

- ~~**The device flow `voice-devices.yaml` needs one edit, then one run**~~ **Done in D17** (`vd-d17-flowkey`, 2026-10-21): Part 1 now asserts `vs-devices-nokey`
  with no key (and that none of `vs-mic`, `vs-speaker`, `vs-speaker-system`, `vs-mic-test`, `vs-speaker-test`, the note and the "neither" line is there, and no
  microphone alert), then types, tests and saves the stand-in's key (`vs-key`, `vs-key-save`), puts the keyboard away (the keyboard's own Done key: iOS by id
  `Done`, Android by its text; Maestro's `hideKeyboard` finds no way, and on iOS the keyboard covered the card), and asserts the card as before; the later
  key step is gone (the key is already saved) and the flow ends with the key removed and `vs-devices-nokey` back. Results: `voice-devices` **PASSED on iOS**
  (iPhone 17 simulator, iOS 26.3; 195 s and again 276 s with `--build`; 98 chunks of 16 kHz / 100 ms to the stand-in), **PASSED on Android** (Medium_Phone_API_36.1,
  API 36; 205 s; 123 chunks), and `voice-mic` **PASSED on both** (iOS 121 s; Android 163 s). No change to the app. Logs: `/tmp/vd-d17-ios-devices{,2,3,4}.log`
  (the first two failed, at the covered card and at `hideKeyboard`), `/tmp/vd-d17-ios-mic.log`, `/tmp/vd-d17-android-devices{,2}.log` (the first failed at the
  iOS-only `Done`), `/tmp/vd-d17-android-mic.log`.
- **iPhone and iPad, real devices**: a wired and a Bluetooth headset listed (which listing step answers, `d5-ios.md` §1), chosen and used by
  Dictate and speech mode (`setPreferredInput` with HFP and a wired mic); headphones pulled while a reply is spoken: no sound from the
  loudspeaker before the hold, Continue plays on; a Bluetooth headset off while listening (`input-lost`, chunks go on); a format change
  (A2DP to HFP, a USB interface) with the queue played again and no sentence twice; whether `uid`s survive a reconnect; the preferred input
  given back after a session (`d5-ios.md` §5).
- **Android phone, Android 12+ and 7–11**: wired, Bluetooth (HFP + A2DP) and USB headsets; the lists (one entry per headset, the built-ins'
  names, Bluetooth names and ids over a reconnect); the built-in microphone chosen with a wired headset connected; a Bluetooth microphone's
  call link; Read aloud on a chosen A2DP speaker; the pause when a wired headset is unplugged or Bluetooth goes off, and Continue; a USB
  headset's microphone pulled while dictating; the communication device and the mode given back (another app's call audio is normal
  after); Android 7–11 showing the Speaker as a line (`d6-android.md` §5, `d13a-android.md`).
- **Desktops with real devices** on macOS, Windows and Linux: the names Electron lists (and the "Default - …" entry), a USB or Bluetooth
  headset chosen, unplugged during a reply (the pause, choice 11) and during listening, the ids kept over a restart and a reconnect, echo
  with a separate microphone and speaker (goal 7.6).

## Choices to confirm

Decisions taken where the goal leaves room (its §8 and the platforms' limits). Each one names where it is decided.

1. **Notice wording** (VD-13): a missing device at the start says "“X” isn't connected. Using the system
   microphone/speaker."; a device lost during a session says "“X” was disconnected. Listening with the system
   microphone." / "Speaking through the system speaker."; both missing at one start make one notice.
2. **The pause** (VD-12): a line and **Continue** on the speech bar; a `paused` orb on the board whose tap continues;
   **Read aloud pauses too** (its reading chip gets "Continue reading"). The pause sentence: "“X” was disconnected.
   Paused so nothing is played out loud." (the same for a session and for Read aloud, D16). No time limit.
3. **Speech mode and the pill pause even while listening** when headphones go, because the next reply would be heard
   out loud (VD-12). Dictation never pauses (it speaks nothing).
4. **Test speaker plays a chime the app makes in code** (0.6 s, two notes), since the app has no sound of its own and a
   voice preview needs the service (VD-15).
5. **Test microphone and the meter are in Settings > Voice only**, not in a first-use flow (VD-16).
6. **Test microphone asks for the microphone permission** if it was never asked: it is the person's tap (VD-7, VD-16).
7. **A returning device is not offered mid-session**, and there is no "switch back" tap (goal 3.3's default kept).
8. **iOS and iPadOS: the speaker is not a choice.** The Speaker row says "Follows the system: headphones or a headset
   when connected, otherwise the speaker." The system's route picker is not used, because it changes the route for the
   whole device (goal 4.4) (platforms.md §3).
9. **Android 7–11: microphone only. Android 12+: both**, with the note "A headset is used for both listening and
   speaking while you talk to a chat." (platforms.md §4).
10. **Android's built-in devices are named by the app** ("Phone microphone", "Phone speaker"): the system names them all
    after the phone's model (VD-5).
11. **On the desktop, an output whose kind cannot be told from its name counts as private when it is lost**: voice
    pauses rather than play out loud (VD-11, goal 7.5). E.g. "USB Audio Device" unplugged during a reply pauses.
12. **Two devices with the same name and neither with the saved id: the first is used, with no notice** (VD-4).
13. **The saved choice is never rewritten by the app**, not even to refresh an id found again by name (VD-3).
14. **The card "Microphone and speaker" stands between "Voice" and "Speech mode sends my turn"** in Settings > Voice
    (VD-17).
15. **iOS keeps its audio session options as today** (no high-quality Bluetooth output while the built-in microphone is
    chosen); Bluetooth quality is not handled (goal 7.4).

Added from the reports of the packages (16 to 19 are D6's, the others D1 to D9's; each names its package):

16. **Android names a device with no name of its own by its kind, in Kotlin**: "Wired headset", "Wired headphones", "Bluetooth
    headset", "Bluetooth speaker", "USB audio", "HDMI", "Hearing aid", "Audio device". English words outside `words.ts`
    (`setBuiltInNames` carries only the two built-ins); moving them needs a change of the contract (D6).
17. **Android's built-in devices are one entry per kind** (`builtin:mic`, `builtin:speaker`), not one per address: a phone may report
    two or three built-in microphones ("bottom", "back"), which would be several "Phone microphone" entries (D6, VD-4's letter).
18. **Android, communication mode: a chosen headset microphone wins over a chosen non-headset speaker** (a Bluetooth microphone has no
    call link otherwise); `setOutput` still answers the chosen speaker, so no "not connected" notice (D6).
19. **If an Android phone does not honour the preferred microphone, the person gets the start notice** ("… isn't connected. Using the
    system microphone."), whose words are not exact for that case; the fallback is announced (D6).
20. **Name lengths:** 40 characters in a notice, 60 in a picker's label; the name is cut with "…" only where shown, never where it is
    matched (VD-5, VD-13, `cutName`).
21. **The wording of the lines Settings shows where the system decides:** the microphone "Follows the system: the microphone the
    system uses." (`MIC_FOLLOWS`, for a platform that cannot pick it) and the speaker (`SPEAKER_FOLLOWS`, item 8); and the label of
    the first option, "System default (<device>)" where the system says which device that is (D1, D8).
22. **Space while the pill is paused: a tap continues, a hold does nothing** (a hold in `speaking` used to interrupt) (D9F).
23. **The pause is also a sticky line in Read aloud's composer notice and a "Continue reading" on the message** (item 2), and a pause
    cancels a countdown into `waiting`; `voice.send()` does nothing while paused (D9).
24. **Preview, Test speaker and Test microphone announce a missing saved device in the devices card** (D16; before, only the picker's
    "(not connected)" showed). The sentence is the start sentence, in a notice whose place is `{ kind: "settings" }` (`vs-devices-notice`); it
    stays after the short sound ends, on the usual 6 s, and goes when Settings closes.
24a. **With no key saved the devices card lists nothing** (D16): it shows "Add your key to choose a microphone and a speaker." and no
    picker or test, the way the voices' section shows its no-key line; Test microphone and Test speaker are offered once a key is saved.
25. **Every session lists the devices once at its start**: the web port lists when the first route listener subscribes (Dictation
    included), and a start with a saved choice lists to match it. A person who never chose anything and never opens Settings has no
    listing outside a session (D3, D3F; `VC.8` and the voice e2e count only calls outside a session).
26. **The web build before the microphone is allowed** (the tests' build only; the desktop window lists names at once): Dictate with a
    saved microphone opens the default first and then lists again; a saved speaker answers "missing" because Chromium rejects every
    sink id before the permission, so the start notice shows (D3).
27. **A device that disappears while following the system default also counts** on the web: a `default` entry that moves to another
    device while the old one is still listed is a loss (D3F).
28. **Test microphone stays disabled while any voice session exists**, not only while one listens (D8's `busy`).
