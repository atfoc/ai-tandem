# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.

- tldraw 5.6.0 is the current stable (licence check, 2026-11-08). Pin it exactly unless a spike recorded another. (orchestrator)
- The prototype's Electron window loads a development bundle of the new board (a production `file://` page without a key goes blank after 5 s; licence.md). The web build over http://127.0.0.1 counts as development. No licence key is used or worked around. (orchestrator)

## Architect (`plans/better-board/design.md`, branch `bb-arch`)

- D1 (architect): one model, `packages/board-tl/src/model/` (schema, shape utils, palette, fonts list, agent terms, apply/read/validate), imported by the window's `tl.js` and by the board host; `view/` holds the window UI (design 1.2).
- D2 (architect, recommendation): tldraw's own sans font for every element, one font folder `packages/board-tl/fonts/` copied into both builds; the spikes may change it (design 1.2, goal 9).
- D3 (architect): the board host is a separate Node process (`packages/board-host`, `boardhost.mjs`) started by a second `internal/headless.Manager` with the same Node/bundle lookups and handshake; it reuses `@aiwb/headless`'s config, memstore and conn client code (design 1.3).
- D4 (architect): window sessions are in Go's memory only (`internal/tlrelay`); Go makes the session id, which is also tldraw's `sessionId` (design 2.1).
- D5 (architect): no feature-level change in the prototype; a release would raise it (design 2.2).
- D6 (architect): no layer drops a sync message; batching comes from one call in flight per sender plus a 25 ms gap (page → Go, host → Go); presence is left to tldraw's own throttling (design 2.4).
- D7 (architect): `model.Board.Kind` (`""` classic, `"tl"` new, `omitempty` so old `board.json` files are untouched); agents say `kind: "new" | "classic"` to `create_board`, default classic (design 4.1, 3.1).
- D8 (architect): the board host decides when to save (1 s throttle for people, immediately before answering an agent, at room close and exit); Go writes `boards/<id>/snapshot.tl.json` on its `PUT /api/tl/{id}/snapshot`, accepted only from the current board host's client id (design 4.2).
- D9 (architect): `editorbridge.Bridge.OnEnd` hook, called after the lock, closes a window's sessions (or all sessions when the host's stream ends); `CallSpec.Client`/`Lost` send agent calls to the host only and fail them with `HOST_STOPPED` (design 2.7, 3.3).
- D10 (architect): a `create`'s `ref` is kept as `meta.key` on the shape and can name the element in later calls (unique per board, `REF_EXISTS`) (design 7.1).
- D11 (architect): the agent's marker is a tldraw custom message (`room.sendCustomMessage`, `aiwb_agent` with label and bounds, 4 s) drawn by our view, not a tldraw presence (design 8).
- D12 (architect): people's names on cursors are generated per page ("Teal Otter") and kept in the page's kv `aiwb.tl.user` (design 8, goal 9).
- D13 (architect, proposal): `read_board` on a new board answers a header line plus one JSON object per element (JSON Lines) in the agent terms (design 7.3).
- D14 (architect): the kind is read in `boardapi.Relay.CallResult` after the board lookup; a tl board's tools go to `tlrelay.CallTool`, never to `routeToAway` or a window; `get_view`/`show_board` for a tl chat board go to the window with the newest open session (design 3.1).
- D15 (architect): the agent edits through a room editor in the host that is not a sync peer: records in, ops in one `editor.run`, the diff written to the room in one storage transaction, all synchronous; then save, then answer (design 7.4, goal 9 "agent peer").
- D16 (architect): the relay's routes are `POST /api/tl/{id}/open|sync|close`, `POST /api/tl-host/out`, `GET|PUT /api/tl/{id}/snapshot`; events `tl_sync`, `tl_closed` (to a window) and `tl_open`, `tl_sync`, `tl_close`, `tl_drop` (to the host), all sent to one client with `Bridge.SendTo`; messages are an array of JSON-text strings Go never parses (design 2.2, 2.3).
- D17 (architect): quiet times: a room closes 30 s after its last session and agent call; Go stops the board host after 60 s with no session and no tl call (two looks 5 s apart); placeholders until measured (design 5.1, goal 9).
- D18 (architect): the old routes (`scene`, `take`) refuse a tl board with 409 `tl_board`; `follow` answers harmlessly; old boards' code paths are unchanged (design 4.1).

## Spike bb-spike-ui (`plans/better-board/spike-ui.md`, branch `bb-spike-ui`)

- U1 (orchestrator's spike): the spike pinned the same tldraw 5.6.0 (`tldraw` and `@tldraw/assets` exactly) and confirms the development-bundle rule above: seen in Chromium and Electron, a production `file://` page without a key shows tldraw's empty licence gate at 5 s; the dev bundle stays with its watermark.
- U2: the new board in the window is a second web target of the same kind as `board.js` (an IIFE defining a global with `mount(element, …)`, its own React root in a box of the app's page, fonts beside it; a one-file page for phones). No iframe. Checked beside Excalidraw in a copy of the app's web build and in Electron (spike-ui.md A, spike-ui-embed.md).
- U3: the sticky is a custom ShapeUtil `sticky` (7.2's fallback: tldraw's `note` grows instead of shrinking and resizes only by scale), with its own colour style prop `aiwb:sticky-color` (a shared `DefaultColorStyle` would make a sticky's last colour the next shape's colour). Shrink-to-fit is `fit.ts`, a pure function of a text measure, run in `onBeforeCreate/onBeforeUpdate` through `editor.textMeasure` (spike-ui.md D).
- U4: agrees with D2: tldraw's own IBM Plex Sans for every element; skia-canvas 4.0.0 measures its woff2 files exactly as Chromium does (spike-ui.md E). Give the fonts to tldraw as `data:` URLs in the web build too, or the window's image export falls back to a system font under `connect-src 'none'` (spike-ui-embed.md).

## tldraw version: 5.6.0, exact

- `tldraw` 5.6.0 and the matching `@tldraw/*` 5.6.0 (`@tldraw/editor`, `@tldraw/sync-core`, `@tldraw/tlschema`,
  `@tldraw/assets` for the font files), React 19.2.3 (the version the repository already has). Pinned exactly, no `^`.
- Who: `bb-spike-host` (the first package to add tldraw), 2026-11-08.
- Why: the latest stable release on npm that day (`latest` dist-tag 5.6.0; `next` is 5.7.0-next).
- Measured by the spike (`plans/better-board/spike-host.md`): tldraw 5.6.0's Editor, text measuring, SVG export and
  `TLSocketRoom` run in Node; see there for the DOM (linkedom recommended, jsdom fallback) and rasterizer (resvg) choices.

## Orchestrator, after both spikes

- O1: the agent edits through a room editor that is not a sync peer (D15) and writes with `room.updateStore` (measured to broadcast; resolves after the commit, so save-then-answer follows directly). The marker is the custom message of D11. Not the persistent peer of spike-host 6.2, because its `whenSettled()` reads private fields of `TLSyncClient`, and D15 keeps `apply` synchronous and atomic. (orchestrator)
- O2: consequence of O1: the window's `TLSyncClient` always runs with `presenceMode: 'full'` (never useSync's solo switch), so a lone window sees agent changes at ~35 ms and not tldraw's 1 fps solo rate. (orchestrator)
- O3: every room is loaded through the spike's `snapshotForRestore()` (clock shifted forward on load, risk 8.5). (orchestrator)
- O4: the board host runs the editor on linkedom (jsdom selectable as fallback, one module), measures with spike-host's `measure.ts`/`fonts.ts`, renders pictures by SVG export → `textToPaths` → resvg, capped at 2000 px on the long side. (orchestrator)
- O5: fonts: tldraw's own files from `@tldraw/assets` 5.6.0 (IBM Plex Sans for our elements), the same files in the window and the host; the window measures only once they are loaded. (orchestrator)

## Window lane

- W1 (window lane): the sticky's type name is `aiwb-sticky` (`STICKY_TYPE` in `palette.ts`; the util's `type` uses it); its tool id stays `sticky`.
- W2 (window lane): sticky colours are Miro's 16 (`light-yellow, yellow, orange, light-green, green, dark-green, cyan, light-pink, pink, violet, red, light-blue, blue, dark-blue, grey, black`), hexes from the UI spike (its `light-red` is `red`), `white` dropped, default `light-yellow`; `terms.ts`, `palette.ts`, `aiwb:sticky-color` and design 7.2 agree.
- W3 (window lane): a sticky's record has `fontSize: number` (0 = automatic, else fixed px) and `fitted: number` (drawn, output of the fit only); agent `"auto"` ↔ 0, a `Size` ↔ `STICKY_FONT_SIZES = { s: 16, m: 24, l: 32, xl: 48 }` (reading: nearest), `shownSize` ← `fitted`; default side 200.
- W4 (window lane): our geo extends tldraw's `GeoShapeUtil` with type `geo` and two style props, `fillColor` (`aiwb:fill-color`, tldraw's colour names, default white) and `labelSize` (`aiwb:label-size`, s/m/l/xl, default m), drawn through `getCustomDisplayValues`; `color` is the border, `size` the border width, `labelColor` the text; agent `fill: <Color>` → `fill: "fill"` + `fillColor`. The rounded rectangle is the custom geo value `rounded-rectangle`, added to `GeoShapeGeoStyle` by `model/styles.ts` so it validates in the schema.
- W5 (window lane): frames are `FrameShapeUtil.configure({ showColors: true })`.
- W6 (window lane): fonts are tldraw's own 16 woff2 of `@tldraw/assets` 5.6.0 (O5), listed once in `model/fonts.ts`; no font file is committed, the builds read them from `node_modules/@tldraw/assets/fonts/` (`tl.js` as `data:` URLs).

## Host lane (`bb-host`)

- H-1 (host lane): the board host's node runtime lives in `packages/board-host/src/node/` (page, fonts, measure, export,
  editor, runtime), not in `packages/board-tl/src/model/`: it needs skia-canvas, resvg and a DOM, which the window's bundle must
  not pull in. What the window shares is in the model: the font list (`model/fonts.ts`, which the host's `node/fonts.ts` reads)
  and the measuring corpus (`model/corpus.ts`, so the Chromium side runs the same cases).
- H-2 (host lane): the page is linkedom unless `AIWB_BOARDHOST_DOM=jsdom` (O4). It is installed by `src/node/install-page.ts`,
  the first import of `src/bin.ts` (and of every test that loads tldraw), so it exists before any tldraw module is evaluated;
  `page.ts` also makes tldraw's `BroadcastChannel` not hold the process. jsdom is **not shipped** in the bundle (a development
  fallback); asking for it in a bundle without it exits 3 with the reason.
- H-3 (host lane): the host takes the shared schema of the window lane as soon as it existed (commit `705bd472` of `bb-win-t1b`,
  merged alone): `src/schema.ts` imports `tlSchema` and `SHAPE_UTILS` from `@aiwb/board-tl/model`, so rooms and the room editor
  validate exactly what windows write. The host's tests load `.tsx` through an esbuild hook (`test/tsx-hook.ts`), as board-tl's.
- H-4 (host lane, O4 made concrete): `get_image` never refuses for size below a scale of 0.1: when (bounds + 2 × 32 px padding)
  × scale would exceed 2000 px on the long side, the scale is lowered to fit and the answer says so; `TOO_LARGE` only when that
  would need a scale below 0.1. Padding is tldraw's export default (32 px, a window's own export), not old boards' 16.
- H-5 (host lane): the board host's bundle is a development build of tldraw and React (`NODE_ENV=development`), as the
  orchestrator's licence decision says for `tl.js`; nothing it prints reaches stdout except through the log.
