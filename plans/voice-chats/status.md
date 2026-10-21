# Voice chats: where the work stands

All packages of `packages.md` (P0–P18), the follow-ups P14F, P19, A4F and FX1 are merged on `voice-chats`. Nothing under
`cmd/` or `internal/` changed (`git diff main...voice-chats -- cmd internal` is empty).

## Checked on the integrated branch

- `go test ./...`; root `npm test && npm run check`; `cd web && npm test`; `cd desktop && npm test`;
  `cd packages/conn && npm test`: pass.
- `cd web && npm run uicheck -- VC.1 … VC.7` (VC.5 has two files) and the existing checks of the screens changed:
  pass, except the board view-mode states that fail the same way on `main` (P0.3's board states, A6.3-board, and the
  `board-selected` state of A2.2, A2.3, P0.6, P7.1, P7.3). Checks that stop at that state leave the states after it
  unproven, on `main` as here.
- `cd web && npm run uicheck:electron -- VC.1 VC.5`: pass.
- `node web/e2e/voice.e2e.mjs` (42 checks, the canary key search), `node web/e2e/newchat.e2e.mjs`,
  `cd app && npm run build:web && cd ../desktop && npm run e2e`: pass.
- Playwright 1.63.0 / Chromium 153. Chromium's fake microphone never answers `getUserMedia` on this machine (on 156
  too); the checks feed the page a synthetic stream (`web/dev/checks/mic.mjs`) and say so.

## Left to the person

- `node app/e2e/run.mjs voice-mic --platform ios --device <udid>` once, from a terminal allowed to use the Mac's
  microphone: here the microphone could not start (the Mac's permission for this session is undetermined), so the
  16 kHz / 100 ms chunks on the simulator are unproven. Android: only the Kotlin compile ran.
- A run against the real ElevenLabs with their own key on an iPhone, an Android phone and the desktop app (Test key,
  dictation, speech mode, read aloud, the pill); interrupting by speaking on the phones; the macOS microphone prompt.

## Departures from the goal and choices to confirm

- The page's CSP is not changed (goal 4.4, 7.4): on the desktop, main makes the ElevenLabs calls with the key, so the
  key never enters the page; the web build (tests only) calls the stand-in on its own origin.
- Settings is a new dialog (the app had no Settings screen), opened from a gear in the sidebar foot. The foot now wraps
  to two rows at the default sidebar width.
- The mic mark is kept on the device that sent the turn (no stored field can carry it without the server).
- There was no Copy action: Read aloud sits beside Branch, Fork and Label. In a narrow pane the hover bar shows icons.
- The camera and image-picker plugins now carry the microphone text (with `false`, Expo removes the iOS text and
  blocks Android's RECORD_AUDIO).
- Hold Space on the board: a tap is the orb, a hold is push-to-talk; Space stays the canvas's (panning) while the
  canvas has the focus, so panning never opens the microphone. Desktop window and web build only.
- On a narrow composer row the voice pair goes to the "more" popup; the chip it brings can take the meter's text
  (415–460 px panels show the ring) and on the phone the effort chip moves into the popup.
- Interrupting by speaking ships on iOS and Android only (echo cancellation); a tap interrupts everywhere.
