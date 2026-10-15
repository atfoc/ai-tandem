# Parity report: the new build against the desktop page (goal 4.3, 7; the condition of D2 and R1)

Written by the integration sweep (branch `rn-sweep`). The rows are those of `parity-inventory.md` (851). The table of every
row, with its proof, is in `parity/a.md`, `parity/b.md`, `parity/c.md`, `parity/d.md` (their form: `parity/README.md`); the
unit tests that stay with the old page and what proves each on the new build: `parity/webtest.md`. This file sums them up.

## 1. In short

- **Every old check has its port** (54 of 54, table in 2), at the viewports the parity rows name, and **no check of
  `web/dev/checks-app/` has a flag** (on or off): every part the screen packages left behind a flag is ported from the old
  check with its words.
- **839 of 851 rows are true on the new build and shown**, by a check of `web/dev/checks-app/`, a unit test, a free e2e script,
  the desktop app's e2e or a device flow. **10 are partly** (each says which part, and why: 6 device-only, 3 deliberate, 1 as on
  the old page). **2 are n/a** by a decision. **None is lost.**
- **Five behaviours of the desktop page were lost on the new build and fixed by the sweep**, and other defects of the new build;
  the sweep's last full run found two more rows broken since they were shown (A-LY-12 and A-SB-30 by ⌘B, B-IM-06 and D-PC-10 by
  Esc), both by the overlays' focus fix, and fixed them (section 4).
- The whole suite passes; `uicheck:app` passed twice in a row, 85 of 85 each time (section 7).

| Area | Rows | yes | partly | n/a | no |
|---|---|---|---|---|---|
| A. The shell | 208 | 206 | 1 | 1 | 0 |
| B. The chat view | 235 | 233 | 2 | 0 | 0 |
| C. The composer and the prompt library | 237 | 233 | 3 | 1 | 0 |
| D. The board, pictures, the transport, the desktop window | 171 | 167 | 4 | 0 | 0 |
| **All** | **851** | **839** | **10** | **2** | **0** |

"yes" means true and shown; a `yes` row may still name a minor clause that no automated test reads (the lists at the end of
each area file, about 100 clauses: a tooltip's exact words, a colour in one state), never the row's behaviour itself.

## 2. The old checks and their ports

Each port keeps the old check's ID, seeds and assertions (the same words in its failure lines) and changes the selectors and the
navigation; its first comment says what it ports and every deviation, with why (`web/dev/checks-app/README.md`, "Porting a check").
`d` desktop (1280×800, mouse), `t` tablet (iPad Pro 11, touch), `p` phone (iPhone 15, touch).

| Old check (`web/dev/checks/`) | Its port (`web/dev/checks-app/`) | Viewports |
|---|---|---|
| `A1.2-hidden.mjs` | `A1.2-hidden.mjs` | d,t |
| `A1.3-works.mjs` | `A1.3-works.mjs` | d,t |
| `A1.4-key.mjs` | `A1.4-key.mjs` | d,t |
| `A1.5-notices.mjs` | `A1.5-notices.mjs` | d,t |
| `A2.2-fits.mjs` | `A2.2-fits.mjs` | d,t,p |
| `A2.3-places.mjs` | `A2.3-places.mjs` | d,t,p |
| `A2.4-popups.mjs` | `A2.4-popups.mjs`, `A2.4-usage.mjs` | d,t,p; d,t,p |
| `A2.5-selectors.mjs` | `A2.5-selectors.mjs` | d,t,p |
| `A2.6-names.mjs` | `A2.6-names.mjs` | d,t,p |
| `A3.2-drops.mjs` | `A3.2-drops.mjs` | d,t |
| `A3.3-during.mjs` | `A3.3-during.mjs` | d,t |
| `A4.2-shows.mjs` | `A4.2-shows.mjs` | d,t,p |
| `A4.3-held.mjs` | `A4.3-held.mjs` | d,t,p |
| `A4.4-ends.mjs` | `A4.4-ends.mjs` | d,t,p |
| `A5.2-cards.mjs` | `A5.2-cards.mjs` | d,t,p |
| `A5.3-gaps.mjs` | `A5.3-gaps.mjs` | d,t,p |
| `A5.4-large.mjs` | `A5.4-large.mjs` | d,t,p |
| `A6.1-picker.mjs` | `A6.1-picker.mjs` | d,t,p |
| `A6.2-reload.mjs` | `A6.2-reload.mjs` | d,t,p |
| `A6.3-readable.mjs` | `A6.3-board.mjs`, `A6.3-markdown.mjs` | d,t,p; d,t,p |
| `A6.4-floors.mjs` | `A6.4-floors.mjs` (ported by the sweep) | d,t,p |
| `AAC.1-first.mjs` | `AAC.1-first.mjs` | d,t,p |
| `AAC.2-localdown.mjs` | `AAC.2-board.mjs`, `AAC.2-localdown.mjs` | d,t,p; d,t,p |
| `AAC.3-remotedown.mjs` | `AAC.3-remotedown.mjs` | d,t,p |
| `IM3.2-composer.mjs` | `IM3.2-images.mjs` | d,t,p |
| `IM3.5-message.mjs` | `IM3.5-message.mjs` | d,t,p |
| `L6-agenttools.mjs` | `L6-agenttools.mjs` (the same scenario, `web/dev/agenttools.mjs`) | d,p |
| `P0.1-overflow.mjs` | `P0.1-overflow.mjs` | d,t,p |
| `P0.3-smoke.mjs` | `P0.3-smoke.mjs` | d,t,p |
| `P0.4-routes.mjs` | `P0.4-routes.mjs` (ported by the sweep) | d (the mock's half), d,t,p (the page's) |
| `P0.5-frames.mjs` | `P0.5-frames.mjs` | d,t,p |
| `P0.6-widths.mjs` | `P0.6-widths.mjs` | d |
| `P0.7-shots.mjs` | `P0.7-shots.mjs` | d,t,p |
| `P7.1-flavours.mjs` | `P7.1-flavours.mjs` | d,t,p |
| `P7.2-menu.mjs` | `P7.2-menu.mjs` | d,t |
| `P7.3-sidefit.mjs` | `P7.3-sidefit.mjs` | d |
| `P7.4-keys.mjs` | `P7.4-keys.mjs`, `P7.4-quote.mjs`, `P7.4-board.mjs` | d,t; d,t; d,t,p |
| `P7.5-canvas.mjs` | `P7.5-canvas.mjs` | d,t,p |
| `PL4.1-library.mjs` | `PL4.1-library.mjs` | d,t,p |
| `PL5.1-insert.mjs` | `PL5.1-insert.mjs` | d,t,p |
| `PL5.2-popup.mjs` | `PL5.2-popup.mjs` | d,t,p |
| `PL6.1-tree.mjs` | `PL6.1-tree.mjs` | d,t,p |
| `R3.12-images.mjs` | `R3.12-images.mjs` | d,t,p |
| `S1.1-subagents.mjs` | `S1.1-subagents.mjs` | d,t,p |
| `SEC.1-sidebar.mjs` … `SEC.10-readonly.mjs` | `SEC.1` … `SEC.6`, `SEC.7-board.mjs` + `SEC.7-drop.mjs`, `SEC.8` … `SEC.10` (same names) | d,t,p each |

Where a port has fewer than three viewports, it is the behaviour that does not exist there, and the file's first comment says
so: the hidden sidebar and its rail are the wide layouts' (A1.*, P7.2; AD-71), the sidebar's drag at the phone is `L14`'s (A3.*),
a resize check is the desktop's (P0.6, P7.3: README "Choosing them"), ⌘L and the keys need a keyboard and the phone takes the
sheet path, which `L17` proves (P7.4-keys, P7.4-quote; AD-64), and the agent's tools are proved at the two board hosts' widths
(L6). Besides the ports, the new build has 26 checks of its own (`L0`–`L24` and `L4b`; 85 checks in all): what no old check proved, at the three viewports.

## 3. Per area: what is not fully true, and why

All other rows are `yes`, each with its proof in the area file.

| Row | Value | Why |
|---|---|---|
| A-SB-31 | partly | Deliberate (AD-71): on the phone a board made from the list opens its own screen, so its row is not put in rename mode. |
| A-DD-10 | n/a | Deliberate (AD-70) and out of scope (goal 4.1): a drag begun in another window; the app is one window, a browser tab is no target. |
| B-SM-14 | partly | The virtual list is shown (L8); a stream held for hours and its memory is device-only, by hand (goal 7.5). |
| B-QS-07 | partly | Deliberate (AD-64): the sheet path (native, the phone layout) does not mark the draft's passages in the thread; the count's list holds them. |
| C-RF-08 | partly | The point flow is shown at d,t,p on the web build; the tap in a device's web view (`PickSurface.native`) is device-only, with no flow yet. |
| C-QT-01 | partly | "The selection is cleared" cannot be shown in a browser (the comment field takes the focus, which clears it by itself); the long press and the system's handles in the sheet are device-only. |
| C-QT-16 | partly | Deliberate (AD-64), as B-QS-07. |
| C-DR-22 | n/a | Deliberate (goal 4.2): the app starts fresh; no old per-chat key is read. |
| D-BD-08 | partly | As on the old page: Excalidraw's menu keeps its "Save to…" entry, which opens an empty dialog, and ⇧S its eye dropper. Nothing writes a file. Left for the owner. |
| D-BD-14 | partly | The Pencil and a two-finger pan and pinch on a device are by hand (goal 7.5); a finger's strokes are shown by `maestro/board-webview.yaml`. |
| D-SV-11 | partly | The background flush is shown on a fake `AppState`; the system's own `background` event and the web view's hand-over before suspension are device-only. |
| D-DW-13 | partly | The system's image picker and its permission wording are device-only (V4's flow `storage-picker-permission.yaml`, by hand); the picker is a fake in the unit tests. |

## 4. What the sweep found lost or wrong, and fixed

Lost behaviours of the desktop page (goal 4.3), each with the proof that fails without the fix:

- **D-SL-12**: the board did not pan or zoom (wheel, drag, pinch) while a point was waited for. Now the board is in view mode
  during the wait and `PickSurface` hears the tap (`P7.4-board@d,t,p`; AD-52).
- **B-RO-13**: the subagent drawer of a chat whose server dropped kept "Loading…" (the drawer's list did not redraw when its
  render function changed; `StickyList` `extraData`). `L19`.
- **B-TH-18**: an open tool card stayed open on another branch that shares it (keyed by chat and call, now by chat, branch and
  call, as the old page). `L22`.
- **The accent focus ring** of the rail's controls, menu items and chips (`ui/focusring.ts`). `P7.1`.
- **The palette's licence notice** in the web export (`THIRD-PARTY-NOTICES.txt`). `A6.4`, `app/test/export-web.test.ts`.

Defects of the new build that did not exist on the old page:

- **The overlays' focus on web** (systemic): react-native-web's `Modal` pulled the focus back as it closed; screens worked
  around it with timers. Now `ui/modal.web.tsx` keeps the old page's rule and the workarounds are gone. `L21`.
- **Esc order** (B-SA-16): the @ list and the quote float were not on the overlay stack. `ui/useEscLayer`. `L19`, `L17`.
- **The model picker's Enter** after a list closed with a focused row picked nothing. `L16`.
- **A point on the phone** (D-SL-10/11): it could not be made; the phone's point flow is built (AD-71). `P7.4-board@p`.
- **Native**: a picture scrolled away was not cancelled (D-PC-08, AD-25, unit tests); a `Popover` near the bottom is placed
  above the on-screen keyboard (the `sheets` flow on an iPhone and an iPad simulator; Android not yet run).

Found by the sweep's first full run after V4 was merged (each deterministic, each fixed where it was):

- **A-LY-12, A-SB-30** (⌘B with a rename box open saved its text, `A1.5`): the overlays' focus fix made the rail's focus move at
  once in a row's `useSideHidden`, whose effect runs before the Sidebar's ends the box; the box blurred while mounted and its
  blur saved. A box that loses the focus while the sidebar is hidden now drops its text, as Esc does (`sidebar/parts.tsx`). The
  part of A1.5 that came after it had never run; it typed before react-native-web's select of the name, and waits for it now.
- **B-IM-06, D-PC-10** (Esc on the large view left the focus on nothing, `IM3.5`): the large view was still drawn in
  react-native-web's `Modal`, whose trap notes the opener after the close button's autofocus (no longer a frame later since the
  focus fix); it is drawn in `ui/modal` like every other overlay.
- The gallery's broken tool card (L1's fence, B-TH-17) logged a console error on every gallery page, which failed L4, L4b and
  P7.4-keys; it is drawn with `?gallery&fence` alone. P0.1 opened its second case beside the first page (the one-page rule).
  `app/test/storagescan` did not know V4's device probe (`dev/StorageProbe.tsx`, a reader, development builds only).

Flaky checks, each with its cause found and fixed (not retried): P0.1 raced the toolbar's ResizeObserver; P0.3 opened four
pages on the mock's one stream (now one at a time, and `open()` refuses a second page unless `beside: true`); the "3.5 s drop"
of L16's desktop page was a page left open (the same cause, in L2, L5, L16, L17, L20, R3.12, PL5.1, SEC.7, SEC.9, SEC.10);
A1.4 selected before the canvas was ready; A6.4 read a virtualized row before it showed; L19 read rows the list was still
placing; PL6.1's phone runs lost the focus to the library's timed re-focus (gone with the focus fix); the desktop e2e's record
of the stream began with a batch of the page's own greeting still on its way (3 runs in 6).

## 5. The unit tests of `web/test`

R1 deletes `web/test`. Of its 876 tests (891 rows with the parametrized ones), 628 that need nothing of the old page moved to
`packages/core/test`, 68 mixed ones were split, and 195 that bundle or read `web/src` stay until R1: each has its proof on the
new build named in `parity/webtest.md` (41 of them written by the sweep: `app/test/wiring.test.ts`, `sidebar.calls.test.ts`,
`gone.test.ts`, `storagescan.test.ts`, `library.open.test.ts`, check lines in SEC.2, SEC.7, SEC.10, L7, L10, L16). R1 deletes
those 195 with the old page and loses no proof of the new build.

## 6. By hand (goal 7.5) and on a device

By hand, for the user (goal 7.5):

- the install script on a real iPhone, a real iPad and a real Android device;
- a stream held open for hours on a phone, and the memory it uses (B-SM-14);
- drawing on the board with a finger and with a Pencil, a two-finger pan and pinch (D-BD-14);
- reaching a server on the local network from a phone, with a self-signed certificate, and the local network permission prompt;
- a suspended and resumed app: the sections fill again, a drawing waiting is written (D-SV-11);
- **the desktop app from the web build, used as it is used today** (D2's own by-hand check);
- IME composition, undo/redo and the selection handles across a chip; the code scan with a real camera; HEIC from the iOS library.

On a device, not yet run (no flow, or no device run by the sweep): the tap that puts a point in a device's web view and its pan
and pinch (C-RF-08, D-SL-10–12 native), a `Popover` over the on-screen keyboard on Android, the long press and the system's
selection handles of the Quote sheet (C-QT-01), the image picker's permission (V4).

## 7. The suite

Run on 2026-10-15 at `rn-sweep` after `react-native-rewrite` (V4) was merged and the fixes of section 4 were made, Playwright
1.64.1 and Chromium 156.0.8078.4; nothing else of the sweep tested on the machine at the same time.

| Command | Result |
|---|---|
| `cd web && npm run uicheck:app`, run 2 | 85 of 85 checks passed (about 52 min) |
| `cd web && npm run uicheck:app`, run 3, the next one | 85 of 85 checks passed (about 52 min) |
| `cd web && npm run uicheck` (the old page) | 54 of 54 checks passed |
| `APP=1 DIST=app/dist-web node web/e2e/newchat.e2e.mjs` | passed (21 checks) |
| `APP=1 DIST=app/dist-web node web/e2e/twopages.e2e.mjs` | 60 checks passed, 0 failed |
| `APP=1 DIST=app/dist-web node web/e2e/remotechat.e2e.mjs`, and with `VIEWPORT=phone` | passed (88 checks), passed (88 checks) |
| `APP=1 DIST=app/dist-web node web/e2e/localserver.e2e.mjs` | passed (37 checks) |
| the same four on the old page (`cd web && npm run build` first) | 21, 60, 88 and 37 checks passed |
| `npm test && npm run check` (root: app, board-bridge, board-view, conn, core) | 522, 62, 14, 204, 1563 tests, 0 failed; types clean |
| `cd web && npm test && npm run check` | 307 tests, 0 failed; types clean |
| `cd desktop && npm test && npm run e2e` | 137 tests, 0 failed; the app's e2e on the old page: 24 ok, done |
| `cd desktop && AIWB_PAGE=../app/dist-web/index.html npm run e2e` | the app's e2e on the web build: 27 ok, done |

Run 1 (before the fixes) failed A1.5, IM3.5, L4, L4b, P7.4-keys and P0.1 (section 4), and L8, L14 and PL4.1 on an older Chromium:
`npm install` in `web/` had removed the `--no-save` Playwright, and the runner took the npx cache's 1.62.1 (Chromium 151). On 156,
PL4.1 passes, and so do L8 and L14. L8 on 151 is the browser's (an answer that grows by more than 40 px between two scroll events is
not followed); it passes on 153 and, run whole in an Electron 44 window (Chromium 152, the desktop app's own), passes there too.
L14's finger drag fails on 151 and 153 (phone): touch on the web build is no shipped target. `web/dev/checks-app/README.md` says so.

## 8. For D2 and R1

- **D2** may switch: every old check has its port and passes, the desktop app's e2e passes on the web build (`AIWB_PAGE`), and
  the four free web e2e scripts pass with `APP=1`. Its by-hand check (section 6) is the user's.
- **R1**: `web/dev/checks/` can go (every ID has its port); `web/test` can go (section 5); `web/dev/shot.mjs`'s `check()` keeps
  the old page's path until then. `remotechat`'s `asksWhere` guard can go with the old page (AD-82). The chat view's part slots
  keep stand-in fallbacks that nothing draws any more (`screens/chat/parts.tsx`); R1 or Part B may remove them.
- **The mock has one stream for one page**: a check opens one page at a time, or says `open({ beside: true })` (README).
- **The desktop app's Chromium** is Electron 44's, 152. The checks run on the Chromium of the Playwright they find (156 here):
  L8, the one check found to depend on the version, passes whole in an Electron 44 window. An Electron upgrade, or D2's own
  by-hand check, is where a difference of the browser would show; L8 run in Electron is a script of the sweep, not in the repository.
- **A build for the checks** is `buildAppDist` (or `EXPO_PUBLIC_AIWB_VERSION=uicheck npm run build:web -- --output-dir … --connect-self`):
  a plain export cannot reach the mock.
