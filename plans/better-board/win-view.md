# The window's lane: the view and the app (findings)

Each package of the window lane adds its own section.

## A1: the app side of new boards

Branch `bb-win-a1`. Design section 6, D12.

### What was built

- **The board screen branches on the kind.** `BoardCanvas` is now a wrapper. It reads `boards[board].kind` and renders
  `TlCanvas` for `"tl"`, else `ClassicCanvas` (the old component, renamed, with no other change).
- **`TlCanvas`** (`app/src/screens/board/TlCanvas.tsx`):
  - It opens `openTlLink(board)` while the board is on screen and is known and not gone, and calls `link.close()` on unmount.
  - It passes the D12 user and registers the view's handle with `tlRegistry().setHandle(board, h)`. It clears the handle on
    unmount, and also when the view never mounted.
  - It renders `slots.BoardVoice` (not on an archived board).
  - It has no RoleBar, SaveBanner, DroppedNote or BottomRow, and makes no `boardApp.show`/`attachView` call.
  - A gone board shows `BoardOff view="gone"`.
  - Its root is `board-canvas` with `data-kind="tl"` and `data-state` `ready`/`loading`/`empty`/`off`.
- **The mounts:**
  - `app/src/platform/tlboard.web.tsx` calls `window.aiwbTlView.mount(element, { board, link, user, testID: "tl-board-view",
    onHandle })` in a View's DOM node and `unmount()` on cleanup. If `tl.js` did not load, it says "Couldn't open this board:
    the board view did not load".
  - `tlboard.native.tsx` shows "New boards are not available on this device yet."
  - The types are structural (`tlboard.types.ts`: core's `TlLink` and `TlViewHandle`, and `TlUser`). The app does not import
    tldraw or board-tl.
- **Focus.** The view focuses its container when it mounts, which is when the person opens the board. If a text field outside
  the board had the focus at mount, the host gives the focus back to that field when the view takes it in the next 3 s,
  unless the person pressed or typed in the board first. A field that no longer exists is left alone. For example,
  `show_board` selects `{board, chat: null}`, which unmounts the composer, so the board keeps the focus.
- **D12** (`app/src/screens/board/tluser.ts`): `{ id: "user:<12 chars>", name: "<Adjective> <Animal>", color }`, with the
  colour from tldraw 5.6.0's `USER_COLORS`. It is kept in `aiwb.tl.user` through the store's `safeGet`/`safeSet`, as the
  storage scan requires. Unit-tested in `app/test/tluser.test.ts`.
- **Creating a board.**
  - `nav.newBoard(group, kind?)` and `addBoard(group, kind?)` take a kind. For `"tl"`, `api.newBoard(..., "tl")` is called
    and `boardApp.takeBoard` is not.
  - The New sheet has a second row with the tile "New board", "Miro-like board, many people at once"
    (`H2_TID.newTlBoard = "new-tl-board"`). It makes the board, opens it and puts the row in rename mode, like "Whiteboard".
  - The sidebar's "New whiteboard" and the "Whiteboard" tile stay classic.
- **The "New" mark.**
  - Sidebar `BoardNode`: `NewKindTag` (`tl-tag`).
  - Home: `placeLists` adds `tl: true` to the row, and `HomeRow` draws a `tl-tag` beside the name. The screen reader label
    gains ", new board".
- **Guards:**
  - `nav.select()` skips `boardApp.flush(prev)` for a tl board.
  - The sidebar's rename skips `boardApp.flush` for a tl board.
  - Core `side.ts` `sectionBack` does not `reloadScene` a tl board on screen. `afterSnapshot` and `follow` work on `wanted`,
    which only `show()` sets, and `show()` is never called for a tl board.
  - Archive, delete and reveal still call `flush`. That is a no-op for a board with no saving state, so they were left alone.
- **The page.**
  - `public/index.html` loads `./tl/tl.css` and `<script src="./tl/tl.js" defer>` after `board.js`.
  - `export-web.mjs` step 0 also runs board-tl's `build:web` and fails if `public/tl/tl.js` is missing. `transformIndex`
    requires the two tl tags. The export checks that `tl/tl.js` and `tl/tl.css` are present.
  - New test in `app/test/export-web.test.ts`.
- **Existing tests updated:**
  - `wiring.test.ts`: `newBoard` takes only a classic board.
  - `storagescan.test.ts`: `tluser.ts` is one more place that writes a key, and the board layer's exemption.

### Checks

- `npm test` at the root passes in every workspace (app 1530 tests, 0 failures).
- `npm run check`: app (web and native), conn, board-*, headless and board-tl pass. **`@aiwb/core` fails on
  `test/remotechat.test.ts` (lines 325–340, `string | undefined`).** It fails the same way on `bb-win` without this branch,
  so it is not from A1.
- Looked at on the mock, with temporary scripts in `/tmp/bb-win-a1/` and Playwright 1.64.1:
  - Setup: board-tl `npm run build:web`, then `buildAppDist`, then `startMock`.
  - A tl board "Team map" was added to `g_shop` through `mockEval`, and the mock's `POST /api/boards` was temporarily made to
    keep `kind`. Both are reverted.
  - **Desktop 1280×800:**
    - The "New" mark is on the tl row and not on the old board.
    - `window.aiwbTlView.mount` is defined.
    - Opening the old board `arch` shows `.excalidraw`.
    - Opening the tl board gives `board-canvas[data-kind=tl][data-state=ready]`, one `.tl-container`, no `.excalidraw` and no
      RoleBar. Our toolbars show: Select, Sticky, Rect, Rounded, Ellipse, Text, Connector, Frame, Pen, the zoom bar and
      tldraw's dev watermark. The voice pill sits above them.
    - The focus is in the board. No page errors and no CSP violations.
  - **Phone 393×852:**
    - The group screen shows the "New" mark on the tl row; its label is "Team map, new board, Whiteboard · no chats yet".
    - The New sheet shows the tile. Pressing it sends `POST /api/boards {"group":"g_shop","new":false,"kind":"tl"}` with
      **no take call**. The mock stored `kind: "tl"`, and the new board opened in `TlCanvas`.
  - **Focus:**
    - With a text field outside the board focused, an agent's `show_board` (mock `rpc`) mounted the board, and further typing
      still went into the field (`"abc" + "world"`).
    - Typing in the composer of a plain chat: `show_board` unmounts the composer, so the board took the focus.
- Screenshots: `shots/win-app-board.png` (desktop, tl board open, sidebar mark) and `shots/win-app-list.png` (phone group
  screen with the mark).

### What the tl board screen shows when the session cannot open

The current `tl.js` ignores `board`, `link`, `user` and `onHandle`, so the screen shows tldraw's local empty board with our
toolbars, fully usable. Meanwhile the link retries `POST /api/tl/<id>/open` with its backoff (the mock answers 400 each
time). The browser console logs only "Failed to load resource: 400"; there are no page errors and nothing else on screen.
Showing the link's status (the "Reconnecting…" pill) is T3's job in the view. `TlCanvas` itself only says `loading` until
the link object exists, which is at once.

### Left or uncertain

- `onHandle` is never called by the current `tl.js`, so the handle registration was checked only by type. It works once T3
  calls it.
- The phone's tablet and wide layouts also mount the web view. Only `tlboard.native.tsx` shows the "not available" text.
  Native was type-checked but not run (no simulators for this goal).
- The New sheet's third tile sits in a second row at half width, because three tiles in one row would squeeze the words on
  the phone. Look at `shots/` if a different layout is wanted.
