# S2 status (lead: Opus 5.5; chunks: Sonnet 5.5)

Branch `ux-s2` from `ux-improvements` (1cac2eb). Chunk worktrees `.worktrees/ux-s2-<n>` from `ux-s2`, merged by the lead.

## Contract (lead, commit "S2: contract skeleton")
- `screens/servers/open.ts`: `openServersList()`, `openServer(id)`, `openServerCert(id)`, `openServerSheet(id)`/`closeServerSheet()`,
  `openServerEdit(id)`, `openAddServer(how)`; phone pushes/sheets, wide opens the Servers dialog as today.
- Screens registered in `index.ts`: `servers`, `server` {id}, `server-cert` {id}. Hosts in Overlays (`Hosts.tsx`): sheet, edit form, add flow.
- `ServerFacts` {id, place: "screen" | "sheet"} is the one body (D12); `ServerSheet` {id, open, onClose} for H1.
- `ids.ts` (S2_TID), `facts.ts` (pure logic and words; STUB bodies until S2-1).
- Decision: the add flow tests with the code's fingerprint as the pin, so the secret is sent only to the certificate the code names
  (board 04c "Nothing secret is sent until the server's certificate matches the code"); the save stays the person's press.

## Decisions (lead, after the restart)
- The fingerprint as 16 blocks is one component, `facts/Fingerprint.tsx` (lead), drawn by the add flow (04d, 04e) and the certificate screen (05c).
- The clipboard is never read without a press (privacy; iOS asks on every read). "In clipboard" is offered where the platform says so without
  reading: the web build when `clipboard-read` is already granted (the checks grant it); native: no tag (the Paste row reads on its press).
- The add flow's test sends the code's fingerprint as the pin: conn's connector checks the pin in the TLS handshake before hello, so on a
  mismatch the secret is never sent (packages/conn/core/conn.js `attempt`). Manual and paste-without-fingerprint keep today's rule: the
  fingerprint shown plain, compared by the person, "Trust and save" pins it and saves (the save tests again).

## Chunks
| Chunk | What | Worktree | State | Left |
|---|---|---|---|---|
| S2-1 | facts.ts real + app/test/serverfacts.test.ts | ux-s2-1 | done, merged (01e2577) | |
| S2-2 | ui: ActionItem `tag` + ActionSheet `after` group | ux-s2-2 | done, merged (330a5c3) | |
| S2-3 | mock seeds `// ux-s2` + mock-ui `UXS2` + P0.3 DRAWN rows + srv.mjs | ux-s2-3 | done, merged | |
| S2-4 | Servers list screen + phone hand-off of `openServers()` | ux-s2-4 | done, merged; lead to verify on screen | tile -> Tile.tsx (S2-6) |
| S2-5 | ServerFacts (screen + sheet) + ServerDetail (all states, cert notice) + Remove P4 | ux-s2-5 | done, merged; lead to verify on screen | |
| S2-6 | ServerSheet + host + ServerEdit (P3); list uses Tile.tsx | ux-s2-6 | done, merged (7ef9018; index.ts kept the lead's seam) | |
| S2-7 | Add flow: Choose how, scanner look, Check and test, Trust and save, mismatch, toast | ux-s2-7 | done, merged (070bbd3; types and addflow tests pass; on-screen proof by S2-9) | |
| S2-8 | CertScreen: compare + trust P4 + scan compare (paste where no camera) | ux-s2-8 | done, merged (b0b1df5) | |
| S2-12 | Polish after the lead's look (2026-10-23): list problem rows say the reason, not the host (03a: "Unreachable · connection refused", "Too old · update it", "Certificate changed · paused"); cert detail drops "Last connected" (the app does not know it: serverSince is the state's start or first sight, goal 4.6) and its second line that repeats the word | ux-s2-12 | done, merged (31cfb1f) | |
| S2-9 | UX.S2-servers check (phone), reports defects of the screens | ux-s2-9 | done, merged (8141c60): 11 scenarios pass at the phone (uicheck id `UX.S2`) | |
| S2-10 | L7, L3 phone halves on the pushed screens | ux-s2-10 | done, merged (4980dd2): L7, L3 pass at every viewport run one at a time; together in one call the mock did not restart (load) | |
| S2-13 | Other packages' phone checks that still expect the old Servers dialog (AAC.1 first; SEC.1, SEC.7, PL5.2, SEC.2, L11, P0.3, remotechat) | ux-s2-13 | done, merged (9c47439): AAC.1 3 viewports, SEC.1, SEC.7-board, SEC.2, L11, PL5.2, L7 pass at the phone | remotechat phone run (heavy lock held by ux-h2-10) |
| S2-11 | device flows _v4-scan, _v4-localnet*, helpers _add-server/_forget-servers on the new phone screens (iOS) | ux-s2-11 | done, merged (62d42f6): storage-picker-permission and net-pinned-stream pass on iOS (iPhone 17); iPad branches read, not run; Android skipped (no JDK) | |

## Restart 2 (2026-10-23, new lead)
Previous lead and chunks stopped by infrastructure errors. S2-6 verified (types, serverfacts tests) and merged; S2-7, S2-8 re-spawned in
their worktrees; S2-12 spawned in ux-s2-12.

## Restart 3 (2026-10-23, new lead)
S2-12, S2-8 and S2-7 verified (types, unit tests, diff read against 03/04/05) and merged; S2-9 and S2-10 spawned in their worktrees.

## Restart 4 (2026-10-23, new lead)
S2-9 (list, detail pass) and S2-10 (L7 halves written, uncommitted, saved as WIP) re-spawned in their worktrees. S2-9 may fix small screen defects in screens/servers; S2-10 touches no app code.

## Resume 5 (2026-10-23 evening, new lead)
Chunk briefs kept in `.worktrees/.ux-briefs/s2/` (common.md, s2-9.md, s2-10.md). S2-9 re-spawned; S2-10 could not be spawned (cap of running
subagents reached), the lead works it in its worktree.

## Resume 6 (2026-10-23 night, new lead)
Lead fixed S2-9's edit defect (the pushed bar's title stale after a rename) as `ui:` c66cad3 (PushedRoute reads the title through useStore).
S2-9 and S2-10 re-spawned in their worktrees (briefs' done/left updated); S2-11 spawned in ux-s2-11 (brief `.ux-briefs/s2/s2-11.md`).
ux-improvements (4e2e7e5, S1) merged into ux-s2 (3a4053a; sel.mjs: both acts kept); wiring test fixed (9c72b03).
ux-improvements (3aa6bf5: H1, T1) merged (b96a69d): flows routed through H1's _open-foot.yaml; Home's seam gets S2's sheet and add flow (81eda31,
adds `setAddServer` to home/serverseam.ts); UX.H1's chip hold now sees `srv-sheet`. Phone: UX.S2, UX.H1 pass; AAC.1 fails (old dialog) -> S2-13.
Final run on ux-s2 (c926af7): root npm test (1 known conn time-out fail), npm run check, web 99/99, desktop 172/172 pass; uicheck UX.S2 L7 L3 AAC.1 at every viewport pass.
ux-improvements (876ba08: S4, T3, C1) merged (411b243). After it: app tests 1260/1260, check, uicheck UX.S2 L7 L3 AAC.1 at every viewport pass. Handed back; left: remotechat phone run (lock held by ux-h2-10 2 h+), device flows not re-run since the H1 merge, Android.
