# Browser checks of the app (`web/dev/checks/`)

The checks of the app's web build (`app/`, its export `app/dist-web`), at three viewports (goal 7.1, AD-80, AD-42). They were
written as ports of the checks of the page the app replaced (the old page, retired by package R1): a check keeps the ID of the one it
ported (`A2.2-fits`, `SEC.2-states`) or has a new one (`L<n>`); its first comment says what it ports and every deviation.

```sh
cd web
npm run uicheck                        # every check of this folder
npm run uicheck -- L1 P0.7             # the checks named (an ID, or an item/phase: A2 takes A2.2-…, A2.3-…)
DIST=/tmp/x/dist npm run uicheck       # a build made before, for the checks: (cd app && EXPO_PUBLIC_AIWB_VERSION=uicheck npm run build:web -- --output-dir /tmp/x/dist --connect-self)
                                       #   (a build for the checks has EXPO_PUBLIC_AIWB_VERSION=uicheck: buildAppDist does that)
npm run uicheck:electron -- L8        # the checks named, drawn by the desktop app's own Chromium (Electron 44's, 152): dev/electron/index.mjs says how and what it leaves out; `-- --all` is every check (in 152 every check passes but `A6.3-markdown`, which does not run there; the shim's note says why)
PORT=4900 …   LIMIT=120 …              # the mock's port (default 4801; one mock runs at a time) and the seconds a check may take

node web/dev/checks/L1-primitives.mjs              # one check alone (builds the app first, or uses DIST)
VIEWPORT=phone node web/dev/checks/L1-primitives.mjs   # one viewport only
```

The runner builds the web export once for the whole run (`buildAppDist` of `dev/shot.mjs`: `npm run build:web` in `app/` into a
temporary folder; about 5 s), gives it to each check as `DIST`, and runs the checks one after the other, each in a process of its own.
Playwright is no dependency of the repository: `npm install --no-save playwright && npx playwright install chromium` in `web/`
(`AGENTS.md`). No check calls a paid model. A later `npm install` in `web/` removes that Playwright, and the runner then takes the
newest one of the npx cache, whatever its age: the summary's last line names the Playwright and the Chromium that drew the pages. The
folder passes on Chromium 156 (Playwright 1.64.1). On older ones two checks fail by the browser, not the build: L8 on 151 (an answer
that grows by more than 40 px between two scroll events is not followed to the end; 153 passes, and so does the whole of L8 in
Electron 44's own Chromium, 152, the desktop app's) and L14's finger drag on 151 and 153 (the list scrolls under a finger that drags a
row; touch on the web build is no shipped target: the phone and tablet apps are native, the desktop app has a mouse).

## The files

| File | What |
|---|---|
| `<ID>-<word>.mjs` | one check, with the **same ID** as the check of the retired page it ported (`SEC.2-states.mjs`), or a new ID (`L*`: layouts and touch). The name has a dash: the runner takes the files with one |
| `sel.mjs` | the selector and navigation helpers (below). Helper modules of an area (a reader of the sidebar, the card readers…) are files **without a dash** in their name (`side.mjs`): the runner does not take them for checks |
| `../shot.mjs` | the driver: `check`, `openApp`, `seed`, `mockEval`, `hostCall`, `callsOf`, `compareShots`, `until`, `atRest`, … (its header lists them) |
| `../viewports.mjs` | the three viewports |
| `L0-harness.mjs` | proves the helpers of `sel.mjs` and the frame of `check()` on a stand-in page that draws the contract of "What a screen must draw". Passes without any screen |
| `L1-primitives.mjs` | the primitives of `app/src/ui` on the gallery (`/?gallery`) |
| `P0.7-shots.mjs` | the comparison of screenshots, on the gallery |
| `L9-markdown.mjs` | S5's, on the gallery's section "Markdown": the B-MD rows that had no check (blocks, raw HTML and links, code and Copy, chips and mentions, the block memo of a streaming answer) |
| `A6.3-markdown.mjs`, `SEC.7-drop.mjs`, `SEC.10-readonly.mjs`, `AAC.2-localdown.mjs` | S4's ports, on the chat view: the chat with code readable in each flavour (S5 first ran it on the gallery), and the chat's side of a server that drops (the warning, the thread kept, level when back, "no longer on", nothing changed). Their parts of the sidebar, the composer, the board and the cards are on (the flags their packages were to set are gone: integration sweep) |
| `L8-stream.mjs`, `L10-chatview.mjs`, `chat.mjs` | S4's new ones: a long chat opens at its end, is virtualized, follows a streaming answer and keeps its place when the user scrolled up; the header, the empty thread, notes, quotes, status lines, a fork. `chat.mjs` (no dash: no check) reads the chat view (`messages` in the order they are on screen, `says`, `textOf`) |
| `A6.3-board.mjs` | B7's, the board part of A6.3: the toolbar, properties panel, menu, export dialog, context menu and help dialog of Excalidraw readable in each flavour (3:1, no weaker than in the theme under it), on Base with Text, the theme under the flavour, the flavour's filter. The colours come in the `theme` message's `chrome` map; at the tablet and the phone the panel is behind Excalidraw's Edit button and has other classes (`mobile` of a stage) |
| `L7-servers.mjs` | S3's, the Servers dialog on the mock: the list, tests, remove, the add and edit flows (no old check had them), the owner's things, the flavours. `flags.app[op]` and `appCalls` of the mock script and read the app operations; `ONLY=add` runs one section |
| `L3-addserver.mjs` | S12's, adding a server on a phone, the paste path on the mock (`phone`, and the desktop keeps S3's form): the box to paste into, the real outputs of `setup-remote.sh` and `remote setup` (`packages/core/test/fixtures/remote-setup`) filling the form, the refusals in words, the fingerprint set against the text's, `local_network_denied`. The scan is device-only (V4): the web build draws no scan button |
| `A4.2-shows.mjs`, `A4.3-held.mjs`, `A4.4-ends.mjs`, `L15-fork.mjs`, `fork.mjs` | S8's: the waits of the fork flows, what they hold and how they end (the old A4.2 to A4.4 at three viewports; a message is sent through `window.__aiwbSend` of a build for the checks), and the fork screens' rows no old check proved (actions, crumb, marker, tree head, filters, search, Esc, marks, fork links, labels). `fork.mjs` (no dash: no check) reads them: `waitsSeen`, `actsSeen` (a mouse hovers each message, a finger opens its "⋯"), `startMove`, `openTree`, `openRow`, `menuOfRow`, `treeSeen`, `notice` |
| `side.mjs` | S1's readers of the sidebar over testIDs (`sideSeen`, `sectionsSeen`, `sideMenu`, `groupHead`, `rowNamed`, `footOf`): the counterparts of the old driver's |
| `SEC.*`, `AAC.1`, `AAC.3`, `A6.1`, `A6.2`, `L11-sidebar.mjs` | S1's: the sidebar's ports and `L11`, the rows, heads and menus no old check proved. Their parts of other screens (the open chat, the composer, the board, the Servers dialog) are on: no flag is left (integration sweep) |
| `A2.4-usage.mjs`, `L12-usage.mjs` | S9's: the usage popover of the context ring lies inside the window and closes (the usage part of A2.4; the rest of A2.4 is K3's), and L12: the ring, the context split, the plan limits, on page.route fixtures (the mock has no plan and one flat split). `A2.4-popups` has the usage popover among its openers |
| `A5.2-cards.mjs`, `A5.3-gaps.mjs`, `A5.4-large.mjs`, `L13-cards.mjs`, `cards.mjs` | S6's: the tool cards in the thread (the three agents' items, the incomplete and the malformed ones, the large and the wide ones in a pane of 300 px; a thread's markup stays small) and, new, `L13`: the permission cards (the answers naming their request, decided elsewhere, a refusal, archived, disabled, a fork's copy), Show on a board tool's card, the 20,000-character bound of the colour. `cards.mjs` (no dash: no check) has the readers over testIDs (`toolCards`, `openCards`, `cardsFit`, `permCards`, and `rowOfCard`/`cardAt`/`permAt` that pick the n-th card as it is on screen: the virtual list keeps no order in the page). The drawer's half of the three is S7's drawer |
| `A3.2-drops.mjs`, `A3.3-during.mjs`, `L14-dragtouch.mjs`, `drag.mjs` | S2's: the sidebar's drag and drop, by the pointer of the viewport (a mouse drags at once, a finger is held first). A3.2 and A3.3 port the old checks (desktop, tablet); `L14` is new (the touch halves no old check saw: scroll and drag apart, the label, the edges of the list); `drag.mjs` is the driver (`dragReader`, the counterpart of `dragger` of `shot.mjs`). `side.mjs` and `drag.mjs` read through the `display: contents` div that the gesture detector puts around a draggable row on web |
| `composer.mjs` | K3's readers of the composer over testIDs (no dash: no check): `composerProbe` and `fitProbe` (for `sampleFrames`), `measureComposer`, `toolbarWidths`, `placesOf`, `SEES` (the seeds' `see` on the new build), `openState` / `openAt` / `resizeTo` (a seeded state at a width of its pane: the desktop's windows, a touch viewport's window; `pageWindow`, `touchWindow`), `playable`. Its header lists the composer's testIDs |
| `A2.2-fits`, `A2.3-places`, `A2.4-popups`, `A2.5-selectors`, `A2.6-names`, `P0.1-overflow`, `P0.5-frames`, `P0.6-widths`, `P7.1-flavours`, `P7.3-sidefit` | K3's ports of the composer's fit, places, popups, selectors, names, overflow, frames, widths fixture (`app/test/fixtures/composer-widths.json`, `WRITE=1` writes it), the composer in each flavour and its fit while the sidebar comes and goes. A window under 700 px is the phone layout, so the old "page of 300 px beside the sidebar" is a window of 300 px, and the ⌘B rounds are the desktop layout's (each check's first comment says what changed and why) |
| `L16-composer.mjs` | K3's: what no old check proved, on the real composer at the three viewports: the placeholder, Enter and Shift+Enter (and Send on touch), trim, Send's state, a refused Send, a busy chat (Stop, Esc), growth, the focus, the @ list, the model's search, the bars, the note |
| `P7.4-quote.mjs`, `L17-quote.mjs`, `quote.mjs` | K5's: the quotes. `P7.4-quote` ports the plain-chat half of the old P7.4 (⌘L with nothing selected, with text of two messages, with one reply's words: the float in the window with the focus in its comment field, Enter adds it, the count, the saved draft; beside the sidebar and beside the rail; desktop, tablet) and asserts the quote's stored place in the displayed text. `L17` (desktop and phone) is new: the Quote sheet of a long press (phone: the displayed text, "Quote", "Quote whole message", the comment in a sheet, closing keeps it, Cancel drops it, a reply being written says to wait), the float, the marks and a press on one (desktop), a passage across a list and a code block, several passages with their comments, a passage in the draft opens for editing, the count and its list, a message of quotes alone sent, a card that shows where it is from far above the window. `SEC.10` has its quote parts. `quote.mjs` (no dash: no check) has the readers (`seen`, `select`, `selectBetween`, `marks`) and `hold` (a finger on a message once the list has laid it out), and lists the quotes' testIDs |
| `IM3.2-images.mjs`, `L18-imagelimits.mjs` | K4's: the composer's images. IM3.2 ports the old check (the attach button and the browser's file chooser, a paste, the strip, Send while an upload runs, a reload, a message of an image alone, a refused upload) at the three viewports; the composer half of `R3.12-images.mjs` is a section's chat's strip. `L18` is new: the limits (ten, 5 MB, 20 MB) with their sentences, the strip wrapping with its remove controls out of the corners, a draft over the limit holding Send, a model with no images (`catalogs.claude.models[…].noImages` on the mock) |
| `S1.1-subagents.mjs`, `L19-subagents.mjs` | S7's: the Subagents chip of the toolbar (the old S1.1 at three viewports: in the row, in the "more" popup, fixed on a started chat, left out in a narrow panel; new: the focus, the arrows, a press outside) and L19, what no old check proved of subagents: the rows in the thread (marks, lines, stats, nesting, the result row, a call not linked yet, not carried over, failed, stopped, a status this client does not know), the drawer (its place, crumb, ‹ n/N ›, ×, Esc without stopping the chat, the prompt cut, the report, a permission card answered from it, Loading… and Starting…, closed with its chat), B-SM-10 (follow only while it runs), a refused pick of the chip and the chip of a chat whose server is away. The drawer is the `drawer` act of `sel.mjs` (a press on the first `sub-row`, waited to rest: on the phone it slides in as a screen); its parts' roots are `sub-drawer` and `sub-drawer-body` |
| `PL4.1-library.mjs`, `PL5.1-insert.mjs`, `PL5.2-popup.mjs`, `PL6.1-tree.mjs`, `L20-library.mjs`, `library.mjs` | S11's: the prompt library's popups (the library popup's tree, search, editor, menu and drag; the insert popup and the text put into the composer's box, its box alone on the gallery) at the three viewports (the old PL4.1 to PL6.1), and new `L20`: the head's key, what a library says as text, the notice of a library set aside, Tab, each flavour. `library.mjs` (no dash: no check) reads the popups over testIDs (`seen`, `insertSeen`, `shape`, `misshapen`; its header lists the testIDs) |
| `P0.3-smoke.mjs` | every seeded state of the mock, at the three viewports and, at the desktop, each section alone: each entry of `DRAWN` holds every part of the seed's `see` and `also` (a seeded state with no entry fails the check); the board states by the phone's stack; one page at a time; a few minutes |
| `A6.4-floors.mjs` | the old A6.4 (integration sweep), at the three viewports: the contrast floors in each flavour, read as the token (`tokensFor` of `app/src/ui/tokens.ts`, imported in Node: the build has no CSS custom properties) and on elements drawn in it (`contrastAudit`; the Allow and New buttons, the words of code by `dataSet tone`, the switch by `side-knob`); the page is in the flavour; the build carries the palette's licence notice as `THIRD-PARTY-NOTICES.txt`. Two pages: the chat's and the sidebar's |
| `P0.4-routes.mjs` | the old P0.4 (integration sweep): the mock's half (routes, knobs, servers, the order of the stream, a seed as reset) is the old file's, at the desktop; the page's half at the three viewports (a branch send against a delayed route, one whose events come late, a held model pick on a fresh fork, Fork on a reply; `fork.mjs`, the composer's `ctx-meter` and `tchip`) |
| `P7.4-board.mjs`, `L24-boardui.mjs` | B4's, the board half of the old P7.4 (⌘L on selected shapes, ⌘⇧L and "Point at", a point by a press; a quote's ⌘L before the board's), now at the three viewports with the phone's point flow (the board, the tap, back in the chat with the reference) and the board's pan and zoom under the pick layer (a build for the checks shows `window.__aiwbView()`, the board's scroll and zoom). `L24` (integration sweep, rows of D.5 and D.7): the selection's controls on every pointer, none in a plain or an archived board's chat, the agent's outline under zoom and pan, the stored file the same in every theme |
| `L21-focus.mjs` | the overlays' focus rule on web (integration sweep, `ui/modal.web.tsx`): a field a menu opens keeps the focus; Esc, a pick and a press outside give it back to the trigger; Tab and Shift+Tab stay in the top overlay (the model's list, a question, the library); a question over the library gives the focus back to what asked. It opens its own pages (`page: false`) |
| `L22-branches.mjs` | integration sweep, rows of B.4, B.6, B.7 and B.8 no check proved: an open tool card stays open on its own branch only (by chat, branch and call), the subagent rows follow the branch, a copied subagent's drawer is read-only, "Fork and edit", two branches working at once (Stop of the shown one only), the branch's words and the alert that opens the tree, the tree's row menu inside a short window; at the three viewports. (`L1` reads the gallery's "Guard" section: a tool card whose item throws is fenced, the thread stays) |
| `L23-gone.mjs` | a chat shown as it was (integration sweep, rows of C.11): a list open as its server drops closes and keys pick nothing, the attach button of a chat its server no longer has says why, a gone empty chat offers no suggestions |
| `L4-chips.mjs`, `P7.4-keys.mjs` | K1's, in the other form a check may have: `export const viewports`, `export async function body({ page, viewport, layout, fail, url })` and a last line `await standalone(import.meta.url, id, viewports, body)` (`../standalone.mjs`: it serves the build itself, opens the gallery, no mock, and fails a line only as the body says it, the viewport in it by the body). The runner runs them the same. **A new port uses `check()`** (it gives the mock, the seeded states, the automatic page errors and the viewport in each line); the form with `standalone` is for a check of the gallery that needs none of that |

## The viewports

`export const viewports = [...]` names where the check's behaviour applies; `check()` runs the body once at each, in this order, each
time on a mock started anew (nothing seeded) and in a fresh browser context.

| name | window | pointer | layout (`app/src/ui/breakpoints.ts`) |
|---|---|---|---|
| `desktop` | 1280×800, scale 1 | mouse | `desktop` (from 1100) |
| `tablet` | Playwright's device "iPad Pro 11": 834×1194, scale 2, touch, mobile | finger | `tablet` (700 to 1099) |
| `phone` | device "iPhone 15": 393×852, scale 3, touch, mobile | finger | `phone` (below 700) |

**Choosing them.** Take the viewports of the package's **Checks** line (`plans/rn-rewrite/packages.md`: "all three", "desktop mouse,
tablet touch"), which come from the parity rows' "Note for the app". A check that ports one of the retired page lists **at least** the viewports of
that line; it does not drop one because it is hard on the phone. What the layout changes, the check handles in its body (below), it
does not skip. The body sees `layout` (the same word as the viewport's name) and `touch`.

The same code runs at the three, so write the body once and branch only where the behaviour differs:

- **press** with `press(page, locator)` (a click with the mouse, a tap with a finger), not `locator.click()`; **hover** with
  `hover(page, locator)` (nothing on a touch viewport: a row's button that shows on hover shows always there, or on a long press);
- **dragging**: a mouse drags at once (`mouseDrag`), a finger is held first and then moves (`touchDrag`, `hold` 450 ms past the 300 ms
  long press of AD-70); `dragTo` takes the one of the viewport, `pointerDragger(page)` goes step by step (`start`, `move`, `end`,
  `cancel`) for a check that looks in the middle of the drag (the drop mark). A plain swipe (a sheet, a resizer) is `touchDrag(…, { hold: 0 })`;
- **navigating**: `openChat`, `openBoard`, `back` (below), never a click on a row where the layout changes the path;
- **the window**: `page.setViewportSize({ width, height })` resizes (the layout follows: `layoutNow(page)`), `open({ size: [w, h] })` opens
  another window on the viewport's device. A resize check lists `desktop` only, since the devices' own widths are what the others test.

## Writing a check

Take the shortest check of the folder as the model (`A1.3-works.mjs`), name the file by the criterion it proves, and run it alone
(`VIEWPORT=desktop node web/dev/checks/<file>`) until it says `ok`, then at all its viewports.

- **The frame.** `await check(title, body, { viewports })`; the body gets `{ url, mock, viewport, layout, touch, page, context, open, fail, note, errors, browser }`.
  The body's `page` already is the page at the viewport (with `sel`, `ls`, `wait`, … from the option `page: { sel, ls, query, wait }` of `check`);
  `open({ sel, ls, … })` opens another (a new context); for a check that opens all its own: `page: false`. `scheme`, `clock` and `still` are options of
  `open()` and of `check`'s `page`.
- **The style.** It waits for signs, not for times (`until`, `waitFor`, `atRest`), with generous bounds; `fail(line)` records and goes on (the line
  starts with the viewport, `phone: …`); a throw ends the viewport. `until()` answers a value that is not true after its bound: read it
  (`if (!await until(…)) fail(…)`). A page error (an uncaught exception) or a console error in any page opened by `check` fails the check by itself.
  A check that makes a console error on purpose lists it: `check(…, { allowConsole: [/net::ERR/] })`. The browser's "Failed to load resource" line
  (an answer of 400 or more) is not counted.
- **The helpers of `dev/shot.mjs`**: `until`, `seed`, `mockEval`, `hostCall`, `callsOf`, `callMatcher`, `holds`, `release`, `atRest`, `sampleFrames`,
  `contrastAudit`/`colourOf`/`contrastOf` (they take a selector), `compareShots({ …, tolerance })` (the pages with `viewport` and `query`: see
  `P0.7-shots.mjs`), `paneSize(kind, width)` (its answer goes to `open({ ...paneSize("panel", 300) })`: it is a window size, so on `desktop`).
- **The helpers of `sel.mjs`** (above): select by `byTid(page, "side-row")`, narrowed by a `dataSet` value, by `hasText`, by `.nth()`; read a state
  from the role/ARIA the screen draws (`aria-expanded`, `aria-selected`, …) or a `dataSet` value (`tone`, `kind`); press with `press(page, locator)`
  and hover with `hover(page, locator)`; drag with `pointerDragger(page)`, `mouseDrag`, `touchDrag`, `dragTo` (the app drags with pointer events:
  AD-70); a seeded state's `act` is `act(page, what)` of `sel.mjs` (the cases the packages add to `acts`). Readers of an area
  are helper modules of their own, without a dash in the name (`side.mjs`, `composer.mjs`, `cards.mjs`, …).
- **What the check needs of a screen**: a `testID` on every element it reads or presses, a `dataSet` for every value it reads, `role`/`aria-*` for every
  state (AD-80; `app/src/ui/tid.ts` types `dataSet`). A list of one kind of thing has one testID and is told apart by text or value. Names are
  kebab-case (`side-row`, `composer-input`, `tool-card`).
- **Pictures.** Pixel fixtures belong to a machine and a Chromium (K3's widths, `P0.7`): written again with `WRITE=1` where a check says so.
- For the seeded states the screen draws, add their entries to `DRAWN` in `P0.3-smoke.mjs`.

## What a screen must draw (the contract of `sel.mjs`)

`sel.mjs` has `IDS`, the testIDs its navigation helpers use. They are the contract of the screens; `L0-harness.mjs` proves the helpers
against a page that draws them. The first package that draws one of them **checks it against `IDS`**, and if it must name it otherwise it
changes `IDS` in the same commit (L0 is unchanged: it reads `IDS`).

| testID | where | what the helpers read |
|---|---|---|
| `app-root` | the root view of the app | `APP_READY` of `shot.mjs`: a page is drawn when it is there (the shell, U3, keeps it) |
| `side-tree` | the sidebar's tree; on the phone it is the first screen of the stack | visible when the list is on screen |
| `side-row` | a row of a chat or a board | `dataSet { kind: "chat" \| "board", key }`: `key` is the selection key the seeds have (`c_plain`, `s_studio~c_plain`); `aria-selected="true"` on the open one on the wide layouts |
| `side-show` | the control that shows a hidden sidebar (wide layouts) | pressed by `openChat` when the sidebar is hidden |
| `nav-back` | the stack's back (phone) | pressed by `back` |
| `chat-head`, `board-bar` | the header of an open chat, the bar of an open board (all layouts) | `openChat`/`openBoard` wait for them |
| `side-section-state` | a section's state | `dataSet { server, tone: "ok" \| "wait" \| "bad" }`; `act("drop:<id>")` waits for tone `bad` |
| `menu`, `menu-item`, `overlay-backdrop` | `app/src/ui` (`TID` of `tid.ts`) | `openMenu` |

Other things a check reads (a section's server, a chip's kind, a state's tone) are `dataSet` values, written by the screen's package.

## Reaching the mock's seeded states

The mock is `dev/mock.mjs` (its seeded states are `dev/mock-ui.js`). `check()` starts it on `PORT` serving the build, and
`url` is its address. The page reaches it over HTTP, as it reaches the test host (`/host/call`, `/host/events`; AD-23).

```js
await check("SEC.2 …", async ({ url, viewport, touch, open, fail }) => {
  const states = await seed(url, "SEC");     // seed first: the page asks for what is seeded as it opens
  const { page } = await open({ sel: states.find((s) => s.id === "studio").sel }); // a page with the selection as the seed says it
  …
}, { viewports: ["desktop", "tablet", "phone"], page: false });
// (the body's own `page` opens before the body runs: a check that must seed first says `page: false` and opens its page itself, as here)
```

- **`seed(url, "A2", …)`** makes the sections' states (`seed(url)` all of them) and answers their list: `{ id, section, sel, see, act, mock, pane, … }`
  (`web/dev/mock-ui.js`, its header). Seed again to start a state over. `mockEval(code, url)` runs code inside the mock (`chats`, `items`, `flags`,
  `send`, `setServerState`, `setSession`, …: the header of `dev/mock.mjs`); `hostCall(url, method, path, body, server)` makes a call as another client.
- **Before or after the page opens?** What the check needs at the page's first draw (a server, a chat) is seeded **before** `open()`;
  what it changes live (a stream event, a server that drops) after. A page that is already open takes a seed through the stream (the mock tells it).
- **`sel`**: `open({ sel: { chat: "c_plain" } })` or `{ board, chat }` (the keys the seeds name, `"<entry id>~<id>"` for a thing of another server) is put in
  localStorage `aiwb.sel` before any script of the page runs, once per context; `ls: { "aiwb.widths": "…", "aiwb.theme": "dark" }` the other keys;
  `scheme: "dark"` the system's theme. The seeds' `sel` is what the page's store starts with (on the phone the stack follows it, AD-71); `openChat`/`openBoard` work from any state, on any layout.
- **A seeded state's `act` and `mock`**: `await mockEval(s.mock, url)` after the page opens, `await act(page, s.act)` from `sel.mjs`. `drop:<id>` drops that
  server while the chat is open and the next `open()` puts it back. The other cases (`hover`, `move`, `tree`, `drawer`, `select`) are drawn by their screens:
  the package that draws one adds `acts.<name> = async (page) => …` to `sel.mjs`.
- **One page at a time.** The mock, like the host of the app, has one stream for one page: a second page open at the same time takes it from
  the first, which takes it back when its browser retries (about 3 s later), and the snapshot each time remounts what the page shows (a
  popup closes, a list is asked for again). So `open()` fails a check that opens a page while another is open: close the first one's context
  (`await ctx.close()`) before the next, or say `page: false` when the body opens its own. A check that proves a second window on purpose
  (PL4.1) says `open({ beside: true })`, and reads what one window did in the other by the snapshot that comes with the stream's return.
- **A fresh mock per viewport**: the body at `tablet` does not see what the body at `desktop` seeded or changed. A knob set in the body (`flags.*`) is
  gone at the next viewport; one that `mock.restart()` is called for inside the body resets the mock the same way.
- **The calls the page makes**: `callsOf(page)` records `POST /host/call` as `{ server, method, path, body, status }`; `page.route` with `callMatcher(re, server)`
  holds or fails one. Nothing of this changes with the build.
- **Time**: `clock: ms` pins the page's clock (and `T0` the mock's: `compareShots` does both); `still: true` stops every animation, for a picture.

## Pictures

`compareShots({ a, b, pages, omit, port, tolerance })` shoots each page of two builds and counts the pixels that differ. A page is
`{ name, viewport, query, sel, ls, scheme, wait, act, mock, omit }`. `port: await freePort()` (a mock for each build, one after the other).
`tolerance` is the levels of a channel a pixel may be off (0: every difference counts): the build's rounded borders are drawn one level apart by two
rasters of one page, so `P0.7` uses 2.

## Known gaps (not this folder's)

- The shipped build's CSP has `connect-src 'none'` (`app/scripts/export-web.mjs`, AD-41). The build the checks run is made with `--connect-self`
  (`buildAppDist` does that): its CSP adds `connect-src 'self'` and nothing else, so the page reaches the mock and the test host it is
  served from over HTTP (U3). A test of `app/test/export-web.test.ts` holds the default export to `'none'`.
- Every screen is real now; no check has a flag at its top any more (the integration sweep turned the last on). The chat view's parts are
  registered by their packages (`app/src/screens/chat/parts.tsx`: its stand-ins are only the fallbacks of the slots). (The canvas is B4's:
  `board-canvas` with `dataSet { board, state: loading | ready | error | takeover | off | empty }`; Excalidraw is in the page itself on the
  web build, so a check drives it by its own classes (`.excalidraw`, `canvas.interactive`); `acts.select` of `sel.mjs`
  selects its shapes, `boarddraw.mjs` draws on it by the pointer of the viewport.)
- A board tool call of an agent is made through the page with the mock's `rpc` knob (`await rpc({ chat, board, target, name, args })` through
  `mockEval`, its header says what comes back); `dev/agenttools.mjs` is the scenario that `L6-agenttools.mjs` runs.
- Nothing here runs on a device: that is Maestro (AD-83, Track V).
