# Package S1: the sidebar, as built

What S2 (drag and drop), S3, S4, S11 and the packages that make or rename the same things build on. Code: `app/src/screens/sidebar/`
(registered in the shell's `Sidebar` slot by `screens/register.ts`), `app/src/platform/thiscomputer.ts`, small additions to `app/src/ui/`
(`useHovered`, `MenuItem autoFocus`, `IconButton keepFocus`), `app/public/index.html` (`theme-ground`). Checks: `web/dev/checks-app/{SEC.1-6,8,9,
AAC.1,AAC.3,A6.1,A6.2,L11}-*.mjs` and the flags it set in `A1.3`, `A1.5`, `P7.2`; reader helpers `side.mjs`; unit test `app/test/sidebar.test.ts`.

## Files
`Sidebar.tsx` (head, tree, foot; the rename state; the head's "+"), `Section.tsx` (a section's head and body, this computer's owner things),
`rows.tsx` (group, board, chat rows, `TreeRows`), `menus.tsx` (`RowMenu`, `AddMenu`, `AddChat`, `later`), `Foot.tsx` (Show archived, the
library's button, the theme picker; the Servers button is S3's `ServersButton`), `parts.tsx` (`Frame`, `PressArea`, `Hover`, `InlineName`, tags,
`useSideHidden`, `useDoublePress`), `actions.ts` (non-visual: archive/delete questions, `moveTo`, `moveGroup`, `renameGroup`, `renameChat`,
`newGroup`, `canTakeGroup`, `markDrop`, groups shown ahead of their server), `subline.ts`, `editguard.ts` (pure, tested).
`index.ts` exports for S2: `moveTo`, `moveGroup`, `canTakeGroup`, `markDrop`, `newGroup`, `renameGroup`, `renameChat`.

## testIDs (`dataSet` in brackets)
`side` · `side-head` · `side-brand` · `side-hide` (the shell's) · `side-new` (the head's "+") · `side-tree` (the ScrollView: sections are in its
content view) · `side-section` [server, tone, collapsed] · `side-section-head` [server] · `side-section-toggle` [server] (role button,
`aria-expanded`) · `side-section-name` · `side-section-state` [server, tone] · `side-count` · `side-add` (every "+": title `New on …`,
`New in …`, `New chat on this board`) · `side-more` (every "…": title `More`) · `side-section-body` · `side-section-line` ·
`side-section-extra` · `side-section-reason` · `btn` (its buttons, by words) · `side-loose` [group, drop] · `side-group` [group, depth, archived, drop] ·
`side-group-head` [group, depth] · `side-group-name` · `side-group-body` · `side-board` [board, archived] · `side-board-chats` · `side-row`
[kind, key, archived] (`aria-selected` on the open one, a board's while it or one of its chats is open) · `side-name` · `side-sub` · `side-empty` ·
`side-err` · `archived-tag` (also "Disabled") · `draft-tag` · `new-dot` · `branch-badge` · `crow-dot` [state] · `name-input` · `side-foot` ·
`side-archived` (role switch, `aria-checked`) · `servers-btn`, `library-btn` · `theme-btn` [open] · `theme-menu` (role menu; items
`menuitemradio` with `data-theme-pref`). Titles (tooltips) are set on the rows and heads as the page had them (`title` attribute).

## Decisions
- **"This computer" only where the app has a server** (`platform/thiscomputer.ts`: web yes, native no). Core's `sidebarEntries` always puts the
  local entry first; on a phone's or tablet's native app the sidebar filters it (and the head's "+", which makes things of this computer) out.
  The web build at a phone *width* keeps it: the layout is not the app.
- **Hover** is `ui/useHovered` (pointerenter/leave on the element): react-native-web's `Pressable` ends its hover when the pointer enters a
  Pressable inside it, so a row that is a Pressable never saw it. A chat or board row is a `PressFrame`: itself the Pressable (so a DOM click on the
  `side-row` element presses it, which B4's L5 does) that knows its hover, and a plain View while in rename mode, so keys and presses of the box
  do not reach it. Heads are a `Frame` (a View that knows its hover) with a `PressArea` inside. The "+" and "…" are drawn with
  `visibility: hidden` until the row is hovered or their menu is open, and always with a finger (`usePointer`).
- **Double press** (`useDoublePress`, 400 ms) is the page's double click: a rename of a row or a group; the first press does what a click did.
- **Text is not selectable** in the sidebar (`parts.tsx Text`): a word selected by a double press makes react-native-web's Pressable drop the next
  press as the end of a selection.
- **Menus** are `ui/Overlay`, mounted only while open (react-native-web's `Modal` makes a `div` in `document.body` for every instance, shown or
  not: one per row would be hundreds, and L0 wipes the body and found them), (a popover; a sheet on the phone). Because a modal gives the focus back to what had it when it closes, and a
  second modal cannot rise on iOS while the first goes, what a pick does runs after the menu is gone (`menus.tsx later`). A menu is drawn open only
  while the sidebar is shown (`useSideHidden` returns `hidden`), so no frame has a menu beside the rail (A-TH-15); when the sidebar is hidden with
  a menu open, or a pick has just closed one, the focus goes to the rail's control. The head's control cannot hide the sidebar with a menu open:
  that press is the layer's and closes the menu (the page's menus were not modal). A1.5 and P7.2 say so.
- **The theme's ground** before the app draws is a style in `app/public/index.html` (`theme-ground`: `bg` of light, dark and the four flavours, held
  to `ui/tokens.ts` by `test/export-web.test.ts`), since the old page's `html { background: var(--bg) }` has no counterpart: without it every
  reload under a dark choice flashed white (A-TH-08, A6.2).
- A board made from the list on the phone opens its own screen, so its row is not put in rename mode (`editguard.ts`); a group is.
- `IconButton keepFocus` (web): a press on the control that hides the sidebar leaves the focus in a rename box, as the page's `mousedown`
  `preventDefault` did, so hiding drops the typed name instead of saving it.

## For the packages that follow
- **S2**: the rows and heads carry no drag. `Zone` (rows.tsx) lights from the store's `dropAt` (`dataSet drop`), the head draws `drop-before`;
  `actions.ts` has the drop's calls. `SEC.3` and `SEC.5` have a flag `DRAG` for the parts that drag (the old check's body is in `dev/checks/`).
- **S4/K3/B4**: `SEC.6/8/9`, `AAC.3` have flags `CHAT_VIEW`, `COMPOSER`, `BOARD(_VIEW)` for what the open chat or board shows (thread, bar,
  box); the sidebar's half runs now, on the shell's stand-ins (the saved selection `aiwb.sel` is read, not `chat-head`'s dataSet).
- `sel.mjs`: `openMenu` waits until a popover is placed (`placed`: it is drawn with no opacity until measured) and no longer waits for the text of
  a menu that has just closed (a 30 s hang on a loaded machine); `side.mjs` has `sideSeen`, `sectionsSeen`, `sideMenu`, `groupHead`, `rowNamed`.
- Not done on a device: the long press on a row (a finger has the "…" always), the pulse of a working dot, the iOS `later` delay (60 ms) are unproven.
