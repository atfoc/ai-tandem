# H2 status (lead: Opus; design: h2-design.md; briefs: .worktrees/.ux-briefs/h2/)

| Chunk | What | Worktree | Model | State |
|---|---|---|---|---|
| 0 | design, ids, contract stubs, chatWord "Waiting for background work" + L11 assert | ux-h2 | lead | done (0b28faf) |
| 1 | Rename sheet (P3), openRename | ux-h2-1 | sonnet | done, merged (473414d); ui: 59ac9d5 Sheet/FormSheet dataSet |
| 2 | row actions: swipe, P1 sheet, Move to, archive+Undo, P4 deletes | ux-h2-2 | sonnet | done, merged (b2c4ea3); its ui: ActionSheet dataSet (b33c205 renamed data→dataSet in the merge); wiring.test deleteBoard assert |
| 3 | New sheet + Where page | ux-h2-3 | sonnet | done, merged (8eb4c7c); its ui: Sheet dataSet duplicate dropped for chunk 1's |
| 4 | Settings › Archived | ux-h2-4 | sonnet | done, merged; Delete swipe uses sidebar deletes until chunk 2 (askDelete) |
| 5 | Search | ux-h2-5 | sonnet | done, merged; storagescan.test one line (home/recent.ts key); New chat with the words via putDraft |
| 6 | drag after the hold (HomeRow + drag.tsx option) + L14 phone half | ux-h2-6 | sonnet | done, merged (459ef39): L14 phone/tablet/desktop ok; sheet opens on release (rows.mjs, SEC.5 now longPress) |
| 7 | mock seeds UXH2 + UX.H2-rows + P0.3 DRAWN + README row | ux-h2-7 | sonnet | done, merged (f6cd20a); report lost, verified by the lead |
| 8 | SEC.5, SEC.10 phone halves | ux-h2-8 | sonnet | done, merged: SEC.5 phone/tablet/desktop ok; SEC.10 untouched (no rows), its phone half fails at quote-sheet (SEC.10:72), not H2; reports a board row's sheet closing ~300 ms after a released long press (chunk 6 opens on release) |
| 9 | openFoot archived path; SEC.1, SEC.4, SEC.6, L11, A6.4, A1.5, UX.H1 phone halves (Archived, New sheet) | ux-h2-9 | sonnet | done, merged: phone+tablet+desktop 6/6 each (on a base without chunks 2, 5: rerun in the final runs); new rows.mjs readers |
| 10 | ux-rows.yaml on iOS (own simulator ux-h2) | ux-h2-10 | sonnet | done, merged (89c8106): ux-rows passes on iOS (run 6; runs 1-5 flow-writing); Android skipped (no JDK 17) |
Lead (after chunk 6 merge, 459ef39): phone SEC.5 L14 SEC.4 UX.H1 4/4 ok.
Chunk 7 (a32b2d20f90a) finished, report lost: branch ux-h2-7 673cae9 (UXH2 seed, UX.H2-rows, rows.mjs readers, P0.3 rows, README). Its P0.3 phone run: 52 FAIL, all chat/board states 'together' (chat-head missing); lead runs P0.3 on ux-h2 without UXH2 to see if they predate it.
Lead: H2 regression found and fixed (feb41ba): home/index.ts read the store at import, before bootstrap's kv: a page opened on a chat showed Home (UX.T1, P0.3's 52 chat/board states at phone). watchOpened() now starts with Home. UX.H2-rows opens sheets with longPress.
Lead: phone UX.H2 UX.T1 ok (f6cd20a); P0.3 phone alone (LIMIT=1800): 74/74 drawn, only the 3 known B1 board lines fail.
Final (lead, after merging ux-improvements e57fb70 → 6f90b13): root npm test (only the known conn "real runner … time-out"), root check ok,
web 99/99, desktop 172/172. uicheck phone UX.H2 UX.H1 SEC.1 SEC.4 SEC.5 SEC.6 L11 L14 8/8; tablet and desktop SEC.1 SEC.4 SEC.5 SEC.6 L11 L14
A6.4 A1.5 8/8 each; phone UX.T1 ok, P0.3 only the 3 known B1 board lines; phone A6.4 (permission card's Allow in accent, T2) and SEC.10
(quote-sheet wait) fail: checked against a base build.
Base build (ux-improvements e57fb70) with H2's checks, phone: A6.4 fails the same Allow line (T2), SEC.10 the same quote-sheet wait: neither is H2's.
Handed back (lead): ux-h2 89c8106 + this status. Open for a device/person: under Maestro's one-move finger a partial swipe on a chat/board row ended as a tap, and a full swipe also opened the chat under the toast (the group row swipes fine; the browser checks' many-move finger passes) — confirm with a real finger.
