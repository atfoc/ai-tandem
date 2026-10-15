# Package K3: the composer, as built

What K4 (images), K5 (quotes), S7 (the Subagents chip), S8 (the move's banner) and S11 (the prompt library's insert popup) build on; S9's context ring is drawn by the toolbar as merged. Code: `app/src/screens/composer/` (registered in the chat view's `Composer` part and as the shell's `focusComposer` by `screens/register.ts`),
the platform ports `app/src/platform/{sized,zoom,leaving,keyboard}.{web,native}.ts*`, the checks
`web/dev/checks-app/{A2.2,A2.3,A2.4,A2.5,A2.6,P0.1,P0.5,P0.6,P7.1,P7.3,L16}-*.mjs` and the readers `composer.mjs`, the fixture `app/test/fixtures/composer-widths.json`,
the unit test `app/test/composer.test.ts`.

## What it draws (`Composer.tsx`)
`Composer({chat})` is the composer of the branch the chat is on (`viewedBranch`; another branch has another composer, keyed by it, with its own draft). Under the
thread, in this order: the context row of a board chat (`context-row`: the board's chip, the chips of the boards the text mentions, K5's count, then the note or
the two buttons), S8's banner, the note of a model that is not the conversation's (`model-notice`), the box (`composer-box`: K4's strip, the chip input
`composer-input`, the toolbar `composer-tools`), the line under it (`composer-err`), K5's float. An archived chat draws `archived-bar` ("Archived — unarchive to
continue", `unarchive`) and no box; a chat of the old board connection draws its own bar.
- **Logic is `@aiwb/core`'s, unchanged**: drafts (`DraftSaver`, `chatdraft`, `draftsback`, `registerComposer`), `composerControls`, `sendWait`, `imagesHold`, `sendend`,
  `mentions`, `chatserver` (read-only, titles), `models`, `agentlist`, `subsettings`, `composerfit`. `send.ts` is `sendMessage` (the board's `buildContext` comes from
  `boardApp`); it is registered as the chat view's `sendMessage` part too, so a suggestion's chip sends a board chat's context.
- **Keys** (`keys.ts`, pure): `boxAction` (the @ list's arrows, Enter, Tab, Esc; Enter sends; Esc stops), `refKey` (⌘L is the composer's; ⌘⇧L is the **board's**:
  `screens/board/boardkeys.ts` takes it and `pickPoint`s, so the composer handles only ⌘L), `sendByKey`, `keyNames`. The composer's ⌘L handler is on the keys port
  (AD-73); the board's selection goes in through `addSelection(chat, board)` and the inserter the composer registers with `registerInserter`.
- **Focus**: `focus.ts` keeps the open boxes by chat; `nav.ts`'s `focusComposer` gives the focus to the box of `sel.chat` 30 ms later (not under the library). The
  composer of a branch a sent move went to takes it with the caret at the end (`ChipInputHandle.focus(atEnd)`, new and optional in `chipinput/types.ts`).

## ENTER on the native boxes (the decision K3's note asks for)
`onKeyPress` reports Enter without its modifiers and the soft keyboard's return key reports the same "Enter" as a hardware keyboard's, so the composer cannot tell
a return key from an Enter nor Shift+Enter from Enter. C-TX-03 says that on touch the return key is a line break and Send is the button. So **on iOS and Android
Enter is a line break, whatever the keyboard** (`enterSends(os)`: web only; the composer's `onKey` takes no Enter there, and K2's box then keeps the new line it
was given), **Send is the button**, and a hardware keyboard sends with **⌘Enter** (iPad) or **Ctrl+Enter** (Android), which the keys port reports (aiwb-keys'
`mod+Enter`, the one the library's edit form already uses to save; the composer ignores it under a dialog and when its chat is not the selected one). Send's title
names no key there (`sendTitleFor`). Not verified on a device (the XCUITest cannot send Return: N3's finding). The browser (all three viewports) keeps Enter = send:
a browser has a keyboard, and L16 holds that Shift+Enter is a line break there.

## The toolbar and its fit (`Toolbar.tsx`, `measure.tsx`, `widths.ts`)
The rules are `logic/composerfit.ts`'s, unchanged. What changed is how widths are known (AD-62: "measured with onLayout"):
- `platform/sized.{web,native}.tsx` is a View that tells its width: **web** a ResizeObserver on the element with the border box's fractional width, applied with
  `flushSync`, so the toolbar is fitted to its row in the frame that shows the row (react-native-web's own `onLayout` reports the integer `offsetWidth` a task later,
  after the paint: a drag of the panel showed frames past the box); **native** `onLayout`.
- A control whose width is not kept is drawn in a hidden layer (`MeasuringLayer`: opacity 0, clipped to a point, no testID) with everything else the fit may need
  (more chip, insert, both meters, Send, Stop, attach; the meters are S9's `CtxRing` / `CtxError` alone, under the testID `ctx-meter-measure`, so that the page has one `ctx-meter`), **in one round**, so the fit is never made with only some of the widths; the row draws only controls whose
  width is known. Kept by `widthKey`, the first measurement of a key staying (a chip measured again in another place would change the fit with its surroundings).
- `platform/zoom.{web,native}.ts`: `zoom()` (devicePixelRatio, live) and `useZoom()` (a media query on the resolution: it fires in the frame of the change). A change of
  zoom drops the kept widths and remounts every `Measure` (`MeasureEpoch`). A build for the checks shows the counter of kept widths on `window.__aiwbWidths`.
- The reason line (`agent-reason`) lets the row wrap; without it the row does not (an overflow is then an overflow, which P0.1 holds the measure to see).
- **Popups** are `ui/Overlay` (a popover over its chip on the wide layouts, a bottom sheet on the phone): the lists (`picker`: search field, groups, rows `pick-row`
  with `role="option"`; arrows, Enter, Esc; focus back on the chip as it closes), the folder browser (`dirs`), the "more" popup (`more-pop`, rows `more-row`).
  One list is open at a time (`openPicker`); a control that changes place has no open list; while "more" is open nothing returns to the row. **Deviation**: the
  popup is a layer over the page with a backdrop, where the old one had none (Send stayed within reach): a press elsewhere closes it and is not also acted on, and in
  a frame in which an overlay is open Send is not held to be within reach (the probe's `list`).
- `aria-disabled`: react-native-web's Pressable replaces it with its own `disabled`, which becomes the button's and takes no focus. Controls that are really off use
  `disabled`; the chips that open nothing while a change is saved (and keep the focus a pick gave them) get `aria-disabled` through `useControlRef`'s fourth argument.

- **The context meter is S9's** (`screens/usage`: `ContextMeter({chat, compact})`, with its popup), drawn in the row by the toolbar as S9's notes say (`compact={fit.meter === "ring"}`); the toolbar keys its width by S9's `ctxText` and `contextOf`.

## Seams (`parts.tsx`: `setComposerPart(name, value)`, once, at import, from `screens/<area>/index.ts`; the area's import goes in `screens/register.ts`)
| Part | Package | What it gets / does |
|---|---|---|
| `ImageStrip` | K4 | `{chat, branch, images, uploads, note, again, onRemove}`: the thumbnails above the text. null: none. Registering it also turns the box's `onImages` (a paste of images) on |
| `AttachButton` | K4 | `{off, onPress}`: the toolbar's attach button, which never leaves the row. The default is a **disabled** button of the final geometry (the fit counts it); K4 replaces it |
| `pickImages` | K4 | `() → Promise<{files, skipped}>`: what the attach button's press calls; null until K4 |
| `useQuotes` | K5 | `({chat, quotes, setQuotes, readOnly}) → {quote(ref, at), count, float, kept()}`: `count` goes in the context row, `float` at the end of the composer, `kept()` is what is saved when the composer goes away |
| `quoteSelection` | K5 | `(chat) → {ref, at} | {error} | null`: what ⌘L reads (the text selected in a message); `at` is handed to `quote` |
| `SubagentsChip` | S7 | `{c, fixed, disabled, open, onOpenChange, onBusy, onError}`: the chip and its popover; the toolbar keeps the one open list and measures it. The default is the fixed chip with its words. `TChip`, `Picker`, `UNTIL_FIRST_MESSAGE` are exported from `screens/composer` for it |
| `BranchBanner` | S8 | `{chat}`: the banner of a pending move, above the box. null: none. (The composer reads `s.moves`; `leftByBack`, `registerComposer`, `sendAt` are core's) |
S11 plugs into nothing of the composer: the insert popup is opened through the box (`ChipInputHandle.openInsert`, core's `openInsertPopup`); the composer's Insert button (`insert-btn`,
or an entry of the "more" popup, `more-insert`) and ⌘P in the box call it, and both are off while the chat is read-only. `focusSelectedBox` does not take the focus under an open library.

## testIDs (`dataSet` in brackets)
`composer` [chat, branch] · `composer-box` [readonly] · `composer-input` (K1's) · `composer-tools` [more, meter, insert] · `tool` [control] · `tool-grow` · `part` [part: more | meter | insert |
attach | stop | send] · `tchip` [kind, fixed] (`more-chip` for the "more" chip) · `chip-name` · `lock` · `send` [sending] · `stop` · `insert-btn` · `attach-btn` · `agent-reason` [tone] · `more-pop` · `more-row` [control] · `more-insert` · `picker` · `picker-search` · `picker-clear` · `pick-row` [optionId] · `dirs` · `dir-browser` · `dir-input` · `dir-item` ·
`dir-use` · `dir-err` · `context-row` · `ctx-chip` [ref] · `ctx-act` [kind: selection | point, on] · `ctx-note` · `mention-pop` · `mention-item` [board] · `composer-err` · `model-notice` [warn] ·
`archived-bar` [legacy] · `unarchive`. The readers are `web/dev/checks-app/composer.mjs` (`composerProbe`, `fitProbe`, `measureComposer`, `toolbarWidths`, `placesOf`, `openState`, `openAt`,
`SEES`: the new build's counterpart of the seed's `see`).

## Findings
- **A window under 700 px is the phone layout** (AD-72), so a "chat page of 300 px beside the sidebar" (the old A2.2, A2.3, P7.3 windows) cannot be made: a page narrower than the
  sidebar leaves it is the phone layout's chat screen (as wide as the window, its popups sheets), and from 1100 px the page is 836 px or more, where the 780 px column keeps its width. The
  ports use windows of the page's width under 700 px, and the desktop layout's 1100 px for the ⌘B rounds (the box keeps its width: that, and every frame fitted, is what they hold). The
  panel beside a board is held at 300 px in a window of 1100 px (the tablet layout starts below). `composer.mjs` `pageWindow`, `openState`.
- A pinned clock (`page.clock.setFixedTime`) stops the sheets' animation (it runs on `Date.now`): P7.1 does not pin it (the composer has no label that tells a time).
- `Sheet` rises in 180 ms: a check that reads a sheet waits for its box to come to rest (A2.4).
- `ui/Text` takes a `ref` now (a prop in React 19; the type said none): the name of a chip gets the web's tooltip.
- The three states with a pending move (`plain-move`, `plain-move-long`, `board-move`) are not drawn by any check here: they start from a message's Branch action (S8). `composer.mjs` has the
  flag `MOVE`; with S8 merged, set it, run `WRITE=1 node web/dev/checks-app/P0.6-widths.mjs` (the fixture then has them) and the checks take them.
- The context row's touch labels are "Add selection" / "Add N selected" and "Point at"; with a mouse "+ Selection ⌘L" / "+ N selected" / "+ Point ⌘⇧L" as before (`usePointer`: the last pointer event).
- `react-native-keyboard-controller` (AD-62's `KeyboardStickyView`) is **not added**: it is a native module that needs react-native-reanimated, and K3 could not build or run it. `platform/keyboard.native.tsx`
  lifts the composer by the keyboard's height with React Native's `Keyboard` events (not verified on a device); the library replaces that one file.
- The checks the old `web/dev/checks` hold for the usage popover (A2.4's opener, P7.1's) are S9's (`A2.4-usage.mjs`); the pending move and the branch send (P7.1, P7.2) are S8's (flag `MOVE`).

## Checks
Ported to `web/dev/checks-app/`: `A2.2-fits`, `A2.3-places`, `A2.4-popups`, `A2.5-selectors`, `A2.6-names`, `P0.1-overflow`, `P0.5-frames`, `P0.6-widths` (desktop; writes `app/test/fixtures/composer-widths.json`), `P7.1-flavours` (the
composer's part), `P7.3-sidefit` (desktop); new `L16-composer` (the rows that had no check: placeholder, Enter and Shift+Enter, trim, Send's state, a refused Send, a busy chat, growth, focus, the @ list, the model's search, the
bars, the note). The `COMPOSER` flags are on in `SEC.7-drop`, `SEC.8-sameid` (with S4's chat-view half, which S4 left off), `SEC.9-storage`, `SEC.10-readonly`, `AAC.2-localdown`, `AAC.3-remotedown`, `A1.4-key`, `A1.5-notices`,
`P7.2-menu`, each with the composer's half of the old check's body; `P7.4-board` reads the composer's chips and buttons; `P0.3-smoke` draws the composer's parts of the A2 states.
