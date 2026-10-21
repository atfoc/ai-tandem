# Goal: choose the microphone and the speaker that voice uses, and keep working when one goes away

This document defines an outcome: what voice does about audio devices in AI Whiteboard once the work is done. It says what
exists at the end, the decisions already made, the bounds the work must stay inside, and how to confirm that it is done. It
is not an implementation plan and not an order of work. It names no files and no functions; how to build it is for whoever
builds it. It builds on `voice-chats-goal.md`: everything that goal says about voice stays true unless this document says
otherwise.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it (it was said or drawn on the board "whiteboard" of the chat that started this work).
- `[standing]`: decided before this goal and kept; it is in the architecture document, in `voice-chats-goal.md` or in the code.
- `[proposed]`: proposed while this goal was written. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Input device**: a microphone the person can speak into: the computer's own, a headset's, a USB or a Bluetooth one.
- **Output device**: where sound comes out: the built-in speaker, headphones, a headset, a USB or a Bluetooth speaker.
- **System default**: the device the operating system itself would use for input or output right now, whichever it is.
- **Saved choice**: the device the person picked in Settings > Voice. It is kept until the person changes it.
- **Session**: one run of Dictation, Speech mode, the voice pill or Read aloud, from its start to its end.
- **Voice**, **Dictation**, **Speech mode**, **Read aloud**, **Voice pill**, **Speech bar**, **Orb**: as in `voice-chats-goal.md`.

## 2. Goal

Today voice uses whatever microphone and speaker the system has as its default, and if that device goes away the session
ends. At the end the person can say which microphone voice listens to and which speaker voice speaks through, and if
the device they chose is missing or disappears, voice carries on with the system default and says so. `[user]`

## 3. What exists when it is done

### 3.1 Choosing the devices

- Settings > Voice has two choices: **Microphone** and **Speaker**. `[user]`
- Each lists **System default** first, then every device of that kind the system reports, by the name the system gives it.
  `[proposed]`
- **System default** is what a person who never opens these choices has. Nothing changes for them. `[proposed]`
- The choice applies to every way of using voice: Dictation, Speech mode, the voice pill, Read aloud, the preview of a
  voice and the test of the speaker. A person does not pick a device separately for each. `[proposed]`
- A choice made in Settings is used by the next session. A session that is running keeps the device it started with, except
  as 3.3 says. `[proposed]`
- The choice is kept on the device it was made on, with the other voice settings. It is never sent to the aiwb server and
  never shared with another device: a headset's name on one computer means nothing on another. `[proposed]`

### 3.2 Checking that a choice works

- **Speaker**: a **Test speaker** control plays a short sound through the chosen device. It costs nothing: it is a sound
  the app already has, not a request to the voice service. `[proposed]`
- **Microphone**: a live level meter shows that the chosen microphone hears something, while Settings > Voice is open and
  the person has asked for it (a tap on a control), and never otherwise. The audio is shown as a level and is not sent
  anywhere. `[proposed]`
- The lists refresh when a device is plugged in or removed while Settings is open, and each time Settings is opened.
  `[proposed]`

### 3.3 When a chosen device is not there

At the start of a session:

- If the saved choice is not among the devices the system reports, voice uses the **System default** for that kind and
  shows one short notice that it did, naming the device that was missing. `[user]`
- The saved choice is **not** erased. When that device is back, the next session uses it again. `[user]`

During a session, a device that disappears:

- **The speaker**: sound moves to the system default at once and the session goes on. A short notice says so. Sound that was
  already played is not played again. `[user]`
- **The microphone**: listening moves to the system default and the session goes on. A short notice says so. Words already
  heard are kept. If listening cannot be started again, the session ends the way it ends today when the microphone is
  unavailable. `[user]`
- **Private listening that would become public**: when the sound was going to headphones or a headset and they are removed,
  the system default may be the loudspeaker. Voice does not start speaking out loud by itself: it pauses the session, says
  why, and goes on only when the person taps to continue. `[proposed]`
- A device that comes back during a session is not switched to mid-session; the next session uses it (3.3 above). `[proposed]`
- A notice never blocks the person, never needs a tap to dismiss, and does not stay on screen after the session ends.
  `[proposed]`

### 3.4 Where a platform does not allow it

The platforms differ in what an app may choose. Where a platform does not let an app pick, the control is not shown as if
it worked: it is either left out or says what the system decides. `[user]`

- Where the app can pick both kinds, both choices are shown.
- Where it can pick only the microphone, only that choice is shown, and the speaker follows the system (headphones or a
  headset when connected, the speaker otherwise).
- Where it can pick neither, Settings says that voice uses what the system uses, and where to change it.

What each platform allows is established when the work starts (7.1); this document does not assume it.

### 3.5 What is the same as before

- The key, the voice, the models, Auto-send and every other voice setting. `[standing]`
- A person who never opens the two choices sees no new notice, no new permission prompt and no new request. `[standing]`
- The sentence "The app can't hear you" and the other voice problems of `voice-chats-goal.md` 3.8 and what they offer.
  `[standing]`
- Voice does not listen in the background and does not listen before a tap. `[standing]`
- The speech mode behaviour of stopping to listen while the reply is spoken. `[standing]`

## 4. Decisions and bounds

**4.1 Client only. The Go server is not touched.** `[user]` No server code, no new server call, no new file format.

**4.2 The system default is the fallback, always.** `[user]` There is no second-choice list and no "next best device".
When a chosen device is not available, the answer is the system default; if that has no device, the session ends with the
problem it ends with today.

**4.3 A saved choice is never erased because a device was missing.** `[user]` It changes only when the person changes it.

**4.4 Voice never changes the system's own settings.** `[proposed]` Choosing a device in voice does not change the
computer's or phone's default input or output, and ending voice leaves the system as it was. Other apps are not affected.

**4.5 The notices are small and honest.** `[proposed]` One sentence, plain, naming the device. They use the same look and
place as the other voice notices, not a new pattern. A fallback that is not announced is a defect.

**4.6 Private audio does not turn public without the person.** `[proposed]` This is the one case where voice stops instead
of continuing (3.3). It follows what the app already does when headphones are removed.

**4.7 Nothing is sent to the voice service because of a device.** `[proposed]` Choosing, listing, testing and the level
meter make no request to the voice service. Device names are not sent anywhere, and are not written to the log.

**4.8 Permissions are asked as late as before.** `[standing]` Device names the system hides until the microphone is
allowed are shown only after it is. An app with voice never switched on asks for no microphone permission. Before the
permission, the list shows System default only, and says why the rest is missing.

**4.9 Existing components are used, not copied.** `[standing]` The new choices are made with the same components,
spacing and states as the existing Settings > Voice choices, in the same section, and follow the app's look on every
platform. The notices use the existing notice component. Any behaviour that is the same on every platform is written
once; only what the platforms really differ in is written per platform.

**4.10 One setting is read by every place that shows it.** `[standing]` The same rule as `voice-chats-goal.md` 4.6.

**4.11 The engine does not learn about platforms.** `[proposed]` The voice engine asks for devices, a choice and a
notification of change in terms that are the same on every platform; the platform's own audio code answers. A test of
the engine runs with stand-in devices and needs no real audio.

**4.12 Nothing is paid for by the tests.** `[standing]` No test, check or script of this work calls the real voice service
or any paid model. Devices in tests are stand-ins.

## 5. Out of scope

- Choosing a device per chat, per board or per kind of use (Dictation against Speech mode). `[proposed]`
- Switching back to a returning device during a session. `[proposed]`
- Listing, naming, renaming or hiding devices beyond what the system reports. `[proposed]`
- Any control of volume, gain, noise suppression or echo cancellation. `[proposed]`
- Changing the system's default device (4.4). `[proposed]`
- Voice in the background, or voice on a server. `[standing]`
- Devices for anything but voice: the board and the rest of the app play no sound. `[proposed]`

## 6. How it is confirmed

Each statement below is confirmed by running it, on stand-in devices where the platform lets a test add and remove them,
and on a real device by the person where it does not.

### 6.1 Choosing

- With two stand-in microphones and two stand-in speakers, each listed with System default first; choosing one is kept
  after a restart of the app and is used by the next Dictation, Speech mode and Read aloud, and by the voice pill.
- The audio that reaches the engine comes from the chosen microphone and not the other; the sound goes out of the chosen
  speaker and not the other.
- A person who never opened the choices gets the system default for both, with no notice.
- The choice is not in any request to the aiwb server or to the voice service, and not in the log.

### 6.2 Checking

- Test speaker plays through the chosen speaker and makes no request to the voice service.
- The level meter moves with the chosen microphone, stops when Settings is left, and is not running before the tap.
- Adding or removing a device while Settings is open changes the lists without reopening it.

### 6.3 Missing at the start

- With the saved microphone or speaker removed, a session starts on the system default and shows one notice that names
  the missing device; the saved choice still shows in Settings, and when the device is back the next session uses it.
- With the saved choice missing and the system default also unavailable, the session ends the way it does today.

### 6.4 Lost during a session

- Speaker removed while a reply is spoken: the sound goes on from the system default, once, with a notice, and no sentence
  is spoken twice.
- Microphone removed while listening: listening goes on from the system default, words already heard are still there,
  and a notice is shown. If it cannot be restarted, the session ends with today's microphone problem.
- Headphones removed while a reply is spoken: the session pauses with a reason; no sound comes from the loudspeaker until
  the person taps to continue.
- A removed device that comes back mid-session does not move the sound; the next session uses it.
- In each case the chat still sends text, and the next session works.

### 6.5 Platforms

- The choices shown on each platform match what that platform allows (3.4): no control that does nothing.
- Confirmed on the desktop window and, for the screens and the fallback logic, the web build, at the viewports the
  Settings page is used at; on the iPhone and iPad layout and the Android layout, on a simulator or emulator where it can
  show devices and by the person on a real device (headset, Bluetooth) where it cannot.

### 6.6 Nothing else moved

- The Go tests are untouched in what they test, and nothing in the Go server changed.
- An app with voice never switched on makes no request to the voice service, asks for no microphone permission and lists
  no devices.
- The tests of the repository that `AGENTS.md` names for the packages changed run and pass: from the root
  `npm test && npm run check`, `cd web && npm test`, `cd desktop && npm test`, the browser checks that touch the screens
  changed (`VC` and the ones for Settings), and the voice checks of `AGENTS.md`. The device test runs once, on a
  simulator you name, only because the native side changed.
- The docs of voice (`docs/architecture.md` and the voice plans) say what is now true: devices, the fallback, and the
  platforms' limits.

## 7. Risks

**7.1 What each platform lets an app choose.** `[not verified]` Browsers and the desktop window may let the page pick both
kinds, but not every browser can pick an output. A phone's audio session may let an app pick an input and not an output.
Android differs by version. Which choices exist on which platform, and under which conditions, is to be established first
and written down; 3.4 follows it.

**7.2 Device names and identity.** `[not verified]` A device's identifier may change between runs, after a reconnect,
after the person clears the app's data, or may be hidden until the microphone is allowed. A saved choice may need the
device's name as well as its identifier to be found again. Two devices with the same name may exist.

**7.3 Changing a device in the middle of a stream.** `[not verified]` Moving listening or speaking to another device while
a socket is open and audio is queued may drop or repeat a moment of audio. The aim is no repeated sentence and no lost
words (3.3); how close the platforms let us get is not known.

**7.4 Bluetooth headsets and quality.** `[not verified]` A Bluetooth headset used as a microphone may switch to a narrower
audio mode and change how the speaker sounds, and the system may do that without telling the app. Whether the app can
notice and say it is not known.

**7.5 What counts as private.** `[not verified]` Telling "headphones were removed" from "the speaker went away" depends on
what the platform reports. Where it cannot tell, the safe reading is the pause of 3.3, not the continuation.

**7.6 Echo.** `[not verified]` A chosen microphone and speaker that are not the same hardware may echo differently from
the built-in pair. Speech mode already stops listening while the reply is spoken (3.5), which is what keeps this from being
a problem; if that changes, this does too.

## 8. Not decided yet

- **The exact wording of the notices** and whether a notice for a missing device at the start differs from one for a
  device lost during a session.
- **Whether Test speaker and the level meter belong in Settings > Voice only, or also in the first-use flow** when a person
  turns on voice.
- **What the pause of 3.3 looks like** on the Speech bar and on the orb, and whether it also applies to Read aloud, which
  has no bar.
- **Whether a returning device is offered mid-session** (it is not, 3.3) or only used by the next session; the user may
  want a tap that switches back.
