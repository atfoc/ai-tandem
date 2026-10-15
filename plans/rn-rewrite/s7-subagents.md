# Package S7: subagents (rows, drawer, the Subagents chip), as built

Code: `app/src/screens/subagents/` (registered by `screens/register.ts`: `setChatPart("SubagentRow" | "SubResultRow")`, `setComposerPart("SubagentsChip")`,
`setSlot("SubagentDrawer")`). Checks: `web/dev/checks-app/{S1.1-subagents,L19-subagents}.mjs`, and the flags turned on in `A5.2`, `A5.3`, `A5.4`, `IM3.5`
(`DRAWER`), `A2.5` (the subagent's meter), `P0.3` (`A5.sub`). All logic is core's (`logic/subagents.ts`, `logic/subsettings.ts`, `logic/prefix.ts`,
`state/store.ts` `setDrawer`, `state/conn.ts` `loadSubItems`); these files only draw it.

## What it draws
- **Row** (`Row.tsx`): `sub-row` (a `Pressable`, role button, `aria-pressed`; dataSet `status`, `waiting`, `on`, `sub` — the sid, "" for a call not linked yet) =
  `sub-mark` (dataSet `status`, `waiting`; `sub-dot` pulses while it runs, a ring that stands still while it waits) + `sub-name` (`sub-agent` glyph and short
  name, `sub-desc`, `sub-type`, `sub-bg` "background") + `sub-line` (dataSet `tone` live | muted | error) + `sub-stats` (`sub-model`, `sub-tools`, `sub-time`, S9's
  `SubMeter`: `ctx-meter`). Below 400 points wide the stats go under the line. Nested rows are in `sub-tree` > `sub-children` (8 levels at most). `sub-result`
  (dataSet `tone`, `on`, `sub`) is the result row; a press on it opens that subagent.
- **Drawer** (`Drawer.tsx`): `sub-drawer` (dataSet `status`, `waiting`, `readonly`, `sub`, `layout`) with `sub-drawer-head` (`sub-crumbs`/`sub-crumb` [sub],
  `sub-drawer-top`: mark, name, `sub-nav` with `sub-prev`, `sub-pos` "n/N", `sub-next`, and `sub-close`; `sub-line`; `sub-stats`) and `sub-drawer-body`, which
  is an S4 `StickyList` of rows: `sub-prompt` (`sub-prompt-text` [clamped], `sub-prompt-more`), `sub-loading` / `sub-off` / `sub-starting`, the thread's
  items through S4's `ItemView` with `sub` set (so the tool cards, permission cards and nested rows are the chat's own parts), `sub-report`. The list's scroller is
  the same `thread-scroll` of the chat (it follows only while the subagent runs: `follow={running}`; one that ended opens at its top; the list is drawn
  anew for another subagent: B-SM-10).
- **Place**: the wide layouts draw it absolutely over the right of the window (`min(700, 58 %)` points, z 45) — `Layout.tsx` already mounts the slot; the phone
  draws it to fill `drawer-screen` of the stack (the screen's bar has the back; the header keeps its own × too). It shows for the chat on screen only (a board
  chat's only while its panel does, on the phone while the chat is the screen).
- **Close**: ×, the phone's back (the store's `subDrawer` is cleared), and on web Esc **through the overlay stack** (`useOverlayClose(live && !picking, closeSub)`),
  so the layers that open over it — the large view of an image (B-IM-09), menus, the Subagents list, the confirm dialog, the tree popup — are above it on the stack and
  take their Esc first, and the composer's Esc does not also stop the chat (the handler is in the capture phase). The wait for a point on the board (`s.picking`) has its
  own Esc: the drawer stays off the stack meanwhile.
- **Chip** (`Chip.tsx`): `tchip` kind `subagents` (fixed: a static chip with the reason as title) and its list, an `Overlay` (popover over the chip, a sheet on the phone;
  `sub-pop` > `sub-menu` > `sub-depth` / `sub-cap` rows `sub-opt` [section, value, on], `role` menuitemradio, `aria-checked`; `sub-pop-cap` [off] greys the cap with
  depth Off). A pick is sent at once and the list stays open; the focus is on the current depth as it opens and returns to the chip as it closes.

## Decisions and findings
- **Mark pulse** is a CSS animation on web (`animationKeyframes`; no DOM change per frame, so a check that waits for the document to be still does) and an `Animated`
  loop on the native driver elsewhere.
- **`DRAWER` flags** are on in A5.2, A5.3, A5.4 (the root is `sub-drawer-body`; `acts.drawer` in `sel.mjs` presses the first `sub-row` and waits for the drawer to come
  to rest: on the phone it slides in) and IM3.5 (`sub-drawer`). IM3.5's block is not run at the phone: the drawer is a screen there and the chat's thumbnails are not on
  screen (B-IM-09 is a row for a hardware keyboard).
- **A5.4's drawer window** is 300 points, the phone layout (the label says 564: the old window's width); the stats and the header wrap there (`SubStats wrap`).
- **P0.6's fixture** `app/test/fixtures/composer-widths.json` is written again with the real chip (the open chip has a caret; the fixed one a 2 point margin after "Subagents",
  the page's `.tchip-pre`).
- **S1.1 on the new build**: a window under 700 points is the phone layout, so the old narrow page of 400 px is a phone-layout chat at every viewport (the list is a sheet over
  the "more" popup's sheet). The popover-over-"more" form is read on the desktop in the panel beside a board (`board-new` at 400); the wide row is read on the desktop (900 px page)
  and the tablet (810 px window, the sidebar hidden). The phone's started chat has other settings than the default ones (the default fixed chip is left out of a row without room).
- **Esc layers not on the overlay stack**: the @ list of the composer (`mention-pop`) and K5's quote float take Esc inside the box, below the drawer's capture handler. With
  the drawer open and the @ list open, Esc closes the drawer, not the list (B-SA-16 says the list first). Not checked by any test; to fix it the list or the float would
  have to push the overlay stack.

## Not covered by a check
B-SA-17 (read-only drawer of a subagent started in the copied part: core's `subInPrefix` is unit-tested, the drawer passes `readOnly` to `ItemView`), B-SA-19 (a branch's
subagents; only the paid `app.e2e` step 22 has it), B-SA-15's "closes when the chat shows another branch" (core's `drawerStays` is unit-tested; L19 checks the other chat).
Nothing ran in a simulator or on a device (the V-track): to look at there, the drawer's slide on the phone stack, the pulse, the sheet of the list over the "more" sheet.
