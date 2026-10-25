# H1 status (lead: Opus; design: h1-design.md)

| Chunk | What | Worktree | Model | State |
|---|---|---|---|---|
| 1 | model.ts + test, ids, HomeRow, HomeList, rowactions stub, seam | ux-h1 | sonnet | done (d58c14c, 4dd0f76) |
| 2 | Home, chips, GroupScreen, HomeRoute, lastsync, stubs (newsheet, search, settings), stop-gap sheets | ux-h1 | sonnet | done (b6f3c0f + offlineToast commit); checked by the lead (types, home tests) |
| 3 | ProblemCard, FirstRun, EmptyHome, Placeholders | ux-h1-3 | sonnet | done, merged (4cf2890) |
| 4 | mock seeds UXH1 + "no server" knob | ux-h1-4 | sonnet | done, merged (67912a8) |
| 5 | home.mjs readers + UX.H1-home check + README row | ux-h1-5 | sonnet | done, merged; UX.H1 passes at phone (lead, resume 5) |
| 6 | sel.mjs phone path, side.mjs homeOf, SEC.1–SEC.10 phone halves | ux-h1-6 | opus | done, merged (724f03d): SEC.1–10 pass at phone, tablet, desktop (mock-start timeouts under load, passed on rerun) |
| 7 | web/e2e/lib/ui.mjs phone navigation + remotechat phone | ux-h1-7 | sonnet+lead | done, merged. remotechat phone: steps 1–3, M pass on Home; 7–10 fail on the known phone tchip failure (C1/C2). Desktop: step 7 "owner presses Stop" fails with the base ui.mjs too (not H1) |
| 8 | device helper flows (_open-app, _open-sidebar, _to-sidebar, _open-foot), ux-stack on iOS | ux-h1-8 | sonnet | done, merged (7615d29): ux-stack passes on iOS with the lead's ui: fix dd61866 (PlaceBar onLayout); net-pinned-stream, storage-picker-permission still assert sidebar text (not run); Android skipped |
| 10 | P0.3-smoke at the phone: phone counterparts of A1.*, A3.tree, SEC.sidebar; UXH1.trouble/nested | ux-h1-10 | sonnet | done, merged (689f641): P0.3 phone/tablet/desktop fail only the 3 known board lines (B1) |
| 11 | phone foot through S1's Settings (gear now pushes Settings after the S1 merge): openFoot, settings.mjs gear id, H1 phone halves, ui.mjs, _open-foot.yaml | ux-h1-11 | sonnet | done, merged (f2d72f1); worktree removed |
| 9 | phone halves of L11, AAC.1, AAC.3, L2, UX.F2-stack | ux-h1-9 (ff to ux-h1-6 0d32404) | sonnet | done, merged (5f11c98): pass at phone, tablet, desktop; reports a chat `waiting` with no subagents reads "Writing…" on Home (F3 chatWord) |

Lead wrote: serverseam.ts (openServerSheet/setServerSheet/openServerDetail/openAddServer, the stop-gap sheet's store), the four
state-component stubs with fixed props (chunk 3 filled them).
Resume 2 (after the second interruption): chunk 2 found finished on ux-h1 (WIP commit), chunk 3 finished in ux-h1-3.
Resume 3 (after the machine restart): no lock held, nothing running; chunks 5, 6, 7 re-spawned in their worktrees.
Resume 5: the chat's subagent cap was full (other leads), so the lead works the chunks itself where it cannot spawn. Lead fix 4306ed5
(+ New centred / margin).
Resume 6: nothing running, no lock; ux-h1-6's uncommitted Home.tsx/h1-design.md change committed (0d32404); chunks 6, 8, 9 re-spawned.
Resume 6 sids: chunk 6 6481a5a344e8 (opus), chunk 8 b19e3acaba47, chunk 9 9289aba550e4.
Lead (resume 6): ui: dd61866 PlaceBar; 56311f9 thiscomputer knob through safeGet (storagescan test); merged ux-improvements c6abecc. Phone run of UX.H1 AAC.1 P0.3: UX.H1, AAC.1 ok; P0.3 12 failures -> chunk 10.
Final (lead, resume 6): P0.3 phone twice with the runner's own mock: A1.*, A3.tree, SEC.sidebar pass; the 3 known board lines (B1) fail; then a mock restart in the UXH1 states fails (shot.mjs:150, empty log, load); UX.H1 covers those states and passes. Not handed back yet: merged ux-improvements 4e2e7e5 (S1) -> 77fedf1 (register.ts conflict: both imports); the gear now pushes S1's Settings, so chunk 11.
Final (resume 6): UX.S1 phone waits fixed (b1032e8, S1's file); phone UX.S1 UX.H1 SEC.9 ok on the final build; remotechat phone not run (heavy lock held by C1/S2 device runs). Handed back.
After T1 merge (444d9ca): phone UX.T1 UX.H1 L11 ok; P0.3 phone 69/69 drawn, only the 3 known board lines (B1). Handed back.
