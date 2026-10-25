# UX improvements: the work plan

The plan for building `ux-improvements-goal.md` (the goal, "the goal" below; section numbers like 3.4 are its sections). The goal
says *what*; this file says *who builds what, where, against which contracts, in which order, and how it is checked*. Where this
file and the goal disagree, the goal wins; where the goal and the board **v3** (`b_edb3unwu`) disagree, the goal says which wins.

Every agent on this work reads, in the integration worktree
`/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/ux-improvements` (branch `ux-improvements`): the goal, this file,
`AGENTS.md` (test rules: obey them), and for its area `docs/architecture.md`, `voice-chats-goal.md`, `voice-devices-goal.md`.
`plans/ux-improvements/board-v3.txt` is a text dump of the board (one line per element: key, label, position); it is not tracked.

Contents: 1 Current state map · 2 Foundation packages and their contracts · 3 Area packages · 4 Execution rules · 5 Model
policy and sizes · 6 Decisions and open questions · 7 Merge order and the final checks.

---

## 1. Current state map

### 1.1 How the app is put together today (phone-relevant)

- **Layout selection.** `app/src/ui/breakpoints.ts` `layoutOf(width)`: phone `< 700`, tablet `< 1100`, desktop from 1100.
  `app/src/ui/useLayout.ts` `useLayout()` reads `useWindowDimensions().width`. The stub of this plan adds `usePhone()` there.
  `screens/shell/Shell.tsx` draws `PhoneStack` on the phone and `WideLayout` (`Layout.tsx`) otherwise. About 20 files branch on
  the layout (`grep -rln 'useLayout()\|"phone"' app/src`): `ui/Overlay.tsx`, `sidebar/Sidebar.tsx`, `sidebar/editguard.ts`,
  `chat/Header.tsx`, `fork/Chrome.tsx`, `subagents/Drawer.tsx`, `board/phone.ts`, `quotes/path.ts`, `images/ImageLarge.tsx`,
  `library/LibraryDialog.tsx`, `voice/pill/Pill.tsx`, `servers/AddByCode.tsx`, `shell/nav.ts`, `shell/widths.ts`.
- **Navigation.** The phone is a React Navigation **native stack** (`@react-navigation/native-stack`, `react-native-screens`)
  in `screens/shell/PhoneStack.tsx`, whose routes are *derived from the store* (`screens/shell/stack.ts` `stackOf`: `side`
  (the sidebar), `board`, `chat`, `drawer`). A back (`BackButton.tsx` `goBack`, a swipe, Android's back) writes the store
  (`nav.ts` `select`), never the stack; `onStateChange` writes a back the navigator made by itself. The board route has
  `gestureEnabled: !picking`. Opening things: `nav.ts` `select`, `openBoard` (alone on the phone), `openChat`, `newChat`,
  `newBoard`, `addBoard`. Screens fill **slots** (`shell/slots.tsx`: `Sidebar`, `ChatView`, `Canvas`, `SubagentDrawer`,
  `BoardVoice`, `Overlays`) registered by `screens/<area>/index.ts` via `screens/register.ts`.
- **State.** `@aiwb/core` store (`packages/core/src/state/store.ts`, `State`): `sel`, `servers: ServerView[]` (state from
  `logic/servers.ts` `ServerState`, labels `stateLabel`), `sections`, `boards`, `chats`, `showArchived`, `themePref`,
  `serversDialog`, `libraryDialog`, `insertPopup`, `picking`, `roles`, `writers`, `confirm`, … Row words come from
  `logic/labels.ts` (`rowLine`, `dotState`), section words from `logic/sections.ts` (`sectionView`).
- **Theme.** `ui/tokens.ts` (light, dark, four Catppuccin flavours via `@aiwb/core/logic/flavours.ts`), `ui/theme.tsx`
  (`useTheme`, `useTokens`), `ui/Text.tsx` (13 px base, `tone`, `size`), `ui/fonts.ts`.

### 1.2 The shared parts (`app/src/ui`) and what the goal needs of them

| Part | Today | Gap for the goal (4.3) |
|---|---|---|
| `Sheet.tsx` | bottom sheet, grabber swipe, backdrop, Android back, keyboard avoid, footer slot (`sheetfooter.tsx`), max 85 % | head (title, sub, leading, actions), detents `fit`/`large`, P1–P4 shapes |
| `Overlay.tsx` | `kind` popover/dialog → Sheet on phone | kind `screen` (pushed on phone, Dialog on wide) — **stubbed** |
| `Menu.tsx` | rows 44 pt in a sheet, `MenuHead`, `MenuSep`, danger tone | 50 pt rows with icon and second line, quick row, danger group last |
| `Dialog.tsx` | centred dialog, `DialogActions` (footer in a sheet) | stacked and form footers (P3/P4 on phone) |
| `Button.tsx` | `size` md/sm (13/12 px text) | 44 pt touch size, 17 pt text, full-width 50 pt (P4) |
| `IconButton.tsx` | 26/20 px with hitSlop 4/6 | 44 pt target |
| `Switch.tsx` | 26×15 look only | 44 pt target on phone (Settings › Voice switch) |
| `SecretInput.tsx` | hidden secret field (iOS masked) | eye toggle 44 pt, monospaced (Add key, add server) |
| `Popover.tsx`, `Resizer.tsx` | wide layouts | unchanged |
| `modal*.tsx`, `overlayhost.tsx`, `overlaystack.ts`, `useOverlayClose*` | every overlay a Modal; nested overlays portal into the top one; Esc/back close the top | used as is by the new sheets; pushed screens are **not** Modals |
| `useKeyboardAvoid*` | sheets ride the keyboard | P3 large detent rides the keyboard; composer 6 pt gap |
| `tid.ts` | testIDs of primitives | **stub** adds the new parts' ids |
| `icons.tsx` | 30 icons | new icons per area (each area adds its own, appended) |
| — | no toast, no swipe row, no haptics, no back with label, no bars, no cells, no state-word list, no search field | all new — **stubbed** (2.x) |

### 1.3 Where each area of the goal lives today

| Goal | Today's code | Notes |
|---|---|---|
| 3.2 Home, stack | `screens/sidebar/*` (the phone's first screen is the whole sidebar: sections per server, indented groups, `Foot.tsx` with Show archived, Servers, Library, Settings, theme), `shell/Home.tsx` (the wide Home), `shell/PhoneStack.tsx`, `stack.ts`, `BackButton.tsx` | Home is a new phone screen; the sidebar stays for the wide layouts |
| 3.3 rows, rename, new, archive, search | `sidebar/rows.tsx`, `menus.tsx` (row "…" and "+" menus), `actions.ts` (rename, archive, delete, new group), `parts.tsx` (`InlineName`), `drag.tsx`/`dragsession.ts` (finger hold-and-drag) | no search exists; archived shown with a switch |
| 3.4 board | `shell/BoardBar.tsx` (crumb, Chats N, "+ Chat on this board"), `board/*` (`BoardCanvas.tsx`, `RoleBar.tsx` "Edit here", `Overlays.tsx` busy pill/flashes/pick layer, `PickSurface.*`, `refs.ts` point/selection, `phone.ts`), `packages/board-view/src/Board.tsx` (Excalidraw with `UI_OPTIONS`), `packages/board-bridge` (messages, `chrome.ts`), `voice/pill/*` (the floating pill) | board chat today: pushed over the board; no Chats sheet |
| 3.5 chat | `chat/*` (`Header.tsx`, `Thread.tsx`, `ItemView.tsx`, `StickyList.tsx`, `Remote.tsx`, `Empty.tsx`), `markdown/*` (`Table.tsx`, `CodeBlock.tsx`), `tools/*` (`ToolCard.tsx`, `PermCard.tsx`), `subagents/*` (`Drawer.tsx` = phone `drawer` route, `Row.tsx`), `fork/*` (`Message.tsx` actions, `TreePopup.tsx`, `Chrome.tsx` branch marks, `LabelInput.tsx`), `usage/*` (`Popup.tsx`, `CtxRing.tsx`), `images/*` (`ImageLarge.tsx`), `quotes/*` (`QuoteSheet.tsx` = quote from a message, `CommentSheet.tsx`, `QuoteFloat.*`) | no Chat info screen, no permission dock, no full diff screen, no table viewer |
| 3.6 composer | `composer/*` (`Composer.tsx`, `Toolbar.tsx`, `ChatChoices.tsx` chips, `Picker.tsx` model/effort, `Folder.tsx`, `Mention.tsx` @ list, `Notices.tsx` context row + archived/old-board bars, `Send.tsx`, `dictation.ts`, `recent.ts` recent folders), `composerimages/*`, `subagents/Chip.tsx`, `library/InsertPopup.tsx` | `test/wiring.test.ts` reads Composer/Toolbar/ChatChoices source: update it with them |
| 3.7 blocked, voice | `composer/Notices.tsx` (bars), `chat/Remote.tsx` (offline line), `voice/*` (`ComposerVoice.tsx`, `SpeechBar.tsx` with Auto-send, `ProblemPopover.tsx` voice problems, `VoiceNotice.tsx`, `pill/*` incl. `Switch.tsx` Auto-send) | |
| 3.8 settings etc. | no Settings screen. `servers/*` (`ServersDialog.tsx`, `ServerForm.tsx`, `ServerRow.tsx`, `AddByCode.tsx`, `addcode.ts`), `voice/SettingsDialog.tsx`, `SettingsParts.tsx`, `DevicesSection.tsx`, `VoiceChoice.tsx`, theme picker in `sidebar/Foot.tsx`, `library/*` (`LibraryDialog.tsx`, `Tree.tsx`, `Editor.tsx`, `LibraryPopups.tsx`) | each is a dialog/sheet today |

### 1.4 Data the screens need that the server does not give (goal 4.6)

| Wanted | Today | What the screen does (decision D5) |
|---|---|---|
| a chat's last activity / board's edited time on rows | `ChatView.created`, `Board.created` only | no time on rows |
| archive date | `Archive` has no date | Archived's sub-line shows the place only |
| agents a server did not find | `usable` (found) + `logic/agentlist.ts` `missing` for the current one | only the found ones, plus the current missing one dimmed |
| model note, context size | `CatalogModel.note`, `contextWindow` exist | shown when the catalog has them |
| minimum server version for Too old | conn has a feature level (`MIN_FEATURE_LEVEL`), no version | Too old shows the server's version and how to update, no minimum |
| "Unreachable since 9:12", "offline since 14:02" | no timestamp in `ServerView` | **client-side**: the app records when a server's state last changed (F3); not server data |

### 1.5 Browser checks that cover the phone today (all must be updated, not deleted — goal 4.10)

Every check runs at the phone viewport except: `A1.2`–`A1.5`, `A3.2`, `A3.3`, `L4-chips`, `P7.2-menu`, `P7.3-sidefit`,
`P7.4-keys`, `P7.4-quote`, `VC.5-hoverbar` (desktop/tablet only: they stay as they are). So ~80 checks touch the phone.
Their navigation goes through `web/dev/checks/sel.mjs` (`showList`, `back`, `openChat`, `openBoard`, `openMenu`; `IDS.tree`
`side-tree`, `IDS.row` `side-row`, `IDS.back` `nav-back`), which assumes the phone's first screen is the whole sidebar.
**When Home replaces it, `sel.mjs`'s phone path changes once (package H1) and every phone check navigates through it.**

The checks per area (owner in §3): sidebar/Home `SEC.1`–`SEC.10`, `L11-sidebar`, `L14-dragtouch`, `AAC.1-first`, `AAC.3-remotedown`,
`L2-layouts`; theme `A6.1-picker`, `A6.2-reload`, `P7.1-flavours`, `A6.4-floors`; board `L5-board-roles`, `HB.1-reader`, `AAC.2-board`,
`AAC.2-localdown`, `SEC.7-board`, `SEC.7-drop`, `P7.5-canvas`, `A6.3-board`, `L24-boardui`, `P7.4-board`, `VC.6-pill`, `VC.7-fit`; chat
`L10-chatview`, `L9-markdown`, `A6.3-markdown`, `L17-quote`, `L15-fork`, `L22-branches`, `L23-gone`, `L12-usage`, `A2.4-usage`,
`IM3.5-message`, `R3.12-images`, `L8-stream`; tools `A5.2`–`A5.4`, `L13-cards`, `L19-subagents`, `L6-agenttools`; composer `L16-composer`,
`A2.2`–`A2.6`, `P0.1`, `P0.5`, `P0.6`, `IM3.2`, `L18-imagelimits`, `L4b-chipdoc`, `S1.1-subagents`, `L21-focus`, `P0.4-routes`; voice
`VC.1`–`VC.4`, `VC.5-readaloud`, `VC.8`; servers `L7-servers`, `L3-addserver`; library `PL4.1`, `PL5.1`, `PL5.2`, `PL6.1`, `L20-library`;
primitives `L0-harness`, `L1-primitives`, `P0.7-shots` (gallery); all states `P0.3-smoke` (its `DRAWN` table: each package edits its own rows).

Device flows (`app/e2e/maestro`): the helpers `_open-sidebar.yaml`, `_to-sidebar.yaml`, `_open-chat.yaml`, `_open.yaml` walk the
sidebar and must follow Home (H1); `sheets.yaml` (F1), `board-webview.yaml` (B1), `composer-chips.yaml` (C2),
`storage-picker-permission.yaml` (C1), `_v4-scan.yaml`/`_v4-localnet*.yaml` (S2), `voice-mic.yaml`/`voice-devices.yaml` (V1/S3).

### 1.6 Known before this work

- `packages/conn` test "the real runner: stdout, stderr, the exit code, a program that is not there, a time-out" fails (15 s
  time-out) on clean `main` at `4eada30` as well as here: not caused by this work. Report it as known, do not chase it.
- A new worktree has no `node_modules`; without them TypeScript resolves `@aiwb/*` to the **main checkout's** packages and
  `npm run check` reports nonsense. First thing in every worktree: `npm ci --prefer-offline --no-audit --no-fund` at its root.

---

## 2. Foundation packages and their contracts

The contracts below are committed as **stubs** on `ux-improvements` (commit of this plan): the files exist, type-check and
render something plain, so area packages can import them now. A foundation package makes them real without changing a
fixed signature; adding optional props is allowed, renaming is not. Every stub's header says `Contract of package Fx` and
`STUB:` with what is left. Files:

```
packages/core/src/logic/statewords.ts   (F3; real, tested: packages/core/test/statewords.test.ts)
app/src/ui/metrics.ts                   (F1; PHONE sizes, TYPE ramp)
app/src/ui/useLayout.ts                 usePhone()            (F2 may change what "phone" means: D4)
app/src/ui/tid.ts                       new TIDs              (F1/F2)
app/src/ui/SheetHead.tsx                (F1)
app/src/ui/ActionSheet.tsx              P1 (F1)
app/src/ui/PickerSheet.tsx              P2 (F1)
app/src/ui/FormSheet.tsx                P3 (F1)
app/src/ui/ConfirmSheet.tsx             P4 (F1)
app/src/ui/Cells.tsx                    P5 body: CellGroup, Cell (F1)
app/src/ui/Bars.tsx                     PlaceBar, ContentBar, LargeTitle (F1 look, F2 wiring)
app/src/ui/BackControl.tsx              the one back control (F2)
app/src/ui/Toast.tsx                    showToast, hideToast, ToastHost (F1)
app/src/ui/SwipeRow.tsx                 (F1)
app/src/ui/SearchField.tsx              (F1)
app/src/ui/StateWord.tsx                (F3)
app/src/ui/pushedscreen.tsx             Overlay kind "screen" on the phone; setScreenPresenter (F2)
app/src/ui/Overlay.tsx                  kind "screen" added  (F2)
app/src/platform/haptics.ts             haptic(kind)          (F1)
app/src/screens/shell/screens.ts        registerScreen, pushScreen, popScreen, StackEntry, HomePlace (F2)
```

### F1 — The phone kit (sheets, sizes, toast, swipe, haptics)

**Goal sections:** 3.1.1, 3.1.3 (toast, Undo), 3.1.4 (P1–P5), 4.3, 4.7. **Mockups:** "00 Five phone patterns" (`dl-00*`, rect
x −7530…−5990, y 3380…4090), "01 Menus" (`dl-01a-phone`, `dl-01b-phone`, x −5952…−5066), "02 Confirm" (`dl-02a-phone`,
x −4906…−4513); rules text `dl-00-rules` (detents: fit ≤ 50 % for P1, P4, short P2; large for search pickers and P3).

**Owns:** `app/src/ui/*` (all), `app/src/platform/haptics*.ts`, `app/src/dev/Gallery.tsx` + `dev/SheetsSelfTest.tsx` (gallery
cases of the new parts), `web/dev/checks/L1-primitives.mjs`, `P0.7-shots.mjs` (gallery), new `UX.F1-kit.mjs`,
`app/e2e/maestro/sheets.yaml`. After F1 merges, `app/src/ui` is a shared hot spot: see 4.5.

**Contract (fixed; stubs hold the signatures):**

- `metrics.ts`: `PHONE` {target 44, sheetRow 50, cell 48, listRow 60, chip 36, margin 16, keyboardGap 6}; `TYPE` {control 17,
  body 16, bodyLine 1.5, secondary 13, busy 15, h2 20, h3 17, confirmTitle 20, largeTitle 34}. Phone screens take sizes from
  here; no literal 44/17 in screens.
- `Sheet.tsx` grows (optional props, wide unchanged): `detent?: "fit" | "large"` (fit: content height up to 50 % for P1/P4/short
  P2, scrolls past; large: to the top safe area less 8 pt, for P3 and search pickers), `head?: ReactNode` (drawn above the scroll
  view, sticky). A sheet over a sheet is allowed only for P2 or P4 over P3 (dev-mode `console.warn` otherwise).
- `SheetHead` {title, sub?, leading?, left?: HeadAction, right?: HeadAction}; `HeadAction` {label, onPress, disabled?, strong?,
  testID?}. Centred without `leading`, start-aligned with it. testIDs `sheet-head`, `sheet-title`, `sheet-sub`, `sheet-left`, `sheet-right`.
- `ActionSheet` (P1) {open, onClose, head {title, sub?, icon?}, quick?: ActionItem[], items: ActionItem[], destructive?, testID?};
  `ActionItem` {id, label, icon?, note?, waitReason?, onPress}. 50 pt rows, icon + 17 pt label + 13 pt note; `waitReason` row
  faded and disabled; destructive last after a separator, red. No Cancel row. Rows `action-row` with dataSet `action`.
- `PickerSheet<T>` (P2) {open, onClose, title, sub?, options: PickerOption<T>[], value, onPick, extra?, cancel?, search?,
  searchPlaceholder?, testID?}; `PickerOption` {value, label, note?, icon?, disabledReason?, section?}. Chosen row tinted with an
  accent ✓, no focus ring; tap picks and closes unless `extra` (then **Done** in the head); search pinned, on by default past 8
  options, large detent then. Rows `picker-row` dataSet `value`; `aria-checked` on the chosen.
- `FormSheet` (P3) {open, onClose, title, sub?, saveLabel?, canSave, dirty, onSave(): void|Promise, error?, children, testID?}.
  Head "Cancel · Title · Save"; large detent; rides the keyboard (Save is in the head, so always above it); closing a dirty form
  (Cancel, swipe, backdrop, back) opens a P4 "Discard changes" first; busy and error inside.
- `ConfirmSheet` (P4) {open, onClose, title, body, confirmLabel, tone?: "danger"|"accent", cancelLabel?, onConfirm(): void|Promise,
  testID?}. Red tile, 20 pt title, body, full-width 50 pt button repeating verb + noun, grey Cancel; busy/error inside; never
  the centred alert. `screens/shell/confirm.ts` `confirm()` and `ConfirmDialog.tsx` draw a ConfirmSheet on the phone (the
  ConfirmRequest gains optional `confirmLabel`; callers that set none get today's label) — wide unchanged.
- `Cells.tsx`: `CellGroup` {title?, footer?, children}; `Cell` {label, sub?, subTone?, value?, leading?, trailing?, onPress?,
  chevron?, tone?, disabled?, testID?, data?}. 48 pt, grouped cards, chevron when it pushes.
- `Bars.tsx` look: `PlaceBar` {back?, title, right?} (title centred, back with label at left), `ContentBar` {back?, title, sub?,
  subTone?, onTitlePress?, actions?} (two-line title, 17/13 pt, never cut to one line: two lines then a fade; ≤ 2 actions of 44 pt),
  `LargeTitle` {title, sub?}. F2 wires the back.
- `Button`: `size?: "md" | "sm" | "touch" | "block"` — `touch` 44 pt min height and 17 pt text; `block` full width, 50 pt (P4 and
  primary actions). `IconButton`: `size?: … | "touch"` (44 pt target, the glyph as drawn). `Switch`: `SwitchLook` gets a `touch`
  variant (51×31) and the holder a 44 pt target. **Opt-in** (D2): a phone screen asks for `touch`; nothing changes size by itself.
- `Menu`/`MenuItem` in a sheet: rows 50 pt, 17 pt label, 13 pt `note`, `icon` slot 24 pt; `MenuSep` before a danger group.
  (Used by ActionSheet/PickerSheet; existing sheet menus get them, which is the phone's look the goal wants.)
- `Toast`: `showToast({text, action?: {label, run}, ms?=5000, kind?}) → hide()`, `hideToast()`, `<ToastHost/>` mounted once in
  `Shell.tsx` above the composer/home indicator; one at a time; `toast`/`toast-action`, dataSet `kind`; announced to screen readers.
- `SwipeRow` {children, right?: SwipeAction[], left?: SwipeAction[], testID?, data?}; `SwipeAction` {id, label, tone: grey|danger|
  accent, onPress, full?}. Buttons 88 pt wide, full row height; full swipe runs the `full` one; RNGH `Gesture.Pan` +
  `Animated` (no reanimated); never starts within 20 pt of the left edge (the platform's back swipe); one row open at a time
  (opening one closes the other); a tap elsewhere closes. On the web build a finger swipe works (checks drive it with
  `touchDrag(…, {hold: 0})`); a mouse has none.
- Long press: `LONG_PRESS_MS = 500` exported from `metrics.ts`; `haptic("select")` on a row's long press. A drag that starts
  10 pt after the press is the area's (H2 uses `sidebar/drag.tsx`).
- `haptics.native.ts` with **expo-haptics** (new native dependency, D7), `haptics.web.ts` no-op; signature `haptic(kind)`.
- `SearchField` {value, onChangeText, placeholder, onFocus?, onCancel?, autoFocus?, testID?}: 44 pt, 17 pt, clear button, Cancel.
- `SecretInput` gains `reveal?: boolean` (the eye's state; the eye control is the caller's 44 pt IconButton) and `mono?: boolean`.
- `DialogActions` gains `layout?: "row" | "stacked"` (stacked: full-width buttons, primary first) for phone forms that stay dialogs.

**Behaviour on tablet/desktop:** nothing visible changes. Every new part is either phone-only by contract (ActionSheet,
PickerSheet, FormSheet, ConfirmSheet, SwipeRow, Bars, Cells, SearchField) or opt-in (Button/IconButton sizes). ToastHost is
mounted on all layouts but only phone code calls `showToast` in this work.

**Mock/state:** none (gallery). **Checks:** new `UX.F1-kit` (phone + desktop: each pattern on the gallery, its sizes ≥ 44 pt, text
≥ 13 pt, head present, destructive last, detents' heights, FormSheet's guard, Toast's timing with Undo, SwipeRow by finger);
update `L1-primitives`, `P0.7-shots` (new gallery cases; the old ones unchanged at tablet/desktop), `L21-focus` if the sheets' focus
order changes. **Device:** `sheets.yaml` gains the detents and a P3 riding the keyboard, and a swipe row + long press haptic case
on the self-test (one run on the lead's own iOS simulator; Android with the emulator lock) — this is the one native build of F1
(expo-haptics). **Tests:** root `npm test && npm run check`, `cd web && npm test`, `cd desktop && npm test`,
`cd web && VIEWPORT=phone npm run uicheck -- UX.F1 L1 P0.7` then the same ids without `VIEWPORT` (all three).
**Acceptance:** contracts above real; stubs' `STUB:` lines gone; gallery shows each pattern in light, dark and one flavour;
tablet/desktop runs of `L1`, `P0.7`, `L21` unchanged.

### F2 — The phone's stack, back and pushed screens

**Goal sections:** 3.1.2, 3.2 (stack, Home place), 4.8, 4.3 (pushed-screen kind, one back). **Mockups:** "02 The stack and the back"
(`sh-02b`, `sh-02c`, x −5480…−4590, y −3810…−2400), back labels on every P5 mockup.

**Owns:** `screens/shell/PhoneStack.tsx`, `stack.ts`, `BackButton.tsx` (becomes `NavBack` over `ui/BackControl.tsx`),
`screens.ts`, `nav.ts` (selection helpers — shared hot spot after F2, see 4.5), `slots.tsx`, `ui/BackControl.tsx`,
`ui/pushedscreen.tsx`, `ui/Overlay.tsx` (kind screen), `ui/useLayout.ts`/`breakpoints.ts` (D4), new
`screens/shell/phone/{HomeRoute,BoardRoute,ChatRoute,PushedRoute}.tsx` (the route components split out of PhoneStack so that
H1, B1 and T1 own their screen's body without touching PhoneStack), new `UX.F2-stack.mjs`, new device flow `ux-stack.yaml`.

**Contract:**

- Routes become descriptors: `stackOf(state, place: HomePlace, pushed)` → `StackEntry[]` {key, name, title, kind}. Order:
  `home` · one `group` entry per group of `place.groups` (browsing) **or**, while a board or a chat is open, one per group of
  *its* place (`groupPath` of core `logic/tree.ts`), so the stack is the same whichever way the person came (3.1.2) · `board` ·
  `chat` · `drawer` (a subagent) · then the pushed screens in push order. A chat on a board always has its board under it.
  The navigator follows the derived list (push, pop, reset) exactly as today; backs it makes are written back.
- `HomePlace` {server: string | null, groups: string[]} lives in a small app store (`screens/shell/homeplace.ts`), saved in the kv as
  `aiwb.home`; API `useHomePlace()`, `setHomeServer(id)`, `pushGroup(key)`, `popToGroup(index)`. Opening content does not
  change `place` (Back from content lands on the content's place, then Home).
- `registerScreen(name, spec)`, `pushScreen(name, params) → key`, `popScreen(key?)` as in the stub. Names used by this plan:
  `settings`, `appearance`, `flavours`, `about`, `servers`, `server` {id}, `add-server` {how}, `archived`, `voice-settings`,
  `choose-voice`, `library`, `library-group` {server, group}, `prompt-editor` {…}, `diff` {chat, item}, `table` {…}, `subagent`
  (today's drawer route keeps its store field `subDrawer` but is drawn as a pushed content screen), `chat-info` is a **sheet**,
  not a screen (3.5).
- `Overlay kind="screen"`: on the phone the content is pushed (F2's presenter: a `PushedRoute` with a `PlaceBar` whose back
  names the screen under it and whose title is `title`; Back, edge swipe, Android back call `onClose`); on the wide layouts a
  `Dialog` (so `ServersDialog`, `LibraryDialog`, `voice/SettingsDialog` switch `kind="dialog"` → `kind="screen"` with no wide change).
- `NavBack` (shell) = `BackControl` with `label` = title of the entry under the top one on place screens, none on content
  screens; `onPress` = `goBack()`; `onHold` = the stack sheet (`stack-sheet`, a P2-shaped list of the entries under the top,
  a pick pops to it). `goBack()` order: pushed screen → drawer → chat (to its board or its place) → board → group → nothing.
- Edge swipe: on for every route but `board` (always off: D15) and off while picking (`picking`/Add selection). Android back =
  `goBack()` (and closes the top overlay first, as today).
- `useLayout()` on native phones uses the shorter side (D4); web unchanged.
- Keeps every testID the checks use today (`nav-back`, `board-stage`, `chat-page`, `drawer-screen`, `side-pane` on the wide layouts).

**Behaviour on tablet/desktop:** unchanged; `kind="screen"` is a Dialog there; HomePlace and pushed screens are phone-only.
**Checks:** new `UX.F2-stack` (phone: the stack from a row, from a "search result" stand-in (`select` call through a seam), from a
board's chat; back labels; hold sheet pops several levels; a pushed screen over a chat returns to it; Android-back stand-in via
`page.goBack` is not available → the check calls the same `goBack` the hardware back calls through the dev seam); update
`L2-layouts`, `L0-harness` (if the stand-in contract changes), `HB.1`/`L5` only where the route names changed. **Device:**
`ux-stack.yaml` on iOS (edge swipe back on chat and group, none on the board, hold sheet) and Android (system back) — needs the
emulator lock. **Tests:** root, web, desktop units; `VIEWPORT=phone npm run uicheck -- UX.F2 L2 L0 L5 HB.1`, then those at all three.
**Acceptance:** stack derivation unit-tested in `app/test/shell.test.ts` (paths from row, search, board Chats, notification =
select with no history); pushed screens drawn; checks above pass at the three viewports.

### F3 — One list of state words

**Goal sections:** 3.1.3 (state words), 4.7, 6.2 (one list), 3.2/3.7.1 ("since 9:12", "offline since 14:02").
**Owns:** `packages/core/src/logic/statewords.ts` (+ test, already real), `app/src/ui/StateWord.tsx`, a `since` record in the core
store (`State.serverSince: Record<string, number>` set when an entry's state changes, in `state/conn.ts`), the iOS
`localNetworkDenied` feed (`platform/localnetwork` read once at start and on return to foreground → a store field), a
`formatSince(ts, now)` helper ("since 9:12", "since yesterday"). **Contract:** as in the stub: `serverWord(view, ctx) →
{key, text, tone, reason?}`, `chatWord(chat) → word | null`, `needsYou(chat)`, `needsAttention(view)`, `waitingOn(n)`,
`SERVER_WORDS`, `CHAT_WORDS`; `<StateWord word dot? size?/>` with testID `state-word` dataSet `word`, `tone`.
Every phone screen draws a state word only through these (R1 checks it). **Wide:** nothing changes (the sidebar keeps
`sectionView`). **Checks:** unit tests only (core); R1 holds screens to it. **Size:** S. Runs in parallel with F1/F2.

---

## 3. Area packages

Each package: worktree `.worktrees/ux-<id>`, branch `ux-<id>` (4.1). "Owns" lists the files only it changes; anything else is
a hot spot (4.5). Mockup rects are board coordinates for `get_image` (board `b_edb3unwu`, scope `rect`, scale ≤ 1; the notes and
the user's pink/green notes lie under each frame, so take ~1500 pt of height from the row's title). Rows: shell y −3810,
board y −2000, chat y −210, composer y 1590, dialogs y 3385.

New checks are named `UX.<ID>-<word>.mjs` (the runner selects `UX.H1` etc.). Every new check runs at **phone** (light and dark
where 6.1 asks) and, if it touches a shared part's wide shape, at tablet and desktop too. A package also adds to
`P0.3-smoke`'s `DRAWN` the seeded states it adds, and edits only its own rows there.

### Wave 2 (after F1, F2, F3 merge) — can run in parallel

#### H1 — Home, groups as screens, server chips, first run — L

- **Goal:** 3.2 (all but the server sheet, which S2 draws), 3.1.2 (Home's place), 6.1 Home rows.
- **Mockups:** "10a–10d Home v2" `sh2-10a…sh2-10d` (x −7530…−5620); "08 Empty Home and first run" `sh-08a`, `sh-08b`
  (x 2320…3240); stack titles `sh-02b`, `sh-02c`.
- **Owns:** new `app/src/screens/home/` (`Home.tsx`, `GroupScreen.tsx`, `HomeRow.tsx`, `ServerChips.tsx`, `ProblemCard.tsx`,
  `FirstRun.tsx`, `EmptyHome.tsx`, `index.ts`), `screens/shell/phone/HomeRoute.tsx`, `web/dev/checks/sel.mjs` (the phone path of
  `showList`, `openRow`, `openChat`, `openBoard`, `IDS`), `web/dev/checks/side.mjs` phone parts, `web/e2e/lib/ui.mjs` phone navigation (the free e2e scripts), device helper flows
  `_open-sidebar.yaml`, `_to-sidebar.yaml`, `_open-chat.yaml`, `_open.yaml`, mock knobs for "no server" and "one server".
- **Contract it offers:** `HomeRow` {item: {kind: group|board|chat, key}, onPress, swipe?: SwipeAction[] (H2), onLongPress? (H2)}
  — 60 pt, icon, name (never cut to one line), sub-line, dot (`needsYou`) or count (group: number of chats that need you, board:
  dot if a chat on it does); testID `home-row` dataSet {kind, key, server}. `useRowActions(item)` is imported from
  `screens/home/rowactions.ts`, a stub returning `{}` until H2. Home's "+ New" calls `openNewSheet(place)` from
  `screens/home/newsheet.ts` (stub until H2), the gear `pushScreen("settings")` (S1), the search field `openSearch()` (H2 stub),
  a chip's long press `openServerSheet(id)` (S2 stub), the problem card's Details `pushScreen("server", {id})` (S2).
- **Depends on:** F1, F2, F3. **Mock:** seeds (in `mock-ui.js`, section `UXH1`): one server only; four servers (connected, connecting,
  unreachable with the selected one, cert changed); a group with a chat needing approval and a stopped chat; a board with a busy
  chat; nested groups three deep; an empty group; an empty connected server; no server at all (knob that hides the local entry
  as a phone has none: `hasThisComputer` false on the web build for that seed).
- **Checks:** new `UX.H1-home` (every state above at phone, light and dark); **update** `sel.mjs` (phone: select the item's
  server chip, push its groups — the item's path read from the mock with `mockEval` — press the row; a board's chat: open the
  board, Chats, the row), `SEC.1`–`SEC.10` phone halves, `L11-sidebar` phone half, `AAC.1-first`, `AAC.3-remotedown` (problem card),
  `L2-layouts`, `SEC.4-make` phone half → "+ New" (H2 finishes it). Desktop/tablet halves unchanged.
- **Tests:** root, web, desktop units; `VIEWPORT=phone npm run uicheck -- UX.H1 SEC L11 AAC L2` while working; before handing
  back, **the whole phone run** (`VIEWPORT=phone npm run uicheck`, lock held, ~20 min) because `sel.mjs` changed for every check,
  and the tablet/desktop runs of `SEC L11 AAC L2`. Device: `open.yaml` once on its own simulator (the helper flows changed).
- **Acceptance:** 3.2's bullets as drawn (one server at a time, no All, hierarchy, no Needs you, groups as screens with back naming
  the parent and the full place line, Home lists boards not their chats, trouble only on the selected server's Home, 60 pt rows
  with no "…"/"+", first run, empty Home); every phone check navigates through the new Home and passes.
- **Chunks (Sonnet):** (1) homeplace + Home skeleton + LargeTitle + chips; (2) HomeRow with dots/counts; (3) GroupScreen and the
  place line; (4) problem card + faded list; (5) first run + empty + connecting placeholders; (6) mock seeds + UX.H1; (7) `sel.mjs`
  phone path + the existing checks' phone halves (lead or Opus: it touches every check); (8) device helper flows.

#### S1 — Settings, Appearance, About — S

- **Goal:** 3.8.1. **Mockups:** "07 Settings" `dl-07a-phone` (x 5300…5720, y 3385…), "13 Server sheet and Settings v2"
  `sh2-13b`, `sh2-13c` (x 730…1630, y −3810…), "07b Catppuccin flavours" `dl-7bf-phone` (x 7830…8240).
- **Owns:** new `app/src/screens/settings/` (`Settings.tsx`, `Appearance.tsx`, `Flavours.tsx`, `About.tsx`, `index.ts`); registers
  `settings`, `appearance`, `flavours`, `about`. Rows push `servers` (S2), `library` (S4), `archived` (H2), `voice-settings` (S3):
  each target may still be a stub screen when S1 lands (the registry throws on an unknown name: S1 registers placeholders
  for the four, which their owners replace).
- **Depends on:** F1, F2, F3. **Mock:** none new (counts from the store).
- **Checks:** new `UX.S1-settings`; update `A6.1-picker`, `A6.2-reload`, `P7.1-flavours` phone halves (the theme is chosen in
  Settings › Appearance on the phone; the sidebar foot's picker stays on the wide layouts).
- **Tests:** units; `uicheck -- UX.S1 A6.1 A6.2 P7.1` at all three. **Acceptance:** 3.8.1 as drawn; a change applies at once;
  no inline control in Settings; "Server log" row only on desktop's narrow window (the web build in Electron).

#### S2 — Servers, server detail and sheet, add a server, certificate changed — L

- **Goal:** 3.8.2, 3.8.3, 3.8.4, 3.2 (the server's sheet), open question 8.
- **Mockups:** "03 Servers" `dl-03a…dl-03d` (x −4370…−2470), "04 Add a server" `dl-04a…dl-04e` (x −2330…50), "05 Certificate
  changed" `dl-05a…dl-05d` (x 190…2090), "13 Server sheet" `sh2-13a` (x 230…640, y −3810…).
- **Owns:** `screens/servers/*`; new `ServerFacts.tsx` (the one body of a server, D6), `ServerSheet.tsx` (chip long press,
  P1-shaped), `ServerDetail.tsx`, `AddFlow/*`, `CertChanged.tsx`; `openServerSheet(id)` (replaces H1's stub); registers `servers`,
  `server`, `add-server`; `platform/scan*.tsx` look only; `web/dev/checks/L7-servers.mjs`, `L3-addserver.mjs`; device flows
  `_v4-scan.yaml`, `_v4-localnet*.yaml`.
- **Depends on:** F1–F3; H1 (the chip that opens the sheet; S2 can build and check the sheet from a test seam before H1 lands).
- **Mock:** servers in every state (exist: `s_studio`, `s_empty`, `s_wait`, `s_away`, `s_old`, `s_cert`); a test result with a matching
  and a non-matching fingerprint (exists in `L3`'s routes; extend), "In clipboard" setup text.
- **Checks:** new `UX.S2-servers` (list, detail per state, remove P4, add flow match / no match, cert changed compare + P4, the
  "Studio added" toast); update `L7-servers`, `L3-addserver` phone halves; `AAC.1` add-from-first-run step (with H1).
- **Device:** `_v4-scan.yaml` (camera with × and "Paste text instead"), `_v4-localnet.yaml` (Local Network announced first) on iOS.
- **Acceptance:** 3.8.2–3.8.4 as drawn; the detail is the one place for a server (Home card, chip sheet, composer's Servers, Chat
  info's Server row all open it); Save off until the test passes; no accept button on a mismatch.

#### T1 — The chat: header, thread, messages, Markdown, quotes from a message — L

- **Goal:** 3.5 header, thread, messages (press and hold, P1, Quote sheet), Markdown (tables + viewer, links + link sheet, code head).
- **Mockups:** "01 Header and thread" `ch-01a`, `ch-01b` (x −7530…−6740), "03 Markdown" `ch-03a`, `ch-03b` (x −5120…−3760),
  "06 Message actions" `ch-06a`, `ch-06b` (x −220…680).
- **Owns:** `screens/chat/*` (except new files of T3), `screens/shell/phone/ChatRoute.tsx`, `markdown/*`, `fork/Message.tsx`
  (message actions), `quotes/QuoteSheet.tsx`, `CommentSheet.tsx`, `QuoteFloat.*`, `hold.ts`; registers `table`.
- **Contract it offers:** `ChatHeader` uses `ContentBar`; its title press calls `openChatInfo(chat)` (T3 stub in
  `screens/chat/chatinfo.ts`), the Tree button `openTree` (T3), **⋯** = Chat info. `ChatView` renders, in order, thread,
  `<AboveComposer chat/>` (a slot T2 fills with the permission dock), composer.
- **Depends on:** F1–F3. **Mock:** a chat with h2/h3, lists, inline code, a 6-column table, a link, a long code block (A6/L9 seeds
  mostly exist).
- **Checks:** new `UX.T1-thread`; update `L10-chatview`, `L9-markdown`, `A6.3-markdown`, `L17-quote`, `L15-fork` (the finger's
  "⋯" menu becomes the long-press sheet: `fork.mjs openActs` phone path), `L8-stream` (Latest pill), `L22-branches` message parts.
- **Device:** the table viewer in landscape (`ux-table.yaml`, iOS) only.
- **Acceptance:** 16 pt body / 1.5 / h2 20 / h3 17 / 24 pt list indent; no floating "…"; Latest pill; P1 message sheet with quick
  row and Branch and edit first on own messages; Quote sheet; table bleed + viewer with pinned header/column and Copy; link
  sheet; code head with Wrap and Copy.

#### T2 — Tool steps, full diff, permission card and dock, busy, subagents — M

- **Goal:** 3.5 tool steps, permission request, busy, subagents. **Mockups:** "04 Tool steps" `ch-04a`, `ch-04b` (x −3680…−2780),
  "05 Permission request" `ch-05p`, `ch-05a…c` (x −2120…−350), "08 Subagents" `ch-08a`, `ch-08b` (x 1860…2770).
- **Owns:** `screens/tools/*` (+ new `DiffScreen.tsx`, `PermDock.tsx`), `screens/subagents/Drawer.tsx`, `Row.tsx`, `Parts.tsx`,
  `hooks.ts` (not `Chip.tsx`: C2); registers `diff`, `subagent`; fills T1's `AboveComposer` slot.
- **Depends on:** F1–F3, T1 (ChatView slot; can start on tool cards before T1 merges). **Mock:** A5 seeds; a failed step with exit
  code; two waiting permission requests; a nested subagent; a finished subagent with steps.
- **Checks:** new `UX.T2-tools`; update `A5.2`–`A5.4`, `L13-cards`, `cards.mjs`, `L19-subagents`, `L6-agenttools` phone halves.
- **Acceptance:** 44 pt two-line steps, failure opens itself with exit code, command + Copy, last 6 lines; read-only steps fold;
  diff ≤ 10 rows with Show full diff → pushed screen (wrap, copy, jump, folded runs); permission card words + full command +
  48 pt Deny/Allow (accent), dock with "1 of 2" and Show, both answer together, answered card folds; header says "Needs your
  approval" (F3 word); busy line 15 pt with seconds; subagent card + pushed subagent screen with previous/next.

#### B1 — The board screen, its bar, bottom row, menu and Chats sheet — L

- **Goal:** 3.4 (all but Point at, Add selection, selection rule: B2; voice card: V1), 4.4, open question 1.
- **Mockups:** `bd-01a`, `bd-01b` (x −7530…−6620), `bd-02a`, `bd-03a`, `bd-03b`, `bd-04a`, `bd-04b` (x −6520…−3810),
  `bd-06a`, `bd2-e` (x −2600…−1640), `bd-08b` (x 1620…2030), `bd-09a`, `bd-09b` (x 3200…4570); y −2000…−700.
- **Owns:** `screens/shell/BoardBar.tsx`, `screens/shell/phone/BoardRoute.tsx`, `screens/board/*` except `refs.ts`,
  `PickSurface.*` (B2), new `board/ChatsSheet.tsx`, `packages/board-view/src/Board.tsx`, a new bridge message in
  `packages/board-bridge/src/messages.ts` + `validate.ts` (the phone's chrome options: trimmed menu items and the footer's right
  inset), `board/phone.ts`; device flow `board-webview.yaml` + new `ux-board.yaml`.
- **Contract it offers:** the bottom row has a 64 pt right inset with a slot `<BoardOrb board/>` (V1 fills; until then empty);
  the bar's Chats button calls `openChatsSheet(board)`; `ChatsSheet` lists the board's chats, marks the voice chat, has **+ New
  chat** first (`newChat({board})` then open full screen).
- **Depends on:** F1–F3. **Mock:** boards in reader/editing/another window/agent busy states (exist: L5, HB.1 seeds).
- **Checks:** new `UX.B1-board` (bar states, Chats sheet, board chat full screen and back to the board at its view, trimmed menu,
  dark); update `L5-board-roles`, `HB.1-reader`, `AAC.2-board`, `SEC.7-board`, `P7.5-canvas`, `A6.3-board`, `L24-boardui` phone halves.
  Board engine: `cd packages/board-engine && npm test && npm run check` and `node dev/harness.mjs` in `packages/board-view`
  (Board.tsx changed; the engine files are not touched, so no `faithful` unless they are).
- **Device:** `ux-board.yaml` (iOS, then Android with the lock): opens fitted with 16 pt margins, the docked orb's inset in
  Excalidraw's footer (open question 1: if the inset breaks, ship the fallback drawn in `bd-04b` and say so), landscape floating
  controls. **Acceptance:** 3.4's board bullets; nothing app-made drawn on the canvas (R1 checks); the busy pill in
  `board/Overlays.tsx` leaves the canvas for the bar's state line.

#### C1 — The composer: box, toolbar, "+" sheet, images, board context row, @ dock, quotes, keyboard — L

- **Goal:** 3.6 (all but the chips row and pickers: C2). **Mockups:** "01 The box" `co-01a`, `co-01s` (x −7530…−6420), "04 The +
  sheet" `co-04a…c` (x −3220…−1810), "05 A board chat's context" `co-05a…c` (x −1620…−210), "07 Notices, and the keyboard"
  `co-07a…c` (x 1580…2990); y 1590…3300.
- **Owns:** `screens/composer/Composer.tsx`, `Toolbar.tsx`, `Send.tsx`, `measure.tsx`, `keys.ts`, `focus.ts`, `widths.ts`,
  `Mention.tsx`, `Notices.tsx` (context row; V1 takes the bars out of it after C1 merges), `send.ts`, `parts.tsx`,
  `composerimages/*`, `quotes/QuoteCount.tsx` (+ new "Quoted in this message" sheet), `usage/CtxRing.tsx` look, `app/test/wiring.test.ts`
  composer parts, `app/test/composer*.test.ts`.
- **Contract it offers:** the toolbar's place takes `<ComposerBlock chat/>` when it answers non-null (V1 fills; C1 ships today's
  bars through it unchanged); the primary button is `Talk | Send | Stop` with `Talk` calling V1's `startSpeech(chat)` (today's);
  the "+" sheet's rows call `openInsertPopup` (S4), `pickPoint` / `addSelection` (B2), Take photo / Photo library / Files
  (`platform/imagepick*`).
- **Depends on:** F1–F3. **Mock:** image upload knobs exist (`flags.upload`); a model without images; quotes (REFS seed exists).
- **Checks:** new `UX.C1-composer`; update `L16-composer`, `A2.2-fits`, `A2.3-places`, `A2.6-names`, `P0.1-overflow`, `P0.5-frames`,
  `P0.6-widths` (+ its fixture `app/test/fixtures/composer-widths.json` phone rows), `IM3.2-images`, `L18-imagelimits`, `L4b-chipdoc`,
  `L17-quote` composer half, `PL5.1-insert` phone half, `L21-focus` composer parts. Wide halves unchanged.
- **Device:** `storage-picker-permission.yaml` (Take photo, system pickers), the keyboard (composer 6 pt on the keys, drag down
  lowers them) in `ux-composer.yaml` — iOS; Android with the lock.
- **Acceptance:** 3.6 box/toolbar/+/images/context row/@ dock/quotes/keyboard bullets; Return adds a line on touch, only the
  button sends.

#### S3 — Settings › Voice, Choose voice, Add key — M

- **Goal:** 3.8.5, 3.7.3 (Auto-send in Settings only), 4.5, 4.9 (Settings half). **Mockups:** "07 Voice (dark)" `dl-07b-phone`
  (x 5800…6210), "07b" `dl-7bc…dl-7be` (x 6350…7750).
- **Owns:** `voice/SettingsDialog.tsx`, `SettingsParts.tsx`, `DevicesSection.tsx`, `DevLine.tsx`, `VoiceChoice.tsx`,
  `SettingsButton.tsx`, `voice/settings.ts`, `voice/logic/settings.ts` (the Auto-send setting moves here; V1 reads it); registers
  `voice-settings`, `choose-voice`; `VC.1-settings`, `VC.8-devices` phone halves; `desktop/e2e` voice steps only if its selectors move.
- **Depends on:** F1–F3, S1 (the Voice row). **Checks:** new `UX.S3-voice`; the voice set of AGENTS.md: `uicheck -- VC` (all
  three), `node web/e2e/voice.e2e.mjs` (lock), `cd desktop && npm run e2e` if what the page shows of the key changed (lock).
  **Device:** `voice-devices.yaml` (iOS) if the Advanced pickers moved. **Acceptance:** 3.8.5 as drawn; the key is in no new place
  (4.5); no device listed and no request before use.

#### S4 — The prompt library and the Prompt picker — L

- **Goal:** 3.8.6, 3.6 Prompt picker. **Mockups:** "06 Prompt library" `dl-06a`, `dl-06b` (x 2220…3130), "06b" `dl-6b-c…f`
  (x 3270…5160); y 3385….
- **Owns:** `screens/library/*` (incl. `InsertPopup.tsx` → P2 search sheet "Prompt"), registers `library`, `library-group`,
  `prompt-editor`; `PL4.1`, `PL5.2`, `PL6.1`, `L20-library`, `library.mjs`, `web/dev/reallibrary.mjs` phone parts.
- **Depends on:** F1–F3, S1 (row). **Checks:** new `UX.S4-library`; the updates above; `node web/dev/reallibrary.mjs` once.
- **Acceptance:** stack of pushed screens with back labels, + sheet, flat search, groups 60 pt, prompt swipe Move/Delete, group
  P1 with "Delete group and 2 prompts" P4, Move P2, editor P3 with keyboard bar Done and "Edited · not saved", leave guard, offline
  notice with locked fields.

### Wave 3 (after the package named in "Depends on")

#### H2 — Row actions, rename, + New, Archived, search — L  (after H1)

- **Goal:** 3.3, 3.1.3 (archive has Undo, delete asks). **Mockups:** "04 Row actions" `sh-04a…c` (x −2910…−1500), "05 Renaming"
  `sh-05c` (x −330…240), "11 New sheet v2" `sh2-11a`, `sh2-11b` (x −1370…−460), "07 Settings › Archived" `sh-07b` (x 1770…2190),
  "09 Search" `sh-09a`, `sh-09b` (x 3370…4280); y −3810….
- **Owns:** `screens/home/rowactions.ts` (replaces the stub), new `home/RowSheet.tsx`, `RenameSheet.tsx`, `NewSheet.tsx` (+ "Where"
  page inside the sheet), `Archived.tsx` (registers `archived`), `Search.tsx` (+ recent searches in the kv `aiwb.search.recent`,
  last opened `aiwb.search.opened`); may **add** functions to `sidebar/actions.ts` (wide behaviour unchanged); drag-after-long-press
  via `sidebar/drag.tsx` (no change to its wide behaviour).
- **Checks:** new `UX.H2-rows` (swipe Archive/Delete, full swipe archives, Undo restores in place, delete asks; long-press P1;
  rename from row, Chat info and board; + New with Where page; Archived with Unarchive swipe; search in each state); update
  `SEC.4-make`, `SEC.5-change`, `SEC.10-readonly`, `L14-dragtouch` phone halves. **Device:** `ux-rows.yaml` (swipe, long press with
  the haptic, drag after 10 pt) on iOS. **Acceptance:** 3.3 as drawn; Rename is one sheet everywhere (T3's Chat info and B1's
  board title call `openRename(item)` from `home/RenameSheet.tsx`).

#### T3 — Branches and tree, Chat info, Context and usage, images, offline/archived thread — M  (after T1)

- **Goal:** 3.5 branches/tree, Chat info, Context and usage, images, another server offline/archived (thread side).
  **Mockups:** "02 Chat info, rename and usage" `ch-02a…c` (x −6650…−5260), "07 Branches and the chat tree" `ch-07a`, `ch-07b`
  (x 880…1780), "09 Empty chat and images" `ch-09b` (images half; x 3970…4380), "10 Another server" `ch-10x`, `ch-10a`, `ch-10b`
  (x 4460…5740).
- **Owns:** `fork/TreePopup.tsx`, `Chrome.tsx`, `LabelInput.tsx`, `treemodel.ts`, `treekey.ts`; `usage/*` (but `CtxRing.tsx` look: C1);
  `images/*`; `chat/Remote.tsx`; new `chat/ChatInfo.tsx` + `chat/chatinfo.ts` (replaces T1's stub).
- **Checks:** new `UX.T3-chatinfo`; update `L15-fork`, `L22-branches`, `L12-usage`, `A2.4-usage`, `IM3.5-message`,
  `R3.12-images`, `L23-gone`, `AAC.3-remotedown` chat half. **Acceptance:** 3.5's bullets for these; Chat info locked rows say why and
  what to do; Server row opens S2's detail; archived chat's Chat info offers Unarchive.

#### C2 — The chip row, the pickers, a new chat's intro, an empty chat — M  (after C1)

- **Goal:** 3.6 chips and pickers, a new chat's intro; 3.5 "An empty chat". **Mockups:** "02 The chat's setup" `co-02a`, `co-02c`,
  `co-02s` (x −6420…−5510), "03 The pickers" `co-03a…d` + captions `co-03e`, `co-03f` (x −5320…−3410); "09 Empty chat"
  `ch-09a` (x 3480…3890).
- **Owns:** `composer/ChatChoices.tsx`, `Chip.tsx`, `Picker.tsx`, `Folder.tsx`, `model.ts`, `recent.ts` (recent folders removed on
  the phone; wide unchanged), `subagents/Chip.tsx`, `chat/Empty.tsx`, `app/test/wiring.test.ts` chip parts; `composer-chips.yaml`.
- **Checks:** new `UX.C2-pickers`; update `A2.4-popups`, `A2.5-selectors`, `S1.1-subagents` phone halves, `L4b-chipdoc` if touched.
  **Device:** `composer-chips.yaml` (iOS) — the chip row hides with the keyboard.

#### B2 — Point at, Add selection, the selection rule — M  (after B1 and C1)

- **Goal:** 3.4 Point at, Add selection, "A selection on the board goes to no chat by itself", 6.2 (selection rule).
  **Mockups:** "07 Point at" `bd-07a…c` (x −1490…−50), "11 Add selection" `bd2-f-a…c` (x 80…1480), "12 Selecting" `bd2-g-a`,
  `bd2-g-b` (x 2170…3070); y −2000….
- **Owns:** `board/refs.ts`, `PickSurface.*`, `board/taps.ts`, the picking banners/bars in B1's bottom-row slot
  (`board/PickBar.tsx`), the chips the flows return (in C1's context row: B2 adds two chip kinds through C1's
  `ContextRow` props). **Checks:** new `UX.B2-pick`; update `P7.4-board`, `L24-boardui` pick halves. **Acceptance:** the agent gets
  the x/y and the ids exactly as today (`P7.4-board` unchanged in what is sent); the draft is kept; Back cancels.

#### V1 — Blocked states and voice in the composer and on the board — L  (after C1 and B1; S3 for the setting)

- **Goal:** 3.7.1, 3.7.2, 3.7.3 (bar and board halves), 4.5, 4.9. **Mockups:** "06 Voice in the composer" `co-06a`, `co-06c`,
  `co-06d`, `co-06s` (x −20…1390, y 1590…), "07 Notices" `co-07*` (blocked bars), "05 Talking to the board" `bd-05a`, `bd-05b`
  (x −3660…−2750, y −2000…), "10 Another server" `ch-10*` (composer half).
- **Owns:** new `composer/Blocked.tsx` (fills C1's `ComposerBlock`; the archived/old-board bars move out of `Notices.tsx`),
  `composer/dictation.ts`, `voice/ComposerVoice.tsx`, `SpeechBar.tsx`, `ProblemPopover.tsx` (→ the "Set up voice" sheet),
  `VoiceNotice.tsx`, `MicMark.tsx`, `ReadAloud.tsx`, `voice/composer.ts`, `read.ts`, `voice/pill/*` (→ the docked orb and the voice
  card; registers B1's `BoardOrb` slot and the `BoardVoice` slot), `docs/architecture.md` voice section (pill → card, 4.9).
- **Checks:** new `UX.V1-voice` (each blocked state said once, box read-only with the draft; Dictate; speech bar states and words;
  Set up voice; voice card on a board); the voice set of AGENTS.md: `uicheck -- VC` (update `VC.2`, `VC.3`, `VC.4`, `VC.6`, `VC.7`
  phone halves; `VC.5-hoverbar` unchanged), `voice.e2e.mjs` (lock), `desktop npm run e2e` only if the key's store or bridge changed
  (it should not). **Device:** `voice-mic.yaml` (iOS) if the speech bar's controls moved.
- **Acceptance:** one vocabulary (Talk, Dictate, Send, Cancel, Interrupt, Mute, End; Stop only for the agent); no Auto-send in the
  bar or on the board; selection goes to the voice chat only in speech mode; nothing in voice-chats/voice-devices goals changes
  but what 4.9 says.

### Wave 4

#### R1 — The rules check and the final sweep — M  (after everything)

- **Goal:** 6.1 (coverage audit), 6.2 (all bullets), 4.7, 4.10.
- **Owns:** new `web/dev/checks/UX.R1-rules.mjs` + helper `rules.mjs` (no dash): walks every phone screen of 6.1 through the
  real navigation (a list of "screen recipes", each a seed + steps, kept in `rules.mjs`; areas' checks may export their recipes),
  and fails by naming the control: touch targets < 44 pt (the element's box plus hitSlop, read through a `data-hit` the parts
  write), text < 13 pt (16/17 where 3.1.1 says), desktop words (`⌘`, "right-click", "Esc", "Ctrl+", hover titles: no `title`
  attribute on the phone), focus rings, every sheet has a `sheet-head` with a title, destructive row last and red, no P1 with a
  Cancel row, each blocked state once with a read-only box and the draft, state words only from `statewords.ts` (the
  `state-word` dataSet against the store's state), delete asks / archive does not and Undo restores in place, back and swipe
  land per 3.1.2 from each way in, Auto-send only in Settings › Voice, selection rule, nothing app-made over the canvas (no app
  element intersecting `.excalidraw canvas` bounds except Excalidraw's own). In light and dark.
- **Also:** the 6.1 audit table in `plans/ux-improvements/coverage.md` (each mockup → the check and state that covers it);
  `web/dev/checks/README.md` (new files, `UX.*`), `P0.3-smoke` final `DRAWN`, `A6.4-floors` (contrast of the new parts in each
  flavour), docs (`docs/architecture.md` "phone layout" paragraph).
- **Tests:** the final checks of §7.

### Packages at a glance

| ID | Title | Depends on | Group | Size |
|---|---|---|---|---|
| F1 | Phone kit | — | wave 1 | L |
| F2 | Stack, back, pushed screens | — (F1 stubs) | wave 1 | M |
| F3 | State words | — | wave 1 | S |
| H1 | Home & groups | F1 F2 F3 | wave 2 | L |
| S1 | Settings root | F1 F2 F3 | wave 2 | S |
| S2 | Servers & add flow | F1–F3 (H1 for the chip) | wave 2 | L |
| T1 | Chat thread | F1–F3 | wave 2 | L |
| T2 | Tools, permission, subagents | F1–F3, T1 slot | wave 2 | M |
| B1 | Board screen | F1–F3 | wave 2 | L |
| C1 | Composer box | F1–F3 | wave 2 | L |
| S3 | Voice settings | F1–F3, S1 | wave 2 | M |
| S4 | Prompt library | F1–F3, S1 | wave 2 | L |
| H2 | Rows, rename, new, archived, search | H1 | wave 3 | L |
| T3 | Tree, Chat info, usage, images, offline | T1 | wave 3 | M |
| C2 | Chips & pickers | C1 | wave 3 | M |
| B2 | Point at, Add selection | B1, C1 | wave 3 | M |
| V1 | Blocked states & voice | C1, B1, S3 | wave 3 | L |
| R1 | Rules check & sweep | all | wave 4 | M |

Wave 2 has nine packages; run **at most five at once** (the machine queues process starts, AGENTS.md "What it costs"): start
H1, T1, C1, B1, S2 first (the long ones), then S1, T2, S3, S4 as slots free.

---

## 4. Execution rules for every package

### 4.1 Worktree and branch

```sh
cd /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/ux-improvements
git worktree add ../ux-<id> -b ux-<id>          # from the current ux-improvements
cd ../ux-<id> && npm ci --prefer-offline --no-audit --no-fund
```

`<id>` is lower case: `ux-f1`, `ux-h1`, … A lead may give its chunks their own worktrees `ux-<id>-<n>` from `ux-<id>` the
same way, and merges them into `ux-<id>` itself. Commit on the branch with a clear message ending in
`Co-Authored-By: Claude <model> <noreply@anthropic.com>` naming the model that wrote it. Never commit `node_modules`, builds,
`ios/`/`android/` outputs, simulator logs, `board-v3.txt` or `out/` folders. Never push, never touch `main`, never rewrite a branch
another agent uses, never bare `git stash`.

### 4.2 Handing back and integrating

1. The lead merges the latest `ux-improvements` into `ux-<id>` (`git merge ux-improvements`), resolves conflicts, runs its
   package's tests (its section) once more, commits.
2. The lead reports: done / failed / blocked, branch and last commit, the commands run and their results, checks added and
   updated, what is left, decisions others must know (a contract change: name it).
3. **The orchestrator integrates**: `git merge --no-ff ux-<id>` on `ux-improvements` (only it writes that branch), then runs
   root `npm test && npm run check`, `cd web && npm test`, `cd desktop && npm test`, and the package's `UX.<ID>` check at the
   phone plus the tablet/desktop halves of the existing checks it changed. A failure goes back to the lead. Then
   `git worktree remove ../ux-<id>` (the branch is kept).

### 4.3 The heavy-run lock

One heavy run at a time on the machine, across all packages:

```sh
L=/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/.ux-heavy.lock
until mkdir "$L" 2>/dev/null; do sleep 30; done      # wait for it (a foreground loop; never end a turn holding or waiting)
echo "ux-<id> $(date) <what>" > "$L/owner"
...the heavy run...
rm -rf "$L"
```

A lock older than 2 hours whose owner's worktree shows no running process may be broken by the orchestrator only.
**Needs the lock:** the whole `npm run uicheck` or a whole viewport of it (`VIEWPORT=phone npm run uicheck`), any uicheck run
of more than 8 check ids, `uicheck:electron --all`, every device flow (`app/e2e/run.mjs`; plus the Android emulator's own lock
`/tmp/aiwb-android-emulator.lock`), `cd desktop && npm run e2e`, every `web/e2e/*.e2e.mjs`, `node web/dev/reallibrary.mjs`,
`cd packages/board-engine && npm run faithful`, the Go full set. **No lock:** unit tests, type checks, up to 8 uicheck ids
(they bind free ports).

### 4.4 Tests, devices, money

- Follow AGENTS.md's table; this change is to `app/`, `packages/*` and `web/`, so: root `npm test && npm run check`,
  `cd web && npm test`, `cd desktop && npm test` each time; uicheck for the screens touched; no Go tests (no package here
  touches the server; if one must, it stops and asks the orchestrator: 4.6 of the goal says server data is out of scope).
- While iterating: `VIEWPORT=phone npm run uicheck -- <ids>`; before handing back: the same ids at all three viewports.
- Playwright: `cd web && npm install --no-save playwright@1.64.1 && npx playwright install chromium` once per worktree.
- **Device flows only for what only a device shows** (goal 6.3), named in each package; each on the lead's **own** iOS
  simulator (`xcrun simctl create ux-<id> "iPhone 17"`, deleted at the end), Android only with the emulator lock. Never "to be
  sure", never two builds at once (the heavy lock).
- **No paid test, ever**: not `AIWB_CLAUDE_E2E`, `AIWB_CURSOR_E2E`, `AIWB_PI_E2E`, not `web/e2e/app.e2e.mjs`. No ElevenLabs call.
- A check that fails and that the change cannot have touched: run it alone once; if it passes, report it as load-sensitive.
- Never touch `~/.ai-whiteboard`, `~/Library/Application Support/AI Whiteboard`, or the user's server on ports 4748/6006.

### 4.5 Hot spots

| File | Owner | Others |
|---|---|---|
| `app/src/ui/*` | F1 (F2 for `Overlay.tsx`, `pushedscreen.tsx`, `BackControl.tsx`, `useLayout.ts`) | after wave 1: an area that needs a ui change makes a minimal, backward-compatible change in a separate commit `ui: …` and names it in its report; no restyle of a part for one screen |
| `screens/shell/PhoneStack.tsx`, `stack.ts`, `screens.ts`, `homeplace.ts`, `BackButton.tsx` | F2 | nobody after F2; use `registerScreen`/`pushScreen` |
| `screens/shell/nav.ts`, `slots.tsx` | F2 | append-only after F2 (a new helper or slot), one commit, named in the report |
| `screens/shell/phone/HomeRoute.tsx` / `BoardRoute.tsx` / `ChatRoute.tsx` | H1 / B1 / T1 | — |
| `screens/chat/ChatView.tsx` | T1 | T2 fills the `AboveComposer` slot, no edit |
| `screens/composer/Notices.tsx` | C1 | V1 removes the bars after C1 merges |
| `screens/composer/Composer.tsx`, `Toolbar.tsx` | C1 | C2 (chips' mount point), V1 (block slot) through C1's props only |
| `app/test/wiring.test.ts` | C1 | C2 edits the chip tests only |
| `voice/logic/settings.ts` | S3 | V1 reads |
| `web/dev/checks/sel.mjs` | H1 | others append to `acts` only |
| `web/dev/mock.mjs` | — | each package adds what it needs in a block marked `// ux-<id>`; no change to a world's behaviour another check relies on |
| `web/dev/mock-ui.js` | — | each package adds its own section `UX<ID>` to `SECTIONS` |
| `web/dev/checks/P0.3-smoke.mjs` `DRAWN` | — | each package edits only its rows |
| `web/dev/checks/README.md` | R1 | each package adds its row of the files table |
| `docs/architecture.md` | — | V1 (voice), R1 (phone layout); others only for what they change |
| `screens/sidebar/*` | wide layouts | H1/H2 may import and add functions; the wide sidebar's behaviour is unchanged |

### 4.6 Writing the screens

- Use the kit: no screen draws its own sheet, back, toast, bar or state word (4.3). Sizes from `metrics.ts`, colours from tokens.
- Phone vs wide: `usePhone()`; where the wide layout keeps today's component, keep it and add the phone one beside it.
- Every control has an accessibility label in the goal's words (4.7); no `title` tooltips on phone-only parts.
- testIDs: kebab-case, dataSet for values; add the ids a check reads to the package's own ids file, not to `ui/tid.ts`.
- Correct in light, dark and the Catppuccin flavours; a new token goes in `ui/tokens.ts` with its test (F1 reviews).

---

## 5. Model policy and sizes

- **Leads** of every package, and any architecture or decision work (a contract change, a hot-spot conflict, the `sel.mjs`
  rewrite, R1's rules walker): **Opus 5.5, effort high**.
- **Implementation chunks**: **Sonnet 5.5, effort high**. A chunk is small and precise: the files it may change, the contract
  it implements (copied from §2/§3 into the prompt), the acceptance in a few lines, the exact test commands, and what not to touch.
- **Escalation:** a chunk Sonnet fails to complete twice in a row (it reports it could not, or the lead's acceptance check
  fails) goes to Opus. The second Sonnet attempt gets the first one's failure in its prompt.
- Sizes (chunks of ~1–3 files and one check scenario each): S ≈ 2–4 chunks, M ≈ 5–8, L ≈ 8–14. Suggested chunking is in each
  package (H1 shown in full); a lead chunks the rest the same way: kit/contract first, then screen by screen, then mock seeds and
  the new check, then the existing checks' phone halves, then device flow.
- F1 chunks: (1) metrics + Button/IconButton/Switch touch sizes; (2) Sheet detents + head slot; (3) SheetHead + ActionSheet;
  (4) PickerSheet with search; (5) FormSheet + keyboard + guard; (6) ConfirmSheet + `confirm()` on the phone; (7) Cells + Bars look;
  (8) Toast; (9) SwipeRow; (10) haptics (native dep) + SearchField + SecretInput eye; (11) gallery + `UX.F1-kit` + L1/P0.7; (12) device.
- F2 chunks: (1) stack descriptors + unit tests; (2) homeplace store; (3) registry + PushedRoute + presenter; (4) NavBack + hold
  sheet; (5) route components split out of PhoneStack; (6) D4 layout on native; (7) `UX.F2-stack` + updates; (8) `ux-stack.yaml`.

---

## 6. Decisions and open questions

### 6.1 Decisions made here (each may be revisited by the user)

| # | Decision | Why |
|---|---|---|
| D1 | Keep React Navigation's native stack, still derived from the store; add Home's place (`HomePlace`) and a registry of pushed screens drawn as routes of the same stack | swipe back and Android back stay native (4.8) and the store-driven model (AD-71) that the checks rely on holds |
| D2 | Phone sizing is opt-in (`usePhone()`, `size="touch"`), not automatic in shared parts; R1's walker enforces 44/13/17 | wide layouts must not move (4.2), and areas land at different times without breaking each other's phone checks |
| D3 | P1–P4 are phone-only components; the wide layouts keep their popovers/dialogs; `Overlay kind="screen"` = pushed on phone, Dialog on wide | the board's rule 6, and 4.2 |
| D4 | On a native phone the layout follows the window's **shorter** side, so landscape keeps the phone layout; the web build keeps width-based layout | the goal's landscape mockups (3.4, table viewer) draw the phone layout; open question 4 |
| D5 | Missing server data (4.6): no time on rows; Archived shows the place, not a date; only found agents (plus the current missing one); model note/context only from the catalog; Too old without a minimum version | goal 4.6 forbids inventing; adding server data is a separate decision |
| D6 | "Since 9:12" and "offline since 14:02" are recorded by the app when a server's state changes (F3) | it is the app's own knowledge, not server data |
| D7 | Add `expo-haptics` (one native dependency, one dev-client rebuild in F1) | 3.3 asks for a haptic; RN's `Vibration` is not a light haptic on iOS |
| D8 | Swipe rows on gesture-handler's Pan + RN Animated, no reanimated | the app has no reanimated; the Sheet already works this way |
| D9 | Home is a new phone slot/screen (`screens/home`); the sidebar stays for the wide layouts; Home reuses core's tree logic and `sidebar/actions.ts` | the sidebar's shape (sections, indents, foot) is what the goal removes on the phone and keeps on the wide layouts |
| D10 | A server's own state word is "Unreachable"; "Offline" is what a chat or the composer says of the server it is on; the states the goal does not name read "Unreachable" with today's label as the reason | one list (3.1.3) with no word invented |
| D11 | On the desktop window made narrow, "This computer" is a server chip like any other | the goal says nothing of it; one rule for every server |
| D12 | The server's sheet (chip) and its detail screen share one body, `ServerFacts`, owned by S2 | open question 8: one place for a server |
| D13 | "An empty chat" (3.5) is built by C2 with the new chat's intro | same file (`chat/Empty.tsx`), one owner |
| D14 | The trimmed Excalidraw menu and the footer's right inset come through a new board-bridge message and Excalidraw's own `MainMenu`/`UIOptions` in `board-view/src/Board.tsx`; the engine files are not touched | 4.4: Excalidraw's tools are configured, not patched |
| D15 | The board's edge swipe is always off; picking (Point at, Add selection) cancels with Back | 3.1.2: the canvas needs its pans |
| D16 | Auto-send keeps its storage key (`voice/logic/settings.ts`); S3 shows it in Settings › Voice, V1 removes it from the bar and the board | 3.7.3, 4.9; nothing stored changes |
| D17 | New checks are `UX.<ID>-<word>.mjs`; an existing check's phone half is rewritten by the package that changes its screen, in the same branch | 4.10 |
| D18 | The orchestrator alone merges into `ux-improvements` | one writer of the integration branch |

### 6.2 The goal's open questions (section 7) and the default this plan takes

1. Docked orb with a right inset: build it (B1); if the inset breaks in the web view or on the web build, ship the drawn
   fallback (`bd-04b`) and say so in B1's report.
2. "+" alone: keep it (the user chose it, 4.1 items 15 and 17).
3. Speech bar folding its heading after the first turn: no (as drawn); revisit after a device test.
4. Landscape on a phone: keeps the phone layout (D4).
5. Allow in the accent colour: yes, as drawn (no risk marking exists).
6. Catppuccin flavours on the phone: kept, behind Appearance.
7. "+ New chat" in the Chats sheet: first (goal 3.4).
8. Server sheet and detail: one body (D12).

---

## 7. Merge order and the final checks

**Order** (each after the orchestrator's integration checks of 4.2): F3 → F1 → F2 → H1 → S1 → T1 → B1 → C1 → S2 → T2 → S3 →
S4 → H2 → T3 → C2 → B2 → V1 → R1. Within a wave the order is whoever finishes first, except H1 before any other package that
changes a check's phone navigation (its `sel.mjs` is the base the others rebase onto).

**Final checks** (the orchestrator, once, while nothing else runs; the heavy lock held):

1. `npm test && npm run check` (root), `cd web && npm test`, `cd desktop && npm test`, `cd packages/conn && npm test`,
   `node --test web/dev/host.test.mjs`, `cd packages/board-engine && npm test && npm run check`,
   `cd packages/headless && npm test && npm run check`.
2. `cd web && npm run uicheck` — every check at its viewports (~50 min): goal 6.1, 6.2 (`UX.R1`), 6.4 (tablet and desktop
   unchanged: no tablet/desktop half was edited except to follow a renamed testID).
3. The voice set (6.4): `uicheck -- VC` (in 2), `node web/e2e/voice.e2e.mjs`; `cd app && npm run build:web && cd ../desktop &&
   npm run e2e` (the key's settings page moved).
4. The free end-to-end scripts that drive the page's phone path: `VIEWPORT=phone node web/e2e/remotechat.e2e.mjs`,
   `node web/e2e/newchat.e2e.mjs`, `node web/e2e/twopages.e2e.mjs`, `node web/e2e/readers.e2e.mjs` (their `web/e2e/lib/ui.mjs`
   phone navigation is updated by H1 with `sel.mjs`; add this to H1's scope if they fail).
5. `cd packages/board-engine && npm run faithful` and `node dev/harness.mjs` in `packages/board-view` (6.4: the board is untouched).
6. Device (6.3), on the orchestrator's own simulator and the Android emulator with its lock: `ux-stack`, `ux-rows`, `ux-board`,
   `ux-composer`, `ux-table`, `sheets`, `storage-picker-permission`, `_v4-scan`/`_v4-localnet` via their flow, `voice-mic`.
7. No Go tests: no package changes the server. (If one did, `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once.)
8. `plans/ux-improvements/coverage.md` (R1) lists every mockup of section 3 with the check that covers it; nothing is "not covered"
   without the user's word.
