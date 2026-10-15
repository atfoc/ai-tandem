# Package K5: quotes, as built

What K3 (the composer), S4 (the chat view), S5 (markdown) and S8 (the fork parts) leave to K5 and what a later reader needs: where a quote is taken, how its place is
counted, the count and its list, how a quote shows where it points. Code: `app/src/screens/quotes/`, the port `app/src/platform/quote.{types,web,native}.ts` with
`quotealign.ts`, small hooks in `screens/chat/` and `screens/composer/`; the checks `web/dev/checks-app/{P7.4-quote,L17-quote}.mjs` (+ `quote.mjs`), the quote parts of
`SEC.10-readonly.mjs` (flag `QUOTES`, now on) and `P0.3-smoke.mjs` (the count of A2.plain-quotes and A2.board-quotes); the unit tests `app/test/quotes.{align,model}.test.ts`.

## Two ways to take a quote (AD-64, goal 4.2)
`screens/quotes/path.ts` `useSheetPath()` decides: **native always, and the web build on the phone layout**, take the **sheet path**; the web build on the tablet and
desktop layouts takes the **selection path**.
- **Selection path** (web, wide): the browser's selection in the thread and ⌘L, as the old page did (`quoteDom.ts` → `platform/quote.web.ts`). The comment field is a
  float at the passage (`QuoteFloat.web.tsx`, a portal into `document.body`): as wide as the composer's box and lined up with it, below the passage or above it, never
  over the composer, following the passage as the thread scrolls. Enter adds, Esc drops, a press elsewhere keeps a typed comment. The draft's passages are marked with
  the CSS Custom Highlight API (`::highlight(aiwb-pending)`), a press on a mark opens its field.
- **Sheet path** (native, phone layout of the web build): a **long press** (500 ms, `hold.ts` `useMessageHold`, touch events on the message's view so that a link or a
  button inside and the thread's scroll are untouched; 10 points of slop) opens the **Quote sheet** (`QuoteSheet.tsx`, in the shell's `Overlays` slot, opened through
  `sheetstore.ts`): the message's displayed text in a read-only multiline `TextInput` (the system's own selection handles), **Quote** (the selection; off until
  there is one), **Quote whole message**, Cancel. A message that cannot be quoted (a reply still being written: "Wait for the reply to finish, then quote it"; a chat that
  takes no change: its server's sentence; archived) says why in the place of the buttons. The quote goes to the composer of the chat through `bus.ts` (the composer's
  `useQuotes` registers a taker while it is drawn), whose **comment field is a sheet** (`CommentSheet.tsx`: Add / Save, Cancel, Remove). Closing that sheet (the dimmed
  page, a swipe, Esc, the back button) keeps what was typed as a press elsewhere does on the wide layouts (C-QT-08 "touch: to be defined"); Cancel drops it (C-QT-07).
  The web phone has no browser selection under the finger: the message gets `user-select: none` and no callout, the sheet is how its words are selected.
- On a web tablet/desktop with touch and no keyboard there is no way to quote (the browser's selection menu has no item of ours); the iPad app is the sheet path.

## The place of a quote (AD-75)
A quote stores `start`/`end` in the message's **displayed text** (`messageText(text, forUser)` of `screens/markdown/displayed.ts`: the text nodes the old page had,
with the "\n" nodes between blocks and around list items). The web DOM has only what is drawn: no separators, a run of white space as one space (`Inlines`), a tab in
code as four spaces, no final "\n" of a code block, no code header or list marker (`NOT_DISPLAYED`). `platform/quotealign.ts` pairs the drawn characters with the
displayed text (`align`, with `shownText(...)` of displayed.ts, which marks the separator characters), so an offset read from the DOM is stored in the displayed text's
and looked up again by it (`shownSpan`, `drawnSpan`). When the two do not match (a mention drawn with the board's name) `align` answers null and the offsets are the drawn
text's; `findQuote` then finds the quote by its words. The sheet path shows `shownText(...).text` itself, so its span needs no mapping. `displayed.ts` was refactored
(`pieces`, additive: `shownText`) with the output of `displayedTextOf`/`messageText` unchanged (`markdown.displayed.test.ts` passes).
- A selection is a quote of **one message's own words**: text in two messages, or in an entry that is no message (a tool card, a note), says "Select text within one
  message"; words beside a message's own (its fork actions, `fk-*`; the cards of its quotes, `sent-quotes`) are left out (S8's note), and a selection of those alone says the
  same as the old page did; a reply being written says to wait; `quotable` (data-quotable) is core's.

## Showing where a quote points (B-QS-08, C-QT-15)
`quotePort.show(chat, ref, highlight)`: **web** scrolls the thread so that the passage is centred and marks it for 1.6 s + 1.2 s (`::highlight(aiwb-quote)`, the colour
by light and dark). The thread is a virtual list, so the message may not be drawn: `screens/chat/threadscroll.ts` (new; the thread registers a handle while it is a list,
`StickyList`'s new `onList` prop) brings its row to the middle, and the port looks for the message for 2 s and centres the passage when it is drawn. **Native** brings the row to
the middle and flashes the message (`flash.ts`, `Flash.tsx`: the chat part `MessageFlash` drawn inside each message). The list's count button and a quote card of a sent
message use it (the chat part `showQuote`).

## Composer (K3's seams, `parts.tsx`)
`useQuotes({chat, quotes, setQuotes, readOnly, width})` is K3's `QuotesHook` (**`width`** is new and optional: the composer's width, which K3's `Composer` now measures with
`Sized`, for the count that leaves its word out at 440 px or less). `quote(ref)`, `count`, `float`, `kept()` as the page's. The count (`QuoteCount.tsx`, `qcount`) and
its list (`Overlay`: a popover over the count on the wide layouts, a sheet on the phone) are as the page's; the hint says "tap" with a finger and "click" with a mouse
(`usePointer`). `quoteSelection` is `quotePort.selected` (null on native).

## testIDs (`dataSet` in brackets)
`qcount` [n, stack, on] with `qcount-label` · `qlist` (the popup) with `qlist-head`, `qlist-hint`, `qlist-item`, `qlist-quote`, `qlist-comment` [none], `qlist-x` ·
`qfloat` [edit] with `qfloat-quote`, `qfloat-comment`, `qfloat-hint` (the float), `qfloat-remove`, `qfloat-cancel` (the sheet), `qfloat-save` · `quote-comment-sheet` ·
`quote-sheet` with `quote-text`, `quote-hint`, `quote-selection`, `quote-whole`, `quote-cancel`, `quote-why` · `flash`. Chat view: `msg` is unchanged (its `dataSet`
role, item, quotable, streaming), `thread` [chat, branch], `thread-scroll`. `web/dev/checks-app/quote.mjs` lists them.

## Findings
- **The virtual list's DOM is in no order on screen** (and, on web, rows are in reverse of their place at first): a range from one message to "the next" must follow the DOM's
  order, not the screen's. The checks' `select` helpers do.
- **Rows of the list are hidden from the pointer while it lays them out** (`opacity: 0; pointer-events: none` for the first moments): a finger held at once hits the list's
  container. `quote.mjs` `hold` waits for the message to be hit.
- **A browser clicks the dimmed page when the finger that opened a sheet lifts** (Chromium's emulation does, after a hold of any length): the Quote sheet ignores a press on
  the dimmed page for 500 ms after it opens and after the finger lifts (`sheetstore.ts`).
- react-native-web's TextInput tells its selection from React's `onSelect` (a key up, a mouse up, `selectionchange`), not from the `select` event: a check that sets a
  selection with `setSelectionRange` presses a key (Shift) afterwards, as a finger's handles would end in a touch.
- An **Android** `TextInput` with `editable={false}` takes no selection: the sheet's box is editable there with no soft keyboard (`showSoftInputOnFocus={false}`) and a key put
  in it is taken back (controlled `value`). **Not verified on a device** (V-track), nor is the long press on native (`onTouchStart` bubbling from the message's view), nor the
  system's selection handles in the sheet.

## Deviations and what is left
- **Native does not mark the draft's passages in the thread** (B-QS-07, C-QT-16: "device test"): AD-64 asks for the flash and, in the sheet, the span; the thread draws no
  highlight, and the pending quotes are in the count's list. A press on a marked passage exists on the web build only. The sheet does not mark the quotes already in the
  draft either (the system selection is the only mark it could draw in a `TextInput`).
- `quote.native.tsx` of the package text is `quote.native.ts` (it draws nothing); the sheet is in `screens/quotes/` because the browser runs it too (the phone layout).
- Esc in the sheet path keeps what was typed (closing the sheet); Esc drops it only in the float. C-QT-07 asks for a Cancel action on touch, which there is.
- ⌘L on native with a hardware keyboard and no selection says "Select text in a message to quote it" (core's sentence); the way to quote there is the long press.
