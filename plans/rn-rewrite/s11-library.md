# Package S11: the prompt library's popups, as built

What later packages that touch the library, the insert popup or the composer's Insert button build on. Code: `app/src/screens/library/`
(registered in the shell's `Overlays` slot by `screens/register.ts`), small changes to `app/src/platform/{focus,dragscroll}.{web,native}.ts`, the
overlay primitives' backdrops (`ui/{Dialog,Sheet,Popover}.tsx`: `tabIndex={-1}`) and the chip gallery (`dev/ChipGallery.tsx`). Checks:
`web/dev/checks-app/{PL4.1-library,PL5.1-insert,PL5.2-popup,PL6.1-tree,L20-library}.mjs` and the readers `library.mjs`; unit test `app/test/library.test.ts`.
The logic is `@aiwb/core`'s, unchanged (`libraryapi`, `logic/{library,libraryview,promptsearch,insert}`, the store's `libraries`, `libraryDialog`, `insertPopup`).

## What it draws
- `LibraryPopups` (`index.ts`) is mounted always and shows both popups from the store; it plugs the insert popup in (`plugInsert`: core's `onInsertPopup`, and the key guard that
  keeps ⌘P from the browser while the popup is open). The sidebar's button (S1's `Foot.tsx`) only sets `libraryDialog`; the composer's Insert button and ⌘P call
  `ChipInputHandle.openInsert` (K1/K3), which calls core's `openInsertPopup`.
- **The insert popup** (`InsertPopup.tsx`): search, the list of every library's prompts with path and first line, "Edit the library" / "Open the library". A dialog on the wide layouts
  and a sheet on the phone. (**Deviation**: the old popup stood near the top of the window; an `InsertTarget` has no place to hang a popover from, so it is centred. Words, keys and order are the same.)
- **The library popup** (`LibraryDialog.tsx`, `Tree.tsx`, `Editor.tsx`): search, the tree (or the flat list a search finds), "New prompt" / "New group" or the bar of the top level during a move, the editor,
  Close; a dialog of 860 px (list beside the editor) or a sheet (the list above the editor, 200 px high). The state machine is the old component's, line by line (`web/src/Library.tsx`); what the DOM did there is done with
  refs and measures: a row is focused with `focus()`, scrolled into view from its laid-out place, the places a drag lands on are `measureInWindow`ed.
- **Keys** (web): the arrows, Home/End, Enter/Space walk and press the rows while one has the focus (the keys port, `onKey`); the search's ArrowDown goes into the rows and Enter chooses the first hit; ⌘↵ / Ctrl+↵ saves from
  either box; Tab is kept inside either popup (`platform/focus` `keepTab`: the overlay's own focus trap would pass through the dimmed page on the wrap); Esc is the overlay stack's (the menu, then the move, then the popup).
- **The menu** (a right click, the menu key, a long press): an `Overlay` popover at the pointer (a sheet on the phone) with the place, "New prompt", "New group", "Move…". A finger held on a row and lifted without moving opens it; so does a
  finger held on the space under the rows. It opens 150 ms after the finger left: the mouse events a browser still sends after a touch would otherwise press the backdrop of the menu that is already there.
- **A drag** (`libdrag.ts`, `Tree.tsx useRowGesture`): a Pan gesture on every row of a prompt or group of a connected library. A mouse starts it by moving 5 px, a finger after a long press (300 ms); a finger that does not move
  is a long press (the menu). The places are the rows, the space under them and the bar of the top level; `libdrag.ts placeAt` is pure, the session is `createLibDrag` (fakes in `library.test.ts`). The edge of the list scrolls after a dwell.

## Findings
- **The overlay's `Modal` draws the focus back into itself while it is mounted** (react-native-web's trap), a moment after what asked it to close. A box or a row that took the focus in the same turn lost it again, and a typed
  key went to the dimmed page's backdrop. So: the insert popup tells its box `insert`/`cancel` after it is gone (`afterClose`, `setTimeout 0`); the library popup tells `back.cancel()` the same way, creates an item in a microtask after
  the menu that asked for it was closed (the same turn lost the focus; a timer let an automated `fill` reach the old form first), and gives the focus again for 300 ms (`refocus`: the name of a new item, the row a closed menu was on, the first entry of a menu), the newer ending the older.
- The backdrops of `Dialog`, `Sheet` and `Popover` were focusable (`focusable={false}` is not `tabIndex`: react-native-web still draws `tabindex="0"`): Tab from the last control went to the dimmed page. They have `tabIndex={-1}` now.
- A Chromium touch (DevTools) sends **no `contextmenu`** on a long press; a Pan with `activateAfterLongPress` is what a long press is here, on web and on native.
- `GestureDetector`'s `LongPress` did not fire on web for the space under the rows; a Pan after a long press does.
- A caret that a script puts **inside a chip's text** is moved out of the chip by the browser in a `plaintext-only` box (K1's), where the old box (`contenteditable="true"`) kept it; no user can do that, so PL5.1's old case became the user's: a
  selection from the text before the chip to inside it (the chip goes whole, the text takes its place).
- `Pressable` `onLongPress` did not fire from a DevTools touch on the list's container either; the filler under the rows uses the Pan.

## Not proven on a device
Everything native: the Pan arbitration with the lists' scroll on iOS and Android (the list's scroll is switched off while a drag lasts), `measureInWindow` per move at the speed of a finger, the sheet over the soft keyboard with the
editor's boxes (P1's `useKeyboardAvoid`), ⌘↵ and the arrows of a tablet's hardware keyboard (the keys port reports them; the tree's arrows are not drawn for a finger), the long press on a real screen. The browser checks drive Chromium
with touch through the protocol, which is the web build only. The insert popup's key (⌘P) in the native box is K2's (`ChipInput.native` `openInsert`).

## Checks
PL4.1, PL5.1, PL5.2, PL6.1 at the three viewports (the old checks' seeds and assertions; each file's first comment says what changed), and new `L20-library.mjs`: the head's key (C-PL-02), what a library says as text and the notices of
a library set aside (C-PL-18), Tab in the library popup (C-PL-32), both popups in each theme and flavour (C-PL-33: the library's part of the old A6.3, which `A6.3-markdown.mjs` left to S11). Deviations: PL5.2's "a chat beside a board" needs
⌘L on selected shapes and is played at the desktop only (`composer.mjs playable`); PL5.1's widths of a pane are exact at the desktop, and at the touch viewports a window of that width (the phone layout) holds the fit and ⌘P.
`web/dev/reallibrary.mjs` (the popups on real servers) drives the old page; its new-build equivalent is `web/dev/reallibrary-app.mjs` (the same scenarios and assertions over the test host and two real server processes: it passes, 16 s).
