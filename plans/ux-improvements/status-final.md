# UX improvements: final state (orchestrator)

Branch `ux-improvements`. Every package of PLAN.md is merged: F1–F3 (foundation), H1, H2, S1–S4, T1–T3, C1, C2, B1, B2, V1, R1, and the fix-up
packages X1–X5 and D1 (device flows). Each package's own record is its `status-<id>.md` here; `coverage.md` maps every mockup to its check.

## Final checks (PLAN §7)
| Check | Result |
|---|---|
| root `npm test && npm run check`, `web`, `desktop` | pass, but `packages/conn` "the real runner … a time-out", which fails on clean `main` too |
| `packages/board-engine` tests, `npm run faithful`; `packages/board-view` harness | pass (faithful: known differences only; harness: 225 messages valid) |
| whole `uicheck` at the phone | 98/115; the rest are tablet/desktop-only refusals and 6 failures, all fixed by X5 and passing alone |
| whole `uicheck` at the tablet, at the desktop (X5) | every check that runs at that viewport passes |
| `UX.R1` (the rules of goal 6.2) | 76 recipes, 504 phone screens, light and dark: 0 failures, 0 skips |
| free e2e scripts | newchat, twopages, readers, away, headlessfail, localserver, voice (60/60), reallibrary (75), desktop e2e: pass. remotechat: one check, "the owner presses Stop…", fails at both phone and desktop, and fails the same on `main` (4f49381) |
| iOS device flows (D1) | 12/13 pass. `board-webview` cannot run here: the simulator's web content process crashes at launch, as it did before this work |
| Android | not run: no JDK 17 on this machine |

## Open for the user
- About › Help points at the repository's README (`HELP_URL`); confirm or give another address.
- Claude's orange agent mark is 2.7:1 on light grounds (its name always stands beside it): a brand-colour decision.
- The image viewer's Save opens the share sheet on iOS (a real save needs `expo-media-library`); Android has no Share or Save in the viewer.
- Wide layouts: Auto-send stays in their speech bar and pill (V1 removed it on the phone only, so tablet and desktop are unchanged as goal 4.2 asks).
- A real-finger try of a partial swipe on chat and board rows, a device flow for speech mode, and Android runs remain to be done on hardware.
