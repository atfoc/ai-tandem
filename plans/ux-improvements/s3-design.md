# S3 — Settings › Voice, Choose voice, Add key: the design (lead's decisions)

Goal 3.8.5, 3.7.3, 4.5, 4.9 (Settings half). Mockups (board `b_edb3unwu`): "07 Voice (dark)" `dl-07b-phone` (rect x 5790, y 3380,
w 430, h 1150), "07b Voice, no key yet" `dl-7bc-phone` (x 6345…6770), "07b Add key (P3)" `dl-7bd-phone` (x 6840…7260), "07b Choose
voice (P5)" `dl-7be-phone` (x 7330…7760); all rows y 3380…4530 (notes under the frames). The whole row: rect x 5790 y 3380 w 1970 h 1250.

## What changes where
- **Phone only.** The tablet and desktop keep today's `SettingsDialog` (a centred dialog) exactly as it is. Nothing in `voice/engine`
  changes but one small export (below); nothing stored changes (`aiwb.voice.settings`, the key in the keystore only).
- On the phone Settings › Voice is the pushed place screen **`voice-settings`** (title "Voice", the stack's bar draws "‹ Settings"),
  and **`choose-voice`** (title "Choose voice", "‹ Voice"). Both registered from `screens/voice/settings.ts` (our registration
  overwrites S1's placeholder whichever is imported first).
- **Opening on the phone.** `openVoiceSettings()` (voice store flag, used by the foot's gear `settings-btn`, the problem popover's
  "Open Settings", V1's "Set up voice" later) is honoured on the phone by `SettingsDialog`: while the flag is set and `usePhone()`, it
  clears the flag and calls `openVoicePhone()` (`screens/voice/open.ts`): top pushed entry `voice-settings` → nothing; top `settings`
  → push `voice-settings`; else push `settings` then `voice-settings` (so the back always reads "‹ Settings", 3.1.2). The dialog
  itself is not drawn on the phone.
- **No request and no device list before use (4.5).** The Voice screen reads only the keystore (`voice.hasKey()`, local) and the
  settings. It does not call `voice.voices()`, does not list devices, does not open the microphone. The voices are fetched when the
  person opens Choose voice or presses a play; devices are listed only while a Microphone/Speaker picker sheet is open; the
  microphone opens only on Test microphone. The key typed in Add key lives in that sheet's state only, dropped at Save and close.

## The Voice screen (`VoiceScreen.tsx`)
testID `vs-screen` (data `key`: `unknown|none|saved`). ScrollView, `t.panel` background, CellGroups (F1 `Cells.tsx`), sizes from `metrics.ts`.

**No key (07b no key)** — `hasKey === false`:
1. A card `vs-nokey-card`: a 60 pt accent tile with the mic, "Talk to your agents" (17 pt, 600), "Talk to your agents and hear
   replies. Voice uses your own ElevenLabs account." (13 pt muted, centred), a block primary button **"Add ElevenLabs key"**
   (`vs-add-key`) that opens Add key, and a 44 pt link "No key yet? Get one at elevenlabs.io ↗" (`vs-get-key`, `openLink` of
   `platform/openlink`, https://elevenlabs.io/app/settings/api-keys).
2. Under it the privacy line (KEY_STORED_NOTE, 13 pt muted).
3. CellGroup "Voice": one disabled cell "Add your key to choose a voice." (`vs-voice-nokey`), footer "Speech mode and the
   advanced options appear once a key is saved."
4. Nothing else: no Sending, no Advanced, no Remove.
While `hasKey === null` the screen shows nothing but its background (no flash of the wrong state).

**Key saved (07)** — `hasKey === true`:
1. CellGroup: the key row `vs-key-row`: leading key tile, "ElevenLabs API key", sub "Saved on this device ✓" (green, `subTone`),
   chevron → Add key (to replace it). Footer: the privacy line.
2. CellGroup "Voice": the chosen voice `vs-chosen-voice` (data `voice`): leading 44 pt round play (`vs-voice-play`, data
   `voice`, `playing`) → `voice.playPreview(id)`, "Playing sample…" under the name while it plays; the name (settings `voiceName`),
   its description when this session already knows it (the voice cache filled by Choose voice; no request for it), ✓ accent at
   the right. With no voice chosen yet (`voiceId === null`): "Your account's first voice", no play, no ✓. Then **"Choose voice"**
   (`vs-choose-voice`, accent label, chevron) → push `choose-voice`.
3. CellGroup "Sending": **"Auto-send after speaking"** with a touch `Switch` (`vs-autosend`, data `on`) = setting `autoSend`.
   Footer "Sends your turn after a pause. For board chats and regular chats alike. Off: you tap Send."
4. The devices notice (`SettingsNotice`, when there is one).
5. CellGroup "Advanced": Speech model, Transcription, Language, Pause before auto-send, Playback speed — each a Cell with its value
   and a chevron opening one P2 `PickerSheet` (`vs-picker`, data `which`), the rows `vs-adv-tts`, `vs-adv-stt`, `vs-adv-language`,
   `vs-adv-pause`, `vs-adv-speed` (data `value`); Language past 8 options gets the pinned search (PickerSheet default). Then
   Microphone `vs-mic` and Speaker `vs-speaker` (chunk 4: their values from the saved setting, "System default" when none; a tap
   opens the device sheet, which lists while open). Then "Skip code blocks" with a touch Switch (`vs-adv-skipcode`, data `on`).
6. CellGroup: **"Remove key from this device"** (`vs-key-remove`), danger, centred, alone → `ConfirmSheet` (P4, `vs-remove-confirm`):
   title KEY_REMOVE_TITLE, body KEY_REMOVE_BODY, confirm "Remove key", danger. Then the screen is in the no-key state.

## Add key (`AddKeySheet.tsx`, P3 `FormSheet`, large detent)
testID `vs-key-sheet`. Head "Cancel · ElevenLabs key · Save"; Save off until something is typed (`canSave`), `dirty` = typed ≠ "".
Body: a field card "API key" (13 pt label) with a hidden monospaced `SecretInput` (`vs-key`, `reveal`, `mono`), a 44 pt eye
`IconButton size="touch"` (`vs-key-eye`, aria-pressed, "Show key"/"Hide key"); a row of two equal 44 pt buttons **Paste**
(`vs-key-paste`, reads `readText` of `platform/clipboard`) and **Test key** (`vs-key-test`, `voice.testKey(typed || undefined)`); a
result line `vs-key-result` (data `tone` ok|danger|muted): "✓ Works: 34 voices found." green / "! <problem sentence>" red /
"Testing…" muted; the privacy line. Save → `voice.setKey(key)`; a refused key → FormSheet `error` KEY_BAD. On save the sheet
closes and the screen re-reads `hasKey`.

## Choose voice (`ChooseVoice.tsx`, P5 `choose-voice`)
testID `cv-screen`. A `SearchField` (`cv-search`, "Search voices") always visible, pinned under the bar. One card of rows `cv-row`
(data `voice`, `selected`): a 44 pt round play/stop (`cv-play`, data `playing`), the name 17 pt, "Playing sample…" accent 13 pt
while it plays, the description 13 pt muted (≤ 2 lines), an accent ✓ on the chosen. The chosen voice first (short list); a tap
chooses (`setVoiceSettings({voiceId, voiceName})`) and stays, so voices can be compared. Under the card "6 of 34 voices"
(`cv-count`) and a **"Show all voices"** cell (`cv-all`) that loads the full list; then "More voices" (`cv-more`) while there is a
cursor. Typing searches the full list (debounced 300 ms). States: `cv-loading`, `cv-failed` with "Try again" (`cv-retry`), `cv-none`.
Stop: the playing row's ■ calls `voice.stopPreview()` — **the one engine addition**: `stopPreview()` aborts the preview clip in play
(and nothing else) — and a preview failure shows its sentence on the row (`cv-problem`), not a popover (no sheet over the screen's
own rows on the phone; the problem store's anchor `preview:<id>` is read by the row).

## Devices (chunk 4) — Microphone and Speaker in Advanced
The rows show the saved choice by name or "System default" without listing; where the platform decides (`choicesFor`'s `show:
"system"` for that kind, known from `ability` without listing) the row's value is "System" and its sheet says the line. A tap opens a
P2 `PickerSheet` (`vs-device-sheet`, data `kind`) that mounts the listing hook while open: System default first, the devices, a saved
one that is gone "(not connected)"; `extra` holds the test (Test microphone with the level meter `vs-mic-test`/`vs-mic-level`, or Test
speaker `vs-speaker-test`) and the notes (`vs-devices-note`), so the head has **Done**. A refused microphone's problem is said in the
sheet (no sheet over the sheet). `neitherLine`: the two rows become one plain cell with the line.

## Words
New sentences go in a block `// ux-s3: Settings › Voice on the phone` appended at the end of `app/src/voice/words.ts`; existing ones
(KEY_*, VOICES_*, ADVANCED_*, DEVICES_*) are reused. The wide dialog's words do not change.

## Files (S3 owns)
`screens/voice/{SettingsDialog,SettingsParts,DevicesSection,DevLine,VoiceChoice,SettingsButton}.tsx`, `settings.ts`, new
`VoiceScreen.tsx`, `AddKeySheet.tsx`, `ChooseVoice.tsx`, `DeviceRows.tsx`, `open.ts`, `ids.ts` (`S3_TID`), `voicerows.ts` (pure:
values of the rows; tested in `app/test/voicescreen.test.ts`), `voicecache.ts`; `voice/logic/settings.ts`; the appended block of
`voice/words.ts`; `voice/engine/keycheck.ts`/`speaker.ts` + `voice/index.ts` for `stopPreview` only. `platform/clipboard.*`: the
read port, byte-identical to ux-s2's (so the merge is clean). Checks: new `UX.S3-voice.mjs` (+ `voicephone.mjs` helpers), the phone
halves of `VC.1`, `VC.8`, and of `VC.2`/`VC.4`/`VC.6` only where they open Settings.
