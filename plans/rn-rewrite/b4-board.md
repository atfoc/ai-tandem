# Package B4: the board screen, as built

What B5 (the page in the native app), the screen packages that draw the chat (S4, K3, K5) and the desktop packages build on.
Code: `app/src/platform/board.{types,web.tsx,native.tsx}`, `boardchannel.ts`, `boardnav.ts`, `boardpage.native.ts`; `app/src/screens/board/`.

## The host (`platform/board.*`, AD-52)
`BoardHost` ({ `onChannel(HostChannel | null)`, `hidden?`, `onOpenLink?`, `testID?` }) holds one board view and gives the screen its channel:
`createHostChannel(post)` of `boardchannel.ts` = core's `createChannel` + a count of requests in flight (`inflight()`, `idle()`).
A host that goes away lets the requests in flight be answered (at most 3 s: the board side asks the view for its scene as the board is left,
to write it) and only then ends the view; `reset()` refuses what is still waiting.
- **web**: `window.aiwbBoardView.mount(element, post, { testID: "board-view" })` in a box of the host; in-process, so the web build speaks
  the messages of the web view. board.js missing: the channel gets an `error` message ("the board view did not load").
- **native**: `react-native-webview`, the settings of AD-52 as revised: `originWhitelist=["*"]` and `onShouldStartLoadWithRequest` through
  `navigation(url, page)` (`boardnav.ts`, tested: the page's own address, an http(s) address offered to the user, the rest dropped); a refused
  http(s) address goes to `onOpenLink`, which the screen turns into a confirm dialog ("Open this address?") and then `Linking.openURL`.
  iOS `allowingReadAccessToURL` = the page's folder, Android `allowFileAccess` and `setSupportMultipleWindows={false}`, `incognito`,
  `cacheEnabled={false}`, no injected JavaScript, scroll and bounce off, messages in by `postMessage`. `key` raised and the channel `reset()` on
  `onContentProcessDidTerminate` / `onRenderProcessGone`; the board side sends the board again when the page says `ready` (a queue until then
  is the channel's). `platform/boardpage.native.ts` `resolvePage()` = `expo-asset` of `@aiwb/board-view/dist-webview/board.html`
  (the one function B5 changes if Android needs another way, AD-56). **Not run on a simulator or a device** (B4's Accept does not need it):
  the native file type-checks (`tsc -p tsconfig.native.json`) and bundles (`npx expo export --platform ios` and `android`, `board.html`
  4.1 MB among the assets), nothing more.
- **`textInteractionEnabled`: not tried.** B4 has no simulator; `TEXT_INTERACTION = true` (the web view's own default) in `board.native.tsx`,
  because `false` could keep Excalidraw's text editor from taking the keyboard and the spike never typed. B5's flow must type in the text tool with the on-screen keyboard
  and set the constant to what lets it.
- `app/metro.config.js` adds `html` to `assetExts` and `app/package.json` has `react-native-webview` 13.16.1 and `expo-asset` ~57.0.20 (both by `npx expo install`).
  B5 still has the Android order of AD-56, `prebuild:board`, the self-test and the Maestro flow. The `expo-asset` config plugin of the spike is not
  in `app.config.ts` (it did nothing for a page `require`d by Metro; another package edits the same `plugins` line).

## The screen (`screens/board/`)
- `BoardCanvas` fills the shell's `Canvas` slot (`index.ts` registers it, and the engine host in `Overlays`; `screens/register.ts` imports `./board`).
  Port of `web/src/Canvas.tsx`: `TakeoverPanel` for a role that is not held (no view then), `BoardOff` ("gone", "unreachable"), the host with `Presence`,
  `FlashLayer`, `PickLayer`, `SaveBanner`, `DroppedNote` over it, the error text "Couldn't open this board: …" (a failed read, or the view's `error`),
  and a cover (`canvas-empty`) until the view has drawn the board (no other board's drawing shows). The effects: the role is asked for as the page does;
  `boardApp.attachView(channel)` while the host is up; `boardApp.show(board)` for [board, store `sceneGen`, wanted, channel], and `hide()` by the screen that
  showed last (a module `owner`) when it goes; `flush` on a stack screen's `blur` (phone, `NavigationContext`); the board bar and its "Chats N" button are the shell's.
- testIDs: `board-canvas` {board, state: empty | loading | ready | error | takeover | off}, `board-view`, `canvas-empty`, `canvas-error`, `takeover-panel` {role},
  `takeover-use-here`, `takeover-spin`, `takeover-dropped`, `board-off` {view}, `board-off-servers`, `save-banner`, `canvas-note`, `canvas-note-hide`, `flash` {tone, agent},
  `flash-label`, `flash-layer`, `presence` {agent}, `pick-layer`, `pick-hint`, `pick-coord`, `pick-cancel` (touch).
- **One web view first** (`engine.ts`, tested): `boardApp.setEngine(() => engine.channel())`: the visible view while one is attached, else a hidden engine host (`EngineHost`,
  1×1 px, opacity 0: not 0×0, a zero-size web view may not run) made on the first request and ended 60 s after its last one (the clock restarts at each request
  and each answer); a visible view that appears ends it once its requests are answered; what waited for it is served by the visible one.
- **⌘⇧L** (`boardkeys.ts`): taken through the keys port, before Excalidraw hears it, while a chat of the board on screen is open in the panel and takes a change; with the panel away
  (⌘J), or no such chat, the canvas hears it (as before). Esc ends the wait. **⌘L is the composer's** (a quote of the selected text, else the selection): K3/K5 call
  `addSelection(chat, board)` (puts the selection in through `insertRef`; answers the sentence "Select something on the board first" when there is none), and register
  what puts a ref into their box with `registerInserter(chat, put)`; the pick layer's press calls `insertRef(chat, ref)` and draws the point's box. These are exported from `screens/board`.

## Findings
- **`html { font-size: 13px }`** in `app/public/index.html`: Excalidraw's chrome is sized in `rem`, and the old page's root is 13px (`styles.css`); at 16px every control of
  the board was 23 % bigger than the old page's. The phone's web view page (`board.html`) has no such rule: its root is 16px (a decision for B5's by-hand look: Excalidraw's
  phone layout is the one used there).
- The chrome of Excalidraw does not follow the flavours in the new build: the old page set Excalidraw's custom properties from the app's tokens (`web/src/flavours-canvas.css`, 95 lines), and
  the `theme` message carries only the mode and the canvas filter. The canvas's ground and filter follow the theme (P7.5 passes); the colours of the toolbar and panels do not. A6.3's canvas parts have no owner yet. (**Done in B7**: `theme.chrome`, see AD-74; `checks-app/A6.3-board.mjs`.)
- A `res` or `changed` message with a non-finite number (`x: NaN`) is dropped by the validator as a whole, so the request it answers is left to its 20 s timeout. (Found by L6 when an
  `apply` was given `moveBy` as `{x, y}`: it is `[dx, dy]`.) (**Changed in B7**: a reply to a waiting request that fails the validator rejects it at once, `VIEW_FAILED` with the validator's path, `channel.ts`.)
- Excalidraw on a touch viewport: a touch within 300 ms of another is a double tap and opens the text editor; keys do not reach a canvas no mouse clicked (a finger taps the tool in the toolbar).

## Checks
Ported to `web/dev/checks-app/`: `P7.5-canvas` (three viewports; Light, Dark and the flavours on a page each, the picks read through the phone layout's Edit button; the switch with no reload is by the
system's scheme until the picker exists, flag `THEME_PICKER`), `P7.4-board` (⌘⇧L, desktop and tablet), `SEC.7-board` and `AAC.2-board` (the board parts, three viewports; the chat parts are S4's; the sidebar
parts are behind the flag `SIDEBAR`), `A1.4-key` (the canvas part, flag `CANVAS` gone). New: `L5-board-roles` (leaving a board writes it; `superseded` shows the panel and "Use here" takes the board back),
`L6-agenttools` (`apply`, `get_image` with bounds, `delete_elements`, `show_board` through the page, desktop and phone) with the scenario `web/dev/agenttools.mjs` and the same on the old page
(`web/dev/checks/L6-agenttools.mjs`, desktop and 393-px windows). The mock has the `rpc` knob (`await rpc(call, { server, timeout })`). `P0.3` draws `A2.board-selected`, `A2.board-busy`, `A6.board`, `SEC.board`.
Unit tests: `app/test/board.test.ts` (navigation policy, the channel's count and drain, the engine's life, ⌘⇧L and Esc).
