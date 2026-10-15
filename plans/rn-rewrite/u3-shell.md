# Package U3: the app shell, as built

What the screen packages (S1…S12, K3, B4) build on. Code: `app/src/App.tsx`, `app/src/bootstrap.ts`, `app/src/screens/shell/`,
`app/src/platform/{transport,focus,lifecycle}.*`, `app/src/state/useStore.ts`.

## Bootstrap (`bootstrap.ts`, AD-76)
`setKv(kv)` → `setPageVersion(EXPO_PUBLIC_AIWB_VERSION)` (new `setPageVersion` in core `state/version.ts`) → `setUi(appUi)`, `setBoardSide(boardApp)`,
`setFlushBeforeReload` → `installLifecycle` (web: `pagehide`, `visibilitychange`, `beforeunload`, `window.aiwbFlush`; native: `AppState` background
→ `flushAll`) → `setUpTransport()` (web `transport.web.ts`: `window.aiwbTransport` → `desktopTransport`, http → `httpTransport`, none → "AI Whiteboard
runs in its app." with testID `no-way`; native `transport.native.ts`: `nativeTransport(createNativeClient())`) → `setPictureAddress((s,c,i) =>
transport().picture(s,c,i))` → a tablet window narrower than 820 starts with the sidebar hidden (not saved) → `watchKeptDrafts()` → `connect()`.
`<Root>` then draws `GestureHandlerRootView > SafeAreaProvider > ThemeProvider(kv) > Shell`; `ThemeToStore` copies the provider's `pref`/`theme` to the
store's `themePref`/`theme` (the board side reads them). `window.aiwbReady = true` once the shell rendered (web).

## Slots (`screens/shell/slots.tsx`, `screens/register.ts`)
A screen package registers with `setSlot(name, Component)` from `screens/<area>/index.ts` and adds `import "./<area>"` to `screens/register.ts`.
`Sidebar` (S1; fills the side pane / the phone's first screen), `ChatView` ({chat}: header + thread + composer; S4/K3), `Canvas` ({board}; B4),
`SubagentDrawer` (S7), `Overlays` (components with no props, always mounted: tree popup, library popups, Servers dialog). Until registered each draws a
stand-in carrying the testID the checks wait for (`side-tree` with flat `side-row`s and `side-hide`; `chat-head`; `board-canvas`).
Exports to use: `SideHideButton` (the sidebar head's hide control), `nav.ts` (`select`, `openChat`, `openBoard`, `newChat`, `newBoard`, `addBoard`,
`setEditRow` (the sidebar registers what puts a row in rename mode), `setFocusComposer` (the composer registers its focus), `setSideHidden`, `confirm`,
`reportError`, `attempt`), `boardside.ts` `boardApp` (B4: `boardApp.attachView`), `state/useStore.ts`, `PhoneStack.tsx` `BackButton`/`goBack`.

## Layouts
Wide (tablet, desktop): `Layout.tsx`, one split view; widths `widths.ts` (saved widths used as they are from 984 px up, fitted to the window below it;
below 820 on a tablet the sidebar lies over the stage, rail kept, `side-backdrop` hides it). Phone: `PhoneStack.tsx`, React Navigation native stack with
`headerShown: false`; routes = `stackOf(state)` (`stack.ts`: side, board, chat, drawer); the navigator follows the store (push/pop/reset), a back the
navigator made by itself is written to the store (`selForRoutes`). **On the phone `openBoard` opens the board alone** (canvas on screen; its chat is
the bar's "Chats N"); the wide layouts open it with its last chat as the page does.

## testIDs (kebab-case; `dataSet` in brackets)
`app-root` [layout], `no-way`, `app` [side: hidden|shown, layout] (wide), `side-pane` [pane] (wide: the pane; phone: the first screen),
`side-rail`, `side-show` [notice], `side-rail-dot`, `side-hide`, `side-backdrop`, `board-panel` [pane], `board-stage`, `board-bar`, `board-crumb`,
`archived-note`, `board-chats`, `board-new-chat`, `chat-page`, `phone-bar` (the drawer's bar; a chat has none since S8: its own header carries the back), `nav-back` (the phone's back; there is one per screen of the stack: use the
last), `drawer-screen`, `home`, `home-glyphs`, `home-spin`, `home-new-chat`, `home-new-board`, `guard-fail` [what], `confirm-dialog`, `resizer` [pane, active]
(ui), `side-tree`/`side-row`/`chat-head`/`board-canvas` (stand-ins; S1/S4/B4 keep the testIDs of `sel.mjs` `IDS`).
`sel.mjs` `openBoard` waits for the board row's `aria-selected="true"` also when a chat of the board is open (the stand-in sets it for `sel.board === key`).

## Decisions
CSP: `app/scripts/export-web.mjs --connect-self` (or `AIWB_CONNECT_SELF=1`) adds only `connect-src 'self'`; `buildAppDist` passes it; the default export keeps
`'none'` (tested). `picture.web.tsx` now waits for a promised address (the desktop's ipc way answers one). `ui/Resizer` takes the last pointer position
from the window's own `pointermove` (the gesture handler dropped a move that came in the frame of the release).
