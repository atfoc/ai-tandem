# Package S8: branch and fork actions, the waits of the fork flows, the chat tree popup, labels, as built

What K3 (the composer), S6, S7 and S11 build on or must agree with. Code: `app/src/screens/fork/` (registered by `screens/register.ts`), the checks
`web/dev/checks-app/{A4.2-shows,A4.3-held,A4.4-ends,L15-fork}.mjs` and `fork.mjs` (readers and moves), the unit tests `app/test/forkscreen.test.ts`.

## What it draws
- **`MessageExtras`** (`Message.tsx`, a chat part of S4): inside a message after its text. A mouse sees the actions (`fk-acts` > `fk-act` with dataSet `kind`:
  `branchEdit | branch | forkEdit | fork | label`) in a bar over the message while it is hovered (`hovered` comes from S4's `ItemView`, `useHovered`);
  a finger has a "⋯" (`fk-more`) on the message that opens the same actions as a menu (`Overlay`: a popover on the tablet, a sheet on the phone), a held
  action disabled with its reason under it. Titles, texts and the holds are core's (`messageButtons`, `heldReason`), the tooltip is the `title` attribute.
  Also the marker "Branch n of m" (`fk-marker`, in flow after the text: the old page put it above the message), the label tag (`fk-label-tag`) and the
  label field (`fk-label-field` > `fk-label-input`, 200 characters). **Every control of the extras has a testID that starts with `fk-`: a reader of what a
  message says (the checks' `msgText`, K5's quote on web) leaves those elements out.**
- **`HeaderCrumb`** (` · ⑂ name`, `fk-crumb`), **`HeaderTail`** (`fk-tail`: the alerts `fk-alert` dataSet `kind` asks | failed | quiet, and the Tree button
  `fk-tree-btn` dataSet `count`) in `Chrome.tsx`. `Banner` (`fk-banner` dataSet `sending`, `fk-banner-text`, `fk-back`) is a new chat part drawn between the
  thread and the composer.
- **The tree popup** (`TreePopup.tsx`, in the shell's `Overlays` slot, `tree-popup`): a dialog on the wide layouts, a sheet on the phone. `fk-nav`,
  `fk-nav-sub`, `fk-filter` (dataSet `id`), `fk-search`, `fk-rows`, `fk-row` (dataSet `kind` user|text|fork, `end`, `on`, `path`, `held`, `mark`; the `title`
  attribute is the hold's reason), `fk-text` (`aria-disabled` while held), `fk-tag`, `fk-model`, `fk-mark` (dataSet `mark`), `fk-stop`, `fk-here`, `fk-end`,
  `fk-fork-link`, `fk-loose-head`, `fk-none` (dataSet `kind` loading | error | empty) with `fk-retry`, the row menu (`menu` labelled "Row actions": `fk-ctx-item`
  dataSet `kind`, `fk-ctx-note`), the foot `fk-nav-foot` with `fk-held` (the reason) or `fk-foot-text`, and `fk-folder-agents`. ⌘⇧B toggles it (the keys port).
- The waits of the fork flows are drawn by S4's thread (`wait-line`, the message on its way, the kept history); S8 draws their holds (Back, the alerts, the
  actions, the tree's rows and menu) and the banner's "is being sent".

## Decisions
- **Touch.** B-FK-01, 15, 17, B-LB-02, B-TR-09: the parity note says "long press menu"; the message has a "⋯" button (always there with a finger, so a long press is
  free for K5's quote), the tree's row has one too (`fk-row-more`) besides a long press, which a touch the browser's tools send does not reach. B-TR-08's
  double click is two presses within 400 ms with a mouse and one press on the picked row with a finger (`treemodel.ts opensOn`); the foot's words follow
  the pointer (`footText`: "Tap a message twice…", "Press and hold…"). The search box is focused on open for a mouse only (no keyboard over the sheet).
- The row menu is anchored to its row (the old page's was at the pointer, B-TR-26: none) and is a sheet on the phone.
- Esc: the row menu is an overlay of its own, on top; then the search is cleared; then the popup closes (`escStep`); in the label field it cancels the label. The
  overlay's close does not say what asked for it, so the keys port's handler notes an Esc (`escAt`) and only that takes the steps; a press on the dimmed page and
  Android's back close at once.
- **Phone: one bar.** The shell's `Bar` is gone from the chat screen; `ChatHeader` draws `BackButton` (new file `shell/BackButton.tsx`, moved from `PhoneStack`,
  which re-exports it) first when the layout is `phone`. The drawer keeps its `Bar`. The wide layouts do not change.
- Fixes of S4's files while there: `usePointer` was imported with its `.ts` extension in `Header.tsx` (the native file, so a mouse looked like a finger on web).

## For K3 (the composer)
The composer draws what the old checks read in it; `fork.mjs COMPOSER_IDS` names the ids A4.2, A4.3 and A4.4 will read (change it to the ids K3 draws) and
`COMPOSER` at the top of each of the three is the flag K3 sets (`true`). What those checks leave out until then, with the old body in `dev/checks/`: Send's spinner
and its title, the empty box after a Send, the text back in the box with the error under it, the pickers' holds, Stop, what is typed while a message is on its way,
the model/effort pick on a fresh fork (B-FK-19), the composer's fit at 300 px, "Branch and edit" putting the text in the box. Until then a message is sent
through `window.__aiwbSend(chat, text)`, which a build for the checks (`EXPO_PUBLIC_AIWB_VERSION=uicheck`) has: it is the chat view's `sendMessage` part, so K3's
own replaces what it does. One difference to expect: with no composer open the move's draft is written to the server at the answer, which makes the mock tell the
chat's status early, so the "Loading…" line of a branch whose events come late is asserted only with the composer (`A4.2`, `COMPOSER`).
The banner is drawn by S8 in `parts.Banner`, above the composer; K3 draws nothing for it. `startMove(chat, target, edit)` reads the composer's bridge (`registerComposer`).

## For K5 and S6
K5: skip the elements with a `fk-` testID when reading a message's text (the extras are inside the message). S6: nothing.

## Parity rows made true
B-FK-01 to 07, 09 to 11 (the banner and Back), 12 to 16 (the thread's lines are S4's, the holds are here), 17, 20 to 26, 29; B-TR-01 to 25 (26 differs: the menu is
anchored to its row); B-LB-01 to 07. The composer's halves of B-FK-08, 12, 13, 18, 19 are K3's. Rows that had `none` and now have a check: B-TR-02, 03, 11, 15, 16, 17
(the Esc steps), 18, 19, B-FK-22 to 25, B-LB-01 (keys, removal), 03, 06, 07 — in `L15-fork.mjs`.
