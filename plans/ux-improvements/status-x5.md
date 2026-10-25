# X5 — the last pass of the final browser checks (lead: Opus 5.5)

Worktree `.worktrees/ux-x5`, branch `ux-x5` (from `ux-improvements` 52a4a94). DIST `/tmp/x5/dist` (one build, checks-only changes so far).
Failures: the orchestrator's phone run on 52a4a94 (`/tmp/orch/uicheck-phone.log`).

## Phone
| Check | Cause | Fix | Result |
|---|---|---|---|
| SEC.3 SEC.4 SEC.5 | check: `homePartInPage` returned `{ there: false }` before the screen was drawn (D1 defers a row's tap ~60 ms) | orchestrator's side.mjs edit, committed (705d882) | pass |
| UX.C1 | check: `act("select")` pressed Edit here again while the check's own take was under way | orchestrator's sel.mjs edit (705d882) | pass |
| AAC.2-board | check: after `back()` the canvas is still the writer's until the new stream's first scene, with no button: `editHere` (no-op for a live canvas without the button) returned before the window became a reader, so the held drawing was never saved | boarddraw.mjs `editHere` (705d882) + AAC.2-board waits for `board-take` after `back()` (c92b23b); same race fixed in SEC.7-board | pass 3 vp; SEC.7 3 vp pass |
| P7.5 | check, not the orb: after the theme pick the board is reopened; `LIVE` is attached under BoardCanvas's loading cover (`canvas-empty`, zIndex 2) until the view has drawn the scene; the click landed on the cover, the canvas lost focus, Ctrl+A selected the page's text, and Excalidraw's `Edit` toggle stayed `display: none` | P7.5 waits for `board-canvas[data-state=ready]` after reopening (c92b23b) | pass |

## Other users of editHere / select (3 vp)
HB.1, L5, P7.1 (3 vp); SEC.7 (phone + 3 vp); A2.2, A2.3, P0.6, P7.3 (their viewports): all pass with the helpers above.

## Whole suite (heavy lock, DIST /tmp/x5/dist, PORT 4001)
- **Tablet** (`/tmp/x5/uicheck-tablet.log`): 94 of 115; the 21 others are the runner's refusals ("this check runs at desktop, phone" etc.):
  every check that runs at the tablet passes (L16 tablet included).
- **Desktop** (`/tmp/x5/uicheck-desktop.log`): 105 of 115; the 10 others are phone-only refusals: every check that runs at the desktop
  passes (A2.5 desktop included).
- No app code changed: no phone re-run of touched screens needed.

## Tests
Root `npm test && npm run check`, `cd web && npm test`, `cd desktop && npm test`: pass.
