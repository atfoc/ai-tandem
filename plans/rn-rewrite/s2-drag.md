# Package S2: sidebar drag and drop, as built

What later packages that touch the sidebar's rows, heads or scroll build on. Code: `app/src/screens/sidebar/{drag.tsx, dragsession.ts, drophit.ts,
pressguard.ts}`, `app/src/platform/{dragpointer,dragscroll}.{types,web,native}.ts`, small changes to `rows.tsx`, `parts.tsx`, `Sidebar.tsx`.
Checks: `web/dev/checks-app/{A3.2-drops,A3.3-during,L14-dragtouch}.mjs`, the `DRAG` parts of `SEC.3` and `SEC.5`, the driver `drag.mjs`;
unit test `app/test/dragdrop.test.ts`.

## How it works
- A `Gesture.Pan` (react-native-gesture-handler) in a `GestureDetector` on every chat row, board row and group head that can be dragged. A mouse starts
  it by moving 5 px with the button down, a finger after a long press of 300 ms, held still (`usePointer()` picks which). A row in rename mode, an archived row
  and a chat nested under a board start none (the gesture stays on and ignores the start: switching it off and on made the web detector update a handler
  it had dropped, "No handler for tag N").
- The places that take a drop register their view (`usePlace`): a group's whole box and a server's ungrouped area (`Zone`, rows.tsx), a group's head. On every
  move the places are measured with `measureInWindow` and the pointer's point is looked up in them (`drophit.ts dropEventAt`): the innermost zone alone; the
  upper half of a group's head, for a dragged group, is "before"; a refusing place lights nothing and the zone around it does not light in its place; the part
  of the tree that is on screen (the box around the scroll view) bounds all of it. The answer is an event of `logic/dropmark.ts`, told to the one mark
  (`markDrop`), which `Zone` and the head already drew from. `dropmark.ts` is unchanged (the old page shares it); its `WINDOW_EVENTS` and `SOURCE_END`
  are HTML drag events and are not used.
- `dragsession.ts` is the state machine (no screen, no store: `Env` is given, the unit test runs it on fakes). A release is looked up on its own, at the place
  the platform says the pointer was, and moves what is dragged with `moveTo` / `moveGroup` of S1's `actions.ts` (so a section's move is shown ahead and put
  back, as before). Escape (the keys port), the system's cancel, and the dragged row being removed end the drag with no move; after every ending the mark is empty.
- A label with the dragged name follows the pointer (`DragGhost`, testID `drag-ghost`), and the dragged row is drawn at 0.45 opacity.
- A pointer held 350 ms in the top or bottom 36 px of the list scrolls it (`edgeSpeed`, 1 to 14 px a tick); one that passes by does not.
- A drag that ends on the row it began on does not open it (`pressguard.ts`: the rows' `useDoublePress` ignores the click that follows a release).

## Web only, in `platform/`
- `dragpointer.web.ts`: the gesture handler's web events leave out the move that re-enters the dragged row's own box and a move in the frame of the release, so a
  drag also follows the window's trusted `pointermove` / `pointerup` (a synthetic one is no pointer). Native: nothing (the handler reports all).
- `dragscroll.web.ts`: a finger that moves after the long press is a scroll to the browser unless a non-passive `touchmove` listener cancels it; the browser decides
  at the touch's start, so the listener stands on the list's box (`clipRef`) as long as it is drawn and cancels only while a drag is held. The rows have
  `touch-action: pan-y` (`touchAction` of `GestureDetector`) so a swipe still scrolls. Native: the sidebar's `ScrollView` is switched off while a drag lasts
  (`LOCK_SCROLL`).

## For readers of the DOM
On web `GestureDetector` wraps its child in a `<div style="display: contents">` (native has no wrapper). `checks-app/side.mjs sidePartInPage` and `drag.mjs`
walk through such a div; a new reader that uses `:scope >` on rows or heads must do the same. testIDs added: `drag-ghost` [kind]; `dataSet`: `drop` on a zone
(S1's), `dropBefore` on `side-group-head`.

## Decisions
- **Dropped with HTML drag and drop** (no pointer gesture can have them): a drag begun in another window of the app (A-DD-10, a browser with two tabs only; the
  app is one window), the old "pointer or key empties the mark" rule for a lost drag end (A-DD-11's first half; the gesture always ends), a drag that comes from
  outside the page (A-DD-08 holds: nothing listens for it). A3.3 says so where it drops a scene.
- A press on a row twice within 400 ms is S1's double press (a rename), also in a check: A3.2's S11 waits 450 ms between its two clicks on a group head.
- A3.2 and A3.3 hold their old scenes; the pointer there jumps from place to place in A3.3 (`steps: 1`), as the old drag events did.

## Not proven on a device
Everything native: the long press, the pan arbitration with the `ScrollView` on iOS and Android (the scroll view is switched off during a drag as insurance),
`measureInWindow` per move at the speed of a finger, the edge scroll's feel, the label over the sidebar of a tablet, Escape from a hardware keyboard on an iPad.
The browser checks drive Chromium with touch events through the protocol, which is the web build only.
