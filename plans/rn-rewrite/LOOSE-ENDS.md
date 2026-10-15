# Loose ends reported by the packages, and how the integration sweep settled them

Collected by the orchestrator from the packages' reports; settled by the integration sweep (branch `rn-sweep`, its packages
`rn-sw-*`). Each item says what was done, or what was decided and where the decision is written. The parity report
(`parity-report.md`) has the whole account.

## Check flags and ports
- **Every `const <FLAG> = false` turned on** — done. No check of `web/dev/checks-app/` has a flag left, on or off
  (`grep -n "^const [A-Z_]* = \(false\|true\)" web/dev/checks-app/*.mjs` finds none). The parts behind them are ported from
  the old checks with their words (rn-sw-flags-a: AAC.*; rn-sw-flags-sec: SEC.6, SEC.7, SEC.9, A1.2–A1.5; rn-sw-flags-chat:
  A2.4, P7.1, P7.2, `composer.mjs` MOVE; rn-sw-flags-misc: IM3.5, P7.5, SEC.10, A6.3; rn-sw-trueflags: the ones already on).
  A few flags had nothing behind them (`void FLAG`): their parts were written from the old checks, not switched on.
- **A6.3-board's live flavour switch** — not needed: the old A6.3 opens a page per flavour and never switches live; P7.5 switches
  the theme by the picker on an open board (rn-sw-flags-misc).
- **The branch send on its way (P7.1/P7.2)** — ported (rn-sw-flags-chat); the build already drew it.
- **A1.2–A1.5, P7.2** — every part on; A1.4's unchecked "the shapes stay selected" is asserted now (rn-sw-flags-sec).
- **P0.3** — every one of the 57 seeded states has its entry and is drawn at the three viewports with every part of the seed's
  `see` and `also`; a state with no entry fails the check (rn-sw-p03). It takes about 2–5 minutes, not 9.5: `atRest` waited out
  20 s on every page that animates.
- **Every old check has a port** — done: A6.4 and P0.4 were the two without one (rn-sw-ports). Table in `parity-report.md`.

## Behaviour gaps
- **Systemic overlay focus** — fixed in `app/src/ui/modal.web.tsx` (rn-sw-focus): the overlays' own focus rule on web, in place
  of react-native-web's trap; every workaround it made necessary is gone (LabelInput's tick, the library's and insert popup's
  microtasks, timers and re-focus, `holdFocus`, `keepTab`, the pickers' timers). Check `L21`. Architecture AD-70.
- **B-SA-16, Esc order** — fixed (rn-sw-esc): the @ list, the quote float and the inline name fields are on the overlay stack
  (`ui/useEscLayer`). L19, L17. Architecture AD-70.
- **Other menus closing as a field opens** — covered by the focus fix (the rule holds for every overlay).
- **The 3.5 s drop on the desktop check page** — not the app: L16's desktop section left a page open, and two pages took the
  mock's one stream from each other every ~3 s (the EventSource retry). `open()` of `shot.mjs` now fails a check that opens a
  second page; the leaks found by it were closed (L2, L5, L16, L17, R3.12, PL5.1, L20, SEC.7, SEC.9, SEC.10, P0.3), PL4.1 opens
  its second window on purpose (`beside: true`), and L16's folder browser runs at the desktop too (rn-sw-silence). The desktop
  app has one window and one subscription: it cannot have this drop.
- **`asksWhere`** — not a lost behaviour: the old page dropped that question in `bfb97f9`, before the rewrite; the guard holds on
  both builds. Architecture AD-82.
- **The old page's folder browser race** — left: the old page is retired at R1. Architecture AD-43.
- **Quoting on a web tablet with touch and no keyboard** — the old page quoted by ⌘L only, so nothing is lost; the desktop app has
  a keyboard, a narrow window takes the sheet path, the iPad app has the sheet. Architecture AD-64.
- **Android: no shortcut under an RN `Modal`** — accepted limit. Architecture AD-73.
- **iOS secret field** — the caret moving to the end did not reproduce on iOS 26.3 / React Native 0.86; `maskededit` answers the
  caret all the same (unit tests). Copying out gives bullets: by design. (rn-sw-nativekb.) Architecture AD-70.
- **A Popover near the bottom and the keyboard** — fixed on native (rn-sw-nativekb): the model picker and the folder browser on an
  iPad; `sheets` flow passes on an iPhone and an iPad simulator. **Android not run** (the emulator lock was held).

## Found by the sweep
- **D-SL-12, lost from the desktop page** — the board did not pan or zoom while a point was waited for; fixed (rn-sw-pick).
- **D-SL-10/11, a point on the phone** — could not be made (the chat's unmount ended the wait); decided and built: the phone's
  point flow (rn-sw-pick). Architecture AD-52, AD-71. **The native tap over the web view is not yet run on a device.**
- **D-PC-08, a native picture not cancelled** — fixed (rn-sw-piccancel). Architecture AD-25.
- **The palette's licence notice** — the web export carried it only as a string in an unused function; it writes
  `THIRD-PARTY-NOTICES.txt` now (rn-sw-ports). The native bundles carry it as a string of the bundle.
- **The focus ring** of the rail's controls, menu items and chips — back (rn-sw-flags-chat, `ui/focusring.ts`).
- **The Picker's Enter after a list closed with a focused row** — picked nothing; fixed (rn-sw-gaps-c).
- **`web/test`** — 628 tests moved to `packages/core/test`, 68 split, 195 that prove the old page stay until R1, each with its
  proof on the new build (`parity/webtest.md`, rn-sw-webtest).
- **Flaky checks found and fixed**: P0.1 raced the toolbar's ResizeObserver; P0.3 opened four pages on a one-stream mock; A1.4
  selected before the canvas was ready; A6.4 read a virtualized row before it showed; L17's Esc case left a page open.
- **The first full run after V4's merge** — A1.5 (⌘B saved a rename box opened by a menu), IM3.5 (Esc left the focus on nothing),
  the gallery's fence card failing L4, L4b and P7.4-keys on a console error, P0.1's second page, and the storage scan and V4's probe:
  each fixed by its cause (`parity-report.md` section 4); then two full runs in a row, 85 of 85 (section 7).

## Left, for the owner (not blockers of D2 or R1)
- Excalidraw's main menu keeps its "Save to…" entry, which opens an empty dialog, and ⇧S its eye dropper: as on the old page.
- `apply.ts` checks a `select` ref after the changes are written (a bad ref applies the changes, then answers BAD_REF): as on the
  old page.
- The chat view's part slots keep their stand-in fallbacks (`screens/chat/parts.tsx`); every slot is registered.

## Device-only, by hand (goal 7.5) — in the parity report
- Pencil drawing; a real phone's memory over hours of a stream; the local network permission prompt on a real device; suspend
  and resume; the install script on a real iPhone, iPad and Android phone; IME composition, undo/redo and selection handles across
  a chip; HEIC from the iOS library (V4); the code scan with a real camera; the desktop app from the web build, used as it is used
  today.
