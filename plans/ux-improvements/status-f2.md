# F2 status (lead: Opus; updated by the lead)

Design: `f2-design.md`. Branch `ux-f2`; chunk worktrees `.worktrees/ux-f2-<n>` from `ux-f2`, merged by the lead.

| Chunk | What | Worktree | State | Left |
|---|---|---|---|---|
| 1 | stack descriptors, back plan + unit tests (`stack.ts`, `goback.ts`, `shell.test.ts`) | ux-f2 | done (0ec31fa) | — |
| 2 | homeplace store (`homeplace.ts`, bootstrap, `homeplace.test.ts`, storagescan) | ux-f2 | done (0ec31fa) | — |
| 3 | registry with overlays (`screens.ts`, `screens.test.ts`) | ux-f2 | done (0ec31fa); presenter and PushedRoute moved to chunk 5 | — |
| 4 | NavBack + hold sheet (`BackButton.tsx`, `StackSheet.tsx`) | ux-f2-4 | done, merged | — |
| 5 | route components, PhoneStack on entries, presenter, `select` clears pushed, uicheck seam | ux-f2-5 | done, merged (c4d4770; lead fix: group stand-in's server from its key) | — |
| 6 | D4 layout on native | ux-f2-6 | done, merged (b4b310e) | — |
| 7 | `UX.F2-stack` + L2 updated (L0, L5, HB.1 pass unchanged) | ux-f2-7 | done, merged | P0.3/P0.4 phone failures are on main too |
| 8 | `ux-stack.yaml` device flow | ux-f2-8 | done, merged; passed on the iOS simulator | Android half written, not run (no JDK 17 on this machine) |

F2 done: ux-improvements (F1) merged in; root/web/desktop units, type checks, and `uicheck -- UX.F2 L2 L0 L5 HB.1 L19` at three viewports pass.
