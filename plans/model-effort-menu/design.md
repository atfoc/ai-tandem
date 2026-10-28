# The model and effort menu: goal, design and decisions

## 1. Goal (the person's words, as given)

- Model selection and effort level are joined in one menu.
- On mobile this is already so; there, move the effort to the top and keep it fixed while the list of models below it scrolls and can be
  searched. Search goes above the effort.
- On desktop, the same menu as on mobile.
- ⌘E opens that menu in the focused chat when its selection is not locked; the search field gets the focus.
- ↑ / ↓ move through the models; Tab / Shift+Tab move through the efforts; Esc closes and applies nothing; Enter applies both.

## 2. Decisions (made by the lead; implementers follow them, do not re-open them)

### 2.1 One menu, top to bottom

1. **Head**: the title "Model and effort"; on the phone the sub-line it has today ("<chat's name> · <agent>"). **Cancel** at the left and
   **Done** at the right (Done is the strong one). On the desktop popover the head is a small `MenuHead`-like title row with the Done
   button at its right; there is no Cancel button there (Esc and a click outside are the cancel).
2. **Search field**, always shown (whatever the number of models), placeholder "Search models", with the clear button (×) when it holds text.
3. **Effort**, fixed (it never scrolls): the label "Effort", the segmented control (`phone/chips/Segmented.tsx`, a smaller size on the
   desktop popover) of the **drafted** model's efforts, and under it the line "More effort thinks longer and uses more of your plan.".
   When the drafted model has no efforts, the same slot shows the muted line "This model has no effort setting." (the slot keeps a stable
   height so the list does not jump as the draft moves between models with and without efforts). When no model of the catalog has efforts
   the effort section is not drawn at all.
4. **Model list**, the only part that scrolls: grouped under provider headings when the catalog names more than one provider (core's
   `groupModels`; the phone's `modelRows` order), each row the model's label and its second line (`modelNote`: note · context size); the
   drafted model has the accent ✓ and the keyboard highlight. "No matching models" when the search leaves none.
5. **Held line**: when a pick cannot be taken now (`held`, a non-empty reason), the reason is shown under the head, rows / segments / Done
   are disabled. (The desktop chip is disabled while held, so the menu cannot be opened then; but a menu that is open when a pick becomes held,
   a send or a save starting included, stays open and shows the line. It closes when the model and effort stop being a choice or the catalog goes.)
6. **Key hints** (desktop popover only), one faint line at the bottom: `↑↓ Model · Tab Effort · Enter Apply · Esc Cancel`.

### 2.2 A draft, applied once

The menu opens with the chat's current choice (`Choice` = model + effort) as its **draft**. Nothing is written while it is open.

- A press on a model row, or ↑ / ↓, makes that model the draft's model; the draft's effort is then resolved as the server does
  (core's `withModel`: kept if the new model offers it, else the new model's default, else none).
- A press on an effort segment, or Tab / Shift+Tab, sets the draft's effort (Tab: next, Shift+Tab: previous, both wrap around; a model with
  no efforts: the keys do nothing, but Tab is still swallowed so the focus stays in the search field).
- **Enter** or **Done** applies the draft (one write carrying the changed fields; nothing when the draft equals the current choice) and closes.
- **Esc**, a click outside, a swipe down of the sheet, or **Cancel** close and apply nothing.
- Typing in the search: if the draft's model is still listed it stays the draft; otherwise the first listed model becomes the draft's
  model (by `withModel`). When the search lists no model, the draft is left as it is but Enter does nothing (no row to apply) and Done is
  disabled; Esc still closes.
- ↑ / ↓ move within the listed (filtered) models, in render order, wrapping around; when the draft's model is not listed, ↓ goes to the
  first and ↑ to the last.

This holds on the phone too (a change: today a tap there writes at once). It is the same menu everywhere.

### 2.3 Where the keys are heard

- The search field has the focus while the menu is open on the desktop (opened by a click on the chip or by ⌘E), so ↑ ↓ Tab Shift+Tab
  Enter Esc are its keys: they are handled in the field's key handler and `preventDefault`ed. The field is marked `data-keeps-tab` (dataSet
  `keepsTab`), so the overlay's Tab trap (`ui/modal.web.tsx`) leaves its Tab and Shift+Tab to it. On the phone, and on the wide toolbar off the
  web (an iPad without a keyboard), a tap on the chip does **not** focus the search (the soft keyboard would cover the menu); ⌘E does (a hardware keyboard).
- Esc is handled by the menu itself (it cancels), the overlay's own Esc handling must not apply anything either.

### 2.4 ⌘E

- ⌘E on macOS / iOS / iPadOS, Ctrl+E elsewhere (core's `isMac(platform)` rule, as `isSideKey`), no Shift and no Alt, `code === "KeyE"`,
  a key repeat is ignored. Heard from anywhere in the window, also in a text box (through the keys port `app/src/platform/keys`, as the
  composer's ⌘L and the shell's ⌘J).
- It acts on the composer of the selected chat (`getState().sel.chat === chatId`), and only when no dialog is up (the composer's
  `underDialog()` rule) and the menu can be opened: the chat's model and effort are a choice (`pickerMode` is not `"fixed"`, the chat is
  not frozen / gone, no fork restart is in progress), the catalog is here, and nothing holds the pick (not `sending`, not `patching`, no
  `held` reason). Otherwise the key is left alone (no `preventDefault`).
- When it acts: `preventDefault` + `stopPropagation`; if the menu is closed it opens with the search focused; if it is open it closes
  (cancel, as Esc).
- Desktop: the menu hangs from the model chip; when the fit has put the model chip into the toolbar's "more" popup, ⌘E opens the menu
  hanging from the "more" chip (the more popup itself stays closed).
- The chip's title names the key: "Model and effort (⌘E)" / "(Ctrl+E)".

### 2.5 The desktop toolbar

- One chip, `kind="model"`, labelled "<model label> · <effort label>" (just the model label when the model has no efforts), opens the menu
  as a popover (`Overlay kind="popover"`, `up`, anchored to the chip), about 360 px wide, the list at most `min(320, 40% of the window
  height)` tall.
- The separate Effort chip is gone from the toolbar: the toolbar no longer gives `composerfit` an `effort` control. Core's `composerfit`
  is left as it is (its `"effort"` Control simply goes unused by the toolbar).
- The fixed chip (a started chat), "Loading models…" and the disabled/hint behaviour stay as they are.

### 2.6 The phone

- `ChipRow`'s model chip opens the rewritten `phone/chips/ModelSheet.tsx`: a `Sheet` whose pinned `head` holds the `SheetHead` (Cancel,
  title, sub-line, Done), the search field and the effort section; its scrolling body is the list. Large detent when there are more than
  eight models, else `fit`.
- The Toolbar's `only` rendering (the chip row drawn by the toolbar) follows the desktop toolbar: no separate effort control.

## 3. Code layout (the contract between the parts)

### 3.1 Core: `packages/core/src/logic/modeleffort.ts` (no React, tested in `packages/core/test/modeleffort.test.ts`)

```ts
import type { Catalog, CatalogModel } from "../types.ts";
import type { Choice } from "./models.ts";

/** `base`: the choice the menu opened with; applying diffs the draft against it (not against a later choice another window made). */
export type MenuState = { query: string; draft: Choice; base: Choice };

/** The state the menu opens with: no query, the current choice as the draft and as the base. */
export function openMenu(cur: Choice): MenuState;
/** The listed models for a query, in render order (groupModels(filterModels(models, q)).flatMap(g => g.models)). */
export function listedModels(models: CatalogModel[], query: string): CatalogModel[];
/** Typing: the draft's model kept when listed, else the first listed (withModel); none listed: the draft as it is. */
export function typeQuery(s: MenuState, query: string, cat: Catalog): MenuState;
/** ↑ (-1) / ↓ (+1) within the listed models, wrapping; draft not listed: ↓ the first, ↑ the last; none listed: unchanged. */
export function moveModel(s: MenuState, d: 1 | -1, cat: Catalog): MenuState;
/** A press on a row. */
export function pickModel(s: MenuState, id: string, cat: Catalog): MenuState;
/** Tab (+1) / Shift+Tab (-1) over the drafted model's efforts, wrapping; an effort not in the list: +1 the first, -1 the last; no efforts: unchanged. */
export function stepEffort(s: MenuState, d: 1 | -1, cat: Catalog): MenuState;
/** A press on a segment. */
export function pickEffort(s: MenuState, effort: string): MenuState;
/** Whether Enter / Done may apply: the drafted model is listed under the current query. */
export function canApply(s: MenuState, cat: Catalog): boolean;
/** What applying writes: the fields of `draft` that differ from `cur` (the menu's `base`) ({ model?, effort? }); null when nothing differs (sameChoice). */
export function applyPatch(cur: Choice, draft: Choice): { model?: string; effort?: string } | null;

export type MenuKeyAction = "next" | "prev" | "effortNext" | "effortPrev" | "apply" | "cancel" | null;
/** ArrowDown next, ArrowUp prev, Tab effortNext, Shift+Tab effortPrev, Enter apply (not with Shift / Alt / ⌘ / Ctrl, not while an IME composes:
 *  `isComposing`), Escape cancel; anything else null. */
export function menuKey(e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean }): MenuKeyAction;
/** ⌘E (Mac, iPhone, iPad) / Ctrl+E (elsewhere), no Shift, no Alt, code KeyE. */
export function isModelMenuKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, platform: string): boolean;
/** "⌘E" / "Ctrl+E", for titles and hints. */
export function modelMenuKeyName(platform: string): string;
```

### 3.2 App: the menu (`app/src/screens/composer/ModelEffortMenu.tsx`)

Holds the draft (`MenuState`, from core) and draws the search field, the effort section, the list, the held line and (popover only) the key
hints, with the keys of 2.2 on the search field. It exports:

```ts
export type ModelEffortMenuProps = {
  open: boolean;              // the draft is (re)made from `value` each time it opens
  cat: Catalog;
  value: Choice;              // the current choice
  held: string;               // "" when a pick can be taken
  focusSearch: boolean;       // give the search field the focus as it opens
  onApply(patch: { model?: string; effort?: string }, choice: Choice): void;   // only called with a non-null patch; the caller closes
  onClose(): void;            // cancel (Esc, outside, swipe, Cancel) and also called after onApply
};
/** The desktop's popover (Overlay kind="popover", anchored, up). testID "model-menu". */
export function ModelEffortPopover(p: ModelEffortMenuProps & { anchor: RefObject<View | null>; keyName: string }): ReactElement;
```

and `phone/chips/ModelSheet.tsx` keeps its file and its export name, its props becoming
`ModelEffortMenuProps & { c: ChatView; sub: string }` (no more `onPickModel` / `onPickEffort`).

### 3.3 testIDs

- The popover root: `model-menu`; the phone sheet keeps `C2_IDS.modelSheet` ("model-sheet").
- Inside both: `model-menu-search` (the field), `model-menu-clear` (×), `C2_IDS.effort` ("effort-seg") for the segmented control with its
  segments `C2_IDS.segment` (dataSet `value`, `on`), `C2_IDS.effortLine` ("effort-line"), `model-menu-row` per model (dataSet `model` = id,
  `on` = drafted, `active` = keyboard highlight), `model-menu-empty`, `model-menu-held`, `model-menu-done`, `model-menu-cancel` (phone),
  `model-menu-keys` (desktop hints).
- The desktop chip stays `TChip kind="model"` (the checks find it by `data-kind="model"`), and gets dataSet `effort` = the effort id shown.

## 4. Who does what

1. Core logic and its tests (3.1).
2. The menu component and the phone sheet (3.2), with the UI of 2.1 for both variants.
3. In parallel after 2: (a) the desktop toolbar, ⌘E there, the browser checks of the wide layouts; (b) the phone chip row, ⌘E there, the
   browser checks of the phone layout.
4. Merge, the tests of AGENTS.md, a review.
