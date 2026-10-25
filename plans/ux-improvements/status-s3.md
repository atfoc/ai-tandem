# S3 — Settings › Voice, Choose voice, Add key: status

Lead: Opus 5.5. Branch `ux-s3` (from ux-improvements 4e2e7e5), worktree `.worktrees/ux-s3`. Design: `s3-design.md`.
Chunk briefs: `.worktrees/.ux-briefs/s3/` (`common.md`, `c<n>.md`). Ports: chunk n uses uicheck PORT 58n0, dist `/tmp/s3-<n>-dist`.

## Chunks
| # | What | Worktree | Model | State |
|---|---|---|---|---|
| 1 | Voice screen skeleton: ids, words, voicerows + test, VoiceScreen (both states, Sending, Advanced P2, Remove P4), open.ts, registration, phone routing; stubs AddKeySheet/ChooseVoice/voicecache | ux-s3 | sonnet | done (f243a7e), verified: screenshots match 07 and 07b |
| 2 | Choose voice P5 + `voice.stopPreview()` | ux-s3-2 | sonnet | done (ab2cdba), verified (look script all ok, screenshots match 07b), merged |
| 3 | Add key P3 complete (eye, Paste via clipboard readText identical to ux-s2, Test key, result line) | ux-s3-3 | sonnet | done (476e65e), verified, merged |
| 4 | Microphone/Speaker rows + device P2 sheet (lists only while open), tests in `extra` | ux-s3-4 | sonnet | done (165986c), verified, merged |
| 5 | `UX.S3-voice` check (phone, light + dark) + P0.3 rows if any | ux-s3 | sonnet | done (03c531f), verified: UX.S3, UX.F1, UX.S1 ok at the phone after the lead's ui: Cells fix |
| 6 | VC.1/VC.8 phone halves; VC.2/VC.4/VC.6 phone "Open Settings"; README rows | ux-s3 | sonnet | done (b2b127d), verified: UX.S3 VC.1 VC.8 ok at the phone; lead fix: the screen holds the Settings-open flag |
| 8 | UX.S3/VC phone halves follow H1's Home (no foot on the phone) after merging ux-improvements 551ea4e | ux-s3 | sonnet | done (09821a8), verified |
| 7 | device: `voice-devices.yaml` on own iOS simulator (Advanced pickers moved) | ux-s3-7 | sonnet | flows rewritten (a20e47a, e1201f8), merged; runs by the lead: voice-devices PASSED on iOS |

## Lead decisions during the work
- `ui:` 0f620a5 — a Cell that holds its own control (a switch, no onPress) is neither disabled nor one accessibility element (its
  aria-disabled passed to the switch). Plain fact cells, pressable and disabled cells unchanged.
- 424e3b1 — on the phone the Voice screen holds the voice store's Settings-open flag while mounted, so leaving it ends Settings' notice and a
  microphone test as closing the dialog does.
- Playing a sample opens the audio output and lists devices (existing engine behaviour; it is a use of voice). The Voice screen, Add key and
  Choose voice list nothing by themselves.

## Final runs (after merging ux-improvements a0ae381 → 3cc1efa; dist /tmp/s3-F-dist)
- root `npm test` exit 0, `npm run check` exit 0; `cd web && npm test` 99/99; `cd desktop && npm test` 172/172.
- uicheck at the three viewports: UX.S3 ok, VC.1 ok, VC.8 ok (tablet failed once in the run of three, "the sound is held after a public
  speaker was lost", a session scenario; ok alone: load-sensitive), VC.3 ok, VC.4 ok, VC.6 ok, VC.7 ok, UX.S1 ok.
- `node web/e2e/voice.e2e.mjs` (heavy lock): passed, 60 checks.
- Pre-existing, the same on a build of ux-improvements a0ae381 without S3: VC.2 phone (waits for `msg-sheet` in fork.mjs openActs: the
  Read aloud control through T1's message sheet), VC.5-readaloud phone ("Read aloud is not the last of the reply's actions
  (read,branch,fork,label)"), VC.5-hoverbar desktop (locator.waitFor timeout). T1's/V1's side.

## Final runs after merging ux-improvements 551ea4e (dist /tmp/s3-G-dist)
- root `npm test`: only the known packages/conn "real runner … a time-out"; `npm run check` ok; web 99/99; desktop 172/172.
- uicheck at the three viewports: UX.S3 ok, VC.1 ok, VC.8 ok, UX.S1 ok; VC.3/VC.4/VC.6 ok at tablet and desktop.
- `voice.e2e` after the merge: steps 1–7 pass; step 8 (devices) fails on a lost connection to the scratch server, at different points per
  run ("the spoken message is stored … POST …/messages -> 503", "(await stateOf()).chats undefined"); the baseline run on ux-improvements
  d8a1855 without S3 fails in step 8 the same way ("This computer" never Connected): pre-existing, not S3's. (Before this merge: 60/60.)
- S3's chunk 7 left the heavy lock held by a dead run (its exit trap never ran); the lead released S3's own lock and stopped its scratch
  server (pid 94009). The lead runs the device flows (/tmp/s3-7/run.sh) in the background.
- Fail the same on a build of ux-improvements d8a1855 without S3 (pre-existing; composer C1, Home H1, message sheet T1; VC phone halves are
  V1's): VC.3 phone ("the message is … not the box's text"), VC.4 phone (`more-chip` tap timeout), VC.6 phone ("the chat the first turn made
  is not under the board's row in the sidebar"), VC.7 all viewports ("in a row of 542 px the pair is not in the popup"), VC.2 phone (waits for
  `send`; past it, `msg-sheet`), VC.5-readaloud phone, VC.5-hoverbar desktop.

## Device (iOS, own simulator, deleted after)
- `voice-devices` PASSED (after the lead's 392da75: `_voice-back` lands on Home). `voice-mic`: Settings › Voice, Add key, Test key, Save and
  Dictate pass; it fails later at its Read aloud step (`tapOn point 92%,20%` then "Read aloud" visible): the message's actions are T1's
  message sheet now (same as VC.5-readaloud phone) — V1's/T1's. Android not run (no JDK 17 on this machine).

## After merging ux-improvements 7284225 (B1, X1) → 6b63097
- root `npm test`: only the known packages/conn time-out; `npm run check`, web, desktop: ok.
- uicheck (dist /tmp/s3-H-dist), three viewports: UX.S3, VC.1, VC.8, UX.S1 ok; VC.4/VC.6 ok at tablet and desktop, their phone halves fail as
  on the base (pre-existing, above).

## Left
- Nothing in S3. Handed back.
