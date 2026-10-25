# S1 — Settings, Appearance, About: status

Lead: Opus 5.5. Branch `ux-s1`, worktree `.worktrees/ux-s1`.

## Design decisions (lead)
- Folder `app/src/screens/settings/`; registers `settings`, `appearance`, `about`. `openSettings()` (index.ts) = `pushScreen("settings", {})`
  for H1's gear (gear testID proposed: `home-settings`).
- Placeholders for `servers`, `library`, `archived`, `voice-settings` are registered **only if the name is free** (so the owner's
  registration wins in any merge order); each opens today's dialog (Servers, Library, Voice) or holds Show archived, params `{}`.
- Catppuccin flavours: a P2 `PickerSheet` opened from Appearance (as mockup 07b draws), not a pushed screen: no `flavours` screen.
- The theme stays one stored value (`aiwb.theme`, nothing stored changes): Light/Dark/System checked when chosen; with a flavour on,
  none of the three is checked and choosing one turns the flavour off. Flavours offer the four (no "Off" row): a theme turns it off.
- About: Version (fact), Help ↗ (HELP_URL, the repository's README: to be confirmed by the user), Server log (desktop app only).

- Checks reach Settings by Home's gear (`home-settings`) when it is there, else through the uicheck seam (`window.__aiwbStack.push("settings", {})`).
- Resumed after an infrastructure stop ("Not logged in"): chunks 1 and 2 had committed; nothing was lost.
- Resumed again: chunk 3 had committed the check but not the phone halves; those are chunk 4. A6.1/A6.2 on the phone choose in
  Settings › Appearance and say nothing of the sidebar foot there (H1's Home decides whether the phone keeps it).

## Chunks
| # | What | Worktree | Model | State |
|---|---|---|---|---|
| 1 | rows logic + Settings + About + placeholders + register | ux-s1 | sonnet | done (bb367a9), verified |
| 2 | Appearance + flavours P2 | ux-s1-2 | sonnet | done (736e66c), merged into ux-s1; lead registered `appearance`, dropped its placeholder and duplicate ids |
| 3 | UX.S1-settings + settings.mjs + sel.mjs acts.openSettings | ux-s1 | sonnet | done (33ca247), verified: UX.S1 ok at the phone, shots match 07/13 v2/07b |
| 4 | A6.1/A6.2 phone halves through Settings › Appearance; P7.1 header | ux-s1 | sonnet | done (d786676); ux-improvements merged (5b4405a) |

- Resume 6: chunk 4 had committed and the lead had merged ux-improvements; only the final verification was left.

## Verification (resume 6)
- Lead fix 1a649e4: the Archived placeholder wrote `aiwb.archived` itself (app/test/storagescan failed); it now calls the sidebar
  foot's new export `setShowArchived` (screens/sidebar/Foot.tsx, append-only; the foot's behaviour unchanged).
- Root `npm test`: app 1100 tests pass after the fix; `packages/headless` bundle.test "with the engine's folder missing … exits 3"
  times out at 30 s (alone too; its sibling is a known load-sensitive one, notes-foundation; S1 touches nothing there). `npm run check` ok.
- `cd web && npm test`: only voicestandin "the command prints its address" (known load-sensitive). `cd desktop && npm test` 172/172.
- uicheck UX.S1, A6.1, A6.2: ok at the three viewports. P7.1: ok at phone and tablet; desktop fails in its composer part
  (`.excalidraw:not(.excalidraw--view-mode) canvas.interactive` never visible: the board opens read-only for the "select" state),
  the same on a build of ux-improvements c6abecc without S1: pre-existing, B1's/readers' side.

## Left
- nothing in S1; ux-s1-2 removed.
