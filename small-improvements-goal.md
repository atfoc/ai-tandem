# Goal: small improvements to voice settings and subagent settings

This document defines an outcome: how three settings of AI Whiteboard are chosen once the work is done. It says what
exists at the end, the decisions already made, the bounds the work must stay inside, and how to confirm that it is done. It
is not an implementation plan and not an order of work. It names no files and no functions; how to build it is for whoever
builds it. It builds on `voice-chats-goal.md` and `voice-devices-goal.md`: everything those goals say about voice stays true
unless this document says otherwise. It changes what they say about the playback speed and the pause length, and nothing else.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it (it was said in the chat that started this work).
- `[standing]`: decided before this goal and kept; it is in the architecture document, in an earlier goal or in the code.
- `[proposed]`: proposed while this goal was written. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Playback speed**: how fast the voice speaks what it reads or answers aloud (Read aloud, Speech mode, the voice pill, the
  preview of a voice).
- **Delay before send**: the silence after the last spoken words after which Auto-send sends the turn. Until now called the
  pause length or the pause before auto-send.
- **Max chats**: the most subagents of one chat that may run at the same time. Until now called the cap, "Running at once".
- **Depth**: how many levels of subagents a chat's agent may start. Off, 1, 2 or 3 levels. It is not changed by this goal.
- **Slider**: a control with a track and a handle that the person drags (or moves with the keyboard) to pick a number
  between two ends.
- **Picker**: the existing control that shows the current value and opens a list to choose from.

## 2. Goal

Three settings are awkward to set today. The playback speed offers only 0.8× to 1.2×, which is too narrow to be useful for
someone who wants to skim a long answer or to follow a hard one slowly. The delay before send can only be one of eleven
values from 0.6 s to 3 s, which is too coarse and too short at both ends. The max chats of a chat can only be one of five
values, though the server accepts any whole number from 1 to 100. At the end:

- the playback speed is chosen from 0.5×, 1×, 1.5× and 2×, `[user]`
- the delay before send is chosen by dragging a slider, from 0.1 s to 10 s in fine steps, `[user]`
- the max chats of a chat is chosen by dragging a slider, to any whole number from 1 to 100. `[user]`

## 3. What exists when it is done

### 3.1 Playback speed

- Settings > Voice > Advanced options keeps its Playback speed choice as a picker, and the picker lists exactly four
  values: **0.5×, 1×, 1.5×, 2×**. `[user]`
- 1× is the default and what a person who never opens the choice has. At 1× the audio is exactly what the voice service
  returned, untouched. `[proposed]`
- The speed applies to everything voice speaks: replies in Speech mode and the voice pill, Read aloud, and the preview of a
  voice. There is one speed, not one per way of using voice. `[proposed]`
- **The voice keeps its pitch.** At 2× the voice speaks twice as fast and is still the same voice at the same pitch, not a
  higher one; at 0.5× it is slower and not deeper. Speech stays understandable at both ends. `[proposed]`
- The speed is the same on every platform the app runs on (iOS, iPadOS, Android, the web build and the desktop window): the
  same sentence takes the same time, and sounds the same, on each. `[proposed]`
- A sentence that Read aloud or the Speech bar shows as the one being spoken is the one being heard, at every speed. What
  follows the audio (the highlighted sentence, the level, the moment a reply is "done") follows it at its real, changed
  speed, not at 1×. `[proposed]`
- Stopping, barge-in, pausing and resuming behave at every speed exactly as at 1×: they act at once and nothing already
  played is played again. `[proposed]`
- Changing the speed in Settings applies from the next sentence that is made after the change. A sentence already queued may
  be heard at the old speed. A running session is not restarted for it. `[proposed]`
- A speed saved before this work (0.8, 0.9, 1, 1.1 or 1.2) is read as the nearest of the four. Nobody has to choose again,
  and nothing breaks. `[proposed]`
- The speed no longer travels to the voice service: the requests for speech are the same at every speed. `[proposed]`

### 3.2 Delay before send

- In Settings > Voice > Advanced options, the choice of the delay before send is a **slider**. `[user]`
- The slider's ends are **0.1 s** (left) and **10 s** (right). `[user]` Its step is **0.1 s**, fine enough to set 1.3 s
  and not 1.25 s. `[proposed]`
- The current value is shown as a number of seconds next to the slider, and changes as the handle moves, not only when it is
  let go. The two ends are labelled with their values. `[proposed]`
- The default stays **1.2 s**. A value saved before this work keeps its meaning: nothing is rescaled or reset.
  `[standing]`
- The delay before send is the one value Speech mode, the voice pill and the Speech bar's countdown all read. The
  countdown bar and the seconds it shows count the chosen delay at any value in range. `[standing]`
- At the low end Auto-send is quick and may send before the person has finished a thought; that is the person's choice. The
  slider does not warn, ask or block. `[proposed]`

### 3.3 Max chats

- In the Subagents popover of a chat (the composer's Subagents chip) and in its phone sheet, the choice of max chats is a
  **slider** and not a list of rows. `[user]`
- It picks **any whole number from 1 to 100**, in steps of **1**. `[user]` The ends are 1 (left) and 100 (right) and are
  labelled. `[proposed]`
- The current number is shown next to the slider and changes as the handle moves. `[proposed]`
- The default stays **100**. A chat that already has a value from 1 to 100, however it was set (by an API client too), shows
  exactly that value. `[standing]`
- **Depth stays as it is**: the same list of rows, the same values, the same wording. `[user]`
- Everything that decides when the choice can be made stays as it is: it can be changed until the chat's first message, it
  is fixed afterwards and on a branch or a fork, and with depth Off the max chats choice is greyed and says why. The Subagents
  chip's label and title say the same things they say today. `[standing]`
- A drag is one change, not many: the chat's setting is saved when the handle is let go (or when a keyboard step is made),
  not once for every number the handle passes. `[proposed]`

### 3.4 The slider, wherever it appears

- One slider component serves the delay before send and the max chats. A second one is not made. `[proposed]`
- It can be dragged by finger and by mouse. It can be moved by tapping the track. It can be moved by the keyboard: the arrow
  keys by one step, Home and End to the ends, Page Up and Page Down by a larger step. `[proposed]`
- A screen reader reads it as an adjustable value with its name, its current value, its ends, and moves it by the
  platform's usual gesture for that. `[proposed]`
- On a phone its touch target is at least 44 pt tall, as every phone control is, and dragging it sideways does not scroll the
  sheet or the screen it is in. Scrolling that starts elsewhere still scrolls. `[standing]`
- Dragging inside a popover or a sheet does not close it, including when the finger or the pointer leaves the slider's
  area while the handle is held. `[proposed]`
- A disabled slider is shown as the app shows other disabled controls and cannot be moved. `[proposed]`
- It looks like the rest of the app on every platform: the theme's colours, in light and dark, and the focus ring that other
  controls have. `[standing]`

### 3.5 What is the same as before

- Everything not named above in Settings > Voice, in the voice screens and in the Subagents popover and sheet.
- The Go server: it accepts the same range of max chats and does nothing different. `[user]`
- How an agent uses subagents, what the cap does when reached, and how a chat is created, copied or branched.
- Voice with the service key missing, the voice list, the devices and their fallbacks.

## 4. Decisions and bounds

**4.1 Client only. The Go server is not touched.** `[user]` No server code, no new server call, no new file format. The
subagent settings go through the call the app already makes, within the range the server already accepts.

**4.2 The speed is made by the app, not asked of the voice service.** `[user]` The service only takes speeds from 0.7 to
1.2, which cannot give 0.5× or 2×. The speed is therefore applied to the audio on the app's side. The voice service is
asked for speech at its normal speed.

**4.3 The speed is applied once, in one place, the same for every platform.** `[proposed]` The change of speed is code that
is the same on every platform, applied to the audio before it reaches the platform's own player, and it can be tested without
real audio. The platform players are not asked to play faster or slower, and nothing about the speed is written per
platform. A platform's own rate control is used only if it keeps the pitch and the results are the same on every platform;
otherwise it is not used.

**4.4 No change of pitch.** `[proposed]` Playing the same audio faster by playing it at a higher sample rate or a higher
playback rate changes the pitch and is not acceptable here (3.1).

**4.5 Speaking is not made slower to start.** `[proposed]` The time from the voice service's first audio to the first sound
heard does not grow noticeably, at 1× not at all and at the other speeds by an amount a person cannot tell apart. Speech
still starts before the service has finished a sentence (`voice-chats-goal.md` 3.5).

**4.6 Settings are stored as they are today.** `[standing]` The speed and the delay before send are plain settings kept
with the other voice settings on the device, read and written by Settings, the Speech bar and the pill alike
(`voice-chats-goal.md` 4.6). Values already saved are read, not migrated by hand.

**4.7 Existing components are used, not copied.** `[standing]` The speed is chosen with the existing picker. The sliders sit
in the same rows, sections, spacing and states as the choices they replace, and use the app's own controls, theme and
phone sizes. Behaviour that is the same on every platform is written once; only what platforms really differ in is
written per platform.

**4.8 No new dependency for the slider unless it is already in the app.** `[proposed]` The slider is made with the parts the
app has. A library is added only if it works on iOS, Android, the web build and the desktop window and looks like the
rest of the app; the reason is written down if so.

**4.9 Nothing is paid for by the tests.** `[standing]` No test, check or script of this work calls the real voice service or
any paid model. The stand-in voice service is the only one.

**4.10 Wording.** `[proposed]` The labels the person reads keep today's words where they exist ("Playback speed", the delay's
and the max chats' current labels), unless a label no longer fits a slider. Values read like the app's others: seconds with
one decimal and a unit, the speeds with the multiplication sign, the max chats as a plain number.

## 5. Out of scope

- A slider or free choice for the playback speed, or any speed other than the four.
- A speed per chat, per voice or per way of using voice.
- Changing depth, the levels it offers, or what depth means.
- Any change to the server, to the range it accepts, or to what the cap does.
- Changing the voice service's own speed setting, the voice, the models or the language.
- Any other setting being turned into a slider.
- New screens, new buttons, or moving the settings to another place.

## 6. How it is confirmed

Each statement is true when the checks below pass. Every check is repeatable and spends no money.

### 6.1 Playback speed

- The picker lists exactly 0.5×, 1×, 1.5×, 2×, and the current speed is the one shown. Every speed saved before this work
  (0.8, 0.9, 1, 1.1, 1.2) is read as the nearest of the four, which is 1×, and the unit test of reading settings says so
  for each.
- A unit test of the change of speed, on a known tone and on a known stretch of speech-like audio, finds: the length at 2×
  is half of the length at 1× and at 0.5× it is double, each within 5%; the tone's pitch is unchanged, within 2%; no
  click or gap appears where two pieces of audio meet; audio at 1× is byte-for-byte the audio that came in.
- The same test runs on the audio as the web player, the native player and the engine's tests each receive it, and the
  results are the same.
- With the stand-in voice service, a spoken reply at each speed: the requests to the service do not carry a speed; the time
  the stand-in measures between the first and last sound played is the expected multiple of the time at 1×; Read aloud's
  highlighted sentence is the one the stand-in is playing at each speed; Stop and barge-in act at once at each speed.
- The time from the first audio received to the first sound played at 2× and at 0.5× is within a small, stated amount of the
  time at 1× on the test machine.
- Changing the speed in Settings during a reply changes the speed of the sentences made after it, and does not restart,
  repeat or drop any.

### 6.2 Delay before send

- The slider has its ends at 0.1 s and 10 s, moves in steps of 0.1 s, and shows each value while it is dragged. A value in
  the middle (for example 4.7 s) can be set by the mouse, by tapping the track, and by the keyboard, and survives closing
  Settings and restarting the app.
- Values saved before this work (0.6 s to 3 s) show unchanged. A stored value outside 0.1–10 s is brought into range, as
  other settings are.
- In Speech mode with the stand-in, a spoken turn is sent after the chosen delay at 0.1 s, at 1.2 s, and at 10 s: the
  time between the last words and the send is the chosen delay within the margin the check allows, and the countdown bar
  counts the same time.
- The Speech bar, the pill and Settings show and use the same value after a change in any of them.

### 6.3 Max chats

- In the popover and in the phone sheet the choice is a slider from 1 to 100 in steps of 1, with depth still a list. Setting
  1, 37 and 100 by drag, by tap and by keyboard each produce one change of the chat, with that exact number, and the chat
  keeps it. A drag across many numbers makes one call, not many.
- A chat with a max chats of 3 (set by an API client) shows 3.
- With depth Off the slider is greyed, cannot be moved, and says why. On a started chat, a branch and a fork, the chip is
  fixed as it is today and the slider cannot be opened.
- The chip's label and title show the new number the same way they show a number today (the default 100 is left out of the
  label).
- The Go tests are untouched in what they test, and nothing in the Go server changed.

### 6.4 The slider

- It works with a finger on a phone, a mouse in the web build and the desktop window, and a keyboard; a screen reader reads
  its name and value and can change it.
- On a phone it has a 44 pt target; a drag along it does not scroll the sheet; a drag that leaves it keeps the handle
  until it is let go and does not close the sheet or popover.
- It is drawn correctly in light and dark, at the phone, tablet and desktop widths, and disabled.

### 6.5 Nothing else moved

- An app with voice never switched on makes no request to the voice service and asks for no microphone permission.
- The tests of the repository that `AGENTS.md` names for the packages changed run and pass: from the root
  `npm test && npm run check`, `cd web && npm test`, `cd desktop && npm test`, the browser checks that touch the screens
  changed (the voice checks `VC` and the checks of the Subagents chip and sheet), and the voice scripts of `AGENTS.md`
  (`web/e2e/voice.e2e.mjs`, and the desktop end-to-end run if the way Read aloud reaches the desktop's player changed). The
  device test runs once, on a simulator you name, only if the native side changed; the speed is meant to need no native
  change (4.3).
- The tests that assumed the old choices (the old speeds, the delay's list, the cap's rows, a speed in the voice service
  request) are changed to the new ones, and no test is removed without a test that covers the same behaviour.
- The docs that say how voice and the subagent settings work (`docs/architecture.md`, and the voice plans where they state
  the speed or the pause range) say what is now true.

## 7. Risks

**7.1 Changing speed without changing pitch is real signal processing.** `[not verified]` A good result at 0.5× and 2× on
speech needs a time-stretching method, not a rate change. Quality varies by method: some add an echo, a warble, or a
flutter at 2×. Which method is good enough, and cheap enough for a phone, is to be found out first, by listening, and written
down.

**7.2 The audio arrives in pieces.** `[not verified]` Speech arrives from the service in many small chunks while it is
still being made. A stretch applied to each chunk alone can click at the joins or change length unpredictably; one that waits
for more audio delays the first sound. Both are bounded by 3.1 and 4.5.

**7.3 What follows the audio.** `[not verified]` The marks at the start of each sentence, the level and the end of playback
are tied to where the audio is. They must follow the changed audio, not the original. A mistake shows as a highlighted
sentence that runs ahead or behind at 0.5× and 2× only.

**7.4 Cost on a phone.** `[not verified]` Stretching audio as it arrives costs processor time on the device, in the same
thread as the rest of the app unless it is moved. At 2× the work per second of speech is the highest; a phone that stutters
in the app while speaking is a defect.

**7.5 A slider in the places it must live.** `[not verified]` A handle dragged inside a popover or a bottom sheet is easily
taken by the surface for a swipe or a click outside. How each of the app's surfaces treats a held touch is to be checked
before the slider is relied on.

**7.6 Precision of a drag.** `[not verified]` On a phone, 100 values in a track about the width of a sheet are fewer than
one point apart. A finger cannot set an exact number by dragging; tap-and-nudge, or the keyboard, may be needed for the
exact number. The delay's 99 steps are in the same case. How the slider helps (a larger drag area, a nudge, a step by
the platform's adjust gesture) is to be found out by using it.

## 8. Not decided yet

- **The exact labels** next to the sliders and on the picker's values ("1×" or "1.0×"), and whether the word "delay" or
  "pause" is the one shown.
- **Whether a change of speed during a reply is heard at once** or from the next sentence (3.1 says the next, which the
  quality of the stretch and the cost of re-doing audio already queued may decide).
- **Whether a nudge control (a minus and a plus) is shown next to the sliders** for exact numbers on a phone (7.6).
- **Whether the sliders show a small mark at the default** (1.2 s, 100).
