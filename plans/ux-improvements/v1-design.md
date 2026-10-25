# V1 — Blocked states and voice in the composer and on the board: the design (lead's decisions)

Goal 3.7.1, 3.7.2, 3.7.3 (bar and board halves), 3.4 (voice on a board, the selection rule's speech-mode half), 4.5, 4.9.
Mockups (board `b_edb3unwu`, `get_image` scope rect, scale ≤ 1):
- "06 Voice in the composer": rect x −30, y 1590, w 1440, h 1500 (`co-06a` Set up voice, `co-06c` dictation, `co-06d` speech mode,
  `co-06s` the speech bar state by state, the notes under the frames).
- "07 Notices": rect x 1560, y 1590, w 1460, h 1500 (`co-07a` offline, `co-07b` archived, "The other notices, one per state").
- "05 Talking to the board": rect x −3680, y −2010, w 960, h 1500 (`bd-05a` voice card listening, `bd-05b` reply spoken).
- "10 Another server": rect x 4460, y −220, w 1300, h 1500 (`ch-10a` offline, `ch-10b` archived; composer half only).

Everything here is **phone only** (`usePhone()`), except where a line says "all layouts". Tablet and desktop keep today's composer
bars, speech bar (with its Auto-send switch), pill, popovers and every testID (goal 4.2, 6.4). Voice behaviour does not change (4.5):
nothing new is stored, sent or listed; no microphone or request before the person uses voice.

## 1. Blocked states (3.7.1) — `screens/composer/Blocked.tsx`, `screens/composer/blocked.ts`

Contract change of C1's part (`screens/composer/parts.tsx`; only the default used it):

```ts
export type BlockInput = {
  chatId: string; branch: string;
  where: Where;            // core logic/chatserver.ts: {server, name, connected}
  gone: boolean;           // the server no longer has the chat
  usable: AgentKind[];     // the agents the chat's server offers
  refused: string;         // the last refused send's sentence ("" none) — Composer.tsx's `under`
  onDismissRefused(): void;
};
export type BlockOut = {
  box?: ReactNode;      // drawn INSTEAD of the box (and the chip row): archived, archived+offline, legacy, no agent
  toolbar?: ReactNode;  // drawn in the toolbar's place INSIDE the box; the box is read-only, greyed, the draft visible: offline, gone
  above?: ReactNode;    // drawn right above the box: model too small (amber), refused send (red)
  sendOff?: string;     // Send is greyed, with this reason (model too small)
};
useBlock: (o: BlockInput) => BlockOut | null;   // a hook, called on every render of the phone's composer
```

`blocked.ts` (pure, tested in `app/test/composer.blocked.test.ts`): `blockOf({ archived, legacy, where, gone, usable, agent, since,
now, tooSmall, refused })` → which states hold and their words. Priority: archived (+offline) › legacy › no agent › gone › offline;
model-too-small and refused are "above" and can stand with none of the others.

| State | Where | Words (17 pt first line, 13 pt muted second) | Control |
|---|---|---|---|
| Offline | toolbar place, after a hairline, cloud glyph | "<Server> is offline since 14:02." / "Your draft is kept until it's back." (`formatSince` of `State.serverSince`; no time known → "<Server> is offline.") | **Servers** 44 pt outlined → S2 `openServer(where.server)` |
| Gone | toolbar place | `goneText(name)` | none |
| Archived | box place, the box's shape (radius 18, panel ground, 1 px line) | ▤ "This chat is archived." / "Unarchive it to send a message. It goes back to the list with the others." | full-width 44 pt primary **Unarchive** (`api.unarchive("chats", id)`; error in the bar) |
| Archived + offline | box place | ▤ "This chat is archived." / "<Server> is offline since 14:02." | none |
| Legacy (old board connection) | box place | "This chat used the old board connection." / "Start a new chat on this board to go on." | full-width 44 pt primary **New chat on this board** → `newChat({ board })` (no board: no button) |
| No agent | box place | ⚠ "No agent is installed on <Server>." / "Install Claude Code, Cursor or pi on that computer, then come back." (this computer: today's NO_AGENT sentence) | none |
| Model too small | above | amber card, ⚠ `modelNotice().text` (warn) | 44 pt **Pick a model** → C2's `ModelSheet` (drawn by Blocked.tsx); no ×; `sendOff` |
| Refused send | above | red card: the reason (`under`) | 44 pt × → `onDismissRefused`; the text stays in the box |

Said once: while a block shows, the box has **no placeholder**, there is no `composer-err` line under the box, no `ModelNotice` warn
line, and no yellow box in the thread. testIDs: `composer-block` (dataSet `kind`: offline|gone|archived|legacy|noagent|toosmall|refused,
`place`: box|toolbar|above), `block-servers`, `unarchive` (kept), `block-newchat`, `block-pick-model`, `composer-err` (kept on the refused
card), `block-dismiss`. `archived-bar` testID kept on the archived/legacy bars (the checks read it).
`ArchivedBar`/`LegacyBar` move from `Notices.tsx` to `Blocked.tsx` unchanged for the wide layouts.
The toast stands above whatever the composer draws: every state measures its height (`useToastLift`); T3's `COMPOSER_LIFT = 124`
(`screens/chat/backonline.ts`, `Remote.tsx`) is removed in favour of the composer's measured height.

## 2. Voice in the composer (3.7.2)

**Vocabulary** (labels, words, accessibility): Talk, Dictate, Send, Cancel, Interrupt, Mute, End; states Listening, Sending in N s,
Thinking…, Speaking, Muted. "Stop" only stops the agent: the mic while it listens is "End dictation" (accessibility) and the line says
"Tap the mic to end" (the mockup's "to stop" yields to the rule). New words in a block `// ux-v1` appended to `app/src/voice/words.ts`;
existing constants used by the wide layouts are not changed.

**Dictate (co-06c).** While it listens: the mic filled with the accent (`dictate` on); inside the box, above the text, a line
`dictate-line`: a live level (5 bars), "Listening…" (accent, 13 pt) and at the right "Tap the mic to end" (13 pt muted). Finished words
go into the box as plain text after what was typed; the live guess is drawn muted right under the text inside the box
(`dictate-guess`), never into the box's value on the phone; when final it lands as plain text. The primary stays **Send** while
dictating (even with an empty box). Typing ends dictation (today's rule); starting dictation does not raise the keyboard. Wide: unchanged.

**Speech bar (co-06d, co-06s)** — `screens/voice/PhoneSpeechBar.tsx`, drawn by `SpeechBar` when `usePhone()`:
an accent-bordered card with the box's radius; top row: a dot + the state word (accent; Muted grey) and **one action of the moment**
at the right: Send (primary; greyed until there are words) while listening, **Cancel** during the countdown ("Sending in 2 s" with a
thin progress line under the row; Cancel keeps the words), **Interrupt** while speaking, none while thinking, **Continue** while paused
(VD-12 sentence in warn). A 48 pt waveform (accent bars; flat dots while thinking/muted). The heard words at 17 pt, the live guess
muted; while speaking the sentence spoken. Bottom: **Mute** (46 pt, outlined, half) and **End** (46 pt, red text on danger-soft, "✕ End",
half). **No Auto-send switch.** End: unsent words (committed + partial) go into the box as the draft (`DictationBoxContext` `put`, after
what the box holds), then `voice.end()`. testIDs kept: `speech-bar` (phase, muted, paused), `speech-send`, `speech-cancel`,
`speech-countdown`, `speech-mute`, `speech-end`, `speech-words`, `speech-spoken`, `speech-status`, `speech-wave`, `speech-continue`,
`speech-paused`; new `speech-state` (dataSet `word`), `speech-interrupt`. Wide keeps today's bar.

## 3. "Set up voice" (3.7.2) — `screens/voice/SetUpVoiceSheet.tsx`

On the phone every voice problem (`ProblemPopover`, any anchor: composer, Read aloud, the orb, previews outside Settings) is one
sheet (F1 `Sheet` + `SheetHead`, detent fit): a 60 pt accent-soft round badge with Talk's wave icon, the title, the body, one 50 pt
primary block button and **Not now** as a full-width 44 pt text button. No key field anywhere but Settings.

| kind | title | body | primary |
|---|---|---|---|
| no_key | Set up voice | "Talk to <agent>, or dictate into the box, with your voice." + muted: "Voice runs on ElevenLabs, a speech service with its own account. Add your ElevenLabs API key once; it stays on this device and is sent only to elevenlabs.io." | Open Settings › Voice → `openVoiceSettings()` |
| key_rejected | Set up voice | "ElevenLabs did not accept this key." + the same muted note | Open Settings › Voice |
| no_credits / service | ElevenLabs | today's sentence | Open ElevenLabs |
| mic_blocked | Microphone | today's sentence | Open system settings (only where it can) |
| offline | Can't reach ElevenLabs | today's sentence | Try again (when retry) |

<agent> = the chat's agent name when the anchor names a chat (`dictate:<id>`, `speech:<id>`), the board's voice chat's for `pill:<board>`,
else "your agents". testIDs: keep `voice-problem` (dataSet `kind`), `voice-problem-text`, `voice-problem-act`, `voice-problem-dismiss`
on the sheet's parts; the sheet `setup-voice`. Wide: today's popover.

## 4. Voice on a board (3.4, 4.9) — `screens/voice/pill/DockedOrb.tsx`, `VoiceCard.tsx`

`pill.ts` registers `BoardOrb` = `DockedOrb` and `BoardVoice` = a switch: `usePhone()` → `VoiceCard`, else today's `Pill` (unchanged).

**Docked orb** (B1's `board-orb-slot`, 64 pt box; also the landscape corner): a 52 pt accent disc with Talk's wave icon (onAccent); a
ring that follows the level while listening; the countdown ring; a spinner while thinking; the wave while speaking; pause glyph when
paused; a badge with the count when a selection goes along (speech mode on and the selection not taken out). Tap: idle → start
(`startPill`), listening/countdown/waiting → End, speaking → Interrupt, paused → Continue (today's `press`). Accessibility label in the
vocabulary ("Talk", "End", "Interrupt", "Continue"). testID `voice-orb` (dataSet `state`, `badge`). Problems: the Set up voice sheet.

**Voice card** (`voice-card`, dataSet `phase`): shown only while this board's pill session is not idle; app chrome positioned above the
bottom band (bottom = BAND_HEIGHT + 8, 12 pt sides, max 480 wide, radius 18, `t.bg`, line, shadow); leaves the bar and Excalidraw's top
tools in sight. At rest (idle) nothing but the orb.
- Listening / waiting / countdown: "To:" + a 44 pt chip with the voice chat's title and ⌄ (`voice-card-to`) → B1 `openChatsSheet(board)`
  ("New chat" when the board has none: the first turn makes one); a small live wave at the right. The heard words at 17 pt, guess muted
  ("Listening…" muted before any). "With N selected shape(s) ×" (`voice-card-selection`, × `voice-card-selection-x`) only when
  `selectedCount(board) > 0` and not left out (today's `selection.ts`). Foot right: **Cancel** (`voice-card-cancel`: countdown →
  `cancelCountdown`; else `voice.end()`) and **Send** (`voice-card-send`, primary, greyed with no words), 44 pt. Countdown: "Sending in
  N s" as the head's state.
- Sending / thinking: agent glyph + "<Agent> · thinking…", `In "<chat>"`; foot **Open chat**.
- Speaking: agent glyph + "<Agent> · speaking" (agent colour), `In "<chat>"`, the spoken sentence at 17 pt; foot **Open chat**
  (`voice-card-open`, accent-soft) and **Interrupt** (`voice-card-interrupt`, outlined, ■). Open chat → `select({ board, chat })`.
- Paused: the VD-12 sentence (warn) and **Continue** (`voice-card-continue`).
- The device notice (`useVoiceNotice`) as a 13 pt line in the card.
No Auto-send, no captions, no "+ New chat", no collapse, no hold-Space on the phone. The selection goes **only** in this (speech-mode)
session, to the voice chat; nothing else sends a selection (B2 owns the rest).

## 5. Checks and seeds

`UX.V1-voice.mjs` (phone, light + dark): each blocked state once with a read-only box and the draft, Servers → server detail, Unarchive;
Dictate's line; the speech bar's states and words (stand-in voice service, `window.__aiwbVoice`); no Auto-send in the bar or the card;
Set up voice with no key → Open Settings › Voice pushes `voice-settings`; the voice card on a board (To: opens the Chats sheet, the
selection chip in speech mode only, Interrupt, Open chat); nothing app-made over the canvas at rest. Seeds: section `UXV1` in
`web/dev/mock-ui.js`, a `// ux-v1` block in `mock.mjs` if a knob is needed, own rows in `P0.3-smoke.mjs` `DRAWN`.
Existing: VC.2, VC.3, VC.4, VC.5-readaloud, VC.6, VC.7 phone halves; `voice.e2e.mjs`; device `voice-mic.yaml` Read aloud step.
