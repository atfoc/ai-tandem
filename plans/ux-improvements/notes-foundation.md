# What the foundation packages left for the area packages

F3 (state words), F1 (phone kit) and F2 (stack) are merged on `ux-improvements` (`367dbd4`). Read this with PLAN.md §2;
where they differ, this file wins (it records what was built).

## F3 — state words
- `useServerWord(view)` (in `ui/StateWord.tsx`) passes the store's `localNetworkDenied` into `serverWord`: screens use it rather
  than building the context themselves.
- `State.serverSince` is stamped on a change of a server's state key and when an entry is first seen. `formatSince(ts, now)` is in
  `packages/core/src/logic/statewords.ts`: "since 9:12" (24 h, local), "since yesterday", "since Oct 3".

## F1 — the kit
- Additions (optional props, nothing renamed): `Sheet` `over?: "form"` (the one allowed sheet over a sheet; any other warns in dev);
  `PickerSheet`/`ConfirmSheet` `over?: "form"`; `ConfirmSheet` `noticeOnly?`; `ConfirmRequest.confirmLabel?`.
- New exports: `Switch` control (`Switch.tsx`); `useToastLift(px)` (`Toast.tsx`) — a screen with a bottom bar (the composer) calls
  it so the toast stands above it; `DisclosureChevron` (`icons.tsx`); logic files `swipelogic.ts`, `swipeopen.ts`, `toaststore.ts`,
  `pickerlogic.ts`.
- New token `warnText` for readable amber text; `warn` stays for marks and dots.
- `confirm()` on the phone draws a ConfirmSheet when the request has ≤ 1 action (testID stays `confirm-dialog`); more actions stay
  the dialog (only `deleteGroup` in `sidebar/actions.ts` does that today).
- Haptics: import `"../platform/haptics"` with **no extension** (it is split `.native.ts` / `.web.ts`; an import with an extension
  type-checks but breaks the web build).
- `FormSheet` on iOS closes its "Discard changes" sheet first and the form 400 ms later (closing both at once empties iOS's
  accessibility tree).
- The kit gallery is `/?gallery=kit` (one section per part in `app/src/dev/kit/`); check `UX.F1-kit` (`web/dev/checks/kit/`).
- Device: the dev client's floating dev-menu button covers sheet heads on the simulator; the one-time `defaults write` fix is in
  `app/e2e/README.md`.

## F2 — the stack
- A Back from content lands on the content's **group screen** first, then Home. A check that does one back from a grouped board
  or chat and expects the list needs a second back (`sel.mjs` `showSide()` already loops).
- `StackEntry` has two more fields, `route` and `id`. `HomePlace.server` is the server's **entry id** (`LOCAL_SERVER` for this
  computer); H1's server chips map to these ids.
- `pushScreen(name, params, { onPop? })`; `popScreen(key?, { quiet? })`; also `pushOverlay`, `clearPushed`, `pushedEntries`,
  `setPushedContent`, `usePushedContent`. `select()` clears the pushed screens when the board or chat changes.
- F2's ids live in `screens/shell/phone/ids.ts` (`group-row`, `group-item`, `pushed-screen`, `uicheck-screen`), not `ui/tid.ts`.
- `GroupRoute` in `phone/HomeRoute.tsx` is a plain stand-in for H1 to replace.
- uicheck builds expose `window.__aiwbStack` (a seam to read the stack and call `goBack`).
- `app/e2e/lib/serverctl.mjs` has `POST /group` and a `group=` parameter on `/board` and `/chat`.

## Known failures that predate this work (do not chase them as yours; fix them if your package owns the screen)
- `packages/conn` unit test "the real runner: … a time-out" fails on clean `main`.
- Phone viewport: `P0.3` stops at `A2.board-selected: waitForSelector timeout` (board in view mode on the phone) — B1's screen.
  `P0.4` (`P0.4-routes.mjs:413`) and `L21` stop waiting for `tchip[data-kind="model"]` — the composer's chips (C1/C2).
- Load-sensitive (fail under load, pass alone): `web/dev/host.test.mjs` "with --local-bin …", `voicestandin.test.mjs` "the command
  prints its address …", `packages/headless` "a bad configuration … exits 3", uicheck "the mock did not start on port …".

## Devices
- iOS: each lead makes its own simulator (`xcrun simctl create ux-<id> "iPhone 17"`) and deletes it after.
- Android: this machine has no JDK 17 and no running emulator; Android device runs are skipped and listed as left in the report.
- The dev client now includes expo-haptics (one rebuild already done by F1).

## Shared machine
- Never kill processes by name or pattern (`pkill -f dev/mock.mjs`, `killall node`, …): other packages run their own mocks, hosts,
  simulators and Playwright at the same time. Stop only the processes you started, by pid.
