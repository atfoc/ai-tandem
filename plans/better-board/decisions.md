# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.


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
