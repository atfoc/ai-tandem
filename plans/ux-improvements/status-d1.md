# D1 — the final iOS device flows

Lead: Opus 5.5. Worktree `.worktrees/ux-d1`, branch `ux-d1` (from `ux-improvements` 25ea7ea). Simulator `ux-d1` (iPhone 17, iOS 26.3,
D0C8D5DF-DC31-41CC-8943-738EE469862D; deleted at the end). Android: not run (no JDK 17 on this machine, notes-foundation.md).

Every flow was run with `app/e2e/run.mjs <flow> --platform ios --device <ux-d1>` under the heavy lock, one at a time. "Attempt" is the runner's
(it makes a second when Maestro failed and the app reported no failure).

| Flow | Result (final) | What failed first, and why | Fix |
|---|---|---|---|
| ux-stack | **pass** (attempt 1) | | |
| ux-rows | **pass** (attempt 1, 3rd run) | (1) its own `_h2-add-server.yaml` drove the old Servers dialog (S2 replaced it); (2) **app**: a left swipe on a Home row also ran the row's press (the group opened under its open actions) when the move came at once and the finger lifted right after (Maestro's synthesized touch; 3/3 by hand with `--hold`); a retry then waited on `_open-app` with the group screen up | flow: the shared `_add-server.yaml` (2988998), `_open-sidebar` at the start (d9b9c0d). **App fix b49d8df**: `SwipeRow` notes its pan (`swiped`, ui/swipeopen.ts), `HomeRow`'s press waits 60 ms and is dropped within 400 ms of a swipe (unit test in swipeopen.test.ts); after it 3/3 by hand and the flow passed |
| ux-board | **pass** (attempt 1, 2nd run): the orb docked in the bottom row, landscape | the Chats sheet's row is read as one label since V1 ("Board-chat, Claude · Fake Sonnet, Voice") | flow: `chats-row` with text `Board-chat.*` (57b6aa8) |
| ux-composer | **pass** (attempt 1, 2nd run) | a new chat opens with the keyboard down since C2 (b0f241c, deliberate) | flow: asserts the keyboard down and the chip row, then taps the box (a164444) |
| — X1 drag-down | **pass** | the drag was an optional step | now **required** (both chats); the drag ends inside the keyboard (iOS `interactive`), `_ux-c1-drag-lower.yaml` (2988998) |
| — T3 tree steps aside | **pass** | no step existed | new `_ux-t3-tree-aside.yaml` at the end of `ux-composer`: hold a row → its actions without the tree; dismiss → tree back; Label… → the form alone; Save → tree back with "⚑ Kbd-mark"; Done (2988998) |
| ux-table | **pass** (attempt 1) | | |
| sheets | **pass** (attempt 1) | | |
| storage-picker-permission (with `_v4-localnet-why`, `_v4-localnet`, `_v4-scan`, `_v4-images`) | **pass** (attempt 1, 3rd run) | (1) after the relaunch it waited for the sidebar's "127.0.0.1 — Connected": the phone's Home says "127.0.0.1 · Connected" under its title since H1; (2) `_v4-scan`: the add form refuses a server already in the list ("Already added as 127.0.0.1", S2) and an earlier part left it | flow: shared `_home-connected.yaml` (339d95a); `_v4-scan` removes the servers first (3d6df8c). Note: a runner retry of this flow fails in `_v4-images` (the photo library keeps the first attempt's pictures): only attempt 1 is meaningful |
| composer-chips (+ composer-chips-gallery) | **pass** (attempt 1, 4th run; verify ok; the gallery part passed) | (1) the rectangle tap missed: the board opens fitted since B1; (2) since B2 the phone's Add selection goes through the board and the reference is a chip beside the box, never inline | flow: tap point (5324086); `_chips-add-selection.yaml` (+ › Add selection › `pick-add`, 23e062b); split into `_chips-phone.yaml` (add, ×, add again; the server's message holds the reference at the caret) and `_chips-inline.yaml` (the old inline-chip steps, wide layouts only); `xcuitest=chips` left the header (its keys are around the inline chip: wide only) (c94f75c, 43fad36) |
| voice-mic | **pass** (attempt 1) | | |
| voice-devices | **pass** (attempt 1; Part 2 needs a real microphone, as before) | | |
| net-pinned-stream | **pass** (attempt 1) | (fixed before its run) the gone "Servers: one is not connected" and the sidebar's "— Unreachable / — Connected" | phone: `problem-card` + `state-word` "Unreachable", `_home-connected.yaml` (339d95a) |
| board-webview | **not runnable here** (2 runs, the 2nd at load ~7) | WebKit's WebContent process dies at launch on this simulator: 22 crash reports in one run, 21 `EXC_BAD_ACCESS SIGBUS KERN_PROTECTION_FAILURE at 0x180000058` in `dyld_sim` `DyldSharedCache::getUUID` ← `dyld4::ProcessConfig::DyldCache`, 1 in JavaScriptCore `DFG::ByteCodeParser::parse`; the cases then fail with "the board view's process ended" (1–2 of 8 pass). Same as B1 chunk 9. The app's board web view itself works (`ux-board`, `composer-chips` draw and select on it) | none (simulator runtime, iOS 26.3) |

Android: not run (no JDK 17 on this machine, notes-foundation.md).

Tests: root `npm test` — one failure, `packages/conn` test/local.test.js "the real runner: … a time-out" (timed out waiting for the state; fails alone too; T3's
status calls it a known conn failure; nothing of D1 touches packages/conn); `npm run check` passes.
- UX.H2 (browser, phone; Home's rows after the app fix): passes.
- Merged ux-improvements (0ae8ec3, X4) into ux-d1: no conflicts.
