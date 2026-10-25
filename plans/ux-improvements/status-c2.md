# C2 — the chip row, the pickers, a new chat's intro, an empty chat: status

Lead: Opus 5.5. Worktree `.worktrees/ux-c2`, branch `ux-c2` (from `ux-improvements` e57fb70). Chunk briefs: `.worktrees/.ux-briefs/c2/`
(common.md + c<n>.md); chunk worktrees `.worktrees/ux-c2-<n>`, ports 46<n>0 (uicheck) / 46<n>1 (mock); results /tmp/c2-<n>/results.md.

## Design decisions (lead)
- The phone's chip row is C2's own (`composer/ChipRow.tsx`); it no longer goes through Toolbar's `only="choices"` (that branch of C1's
  Toolbar.tsx is now unused; left in place, Toolbar is C1's). Which chips: core `logic/chiprow.ts` `chipKinds` (agent while agentOpen, folder
  until the first message or while missing, model · effort while not fixed, subagents on a new chat). Effort has no chip of its own on the
  phone: it is in the Model and effort sheet (co-03a "no 5th chip").
- A chat whose server is not connected or no longer has it: no chip row and no reason line (what blocks it is said once, by V1's block and the
  header); an agent the server lacks: red chip with ⚠, reason line `agent-reason` under the row (13 pt).
- Fork with no message of its own / pending move: the model chip alone, with "Only the model can change" beside it.
- Pickers: Agent and Model and effort are the kit's PickerSheet (search by the kit's rule, past 8 options); Folder and Subagents are Sheets
  with SheetHead. `Segmented` (composer/phone/chips) for effort, depth, running at once. testIDs kept from the wide toolbar where a check
  reads both layouts (`tchip`+kind, `dir-*`, `sub-opt`, `agent-reason`); new ones in `phone/chips/ids.ts`.
- Empty chat (phone): ch-09a's sizes (56/22/16), co-02a's hint text from core `setupHint` ("Choose the agent, folder and model above the box.
  They lock when you send."; it names only what the row shows) in quiet grey, ch-09a's "TRY ASKING" starters (48 pt) above the composer.
- T1's `chat/Thread.tsx`: one style (the phone's empty row grows in ShortThread) so the starters stand above the composer.
- On the phone a chat with a chip row opens with its box unfocused (composer/index.ts registers focusSelectedBox with a keepOff rule; C1's focus.ts gained an optional `keepOff`), so the keyboard does not hide the choices.
- `ui:` commits a80892a (PickerSheet `foot?`, a line under the list without Done) and c6f9252 (Menu iconSlot minWidth/minHeight 24 instead of a fixed 24: larger icons widen it).

## Chunks
| # | What | Worktree | State |
|---|---|---|---|
| 0 | skeleton: ChipRow, chiprow.ts (+test), Segmented, sheet stubs (lead) | ux-c2 | done a6b7300 |
| 1 | Agent + Model and effort sheets | — | merged (08113e2) + ui c6f9252 (sheet icon slot grows for 34-pt tiles); screenshots ok vs co-03a/b; mock has no pi multi-provider catalog nor a missing-agent seed (chunk 6) |
| 2 | Folder sheet | — | merged (a50ba04); screenshots ok vs co-03d/f. Web: the kit Sheet gives no footer on web, so the body has minHeight window−200 and a sticky "Use" (kit note for F1/R1); dir-path/dir-up/dir-input/dir-err are in the sheet head, outside `dir-browser` |
| 3 | Subagents sheet | — | merged (23157b5); screenshots ok vs co-03c |
| 4 | Empty chat / new chat's intro (phone) | — | merged (6e36913) + lead: starters at the foot (Thread.tsx one style, commit "chat: …"); hint tone muted (faint < 3:1); L10 tablet ok; L10 phone fails at :174 (busy line has no dots: T1/T2) and :201 (waits `send`: phone composer) — not C2's empty thread |
| 5 | S1.1-subagents tablet/desktop: fix or predates | — | merged bc8455b: check-only; narrow page = phone layout (C1), started-chat panels predate (e59ad9c, voice pair kept longest); tablet+desktop pass. Phone half of S1.1 still to redo (chunk 7) |
| 6 | mock seeds + UX.C2-pickers + P0.3 rows + mock-ui section | — | merged (616ffc1); lead: segments 44 pt inside the track's border, SEG_MIN 44; UX.C2 phone ok (lead, dist 1afcbfb+). Seed UXC2 adds a remote "Pi box" (only P0.3 and P7.1 seed every section). P0.3 phone: UXC2 rows ok; A2.plain-loading / plain-fork-fresh = 7a; board ones pre-existing |
| 7a | composer.mjs phone picker helpers; A2.3 A2.4 A2.5 A2.6 P7.1 P0.6, SEES/P0.3 fork-fresh | — | merged (b361a24). Lead after it: ui f760d38 (Button row maxWidth: a long label wraps), 87118e8 (Use <folder> wraps, path head-ellipsis on web, disabled chip muted not faded, P0.3 plain-loading phone row). Phone ok: A2.3 A2.4 A2.6 UX.C2, P7.1 composer stages. Not C2's: P7.1 phone tool cards (T2), A2.5 phone sub meter (T2), A2.5 desktop board-new 400 px (fails on base) |
| 7b | L16 A4.2 A4.4 fork.mjs P0.4 L21 S1.1 (phone) L19 (brief c7b.md) | — | merged (c2a4a4e): phone ok L16 A4.2 A4.4 P0.4 S1.1 L19; wide ok. L21 phone stops at :73 library-btn (H1's Home, not C2's; its new chip-sheet section passes). L16 tablet effort chip fails on base too (pre-C2, C1 noted). Lead after it: model chip kept during a fork's pick; P7.1 phone branch-send stage reads Talk; A4.2 busy seconds |
| 8 | device: composer-chips.yaml onto Home + _ux-c2-chips (row, model and folder sheets), one iOS run | ux-c2-8 (kept for the run) | flows merged (bbc4700). Resume 1 (4 runs): reached the chat; found that a new chat opened with the keyboard up, hiding the row (fixed by the lead b0f241c: on the phone a chat with a chip row opens unfocused); shared _add-server ended on S2's placeholder (S2 now merged). Resume 2: merged (1a76704): shared _add-server again (S2), Edit here before the selection; on the iPhone 17 simulator the C2 steps (row in sight, model sheet, folder sheet) PASS; the flow then fails at C1/K2's caret check `caret-at-chip-start` (tap points measured on an iPhone 16e; new iPhone 17 estimates committed, not run). After B1's merge the flow taps the Chats sheet's row (not run) |

## Known failures, not C2's (for the final runs)
- Wide toolbar fit (core composerfit / C1's Toolbar): at the tablet a new chat's effort and subagents chips sit in "⋯" though the row has room —
  the same on `main` (screenshot /tmp/c2-lead/tab-main-crop.png): L16 tablet stops at `tchip[data-kind="effort"]` (L16:450).
- A2.5 desktop "board-new in a 400 px panel: 0 elements match tchip[title^=Model]" — fails on unmodified ux-c2's A2.5 too.
- A2.5 phone "a subagent's meter: none on the page of a thread with a subagent" — T2's phone sub-card has no ctx-meter.
- P7.1 phone "the tool cards" stages (T2's cards at the phone).
- (L21 phone passes after the merge of X1.)
- L10 phone :174 (busy line has no dots) / :201 (`send`) — X1 has since rewritten L10's phone half.
- The View-only board waits (`canvas.interactive`, A2.board-selected, A6.board, SEC.board) — B1's.
- packages/conn "the real runner: … a time-out" (unit test).

## Merges
- 24 Oct: ux-improvements (X1, H2, S2, T3) merged into ux-c2 (dcc025b). Root check ok; root test only conn "real runner"; web 99/99; desktop 172/172.
  Final dist /tmp/c2-lead/dist-final (dcc025b); final runs VF-phone, VF-wide spawned (brief vf.md).
- VF-phone (dist-final dcc025b): ok UX.C2 A2.3 A2.6 L16 A4.4 P0.4 L21 S1.1 L19; A4.2 load-sensitive once (passes alone); A2.5 = T2's sub meter;
  P0.3 = the three View-only board states (B1's); A2.4 and P7.1 phone composer stages read `usage-pop` where the phone ring opens T3's `usage-sheet`
  (the phone opener tables of 7a): fixed by the lead, A2.4 phone ok, P7.1 PART=composer phone ok; P7.1 tool-card stages = T2's.
- VF-wide (dist-final dcc025b): tablet ok A2.3 A2.5 A2.6 A4.2 A4.4 P0.4 L21 S1.1 L19; desktop ok A2.6 L16 A4.2 A4.4 P0.4 L21 S1.1 L19.
  A2.4/P7.1 (tablet, desktop) read `usage-pop` where a ring in a window < 700 px opens T3's sheet: fixed by the lead (2382d36), A2.4 tablet+desktop ok,
  P7.1 PART=composer tablet+phone ok, desktop = the View-only board wait only. Known: L16 tablet (wide fit, as main), A2.3/P7.1 desktop board wait (B1),
  A2.5 desktop 400 px panel (fails on base).
- After the focus fix (b0f241c): phone ok UX.C2 L16 L21 A2.3 UX.C1 A4.2 A4.4 P0.4.
- 24 Oct (later): ux-improvements (B1) merged (9d33be9). Root check ok, root test ok (all), web 99/99, desktop 172/172. UX.C1's board-chat step and
  composer-chips follow B1's Chats sheet (ebdca14). Phone ok UX.C2 UX.C1 A2.3 A2.4 A2.6 S1.1; tablet ok A2.4 A2.6 S1.1.
- DONE, handed back. Chunk worktrees all removed. Left: one device run of composer-chips to confirm the iPhone 17 tap points and the Chats-sheet step;
  Android not run (no JDK 17).
