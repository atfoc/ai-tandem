# B2 — Point at, Add selection, the selection rule: design and contracts

The lead's decisions for package B2 (PLAN.md §3 "B2", goal 3.4 "Point at", "Add selection", "A selection on the board goes to no chat
by itself", 6.2). Chunks implement this file; a change to it is the lead's. Mockups (board v3 `b_edb3unwu`, phone frames 393×852 at
y −1913): "07 Point at" bd-07a x −1475, bd-07b x −965, bd-07c x −455; "11 Add selection" bd2-f-a x 92, bd2-f-b x 585, bd2-f-c x 1078;
"12 Selecting" bd2-g-a x 2178, bd2-g-b x 2671 (V1's half). Notes under each frame (y −1035…−850).

Everything below is **phone only** (`usePhone()` / `onPhone()`); tablet and desktop keep today's pick layer (hint pill, Esc, flash),
⌘L, ⌘⇧L, the inline chips in the box and the context row's "+ Add N selected", and every testID they read.

## 1. What is sent does not change

A reference is still an inline tag in the composer's value (`core logic/refs.ts` `serializeRef`), put **where the caret was** when the
flow began. The phone only *shows* it differently: the box holds the plain text and the references are chips in the context row.
The composer's value (what drafts store, what `submit` sends, what `held` refs and `insertRef` work on) is exactly today's: for a draft
"first second" with the caret after "first" and a point picked, the value and the sent text are `first <point x=".." y="..">…</point> second`.

## 2. The phone's reference box (`screens/board/refbox.ts` logic, `screens/board/RefBox.tsx` component)

`refbox.ts` (no React, Node-loadable; tested in `app/test/board.refbox.test.ts`):

```ts
export type Placed = { ref: Ref; at: number };           // at: an offset in the plain text, where the tag stands
/** The value's tags taken out: the plain text and where each tag stood (in order). Where a tag has white space on both sides (or at
 *  the start/end of the text next to white space), one of those spaces is dropped, because `joinRefs` puts it back (chipSpacing). */
export function splitRefs(value: string): { text: string; refs: Placed[] };
/** The value: the tags put back into the plain text at their offsets, spaced as ChipInput's insertRef spaces a chip
 *  (platform/chipinput/chipvalue.ts chipSpacing). joinRefs(splitRefs(v)) === v for every value insertRef can make. */
export function joinRefs(text: string, refs: Placed[]): string;
/** The offsets after the plain text changed from `before` to `after` (one edit: the common prefix and suffix are kept; a tag inside
 *  the replaced span moves to its start; a tag at the edit's start stays before what was typed there). */
export function shiftRefs(refs: Placed[], before: string, after: string, caret?: number): Placed[];
// caret: the caret's offset in `after` when the box knows it (RefBox passes the inner box's caret end): it places an edit in a run of
// the same characters.
```

`RefBox.tsx`: `forwardRef<RefBoxHandle, ChipInputProps & { onRefs(refs: Ref[]): void }>` drawing the ordinary `ChipInput` with the
same props, holding the plain text in it and the `Placed[]` beside it. `RefBoxHandle = ChipInputHandle & { removeRef(i: number): void }`.
- `onChange(plain, before)` of the inner box → `shiftRefs` → the outer `onChange(joinRefs(plain, refs), before)`.
- `set(value)` → `splitRefs`; the inner box gets the plain text, `onRefs` the refs.
- `insertRef(ref, at?)` → placed at `at.start` when given, else at the inner box's `caret()`'s start, else at the end; reported through
  the outer `onChange`; the inner box gets no tag. Same reference twice: kept twice (as today).
- `caret()`, `select(at)`, `openInsert(at)`, `replaceBeforeCaret`, `focus` → the inner box's (offsets are plain-text offsets; every
  caller gets them from this same handle, so they agree: `refs.ts` `away.caret`, Composer's `plusAt`).
- `removeRef(i)` → drops it, reports the new value.
- `locked` / `readOnly`: nothing put in or taken out (removeRef and insertRef do nothing).

Composer.tsx (phone branch only) draws `RefBox` in place of `ChipInput` and passes its refs to the context row (§4).

## 3. The two flows (`screens/board/refs.ts`, core store, core board side)

Store (`packages/core/src/state/store.ts`, additive): `pickFor: "point" | "select"` beside `picking` (default and after every end
`"point"`). `picking` stays the chat that waits, for both flows, so every place that ends a wait (goBack, the system back, Esc, ⌘⇧L,
`composerGone`, a dead chat) ends either.

`refs.ts`, additive:
- `startSelect(chat)`: the phone's Add selection. Like `startPick(chat, true)` with `pickFor: "select"`: keeps the box's caret in
  `away`, goes to the board (`go({ board, chat: null })`). A second call while that chat waits ends the wait.
- `finishSelect(chat)`: the selection on the board (`boardApp.selectionRefOn(board)`) goes into the chat's box at the kept caret (or
  is held, as `finishPick`), the wait ends and the chat opens again. Nothing selected: does nothing.
- `pickPoint(null)` (every end) sets `pickFor: "point"` again.
- `pickingFor(s): "point" | "select" | null` helper.

Board side (`packages/core/src/board/side.ts` `viewModeOf`): view mode while a **point** is waited for, as today; while a selection
is made the board keeps its role's mode (held → edit, so Excalidraw selects; a reader stays in view mode and the bar offers Edit here).

## 4. The chips (`screens/board/RefChips.tsx`, labels in `screens/board/reflabels.ts`)

`reflabels.ts` (Node-loadable, tested):
- `nearName(ref)`: the label of the first element of a point's `near:` detail (`"Checkout service"`), else its type (`"a rectangle"`),
  else null.
- `pointChipText(ref)` → `Point near Checkout service` | `Point near a rectangle` | `Point at (412, 230)`.
- `pinText(ref)` → `x 412, y 230 · near Checkout service` | `x 412, y 230`.
- `selectionChipText(ref)` → `2 shapes · Payments, Inventory` | `1 shape · Payments` | `3 shapes` (names: the labels of the detail's
  elements, in order, those that have one; the count is `ids.length`; "shape(s)" whatever their types).

`RefChips` {refs: Ref[], onRemove(i), readOnly?}: one 34 pt chip per reference, accent-soft ground, accent text 15 pt, an icon (the
"+" sheet's `PointIcon` / `SelectionIcon`), the text (one line, ends cut by the chip's max width), and a × with a 44 pt target
(`accessibilityLabel` "Remove the point from the message" / "Remove the selection from the message"); testIDs `ctx-chip` with
dataSet `{ kind: "point" | "selection", i }`, the × `ctx-chip-remove`. No × while `readOnly`.

C1's `ContextChips` takes them through a new optional prop `refChips?: ReactNode`, drawn right after the board chip; the row shows
when there is one.

## 5. The selection rule (goal 3.4, 6.2)

On the phone nothing puts the board's selection into a chat by itself, and nothing offers to: `ContextChips` drops "+ Add N selected"
(the wide `ContextRow` keeps it). The "+" sheet's board rows become **Add selection** (note: "Select shapes on the board" or, with a
selection already there, "2 shapes selected on the board"; waits with a reason on an archived board or a box that takes nothing) →
`startSelect(chat)`, and **Point at** (note "Tap a spot on the board") → `startPick(chat, true)`. ⌘L with a hardware keyboard stays (a
deliberate key, not "by itself"). The voice pill's selection (VC-28) is V1's (speech mode only) and is not touched here.

## 6. The board while a flow waits (`screens/board/PickBar.tsx`, `BottomRow.tsx`, `Overlays.tsx`, `PhoneBoardBar.tsx`)

- **Bar** (PhoneBoardBar): the state line says `BOARD_WORDS.picking` "Picking a point" / `BOARD_WORDS.selecting` "Selecting for the
  chat" (appended to `packages/core/src/logic/statewords.ts`, tone `"wait"`, drawn by `<StateWord>` with `colour` = the accent, as
  the mockup's accent pill) in place of the place and the role word; **Chats** is dimmed and disabled. Back cancels (goBack already ends a wait).
- **PickBar** (drawn by BottomRow in place of the whole row while this board's chat waits; full width, `BAND_HEIGHT`, accent ground,
  over Excalidraw's band; in landscape at the bottom edge too): an icon, a 17 pt white title, a 13 pt sub-line `for “<chat name>”`,
  and at the right one white 44 pt button (white ground, accent text, the orb's place):
  - point: title **Tap a spot on the board**, button **Cancel** (testID `pick-cancel`) → `pickPoint(null)`;
  - select, holder: title **Select items**, button **Add (n)** (n = `selectedOn(...)` of the board; off while 0) → `finishSelect`;
  - select, reader: button **Edit here** (`editHere(board)`), **Taking over…** while taking; then Add (n).
  testIDs `pick-bar` (dataSet `kind: point|select`), `pick-add` (dataSet `count`), `pick-take`.
- **Canvas**: an accent border (2 px, takes no pointer) around the canvas in both flows; no hint pill over the canvas on the phone.
- **The pin** (point): a tap draws a pin (16 px accent dot with a soft ring, `pick-pin`) and its label (`pinText`, dark ground,
  `pick-pin-label`) at the spot; 600 ms later `finishPick` runs (the chat opens with the chip). Taps meanwhile do nothing.

## 7. testIDs (`screens/board/ids.ts`, appended as `B2_TID`)

`pick-bar`, `pick-cancel`, `pick-add`, `pick-take`, `pick-pin`, `pick-pin-label`, `pick-border`; chips `ctx-chip` (kind point|selection)
and `ctx-chip-remove`.
