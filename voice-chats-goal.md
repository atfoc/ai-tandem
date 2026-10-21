# Goal: talk to the chats and hear them, with ElevenLabs, from the app alone

This document defines an outcome: what voice is in AI Whiteboard once the work is done. It says what exists at the end,
the decisions already made, the bounds the work must stay inside, and how to confirm that it is done. It is not an
implementation plan and not an order of work. It names no files and no functions; how to build it is for whoever builds
it. The source of the decisions is the board "ElevenLabs voice: client-only design"; where this document and the board
differ, the board is what the user drew and the difference is a mistake to report, not to settle silently.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it (it is drawn on the board or was said).
- `[standing]`: decided before this goal and kept; it is in the architecture document or in the code.
- `[proposed]`: proposed while this goal was written. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Voice service**: ElevenLabs, reached over the network at `api.elevenlabs.io`. The only service voice talks to.
- **Key**: the person's own ElevenLabs API key.
- **STT / TTS**: speech to text, and text to speech.
- **Dictation**: speech becomes text in the composer's text box and nothing is sent.
- **Speech mode**: the person talks, the turn is sent as a chat message, and the model's reply is spoken.
- **Read aloud**: one message, the person's or the model's, is spoken on request.
- **Voice pill**: the control floating over a board's canvas that talks to one of that board's chats.
- **Orb**: the pill's round microphone button, and what the pill collapses to.
- **Target chat**: the chat the pill's microphone talks to.
- **Barge-in**: the person interrupts what is being spoken, by tapping or by speaking.
- **Auto-send**: a spoken turn is sent by itself after a pause. Its opposite is **tap to send**.

## 2. Goal

Today a chat is typed and read. At the end a person can use their voice in three ways, in the chat view and on a board:

1. **Speech mode.** They talk, the turn is sent as a chat message, and the model's reply is spoken to them. `[user]`
2. **Dictation.** They talk and the words appear in the composer's text box. Nothing is sent: they edit and press Send. `[user]`
3. **Read aloud.** Any message in a chat, theirs or the model's, can be spoken on request. `[user]`

On a board, the voice pill lets them talk to a chat of that board while they look at the board, and see the agent's
edits appear. `[user]`

All of it runs in the app. The Go server is not touched: voice only changes text before it is sent and after it
arrives. `[user]`

## 3. What exists when it is done

### 3.1 Speech mode

- The microphone's audio is turned into text by the voice service as the person talks; the finished text is sent as a
  chat message by the same path a typed message takes. `[user]`
- The model's reply is spoken sentence by sentence as it streams in, so speech starts after the first sentence and not
  after the whole reply. `[user]`
- Speech mode always speaks the reply: there is no setting for it. `[user]`
- The speech bar shows what the person has said so far, a live waveform and the model's spoken sentence while it
  speaks, with **Mute**, **End** and, while the model speaks, a tap on the waveform that interrupts it so the person
  can talk. `[user]`
- **How the turn is sent** is chosen by the **Auto-send** toggle in the speech bar. `[user]`
  - **On**: a pause after the last words starts a countdown that is shown as a bar with the seconds left, and the
    turn is then sent. **Cancel** stops the countdown and keeps the words; sending or talking on goes from there.
  - **Off**: the bar keeps listening until the person taps **Send**.
- Settings > Voice picks the default of Auto-send for new speech. The pause length is 1.2 s by default and is changed
  in Advanced options. `[user]`
- A turn that was spoken carries a mic mark in the thread, so it can be told from a typed one. `[user]`

### 3.2 Dictation

- The composer has a Dictate control. Tapping it starts listening; tapping it again stops. `[user]`
- Words that are still a guess show in the text box while the person speaks; finished words are appended to what is
  there. `[user]`
- Nothing is sent. The person edits and presses Send. `[user]`

### 3.3 Read aloud

- Every message, the person's and the model's, has a **Read aloud** action beside the other message actions (Copy,
  Fork). `[user]`
- Before a message is spoken it is cleaned so that only what a person would say remains: markdown marks, code and
  links are not read. Code blocks are skipped by default; one setting in Advanced options turns that off. `[user]`
- A message being read has a control that stops it. Reading is never started by anything but the person's tap (or by
  Speech mode for the model's reply).

### 3.4 The composer

- The composer's toolbar gains two controls: **Dictate** and **Speech mode**. `[user]`
- On a narrow row they join the rest of the toolbar in its existing overflow popup, as other controls do today. `[user]`
- Voice never changes how a typed message is sent, and the composer works as before when voice is not used.

### 3.5 Playback

- There is one audio player for the whole app. It speaks one sentence after another without gaps the person can hear,
  and starts playing a sentence before the voice service has finished producing it. `[user]`
- **Barge-in:** tapping the orb, the waveform or a Read aloud control, or speaking, stops what is playing, clears
  what was queued and cancels the requests still running. `[user]`
- Playback speed is a setting (Advanced options), 1.0x by default. `[user]`

### 3.6 The board pill

- Every board shows a floating voice pill over its canvas. It uses the chats of that board that the sidebar shows.
  `[user]`
- **Orb states.** `[user]`
  - *Idle*: tap it, or hold Space (where a keyboard exists).
  - *Listening*: a ring pulses with the person's voice.
  - *Thinking*: the turn is sent and the board shows the agent's edits as they happen.
  - *Speaking*: tap to interrupt.
  - *Auto-send waiting*: the ring fills, then the turn is sent.
  - *Tap to send waiting*: a small ↑ badge on the orb sends the turn when tapped.
- **Sizes.** The compact pill (chat chip, **+ New chat**, orb) grows to the listening bar while the person listens or
  words are waiting, and shows the live waveform, the words so far, and the countdown or Send. It can be collapsed to
  the orb alone. `[user]`
- **Captions.** The board shows floating captions of what the person said and of the model's spoken reply. `[user]`
- **The Auto-send toggle is one value.** The pill, the chat's speech bar and Settings > Voice (as its default) all
  read and write the same setting. `[user]`
- **Cancel** in the pill stops the countdown and keeps the words in the pill; tapping Send or talking on goes from
  there. `[user]`
- **The target chat.** `[user]`
  - With no chat yet on the board, the first thing the person says creates one, the same way the sidebar's **+** on
    the board's row does. The sidebar's **+** and the pill's **+ New chat** are one action, not two copies of it.
  - Otherwise the target is the chat used last. **+ New chat** starts a fresh one and it becomes the target at once.
  - The chip names the target and, opened, lists this board's chats, the ones the sidebar shows, with a way to show
    all of them.
  - The new chat shows under the board's row in the sidebar at once, with its working dot as today.
  - The chat view opens only if the person opens it, as today. The reply fills the chat in the sidebar.
  - The board's selection chip is sent with the spoken turn, as with a typed one. `[user]`

### 3.7 Settings > Voice

- **ElevenLabs API key**: entered in the app's existing secret input, with Show, a **Test key** button that says
  whether the key works and how many voices it found, and the line that it is stored on this device only and sent only
  to elevenlabs.io. `[user]`
- **Remove key from this device**: clears the key from the store it lives in. `[user]`
- **Voice**: a short list of voices with a name and a few words about each, one chosen, and a play button on each that
  plays the voice's own preview clip, so that choosing a voice costs no credits. A control shows all of the voices. `[user]`
- **Speech mode sends my turn**: Auto-send or Tap to send, the default of 3.1. `[user]`
- **Advanced options** (collapsed by default) `[user]`:
  - Speech model for text to speech: Flash v2.5, v4 Turbo or Multilingual v2. Default: Flash v2.5, the fastest and cheapest.
  - Transcription model for speech to text. Default: Scribe v2 Realtime.
  - Language. Default: auto-detect.
  - Pause before auto-send. Default: 1.2 s.
  - Playback speed. Default: 1.0x.
  - Skip code blocks when reading. Default: on.
- The voice, the models and the speeds are plain settings kept like the app's other settings. The key is not one of
  them (4.2).

### 3.8 With no key, and when something fails

- With no key, tapping Dictate, Speech mode, Read aloud or the board's orb does not fail silently: a small popover says
  "Voice needs your ElevenLabs key. It stays on this device." with **Open Settings** and **Not now**, one tap from
  Settings. `[user]`
- The same popover shows for every other failure, each with a plain sentence and one action. `[user]`

| Failure | The words | The action |
|---|---|---|
| The key is rejected (401) | "ElevenLabs did not accept this key." | Open Settings |
| Out of credits, or rate limited | "Your ElevenLabs plan has no credits left." | Open ElevenLabs |
| The microphone is blocked | "The app can't hear you. Turn on the microphone in system settings." | Open system settings |
| Offline or a network error | "Can't reach ElevenLabs." | Try again |

- A failure of voice never breaks the chat: the chat keeps working in text, and a message already sent is not lost. `[user]`

### 3.9 What is the same as before

- Chats, agents, the model's reply stream, the prompt library, boards, and the Go server with its API, its files and its
  tests. `[user]`
- A typed message goes the way it always did.
- An app whose person never turns voice on behaves as before and pays for nothing: no microphone is asked for, no
  connection to the voice service is made, no player is started. `[proposed]`

## 4. Decisions and bounds

**4.1 Client only. The Go server is not touched.** `[user]` No server code, no new server call, no new file format.
Voice changes text before it is sent and after it arrives. A spoken turn is an ordinary chat message to the server.

**4.2 The key stays on the device, never on the aiwb server.** `[user]`

- The key lives in the same kind of store the app already uses for server secrets, per platform:
  - iOS and iPadOS: the Keychain, through the same secure store the server secrets use. This device only, not in an
    iCloud backup or transfer.
  - Android: the Android Keystore through the same secure store, hardware-backed where the phone has it.
  - Desktop (Electron): the same flow the server secrets use now: the file in the user's data folder with owner-only
    permissions, written by the main process only; the page asks over IPC. No keychain, nothing new to build.
  - Browser (web build): tests only, never shipped. The key is held in memory and is gone on reload. There is no
    "Remember on this device", and nothing is written to the browser's storage.
- One small keystore interface with get, set and clear sits in front of all four; the rest of voice does not know where
  the key is.
- The key is read into memory only when a voice call starts, and goes only to `api.elevenlabs.io` as the `xi-api-key`
  header over https or wss.
- The key is never in the app's settings, in a log line, in the text of an error, sent to the aiwb server, or in a
  board or a chat. It is not kept anywhere else because it was convenient.
- Settings has "Remove key from this device", and it clears the key from the store above.

**4.3 Audio and the voice service.** `[user]`

- The aiwb server never sees the key or the audio. No audio is stored by the app.
- Voice uses two separate calls to the voice service, both straight from the app to `api.elevenlabs.io`:
  - **Listening (STT):** one WebSocket that stays open for the whole listening session, with the Scribe realtime model.
    Microphone audio is captured as 16-bit mono PCM at 16 kHz in small chunks (about 100 to 250 ms), and each chunk
    goes up as base64 inside a JSON frame. The service answers with JSON text events only: partial transcripts (a live
    guess, shown at once) and committed transcripts (final, appended). After the pause length with no new words, the
    turn is sent. End or Mute closes the socket or stops sending.
  - **Speaking (TTS):** one streamed HTTP request per sentence, answered with a chunked body of raw audio (PCM, 24 kHz)
    that plays as it arrives. The request carries the plain text of one sentence, the voice and the model; the answer
    has no JSON wrapper.
- The model's reply is cut into sentences at `.` `!` `?` as its text arrives, so the first sentence is spoken without
  waiting for the rest.
- A browser cannot set headers on a WebSocket. Where the page cannot send the key as a header, a short-lived,
  single-use token is passed as a query parameter instead. `[proposed]`
- Settings > Voice's play buttons use the voice's own preview clip, not a TTS request.

**4.4 Platform work that voice needs.** `[user]`

- Microphone permission and the audio session are handled natively, on the phone, tablet and desktop alike.
- The web and Electron page's content security policy must allow `api.elevenlabs.io` over https and wss. Today its
  `connect-src` is `'self'` or `'none'`; the change allows that one host and nothing wider.
- There is one audio player queue for the whole app (3.5).

**4.5 Existing components are used, not copied.** `[user]`

- Settings > Voice uses the app's existing secret input for the key.
- The composer's new controls are added to the composer toolbar and take part in its existing fit-to-width overflow
  popup like the controls already there.
- Read aloud is a message action beside the existing ones.
- The board's pill is a floating control over the board's canvas. It does not change the board view's engine, the
  board's messages or the board file.
- The sidebar's **+** and the pill's **+ New chat** run the same new-chat action for a board; the pill's chat chip
  lists the chats the sidebar lists, from the same source, so the two never disagree.
- Voice is written as its own module of the app: the keystore, STT, TTS, the player and the hook that the screens use.
  The screens call it; they do not each carry a piece of it.

**4.6 One setting is read by every place that shows it.** `[user]` Auto-send, the voice, the models, the pause length
and the speed each have one stored value, read and written by Settings, the speech bar and the pill alike.

**4.7 Nothing is sent without the person's act.** `[user]`

- Dictation never sends.
- Speech mode and the pill send a turn only when the person chose Auto-send and the pause ran out, or when they tapped
  Send (or the ↑ badge). Cancel is always available while a countdown runs.
- Read aloud and the model's spoken reply never repeat a message the person did not ask to hear.

**4.8 What is sent to the voice service is only what voice needs.** `[proposed]` Microphone audio while the person is
listening; the text of one sentence with the voice and model ids while something is spoken; the key as the header. No
chat, board or other content is sent beyond the sentence being spoken, and no audio is sent while the microphone is
muted or the session has ended.

**4.9 Voice does not pay for what the person did not ask for.** `[user]` Choosing a voice uses its preview clip, which
costs no credits. A failed or cancelled turn stops its requests at once (3.5).

**4.10 Look and feel.** `[user]` The screens follow the mockups of the board: a rounded settings page with the sections
of 3.7, the toolbar controls placed as drawn (Dictate beside Speech mode, before the attach button), the orb states
of 3.6, and the colours of the board's legend (the voice service, the app's code and the device's hardware are three
distinct things in the flows).

**4.11 Nothing is paid for by the tests.** `[standing]` No test, check or script of this work calls the real voice
service or any paid model. Tests use a stand-in for it. A run against the real service is done by the person, by hand.

## 5. Out of scope

- Any change to the Go server, its API, its files, the chats' stored form or the agents.
- Storing the key, or any audio, on the aiwb server, in a board or in a chat. Sending audio through the aiwb server.
- A voice service other than ElevenLabs, or a voice that runs on the device itself.
- Wake words, always-on listening and listening while the app is in the background.
- Voice commands that are not a chat turn: the person talks to a chat and the chat's agent does the work.
- Shipping voice in the web build. It exists for tests only; no key is ever remembered there.
- Choosing or tuning voices beyond what 3.7 lists, cloning a voice, and managing the person's ElevenLabs account or
  plan.
- Interrupting the agent's work. Barge-in stops speech, not the turn.

## 6. How it is confirmed

### 6.1 Speech mode and dictation

With the voice service stood in for (4.11) and a scripted microphone:

- Speech mode: words said become a chat message through the ordinary send path and the reply is spoken sentence by
  sentence, the first sentence before the reply has ended. With Auto-send on, the turn is sent after the pause (1.2 s
  by default), and Cancel inside the countdown sends nothing and keeps the words. With Auto-send off, nothing is sent
  until Send.
- Dictation: partial words show while speaking, finished words are appended, and nothing is sent however long the
  silence is.
- End and Mute stop sending audio and close the socket.
- A spoken turn shows its mic mark in the thread; a typed one does not.

### 6.2 Read aloud and playback

- Read aloud on the person's message and on the model's: markdown marks, code (by default) and links are not spoken.
  Turning "Skip code blocks" off reads them.
- One player: a second request does not overlap the first; a tap on the orb, on Read aloud or on the waveform, or
  speaking, stops the sound, clears the queue and cancels the requests still open.
- Playback starts before the stood-in service has finished the sentence.

### 6.3 The key

- Per platform, the key is stored in the store of 4.2, read back, cleared by "Remove key from this device", and gone
  after it. In the web build it is gone after a reload.
- A search of the app's stored settings, of the aiwb server's traffic, of the log and of the text of every error shown
  during a full run with a recognisable key finds the key nowhere except the `xi-api-key` header (or its short-lived
  token) sent to `api.elevenlabs.io`.
- Test key reports a working key with the number of voices found, and a rejected one with the 401 message.

### 6.4 The popovers

With no key, Dictate, Speech mode, Read aloud and the orb each show the "needs your key" popover with Open Settings and
Not now; Open Settings lands on Settings > Voice. A 401, no credits, a blocked microphone and an offline error each show
their own sentence and their own action (3.8), and the chat still sends text.

### 6.5 The board pill

- With no chat on the board, the first spoken turn creates one that shows under the board's row in the sidebar and
  becomes the target; with a chat, the last used is the target; **+ New chat** and the sidebar's **+** produce the same
  result; the chip lists the sidebar's chats.
- Every orb state of 3.6 is reachable and looks as drawn; the compact pill grows and collapses as in 3.6; Auto-send and
  tap to send each show their ring or badge when collapsed.
- The Auto-send toggle changed in the pill, in the speech bar or in Settings is changed in the other two.
- The selection chip is sent with a spoken turn.
- While the turn is Thinking, the agent's edits show on the board.

### 6.6 Where it runs

Voice is confirmed on the app's iPhone and iPad layout, the Android layout, the desktop window and, for tests, the web
build, each at the viewports it is used at. A narrow composer row puts Dictate and Speech mode in the overflow popup.
Microphone permission and the audio session are confirmed on the platform's real stack: a simulator or an emulator
where it can show them, and by the person on a device where it cannot.

### 6.7 Nothing else moved

- The Go tests are untouched in what they test, and nothing in the Go server changed.
- An app with voice never switched on makes no request to the voice service and asks for no microphone permission.
- The tests of the repository that `AGENTS.md` names for the packages changed: from the root `npm test && npm run
  check`, `cd web && npm test`, `cd desktop && npm test`, and the browser checks that touch the screens changed. The
  device test that covers the microphone and the audio session runs once, on a simulator you name, only because the
  native side changed.

## 7. Risks

**7.1 The microphone and the audio session in React Native.** `[not verified]` Capturing 16 kHz mono PCM in small
chunks, and playing a stream of PCM chunks as they arrive, may need native code the app does not have yet, on each of
iOS, Android and the desktop window. How, and with what, is not decided.

**7.2 A WebSocket with a header.** `[not verified]` The design sends the key as a header on the STT socket on the
phones and in Electron, and a token as a query parameter where a header cannot be set. Whether React Native's and
Electron's sockets can set that header is not confirmed. If one cannot, the token path (4.3) is used there too, and the
key is then used for one more request, to get the token.

**7.3 Speaking over the speaker.** `[not verified]` Barge-in by speaking (3.5) means the microphone listens while the
speaker plays. Without echo cancellation the model could hear itself and interrupt itself. The speech bar and the orb
interrupt by a tap, which needs none of this; whether speaking alone may interrupt depends on what the platforms'
audio sessions can cancel.

**7.4 The content security policy.** `[not verified]` Letting the page reach `api.elevenlabs.io` (4.4) changes a policy
that is `'none'` or `'self'` today. The shipped web export has `'none'`, and tests copy it with a change. How the
change is made without widening the policy of a build that does not use voice is not decided.

**7.5 Cutting a reply into sentences.** `[not verified]` Cutting at `.` `!` `?` can cut at an abbreviation, a number
or a URL, and a reply that is mostly a list or code has few sentences. The rule needs to hold up on real replies; a
wrong cut is heard, not seen.

**7.6 The service's limits.** `[not verified]` The voice service's models, voice list, rate limits and the realtime
event names can change. The names in 4.3 are from the board's design and have to be confirmed against the service when
the work starts.

**7.7 Cost.** `[proposed]` Each spoken sentence is a paid request and each listening minute is paid. Nothing here
makes voice free; 4.9 only keeps it from being spent without the person's act.

## 8. Not decided yet

- **How voice reaches the native microphone and speaker** (7.1): which module, whether the app builds its own.
- **The length of the list of voices** shown before "Show all" (the mockup shows four).
- **Whether hold Space on the orb is push-to-talk or the same toggle as a tap.** The mockup says "tap, or hold
  Space"; what releasing Space does is not drawn.
- **The words of the error sentences' translations**, if the app is ever shown in another language. They are English
  today.
