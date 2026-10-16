# Follow-ups collected while merging

- W5: HOLD line showed as "headless: headless: HOLD" in the server log: fixed in E3 (the process prints `HOLD apply <board>`; the server log adds the one prefix). The knob also takes `hold-before-save:N` (holds the Nth apply of the process).
- W5: board side lacks save-outcome accessor; BoardApi.releaseBoard ifIdle (W8 adds) -> W5's own release could switch.
- W15 docs: AGENTS.md lists packages/headless and its test commands.
- W9: screen calls with Away==nil keep NoClientText error (deviation, sensible).
- W3: mock.mjs doesn't answer follow/unfollow or send scene -> W12.
- W10: no hretry wait name yet (D31); E3 did not need it (one failed start, a second call inside the 60 s answers at once with the same text). -race of cmd/ai-whiteboard not run. DONE (hb-c1): `go test -race ./cmd/ai-whiteboard` ran: ok in the default set (6.9 s) and in the full set (`AIWB_TEST_FULL=1`, 17.5 s); no race.
- W15: Ui.select port still declares o?: {ifFree?, row?}; unused. Docs describe headless writer before engine/shipping were in: recheck after W13/EN9. DONE (hb-c1), first half: `select(sel)` has no options now. The docs recheck (headless writer before engine/shipping) is still open.
- E1: AGENTS.md has no row for web/e2e/away.e2e.mjs (and readers/headlessfail when they land) yet; E4 / final docs pass adds them. DONE (hb-c1) for `away` and `headlessfail`: rows in AGENTS.md. `readers.e2e.mjs` is another agent's and still to add; `faithful` row time set to about 10 s (a run took 8 s).
- EN9: packages/headless/build.mjs (and src/engine.ts) still fall back to a stand-in when @aiwb/board-engine does not resolve; the engine is always there now: make the build fail instead, and tidy those comments. DONE (hb-c1): the build ends with a message when `@aiwb/board-engine/node` does not resolve (test in `test/bundle.test.ts`); comments tidied.
- EN9: engine.md's file list lacks src/page-first.ts and src/skia-binary.ts; Linux musl is not a target (glibc only). DONE (hb-c1): both files listed, glibc-only said.
- W14: add a check in scripts/build-app.sh that Electron's RunAsNode fuse is on (plans/headless-board/w14-fuses.mjs reads it); without it the app's Electron cannot be the runtime. DONE (hb-c1): `scripts/check-run-as-node.mjs`, called by `scripts/build-app.sh` after packaging.
- FX2 known gap (open): if the headless writer is granted the same board again before a call cut by a yield ends, that call's late change could reach the new grant's scene. Needs a release and a new grant inside one call; not guarded.
