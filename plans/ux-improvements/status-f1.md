# F1 status (lead: Opus 5.5; chunks: Sonnet 5.5)

Branch `ux-f1` (integration of F1's chunks). Each chunk works in `.worktrees/ux-f1-<n>` on branch `ux-f1-<n>`, branched at `5a36cad`.
The first chunks were killed mid-way (login error, SIGTERM); their uncommitted work was reviewed by the lead, judged good, kept
as a WIP commit on each chunk branch, and the chunks were re-spawned to finish from there.

| Chunk | Worktree | What | State | Left |
|---|---|---|---|---|
| F1-1 | ux-f1-1 | Button/IconButton/Switch touch sizes, Switch control, SearchField, SecretInput reveal/mono, DialogActions stacked, haptics (expo-haptics) | done, merged (c6a8fcd) | native haptic only on the device run (F1-9) |
| F1-2 | ux-f1-2 | Sheet detents + head + over, SheetHead, ActionSheet, Menu rows in a sheet | done, merged (c925153) | — |
| F1-3 | ux-f1-3 | Cells, Bars (title fade), `warnText` token, DisclosureChevron | done, merged (c8ca2dd) | — |
| F1-4 | ux-f1-4 | SwipeRow, swipelogic/swipeopen + tests | done, merged (d2a00e8) | — |
| F1-5 | ux-f1-5 | Toast, toaststore + tests, ToastHost in Shell.tsx, useToastLift | done, merged (d86c120) | — |
| F1-6 | ux-f1-6 | PickerSheet (P2) with search, pickerlogic + test | done, merged (29f7d64) | — |
| F1-7 | ux-f1-7 | FormSheet (P3), ConfirmSheet (P4, `over`, `noticeOnly`), `confirm()` as a sheet on the phone, ConfirmRequest.confirmLabel; L7, PL4.1, fork.mjs phone updates | done, merged (90e85da) | — |
| F1-8 | ux-f1-8 | gallery completion (light/dark/mocha), UX.F1-kit sweep + settle wait + themes, L1 and P0.7 phone cases, README row | done, merged (2cf5f5f) | — |
| F1-9 | ux-f1-9 | device: SheetsSelfTest kit page + sheets.yaml 7a–7c (detents, P3 on the keyboard, swipe + long-press haptic); `ui:` FormSheet closes the discard confirm before the form on iOS | done, merged (28b37b0); iOS passed, Android not run | — |

Chunk worktrees 1–7 removed after merging (branches kept). `ux-f1-base` is a detached worktree of `ux-improvements` (ba778f9) for baseline runs; removed at the end.

Known, not F1's: L21 and A4.4 at the phone stop at `[data-testid="tchip"][data-kind="model"]` on clean `ux-improvements` too (ba778f9).

**F1 done** (379a34a + this commit). Final runs on `ux-f1`: root `npm run check` ok; root `npm test` only the known `packages/conn`
"the real runner … a time-out"; `web` 99/99, `desktop` 172/172; uicheck UX.F1 L1 P0.7 ok at phone and at every viewport;
L7 PL4.1 L10 L11 ok at phone/tablet/desktop; L21 ok at tablet/desktop (phone: the known model-chip stop).
