# B1 — the board screen on the phone: design and contracts

The lead's decisions for package B1 (PLAN.md §3 "B1", goal 3.4, 4.4, open question 1). Chunks implement this file; a change to
it is the lead's. Mockups: board v3 `b_edb3unwu`, rect x −7530…4570, y −1960…−860 (01a/01b x −7530…−6620, 02a x −6520…−6110,
03a/03b x −5760…−4800, 04a/04b x −4720…−3810, 06a/10 x −2610…−1610, 08b x 1610…2050, 09a/09b x 3200…4580).

Everything below is **phone only** (`usePhone()` in the app; `phone: null` in the view). Tablet and desktop keep today's
`BoardBar.tsx`, `RoleBar.tsx`, the presence pill, Excalidraw's own menu and footer, and every testID.

## 1. The bridge (packages/board-bridge)

```ts
/** The phone's chrome of the board view (B1): Excalidraw's menu trimmed and headed by the board's name, and its footer made
 *  one band of BAND_HEIGHT px across the view with a right inset where the app puts Edit here and the orb. */
export type PhoneChromeMsg = {
  title: string;        // the board's name, heads the menu (≤ 200 chars)
  inset: number;        // px kept free at the band's right end (0…400)
  band: string;         // #rrggbb: the band's ground (the app's bar ground, tokens.bg)
  line: string;         // #rrggbb: the hairline above the band (tokens.line)
  share: boolean;       // "Share image…" is offered (false where the platform cannot share a picture)
};
export const BAND_HEIGHT = 64;

/** How a board opens on the phone (B1): fitted (margin px on each side, inside what is visible), or a view kept from before. */
export type OpenView = { fit: number } | { scrollX: number; scrollY: number; zoom: number };

ToBoard  += { t: "phone"; chrome: PhoneChromeMsg | null }        // null: today's chrome (the wide layouts)
ToBoard "load" += open?: OpenView                                  // absent: the scene's own appState, as today
FromBoard += { t: "menu"; board: string; item: "share" | "clear" } // a phone menu item the app carries out
```

`validate.ts` validates each (numbers finite and in range, colours `#rrggbb`, strings bounded, `item` one of the two). The bridge
still carries no address, secret or call: `menu` tells what the person pressed, like `selection`.

## 2. The view (packages/board-view: Board.tsx, endpoint.ts; no engine file)

- The endpoint keeps `phone: PhoneChromeMsg | null` in its store (across loads; a new web view starts with null).
- With `phone` set, `Board.tsx` gives Excalidraw a `<MainMenu>` of its own (Excalidraw's `MainMenu` API, nothing patched):
  a group titled with `title`; **Find on the board** (opens Excalidraw's own search), **Fit the whole board** (the fit below,
  margin 16), **Export image…** (Excalidraw's own image export dialog), **Share image…** (only if `share`; posts `menu share`),
  a separator, **Clear the board…** (danger colour, last; not in view mode; posts `menu clear`). Nothing else: no Open, Save to…,
  Help, links, theme, background. Without `phone`: no `MainMenu` child (Excalidraw's default, as today).
- With `phone` set the wrapper carries a class (`aiwb-phone`) and CSS makes Excalidraw's mobile footer (`.App-bottom-bar`) one
  band of `BAND_HEIGHT` px flush with the bottom and both sides, ground `band`, a 1 px `line` above, no island radius or shadow,
  and its content padded right by `inset` px. Excalidraw's selected-shape panel (`.App-mobile-menu`) still opens above it; the
  menu dropdown opens above the band and is not covered. Wide: no class, no CSS.
- `open` on `load`, once the Excalidraw of that load has mounted and laid out: `fit` = the non-deleted elements' bounds fitted
  into the visible rect (the container less the band at the bottom and, in edit mode, less Excalidraw's top toolbar) with `fit`
  px on each side, zoom at most 1 (a small board is centred at 100 %), no animation; an empty board is left as it is. A view
  is applied as given. Then the usual `view` message tells the app.

## 3. The board side (packages/core/src/board/side.ts — additive)

- `setPhoneChrome(c: PhoneChromeMsg | null)`: kept; sent (`t: "phone"`) when it differs from what the view has, and again to a
  view that attaches or says `ready`.
- `setOpenView(f: ((board: string) => OpenView | undefined) | null)`: asked in `sendLoad` for a load that is not a redraw in
  place; its answer is the `open` of the `load`.
- `onMenu(f: (board: string, item: "share" | "clear") => void): () => void`.
- `boardPicture(id): Promise<ExportValue>`: the whole board (every live element, scale 2, background) drawn by the view when the
  board is live there, else by the engine on the kept scene; rejects `EMPTY` for a board with nothing to draw. (The menu's Share.)
- `clearBoard(id): Promise<void>`: every live element of a board this window holds deleted as **one** change (one undo step on the
  live view; through `serial` and `edit`, then `saveSoon`); no flash. Rejects `NOT_HOLDER` (not held) and `ARCHIVED`. (The menu's Clear.)
- Order: a view that attaches or says `ready` is sent `phone` **before** its `load` (the view re-mounts a shown board when the chrome
  comes or goes). `open` is asked only for a load the view does not draw in place (it does not show that board yet).

## 4. The app (app/src/screens/board, shell/phone/BoardRoute.tsx)

- **Bar** (`board/PhoneBoardBar.tsx`, `ContentBar`): `NavBack` alone; title = board name (17 pt, two lines then fade, never "…");
  sub = the place (the board's nearest group, or its server's name at the root) then the state word drawn by `<StateWord>`
  through ContentBar's new `state` prop; **Chats** button (44 pt, label "Chats" + count badge, accessibility "Chats, 2"), the badge
  in the agent's colour (`agentPaint(t, agent).main`) while a chat of the board is busy (`boardWorker`); it calls
  `openChatsSheet(board)`. While an agent works the state is "<Agent> is working…" in the agent's colour and **replaces** the place.
- **State words** (`packages/core/src/logic/statewords.ts`, appended): `BOARD_WORDS` { view "View only", taking "Taking over…",
  editing "Editing", taken "Another window is editing", agent "An agent is editing", archived "Archived · read-only" } and
  `boardWord({ role, writer, archived, worker })` → StateWord (worker → `{ key: "working", text: "<Short> is working…", tone: "ok" }`,
  drawn in the agent's colour via StateWord's new `colour`). The wide RoleBar's sentences stay.
- **Bottom row** (`board/BottomRow.tsx`, drawn by BoardCanvas over the band's right end, inside the board screen): reader →
  **Edit here** (`Button size="touch" tone="primary"`, testID `board-take`), "Taking over…" while taking (disabled, spinner);
  holder → nothing; archived → nothing; then a 64 pt box holding `<slots.BoardOrb board/>` (empty until V1). Its measured width
  (+ 8) is the `inset` sent (`rowinset.ts`). It lifts the toast above the band (`useToastLift(BAND_HEIGHT)`).
- **No floating parts on the phone**: `RoleBar` and `Presence` are not drawn; the dropped-edit note becomes a toast; when this
  window loses the board a toast "Another window took over this board" with action **Edit here**. The flashes stay (09a note 3).
- **Chats sheet** (`board/ChatsSheet.tsx`, opened by `board/chatssheet.ts` `openChatsSheet(board)` / `closeChatsSheet()` /
  `useChatsSheet()`; registered as an Overlay): `Sheet` + `SheetHead` title `Chats on "<board>"`, sub "2 chats"; first row
  **New chat on this board** (accent "+", second line "The agent can read and draw on this board"; not on an archived board or
  one whose server is not reachable) → `newChat({ board })` (opens it full screen); then each chat of the board
  (`boardChats(chats, board, showArchived)`): agent glyph, name (17 pt), second line "<Agent short> · <chat state word or model>",
  **Voice** badge on the chat voice talks to (`pickTarget` of `voice/pill/logic.ts`), chevron; ≥ 50 pt rows; a tap selects it
  (`select({ board, chat })`) and closes the sheet. V1's voice card "To:" calls the same `openChatsSheet`.
- **Open view** (`board/viewmemory.ts`): per board, the last view on this phone (kv `aiwb.boardviews`, newest 50), written from the
  store's `view` while the board is shown on the phone; `setOpenView` answers it, else `{ fit: 16 }`. Wide: `setOpenView(null)`.
- **Menu actions** (`board/menu.ts`): `share` → the engine's `export` of the live board (all, scale 2, background) → the platform's
  share (`platform/shareimage`: iOS RN `Share` with a cache file; web `navigator.share` with a file when it can, else a download;
  Android: `share: false`). `clear` → `confirm()` P4: title `Clear "<board>"?`, body "Every shape on it is removed, for everyone
  who opens it on <server>.", confirmLabel "Clear the board", danger → delete every element of the live board as one change.
- **Slot**: `slots.tsx` gains `BoardOrb: ComponentType<{ board: string }>` (default nothing) — append-only, one commit.
- **Landscape** (`board/landscape.ts` `useBoardLandscape()`: native phone, width > height): the bars become floating controls in the corners (top-left: back, name, state,
  Edit here; top-right: Chats; bottom-right: the orb slot), the status bar hidden, Excalidraw's footer with `phone: null`; no re-fit.

## 5. testIDs (`board/ids.ts`)

`board-bar` (the phone bar too), `board-chats` (the Chats button; dataSet `count`, `busy`), `board-take` (Edit here),
`board-row` (bottom row), `board-orb-slot`, `chats-sheet`, `chats-new`, `chats-row` (dataSet `chat`, `voice`), `board-float`
(landscape controls). The state word is the kit's `state-word` (dataSet `word`, `tone`).

## 6. Open question 1 (the docked orb's inset)

Built docked. `UX.B1-board` measures, on the web build at the phone viewport, that no Excalidraw footer control lies in the
inset in the reader's, the holder's and the shape-selected footer; `ux-board.yaml` looks at it on the iOS simulator. If it
breaks, the fallback is `bd-04b` (Excalidraw's row untouched, the orb floating above its right end) — reported, not silent.
