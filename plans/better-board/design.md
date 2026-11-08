# Better-board prototype: design

How the new board (tldraw) fits into this codebase. Written by the architect (branch `bb-arch`) for the implementers of
`better-board-prototype-goal.md` ("the goal"). Read `ORCHESTRATION.md` first. Section numbers of the goal are written
"goal 3.4"; decisions here are `D<n>` and are also listed, one line each, in `decisions.md`. Departures from goal section 7
are in `deviations.md`.

Line numbers refer to commit `86ae93f6`.

**Assumptions that depend on the spikes** are marked **[S-HOST]** (`bb-spike-host`: tldraw's Editor, `TLSocketRoom` and the
sync client in Node, text measuring with skia-canvas, SVG → PNG) and **[S-UI]** (`bb-spike-ui`: tldraw in the window with our
UI, and how it is embedded in the web build and the Electron window). Section 10 lists each one with its fallback.

**tldraw version.** Both spikes installed `tldraw@5.6.0` (with `@tldraw/sync-core`, `@tldraw/editor`, `@tldraw/tlschema`,
`@tldraw/assets` at 5.6.0, React 19.2.3, the same React the app pins). This design assumes 5.6.0. The first package that adds
tldraw to a workspace records it in `decisions.md`, pinned exactly.

---

## 0. The picture

```
 window A (page)                      window B (page)                Go server                         board host (Node)
 TlCanvas ─ tl view (tldraw)          …                              internal/tlrelay                  packages/board-host
   TLSyncClient ── TransportSocket                                    sessions, routes, counters        TLSocketRoom per open board
                    │  (core TlLink: batching, reopen)                                                   proxy socket per session
                    ▼                                                                                    room editor (Node) for agents
 transport.call  POST /api/tl/{id}/open|sync|close  ───────────────▶  SendTo(host, tl_open|tl_sync|tl_close) ──▶ stream event
 transport.stream ◀── tl_sync / tl_closed (SendTo the window) ◀─────  POST /api/tl-host/out  ◀──────────────────── one call in flight
                                                                      GET|PUT /api/tl/{id}/snapshot ◀─────────── load / save
 MCP agent ──────────────────────────────────────────────────────▶  boardapi: kind=="tl" → tlrelay.CallTool ─▶ rpc (bridge, Client=host)
                                                                                                               ◀── POST /api/rpc-reply
```

- The page never opens a socket (goal 4.6). Everything rides on the existing transport: a **call** for what the page sends and a
  **stream event** for what it receives. The desktop main process and the test host forward both without change, because
  neither filters routes or events (the conn module filters routes, and its `routes.json` gets the new rows).
- The board host is a client of the client API, like the headless writer: the same secret, its own client id, its own event
  stream. Go relays sync messages between a window's session and the host as opaque strings (goal 4.7, 7.4).
- Agent tools on a new board go to the board host as `rpc` events on its stream, answered with the existing
  `POST /api/rpc-reply`. They never go to a window, except `get_view` and `show_board` (goal 4.4).

---

## 1. Package layout (goal 7.1)

### 1.1 New and changed places

| Where | New / changed | Owns |
|---|---|---|
| `packages/board-tl/` (`@aiwb/board-tl`) | **new** | tldraw in the window **and** the shared model. `src/model/`: the one schema and shape definitions (window and host), the palette, the fonts list, the agent terms, `apply`/`read`/`validate`. `src/view/`: the React UI (navigation, main toolbar, contextual toolbar, agent marker, cursors' names), `TransportSocket` (a `TLPersistentClientSocket` over core's `TlLink`), the `TLSyncClient` setup. `src/web/entry.tsx`: the IIFE entry `window.aiwbTlView`. `build.mjs`: the web bundle into `app/public/tl/`. `fonts/`: the font files both sides use. |
| `packages/board-host/` (`@aiwb/board-host`) | **new** | The board host process. `src/bin.ts` (entry), `src/main.ts` (stdin config, start, exit), `src/link.ts` (stream events in, `out` batches), `src/rooms.ts` (one `TLSocketRoom` per open board, proxy sockets, load, throttled save, quiet close), `src/agent.ts` (the `rpc` tools on a room editor, save before the answer, the agent marker), `src/node/` (the stand-in page, text measuring, SVG → PNG: what S-HOST proves), `build.mjs` → `dist/boardhost.mjs` + `dist/assets/` + `dist/manifest.json`. |
| `packages/headless/` | reused, unchanged | The board host imports its `memstore.ts`, its config parsing (`main.ts` `parseConfig`, `entryOf`, `redact`) and its `makeClient` pattern (`bin.ts`) through the workspace (`"exports": {"./*": "./src/*"}`). If an import needs a small export added there, that is the only change allowed in the package. |
| `packages/board-engine/` | reused, unchanged | `src/page.ts`, `src/canvas.ts` and `src/skia-binary.ts` are generic enough to copy from or import (S-HOST decides). Its Excalidraw parts are not used. |
| `packages/core/` | changed | `types.ts` `Board.kind`; `api.ts` (`newBoard` with a kind, the three `tl` calls); `src/tl/link.ts` (**new**: `TlLink`: one session, batching, reopen); `src/tl/registry.ts` (**new**: routes `tl_sync`/`tl_closed` events to links, keeps the window's tl handles for `get_view`/`show_board`); `state/conn.ts` (two `case`s and one branch in `answer`). |
| `packages/conn/` | changed | `core/routes.json` (the new rows), `core/calls.js` (body limits and the start-time limit for the new routes). |
| `app/` | changed | The board screen branches on the kind; a tile to create a new board; a mark on new boards in lists; `public/index.html` and `scripts/export-web.mjs` load and build `tl.js`. Section 6 names the files. |
| `internal/tlrelay/` (Go) | **new** | Sessions, the `tl` routes' handlers, the board host's link, agent calls to the host, the host's lifecycle adapter, counters and status. |
| `internal/headless/` (Go) | changed, small | The `Manager` takes the program's file name, the bundle folder's name and a display name as options, so a second manager runs the board host. The headless writer's behaviour does not change. |
| `internal/editorbridge/` (Go) | changed, small | `CallSpec.Client` and `CallSpec.Lost`; an `OnEnd` hook when a client's stream ends. |
| `internal/model`, `internal/boards` (Go) | changed | `Board.Kind`; create with a kind; the snapshot file; old routes refuse a tl board. |
| `internal/server` (Go) | changed | Mounts the `tl` routes; `POST /api/boards` takes `kind`; take/scene refuse a tl board. |
| `internal/boardapi`, `internal/boardtools` (Go) | changed | Routing by kind, `create_board` with a kind, the tool texts. |
| `internal/app` (Go) | changed, small | Tells `tlrelay` when a board is archived or deleted. |
| `cmd/ai-whiteboard` (Go) | changed | Flags, wiring of the second manager and `tlrelay`, status. |
| `desktop/`, `web/dev/host.mjs` | **unchanged** | They forward every call and event already (desktop `ipcface.js:114-131`, host `hostface.mjs:95-110`); the route check is conn's. |

### 1.2 One engine (goal 7.1 `[standing]`)

- **D1.** `packages/board-tl/src/model/` is the only place where shapes, bindings, style props and the schema are defined.
  The window imports it (bundled into `tl.js`), and the board host imports it (bundled into `boardhost.mjs`). Both build the
  tldraw store with `createTLSchema({ shapes: …, bindings: … })` from `model/schema.ts`, and both use the same `ShapeUtil` classes
  from `model/shapes/` (they include the React `component()`/`toSvg()`, which the host needs for its SVG export; this is fine
  because the host bundles React too **[S-HOST]**).
- `model/` imports `tldraw`/`@tldraw/editor` and nothing of `view/`, of the DOM beyond what tldraw itself needs, or of the app.
  `view/` may import `model/`; `board-host` imports only `model/`.
- The agent terms (`model/terms.ts`), their validation (`model/validate.ts`), the mapping from records to terms
  (`model/read.ts`) and the ops on an `Editor` (`model/apply.ts`) live in `model/` too. So the window can use `read.ts` for
  `get_view`, and unit tests run them in Node.
- The fonts: `packages/board-tl/fonts/` holds the files. `tl.js`'s build copies them into `app/public/tl/fonts/` and declares
  them with `@font-face`; the board host's build copies the same files into `dist/assets/fonts/` and registers them with
  skia-canvas. `model/fonts.ts` names them once (family → file → weight/style), and both builds read that list. Goal 9 leaves
  the choice of fonts open: **D2** (recommendation) use tldraw's own sans (the `sans` font family's files from
  `@tldraw/assets`) for every element, so there is one family to measure and match; the spikes may change it.

### 1.3 How the board host bundle is built and found

- **D3.** The board host is a **separate process** from the headless writer, started by a **second instance** of
  `internal/headless.Manager` with other options. One process for both would put the old boards' writer at risk (goal 4.3),
  and the two have different lives (the headless writer holds boards for agents; the board host holds rooms for windows and
  agents).
- `packages/board-host/build.mjs` (esbuild, `platform: "node"`, `format: "esm"`, `target: "node22"`, the `createRequire` banner of
  `packages/headless/build.mjs`, externals: `skia-canvas` and `@resvg/resvg-js` if S-HOST uses it) writes:
  - `dist/boardhost.mjs`;
  - `dist/assets/` (the fonts of `model/fonts.ts`, `node_modules/skia-canvas/…` and any other native module, as
    `copyEngineAssets` does it today);
  - `dist/manifest.json` `{version, os, arch}`, the same format as the headless bundle's.
- Go finds it with the headless writer's rules (`internal/headless/find.go`), parameterised (G3 below):
  - Node: `-boardhost-node` (or `AIWB_BOARDHOST_NODE`), else the same lookups as the headless writer (Electron of the app, `node`
    ≥ 22 on `PATH`).
  - Bundle: `-boardhost-dir`, else `<exe>/../Resources/boardhost/`, `<exe>/boardhost/`, `<exe>/resources/boardhost/`.
  - The file is `boardhost.mjs`. The manifest version check is the same (`dev` takes any).
- The handshake is the headless writer's: one JSON line on stdin (D27), and the process opens its event stream only when it can
  work. The manager waits for that stream (`Bridge.Known`).
- **Licence (orchestrator's decision, `licence.md`).** Both bundles are **development** builds of tldraw: `tl.js` is built with
  `process.env.NODE_ENV = "development"` (a production `file://` page without a key goes blank after 5 s in the Electron window),
  and so is `boardhost.mjs`. Nothing touches tldraw's licence check or watermark (goal 4.2). The rest of the app's web export
  stays a production build; only `tl.js` differs.
- Development and the checks of the prototype: `-boardhost-dir packages/board-host/dist -boardhost-node "$(command -v node)"`.
  Packaging the board host into the Mac app and `build-server.sh` is out of scope for the prototype (the findings report says
  what it would take: the same `extraResources` entry as `headless/`).

---

## 2. The multiplayer relay (goal 7.4, 4.6, 8.4)

### 2.1 Sessions

A **session** is one window showing one new board. It has an id made by Go (`"s_" + 16 random base36 chars`), the board id, and
the window's client id (`X-AIWB-Client` of the call that opened it). The session id is also the `sessionId` the board host gives
`room.handleSocketConnect`.

- **Open.** The window calls `POST /api/tl/{id}/open` when it shows a new board (the tl view mounts), and again after every
  close it did not ask for.
- **Close.** The window calls `POST /api/tl/{id}/close` when the board leaves its screen (the tl view unmounts).
- **Also closed by Go:**
  - when the window's stream ends or is replaced (the `OnEnd` hook, D9): the window learns it from its own stream's state and
    reopens;
  - when the board host's stream ends: every session gets `tl_closed {reason: "host_stopped"}`;
  - when the board is archived or deleted: `tl_closed {reason: "archived" | "deleted"}`;
  - when the host closes it (`closed` in an `out` call, e.g. tldraw rejected the client): `tl_closed {reason}` with the host's
    reason.
- **D4.** Sessions are in Go's memory only. A server restart closes them all, as it ends every stream.

### 2.2 Routes (client API)

Every route below goes through `ClientHandler` (secret, Host, client id, level ≥ 7) like the others. The board id must name a
board whose kind is `tl`, else `409 {"code":"not_tl"}`; an unknown board is `404`.

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /api/tl/{id}/open` | a window | `{}` | `200 {"session":"s_…"}`. Starts the board host if it is not running and waits until its stream is open (D26). `503 {"code":"board_host_unavailable","error":"<reason>"}` when it cannot run. `409 {"code":"archived"}` for an archived board. **As built:** `409 {"code":"no_stream"}` when the calling client has no event stream open (the window opens again once its stream is up); see 2.8. |
| `POST /api/tl/{id}/sync` | a window | `{"session":"s_…","messages":["<text>", …]}` | `200 {"ok":true}`. `410 {"code":"no_session"}` when the session is unknown, closed, of another client or of another board: the window then reopens. |
| `POST /api/tl/{id}/close` | a window | `{"session":"s_…"}` | `200 {"ok":true}`, also for an unknown session. |
| `POST /api/tl-host/out` | the board host only | `{"out":[{"session":"s_…","messages":["<text>", …]}], "closed":[{"session":"s_…","reason":"<text>"}]}` (either list may be absent) | `200 {"gone":["s_…", …]}`: the sessions of `out` that Go no longer knows (the host closes them in its room). `403 {"code":"not_board_host"}` from any other client. |
| `GET /api/tl/{id}/snapshot` | the board host only | — | `200` with the stored snapshot (JSON, `Content-Type: application/json`), or `204` when the board has none yet (a new board: the host starts an empty room). `403 not_board_host`. |
| `PUT /api/tl/{id}/snapshot` | the board host only | the snapshot JSON | `200 {"ok":true}`. Written atomically (`store.WriteFileAtomic`). Allowed on an archived board (a last save may arrive after an archive). `404` after a delete. `400` when the body is not valid JSON (Go checks `json.Valid` and nothing else). `403 not_board_host`. |

- `messages` is an array of **strings**: each one is one tldraw protocol message as JSON text, made by tldraw's side
  (`JSON.stringify` of the message object). Go reads the request into a struct with `Messages json.RawMessage` and puts those
  bytes into the event as they are: it never parses or looks into them (goal 4.7, 7.4 "opaque bytes"). Go checks only that the
  field is present and its first byte is `[`.
- **Limits.** The conn module's body limit is 2 MiB for a JSON body (`packages/conn/core/calls.js:14`). The new routes get their
  own limits there and in Go's `MaxBytesReader`:
  - `POST /api/tl/{id}/sync` and `POST /api/tl-host/out`: 32 MiB (the size of the largest stream event conn accepts, `MAX_STATE`
    in `text.js:10`);
  - `PUT /api/tl/{id}/snapshot`: 128 MiB (as `PUT scene`).

  A message over these limits fails its call. That is acceptable for the prototype, and the report says so.
- **Start time.** `POST /api/tl/{id}/open` may wait for a cold start of the board host (seconds). It goes into conn's `START` set
  (`calls.js:25`), which gives it the `start` time limit and not the 15 s of an ordinary call.
- **Level.** No feature-level change (D5): the routes are new and only this branch's app calls them. A release would raise the
  level (the findings report says so).

### 2.3 Stream events

| Event | To | Shape |
|---|---|---|
| `tl_sync` | the window of the session | `{"type":"tl_sync","board":"<id>","session":"s_…","messages":["<text>", …]}` |
| `tl_closed` | the window of the session | `{"type":"tl_closed","board":"<id>","session":"s_…","reason":"host_stopped"\|"archived"\|"deleted"\|"<host's reason>"}` |
| `tl_open` | the board host | `{"type":"tl_open","board":"<id>","session":"s_…"}` |
| `tl_sync` | the board host | `{"type":"tl_sync","board":"<id>","session":"s_…","messages":["<text>", …]}` (the same shape both ways) |
| `tl_close` | the board host | `{"type":"tl_close","board":"<id>","session":"s_…"}` |
| `tl_drop` | the board host | `{"type":"tl_drop","board":"<id>","reason":"archived"\|"deleted"}`: close the room; save it first for `archived`, drop it unsaved for `deleted` |

- Every one of them goes to **one** client, with `Bridge.SendTo(clientID, ev)` (`bridge.go:467`), which queues the event on that
  client's stream and never blocks. It is not a follower event: a window does not get its own messages back, and windows that
  do not show the board get nothing. `SendTo` does not consult the events table (`events.go`), so the table needs no new rows.
  Add the four type names to the table's comment so the next reader finds them.
- In the page, `state/conn.ts` `onEvent` gets two `case`s, `tl_sync` and `tl_closed`, which call
  `tlRegistry().event(server, m)` (C1). They are not in `OF_A_THING`, so a remote section without a tree still delivers them.

### 2.4 Batching and backpressure

No layer drops a message (D6). Order is kept per session in every hop. Batching comes from **one call in flight** per sender,
with a short minimum interval:

- **Page → Go** (`TlLink`, core):
  - It keeps a queue per session.
  - When the queue is non-empty, no `sync` call is in flight, and at least `SEND_GAP` (25 ms) has passed since the last call
    started, it sends everything queued in one call.
  - While a call is in flight, new messages wait and go together in the next call.
  - A `410` or a transport failure ends the session (status `offline`): the link reopens (2.5).
  - A queue above 5,000 messages or 16 MiB also ends the session. It should never happen, and the reopen gives a clean state.
- **Go → host.** One `tl_sync` event per `sync` call. The host's stream buffer (4,096 events, `bridge.go:222`) is bounded by one
  call in flight per session, so it cannot fill in practice.
- **Host → Go** (`link.ts`):
  - The same rule: one `POST /api/tl-host/out` in flight, at least `SEND_GAP` (25 ms) apart, carrying every session's queued
    messages and closes.
  - The proxy socket's `send(text)` only appends to the session's queue.
- **Go → window.** One `tl_sync` event per session per `out` call, so at most about 40 events a second per window.
  - A window whose stream stalls fills its 4,096-event buffer after about 100 s. The bridge then closes that stream
    (`sendRawLocked`, `bridge.go:861`), which is the existing behaviour.
  - The `OnEnd` hook closes the window's sessions, and the window reopens when its stream is back.
- **Presence.** tldraw throttles presence itself: the sync client sends pushes at most once per animation frame. Neither the
  page nor the host coalesces presence-only pushes, because a dropped `push` would leave the client waiting for its
  `push_result`. If the measurement of 8.4 shows the cursor traffic is too heavy, the remedy is a larger `SEND_GAP` for the
  page, which batches more cursor moves into one call. It is not dropping.
- `SEND_GAP` is a constant in each place. Tests pass their own.

### 2.5 The window's sync socket and reconnection

The tl view runs tldraw's `TLSyncClient` itself (not `useSync`, which wants a WebSocket URL) with a `TransportSocket` that
implements `TLPersistentClientSocket` (`@tldraw/sync-core`, `index.d.mts:586`) over core's `TlLink`:

```ts
// packages/core/src/tl/link.ts — platform-free, no tldraw import. One per mounted tl view.
export type TlLinkStatus = "connecting" | "online" | "offline";
export interface TlLink {
  readonly status: TlLinkStatus;
  send(messages: string[]): void;                                // queued; batched as in 2.4
  onMessages(cb: (messages: string[]) => void): () => void;      // from tl_sync events of this link's session
  onStatus(cb: (s: TlLinkStatus, reason?: string) => void): () => void;
  restart(): void;                                               // close the session (if any) and open a new one
  close(): void;                                                 // POST close; no reopen; the link is finished
}
export function openTlLink(board: string /* the board key */, deps?: TlLinkDeps /* api + timers, for tests */): TlLink;
```

- **Opening.** `openTlLink` opens at once (`connecting`); `open` answered → `online`.
- **Closing.** A close it did not ask for (`tl_closed`, a `410`, a failed call, the stream of this server closed or reopened)
  → `offline`, then a reopen after 0.5, 1, 2, 5, 5… s. Each answered `open` → `online`.
- **The server's stream.** The registry tells every link of a server when that server's stream goes down or comes back.
  "Stream reopened" counts as a close, because Go's `OnEnd` closed the old session.
- **`TransportSocket`** (in `board-tl/src/view/socket.ts`):
  - `connectionStatus` follows the link: `connecting` → `offline`, `online` → `online`, `offline` → `offline`.
  - `sendMessage(msg)` → `link.send([JSON.stringify(msg)])`.
  - `onReceiveMessage` → `JSON.parse` of each string.
  - `restart()` → `link.restart()`.
  - When the status turns `online`, `TLSyncClient` sends its `connect` message, as it does on a WebSocket open.
- **The board host restarted from an older save** (risk 8.5). In `TLSyncRoom`'s connect, a client whose `lastServerClock` is
  ahead of the room's clock gets `sinceClock = -1` and a full "wipe all" state
  (`InMemorySyncStorage.getChangesSince`, `sync-core/dist-esm/lib/InMemorySyncStorage.mjs:288-296`).
  - So a reconnecting window gets the room as it was saved.
  - Its unacknowledged local changes are rebased and pushed again by `TLSyncClient`. **[S-HOST]** confirms this. The prototype
    reports what happens to edits made while cut off (goal 3.4).
- **What the window shows.** The tl view shows a small "Reconnecting…" pill while the link is not `online` (goal 6.6).

### 2.6 Where each piece lives

| Piece | Go | Page / Node |
|---|---|---|
| routes `open`, `sync`, `close` | `internal/tlrelay/routes.go` (handlers), mounted in `internal/server/server.go`, rows in `ClientRoutes` (`clients.go:62`) and `wantRoutes` (`clienthandler_test.go:231`) | `packages/conn/core/routes.json` (same order as `ClientRoutes`), `calls.js` limits; `packages/core/src/api.ts` `tlOpen`/`tlSync`/`tlClose` |
| routes `out`, `snapshot` | `internal/tlrelay/routes.go` | the same rows in `routes.json`; called by `packages/board-host/src/link.ts`, `rooms.ts` through the conn client |
| events | `internal/tlrelay` → `Bridge.SendTo` | `packages/core/src/state/conn.ts` → `src/tl/registry.ts`; the board host's `link.ts` |
| session table | `internal/tlrelay/sessions.go` | — |
| batching | — | `core/src/tl/link.ts`, `board-host/src/link.ts` |
| socket for tldraw | — | `board-tl/src/view/socket.ts` (window), `board-host/src/rooms.ts` proxy sockets (host) |

The desktop main process (`desktop/ipcface.js`) and the test host (`web/dev/hostface.mjs`) need no change. The test host is
HTTP/1.1, so a page has at most about five calls at once there. One call in flight per session fits. `web/dev/mock.mjs` has
its own route list; the prototype adds nothing there unless `cd web && npm test` requires it.

### 2.7 Go: `internal/tlrelay`

```go
package tlrelay

// Host is what tlrelay needs of the board host's process manager (a *headless.Manager made with the board host's options).
type Host interface {
	Ensure(ctx context.Context) (clientID string, err error)
	CallTimedOut()
	Status() headless.Status
}

// Bridge is what tlrelay needs of the editor bridge.
type Bridge interface {
	SendTo(clientID string, ev any) bool
	CallBoard(spec editorbridge.CallSpec, timeout time.Duration) (json.RawMessage, error)
	Known(clientID string) bool
	HasCalls(clientID string) bool
}

// Boards is what tlrelay needs of the board store.
type Boards interface {
	Get(id string) (model.Board, bool)
	SnapshotAt(id string) ([]byte, bool, error)  // bool: a snapshot exists
	SaveSnapshot(id string, body []byte) error
}

type Relay struct { /* bridge, boards, host, mu, hostID string, sessions map[string]*session, lastAgentCall time.Time, counters */ }

func New(b Bridge, bs Boards, quiet time.Duration, logf func(string, ...any)) *Relay
func (r *Relay) SetHost(h Host)                      // set once, after the manager is made
func (r *Relay) Mount(mux interface{ HandleFunc(string, func(http.ResponseWriter, *http.Request)) }, clientHeader string)
func (r *Relay) ClientEnded(clientID string)         // the bridge's OnEnd hook
func (r *Relay) BoardGone(id, reason string)         // archive ("archived") or delete ("deleted")
func (r *Relay) CallTool(c ToolCall) (json.RawMessage, error)    // section 3
func (r *Relay) ScreenClient(board string) (clientID string, ok bool) // the window with the newest open session on board
func (r *Relay) HostAdapter(b *editorbridge.Bridge) headless.Bridge  // for the manager: see 5.1
func (r *Relay) Status() Status                      // for `status -json` "boardhost"
```

- The host's client id is set through the adapter's `SetAway(id)` (the manager calls it before the start, as for the headless
  writer). A call to `out` or `snapshot` is from the board host when its `X-AIWB-Client` equals that id.
- `ClientEnded(id)`:
  - `id` is the host: forget it, and send `tl_closed {reason:"host_stopped"}` for every session, then drop them all.
  - Otherwise: drop that window's sessions and send `tl_close` to the host for each.
- All of tlrelay's state is under its own mutex. It calls the bridge only with that mutex released, or through the bridge's
  methods that take the bridge's lock (never from inside the bridge's lock: `ClientEnded` is called by the bridge after it
  unlocks, D9).

### 2.8 As built by the Go lane (differences from 2.2–2.7, 3.1–3.4, 5.1)

Branch `bb-go`. Everything of 2.2–2.7 holds except what this list says. Other lanes: the items marked **(client)** change what a
window or the board host sees.

- **`open` refusals (client).** Besides 2.2's answers: `409 no_stream` when the caller has no event stream open (a session
  nobody could be told about, which no `OnEnd` would ever drop); `404 not_found` / `409 archived` also when the board was deleted
  or archived while the board host was starting (the session is closed again; the host sees `tl_open` then `tl_close`). The window
  treats all of them as a failed open and reopens later; for `archived`/`not_found` it may stop.
- **Other error answers (client).** Every refusal is `{"code","error"}`. A body over its limit is `413 too_large`; an unreadable
  body or bad JSON `400 bad_request`; `messages` not an array `400 bad_request`; an invalid snapshot `400 bad_json`; no client id
  `400 bad_request`. Host-only routes check the host first (`403 not_board_host`), then the board (`404`/`409 not_tl`). `open` and
  `close` accept an empty body.
- **`sync` on a dead host (client).** When the session's host is no longer the current one or has no stream, `sync` answers `410
  no_session` and Go drops the session (the window reopens).
- **`out` (client: host).** A session whose window's stream is gone is dropped and listed in `gone`.
- **The host's id belongs to the manager.** `ClientEnded(host)` closes the sessions opened with that host (`tl_closed host_stopped`
  to their windows) but does **not** forget the host's id: the board host's stream can end while its process lives on and reconnects
  with the same client id. If the host is still `Known` at that moment (a replaced stream), it is also sent `tl_close` for each of
  those sessions. The id is set by the adapter's `SetAway(id)` before the start and cleared only by `SetAway("")` in the manager's
  `reap`, after the process exited, so the host's last saves during its shutdown are accepted. `tl_drop` is sent only to a host that
  is `Known`.
- **Locks.** One mutex in the relay; order `headless manager → relay → editor bridge`. The relay sends a session's events in the
  same critical section as the session-table change (so `tl_open` precedes every `tl_sync`, nothing follows `tl_close`/`tl_closed`),
  and never calls `CallBoard` or the `Host` while holding its mutex.
- **`CallSpec.Client` (G2).** The call goes to that client only and is recorded as being about no board: no hand-off fails it,
  a timeout returns `ErrTimeout` and takes nothing, and `Away` is ignored. On a `Screen` spec it names the window, in place of the
  lookup by `ChatBoard`. `CallSpec.Lost` applies to any call whose client's record ends. `Bridge.OnEnd` also fires for records
  ended by `CloseAll`; once per record, always after the bridge's unlock, on the stream's goroutine (never inside `SendTo`).
- **`tlrelay.ToolCall`.** `type Agent struct{ Kind, Label string }`; `type ToolCall struct{ Chat, Branch, ChatBoard, Board, Tool
  string; Args any; Agent Agent }`; params sent `{"chat","branch","board":ChatBoard,"target":Board,"name":Tool,"args","kind":"tl",
  "agent"}`. `CallTool`'s error text is the agent's whole text (`HostStoppedText`, `TimeoutText`, `UnavailableText(reason)`, or the
  host's own `"CODE: text"` unchanged); the errors unwrap to `ErrHostLost`, `editorbridge.ErrTimeout`, `headless.ErrUnavailable`.
  The log line has no rpc id (`CallBoard` does not return it): `tl: <tool> board=<id> chat=<id> -> board host <ok|error CODE|lost|
  timeout|unavailable> <ms>ms`.
- **`tlrelay.Status`** `{available, reason, running, pid, sessions, calls: {<tool>: {ok, error, lost, timeout, unavailable}},
  screenCalls}`; `status -json` puts it under `running.boardhost` (null from a server that does not tell); the human status prints
  `Board host: running (pid N, S sessions) | available, not running | not available: <reason>`.
- **Agent routing (3.1).** Go refuses mixed terms before asking anyone: on a tl board an `apply` with `create`/`update` →
  `BAD_ARGS: this is a new board; use ops (see the tool description)`; on an old board an `apply` with `ops` → `BAD_ARGS: this is a
  classic board; use create and update (see the tool description)`. `ops` missing on a tl board is the host's to answer. The
  marker's label names the agent that calls (a Cursor subagent in a Claude chat is "Cursor"). A screen call on a tl chat board that
  finds no window gets `screenText` also on a server without a background editor. `create_board` with another `kind` →
  `BAD_ARGS: kind is "new" or "classic"`.
- **`internal/headless` options (G3).** `Options.Program`, `Folder`, `Name` and also **`NodeEnv`** (the variable read when `Node` is
  empty; the board host's manager uses `AIWB_BOARDHOST_NODE`). The flags named in reasons follow `Folder` (`-boardhost-node`,
  `-boardhost-dir`); the process's output lines are prefixed `boardhost:`.
- **Wiring (G6).** Flags `-boardhost-node` (else `AIWB_BOARDHOST_NODE`), `-boardhost-dir`, `-boardhost-quiet` (60 s, Go's process
  quiet). Room quiet 30 s (the manager's `Quiet`, sent as `quietMs`). `quiet=` of `AIWB_TEST_WAITS` sets the process quiet to its
  value and the room quiet to half of it. `App.BoardGone` is called only for tl boards, after the store's change, also for boards
  archived or deleted with their group. The six routes are also in `web/dev/mock.mjs`'s route list and the level-5 contract table.
- **Boards (G1).** `boards.ErrBadKind`, `ErrNotTL`, `ErrTLBoard`, `ErrBadSnapshot`; `Service.IsTL(id)`. `internal/server` maps
  `ErrTLBoard`→409 `tl_board`, `ErrNotTL`→409 `not_tl`, `ErrBadKind`→400 `bad_kind` for every route.

---

## 3. Agent routing (goal 4.4, 3.5, 6.3, 7.6)

### 3.1 Where the kind is read

In `internal/boardapi/mcp.go` `CallResult`, after the board lookup (`:150-160`) and before the `CallSpec` is built (`:166`):

```go
// a new board: its calls go to the board host, never to a window (goal 4.4)
if !screen && bd.Kind == model.KindTL {
	return r.tlTool(caller, tool, target, args)
}
```

- `r.TL` is a new field of `Relay`, an interface `TLCaller { CallTool(tlrelay.ToolCall) (json.RawMessage, error);
  ScreenClient(board string) (string, bool) }`. With `TL == nil` (it never is in the prototype's server), a tl board answers
  `NOT_SUPPORTED: this server cannot edit new boards`.
- `tlTool` builds `tlrelay.ToolCall{Chat, Branch, ChatBoard, Board: target, Tool, Args, Agent: {Kind, Label}}`, calls
  `r.TL.CallTool`, and turns the answer into the MCP result with the existing `pageResult` (`image.go:38`). The answer is either a
  JSON string (text) or `{text, image: {mimeType, data}}`, as today, so pictures, the Cursor file path and the size limits work
  unchanged.
- `Agent.Label` is the chat's agent kind as a person reads it: "Claude", "Cursor" or "pi" (`model.ChatMeta.Agent`,
  `model.go:224`). It names the agent's marker (section 8).
- **`list_boards`** (`listBoards`, `mcp.go:283`) adds `  (new board)` to the line of a tl board.
- **`create_board`** (`createBoard`, `mcp.go:313`) reads an optional `kind`, `"new"` or `"classic"` (absent: `"classic"`, so
  every agent prompt and test of today keeps its meaning). It calls `Boards.Create(name, group, true, kind)`. Its answer says
  `created <name> (<id>) in <group>, a new board`. The agent-facing word is "new board"; the stored value is `tl` (D7).
- **Screen calls.** `get_view` and `show_board` keep their `Screen` spec. When the chat's board is a tl board, `CallResult` asks
  `r.TL.ScreenClient(meta.Board)`:
  - If there is a window, the spec gets `Client: <that window>` and goes through `CallBoard` as today.
  - If there is none, the call falls through to `screenLocked`, which finds nobody for a tl board (no window holds or follows
    it), so the agent gets the existing plain-word `screenText`.

  `show_board` whose `board` argument names a tl board while the chat's board is an old one goes to the window that shows the
  chat's board, as today; that window handles a tl target (C1).
- The old paths do not change for old boards. A tl board never reaches `routeToAway` and never makes the headless writer start.

### 3.2 Go → board host: the request and the answer

`tlrelay.CallTool`:

1. `host.Ensure(ctx)` with the call timeout (30 s, `callTimeout`). A failure → the error `board_host_unavailable`, and the agent
   reads `UNAVAILABLE: the board host could not start: <reason>. New boards cannot be read or changed until it can; tell the
   user.`
2. `bridge.CallBoard(CallSpec{Method: "tool", Params: p, Board: c.Board, Client: hostID, Lost: ErrHostLost}, callTimeout)` with
   these params (the same keys as a window's `rpc` today, plus `kind` and `agent`):

   ```json
   {"chat":"c_…","branch":"main","board":"<chat's board>","target":"<board>","name":"apply","args":{…},
    "kind":"tl","agent":{"kind":"claude","label":"Claude"}}
   ```

   The host answers with `POST /api/rpc-reply {"id":"rpc_…","result":<string | {text,image}>}` or `{"id":…,"error":"CODE: text"}`.
   An `error` becomes the agent's error text, as for a window. (`ReplyFrom` already accepts the reply only from the asked
   client.)
3. It records the time of the call (for the host's quiet time, 5.1) and counts the outcome (3.4).

### 3.3 When the board host dies during a call

- The host's stream ends → the bridge's `endLocked` fails the host's open calls. With `CallSpec.Lost` set, a call fails with
  that error instead of `ErrNoClient` (G2). `ErrHostLost`'s text for the agent:
  > `HOST_STOPPED: the board host stopped while it ran this call, so the call did not finish. The board is as it was after your
  > last finished change. Read the board again before you change it.`
- A call with no answer in 30 s: `CallBoard` returns `ErrTimeout` (the host is no window, so it keeps nothing to lose); `tlrelay`
  calls `host.CallTimedOut()`, which kills the process (the headless writer's rule), and the agent reads
  `TIMEOUT: the board host did not answer in 30 s and was restarted. Read the board again before you change it.`
- The next call starts a new process (`Ensure`). A start failure is remembered for 60 s, as for the headless writer.

### 3.4 Proof that every call was answered by the board host (goal 6.3)

- `tlrelay` keeps counters, shown in `ai-whiteboard status -json` under `"boardhost"`:
  `{"available","reason","running","pid","sessions":n,"calls":{"<tool>":{"ok":n,"error":n,"lost":n,"timeout":n,"unavailable":n}},"screenCalls":n}`.
- Each tool call logs one line:
  `tl: <tool> board=<id> chat=<id> -> board host <rpc id> <ok|error CODE|lost|timeout> <ms>ms`.
- A guard makes "never a window" observable as well as true by construction. `CallBoard` with `Client` set refuses to send to
  any other client: the call fails with `ErrNoClient` if that client is gone. It never falls back to a holder or follower.
- The checks of 6.3 read the counters before and after, and grep the log for `-> board host`.

### 3.5 What the board host answers

| Tool | Answer |
|---|---|
| `read_board` | Section 7.3 output. |
| `apply` | `ops` (7.2). Answers 7.4. Saved before the answer. |
| `delete_elements` | `refs: [{"id"}\|{"key"}]` → the same as an `apply` of `delete` ops (cascade is ignored: a connector whose element goes keeps a free end). Saved before the answer. |
| `get_image` | Scopes `all`, `refs`, `rect` (as today's arguments); `selection` → `NO_SELECTION: no window's selection is known to the board host; use scope all, refs or rect`. A frame named in `refs` is drawn **with** what it holds (unlike Excalidraw's, so "a picture of the frame" is one ref). Limits and codes as today (`TOO_LARGE`, `EMPTY`, `RENDER_FAILED`, `BAD_ARGS`, `UNKNOWN_REF`). The answer `{text: "scope … bounds x,y,w,h … n elements", image: {mimeType: "image/png", data}}`. |
| `get_view`, `show_board` | Never sent to it. If one arrives: the plain words of the headless writer (`packages/headless/src/texts.ts`). |
| `list_boards`, `create_board` | Answered by Go (3.1). |

---

## 4. Storage (goal 7.7, 3.6)

### 4.1 Files

- **D7.** `model.Board` gets `Kind string \`json:"kind,omitempty"\``. Constants: `KindClassic = ""` (every board of today,
  whose `board.json` is not changed) and `KindTL = "tl"`. The TypeScript mirror in `packages/core/src/types.ts` gets
  `kind?: "tl"`.
- A tl board's folder `boards/<id>/` holds `board.json` (with `"kind":"tl"`) and, once the host saved it, `snapshot.tl.json`
  (`store.Paths.BoardSnapshot(id)`, new). It has no `drawing.excalidraw` and no `scene.rev`.
- `boards.Service.Create(name, group string, isNew bool, kind string)`:
  - It writes no content for a tl board. Go does not write tldraw records (goal 4.7), and a missing snapshot means an empty room.
  - Every existing caller passes `KindClassic`.
- `SnapshotAt(id) (raw []byte, exists bool, err error)` and `SaveSnapshot(id, body)`:
  - They are valid only for a tl board (`ErrNotTL` otherwise).
  - `SaveSnapshot` checks `json.Valid` and writes atomically. It does not check the archive flag (2.2).
- **The old routes refuse a tl board.** `GET`/`PUT /api/boards/{id}/scene` and `POST /api/boards/{id}/take` answer
  `409 {"code":"tl_board"}`, and `SceneAt` and `SaveAt` return `ErrTLBoard`, so no old code path can treat a tl board as
  Excalidraw. `follow`/`unfollow` keep working on a tl board and change nothing (a harmless answer
  `{"rev":0,"writer":""}`), because the board side of an old window may still call them.
- **The board's metadata** (rename, move, archive, delete, groups, `new`) is the same code for both kinds.

### 4.2 Who writes, and when

- **D8.** The board host decides when to save. Go does the writing (`PUT /api/tl/{id}/snapshot`). This keeps one owner of the
  board folders, so a delete that removes a folder cannot race with a host writing a file into it. It also lets the server
  refuse writes from anyone but the current host process (an old process that is still dying cannot overwrite a new one's
  save).
- The content is `JSON.stringify(room.getCurrentSnapshot())` (`RoomSnapshot`: `clock`, `documentClock`, `documents`,
  `tombstones`, `schema`). Loading is `new TLSocketRoom({ schema, initialSnapshot })` with the parsed snapshot, or with none for
  `204`.
- **The save throttle for people's edits.** `onDataChange` marks the room dirty and schedules a save `SAVE_DELAY` = 1 s after the
  first unsaved change. At most one save is in flight per room; a change during a save schedules another one. So a person's
  edit is on disk within about 1–2 s (goal 3.6 "within a few seconds").
- **Saved before an agent is told.** After an agent's `apply` or `delete_elements` has changed the room, the host saves
  immediately, and waits for that save, before it answers. This save also carries the people's pending edits. If the save fails,
  the agent reads `SAVE_FAILED: the change was made but could not be saved: <reason>` (the headless writer's wording).
- **Room close.** When the last session leaves and no agent call has touched the room for `ROOM_QUIET` (30 s, from the config
  line's `quietMs`), the host saves the room if it is dirty, waits for that, and closes it.
- **The host stops** (stdin closed, SIGTERM): it saves every dirty room, bounded at 2 s in total, as the headless writer does,
  then exits.
- **Restarts.**
  - **The board host dies.** Each room is as of its last save: at most about 2 s of people's edits are lost, and nothing an agent
    was told is done.
  - **The server restarts.** The host's stdin closes, so it saves what it can and exits. Windows reconnect when their stream is
    back, and the rooms load from disk.

---

## 5. Board host lifecycle (goal 3.7)

### 5.1 Start, stop, restart

- **Start on first need.** Two things call `host.Ensure`: a window's `open` and an agent's tool call on a tl board. Nothing
  starts at boot.
- **What "busy" means.** The board host's manager uses a `headless.Bridge` adapter from `tlrelay.HostAdapter`:
  - `Known(id)` → `bridge.Known(id)`;
  - `SetAway(id)` → tlrelay records the host's id (`""` after its exit);
  - `HoldsAny(id)` → tlrelay has an open session, or the last tl tool call was less than `quiet` ago (60 s, the
    `-boardhost-quiet` flag; `quiet=` of `AIWB_TEST_WAITS` lowers it as for the headless writer);
  - `HasCalls(id)` → `bridge.HasCalls(id)`.
- **Quiet-time stop.** The manager's existing idle watch stops the process when the adapter says it is not busy at two looks in a
  row, 5 s apart (`watch`, `manager.go:310`). Since Go's quiet (60 s) is longer than the host's room quiet (30 s), the rooms are
  normally closed and saved by the time the process is stopped. If they are not, the stop saves them anyway (4.2).
- **Restart after death.** The process exits and `reap` clears the id; the bridge's `OnEnd` → `tlrelay.ClientEnded(host)` closes
  every session with `host_stopped`. The windows' links reopen. Their `open` calls `Ensure`, which starts a new process.
  Agent calls in flight failed with `HOST_STOPPED`, and the next one starts the process.
- **Window reconnection.** It is the link's reopen (2.5). The status pill shows "Reconnecting…" until `online`.

### 5.2 The board host process

- **The config line** is the headless writer's (`internal/headless/run.go` `config`) with the same fields.
  - `quietMs` is the **room** quiet time. The board host's manager is made with `Quiet: roomQuiet` (30 s).
  - Go's own quiet for stopping the process is the 60 s the adapter uses.
  - `handoverMs` is ignored.
- **Start order**, all within 20 s or the process exits with code 3 and the reason, as the headless writer does:
  1. read the config line;
  2. install the Node stand-in and register the fonts **[S-HOST]**;
  3. build the schema;
  4. make the conn client;
  5. open the stream.
- **Events it handles:**
  - `hello`, `snapshot` (nothing to keep; it ignores board lists);
  - `tl_open`, `tl_sync`, `tl_close`, `tl_drop`, `rpc`;
  - `server_stopping`: save every dirty room, then `POST /api/client/flushed`.
    **As built (Go):** the bridge's `StopAndFlush` sends `server_stopping` only to clients that hold classic boards, so the board
    host does not get it. At shutdown Go closes the board host's manager right after `StopAndFlush`, which closes its stdin, and the
    host saves its dirty rooms then (4.2) while the client listener still serves. Handling `server_stopping` stays harmless.
- **Rooms.** `rooms.ts` keeps `Map<boardId, RoomEntry>`:

  ```ts
  type RoomEntry = {
    room: TLSocketRoom<TLRecord, { session: string }>;
    loading: Promise<void> | null;        // GET snapshot in flight; messages and calls wait for it
    pending: Map<string, string[]>;       // per session, messages that arrived while loading
    sockets: Map<string, ProxySocket>;    // per session
    dirty: boolean; saving: Promise<void> | null; saveTimer: Timer | null;
    lastAgent: number;                    // ms, the last agent call
    queue: Promise<unknown>;              // agent calls on this room run one at a time
  };
  ```

- **`tl_open`:**
  1. ensure the room (load it if needed);
  2. make a `ProxySocket` `{ readyState: 1, send(text) { link.queue(session, text) }, close(code, reason) { link.closed(session, reason) } }`;
  3. `room.handleSocketConnect({ sessionId: session, socket, meta: { session } })`;
  4. replay the pending messages with `room.handleSocketMessage(session, text)`.
- **`tl_sync`:** for each string, call `room.handleSocketMessage(session, text)`; while the room is loading, queue the strings.
- **`tl_close`:** `room.handleSocketClose(session)`; when it was the last session, start the quiet timer.
- **`tl_drop`:** close every session of the room, save it if `archived`, then close the room.
- **Sessions Go no longer knows.** A session listed in an `out` answer's `gone` gets `room.handleSocketClose(session)`.

---

## 6. How a new board appears in the app (goal 4.3)

| What | Files |
|---|---|
| The record | `packages/core/src/types.ts:32`: `kind?: "tl"`. `boardIn` (`logic/sectionwire.ts:24`) already spreads the record, so the field reaches the store from the snapshot and the `board` events. |
| Create from the UI | `packages/core/src/api.ts:132` `newBoard(group, name?, isNew = false, kind?: "tl")` sends `kind` in the body (and only when it is `"tl"`). `app/src/screens/shell/nav.ts:97` `newBoard(group, kind?)` → for `"tl"` it does not call `boardApp.takeBoard`. `nav.ts:116` `addBoard(group, kind?)`. `app/src/screens/home/NewSheet.tsx:112`: a second tile, "New board", "Miro-like board, many people at once" (`H2_TID.newTlBoard`), `onPress={() => makeTlBoard()}`. The sidebar's "New whiteboard" stays classic. Go: `POST /api/boards` (`server.go:534`) reads `Kind string`, accepts `""` and `"tl"` (else `400 {"code":"bad_kind"}`), passes it to `Create`, and does **not** call `TakeBoard` for a tl board. |
| Listing | Unchanged lists. A tl board's row has a small "New" mark next to its name: `app/src/screens/sidebar/rows.tsx:153` `BoardNode`, `app/src/screens/home/model.ts:96` (adds `tl: true` to the row) and `HomeRow.tsx:78`. |
| The board screen | `app/src/screens/board/BoardCanvas.tsx:91`: the present component is renamed `ClassicCanvas` (no other change), and `BoardCanvas` becomes a wrapper: `const kind = useStore((s) => s.boards[board]?.kind); return kind === "tl" ? <TlCanvas board={board} /> : <ClassicCanvas board={board} />;` (a wrapper, so the hooks of each keep their order). |
| `TlCanvas` | `app/src/screens/board/TlCanvas.tsx` (**new**): makes `openTlLink(board)` on mount and `link.close()` on unmount; reads the person's name (D12); renders `<TlHost board link user onHandle />` and `<slots.BoardVoice>` like `ClassicCanvas`; no `RoleBar`, no `SaveBanner`, no `DroppedNote`, no `boardApp.show`/`attachView`. It registers the handle the view gives (`tlRegistry().setHandle(board, handle)`) for `get_view`/`show_board`. |
| The mount | `app/src/platform/tlboard.web.tsx` (**new**): mounts `window.aiwbTlView.mount(element, { board, link, user, testID, onHandle })` into an RN `View`'s DOM node, as `board.web.tsx` mounts `aiwbBoardView`. `app/src/platform/tlboard.native.tsx` (**new**): a centred text "New boards are not available on this device yet." (phones are out of scope, goal 5). |
| The web build | `packages/board-tl/build.mjs` writes `app/public/tl/{tl.js, tl.css, fonts/}` (git-ignored like `app/public/board/`). `app/scripts/export-web.mjs` step 0 also runs `npm run build:web` in `packages/board-tl` and checks `public/tl/tl.js` exists. `app/public/index.html` loads `./tl/tl.css` and `<script src="./tl/tl.js" defer>` beside `board.js` **[S-UI]**. `tl.js` is a development build of tldraw (1.3, licence). |
| Old boards' paths | Guards so no Excalidraw code runs for a tl board: `nav.ts select()` skips `boardApp.flush(prev.board)` for a tl board; `rows.tsx` rename skips `boardApp.flush` for a tl board; `packages/core/src/board/side.ts` `afterSnapshot`/`sectionBack` do not load a scene for a tl board on screen (one `isTl(key)` check where the board on screen is picked). `ClassicCanvas` is never rendered for a tl board, so `show`/`attachView` never see one. |
| Agent `rpc` in the window | `packages/core/src/state/conn.ts` `answer` (`:155`): if the tool is `get_view` and the chat's board is a tl board, or the tool is `show_board` and its target (or the chat's board) is a tl board, `tlRegistry().answer(params)` instead of `boardSide().runTool`. `answer` returns the same shape (`string` or `{text}`). |

**`get_view` and `show_board` in the window** (`tlRegistry().answer`):

- `get_view` on a tl board that is on screen returns text: the board's name and id, `kind: new`, the visible area
  `x,y,w,h` (page coordinates, rounded), the zoom in percent, then the selected elements as 7.3 lines.
- `show_board`:
  - `select({ board, chat: null })`;
  - when the view has mounted (the handle is registered, waiting up to 5 s), `handle.zoomTo(refs)`: refs are `{id}` or `{key}`,
    and the camera fits their bounds;
  - the answer `shown <name> (<id>)`.
- No board on screen: the existing words.

The handle the view gives is `{ getView(): { bounds, zoom, selected: TlElement[] }, zoomTo(refs: AgentRef[]): boolean }`. It is
built in `board-tl/src/view/` from the editor and `model/read.ts`.

---

## 7. Agent terms (goal 7.6)

### 7.1 Principles

- An agent names elements, not tldraw records. The mapping is `model/apply.ts` and `model/read.ts`. Shape mapping (7.2 of the
  goal): `sticky` → our sticky shape (the restyled `note`, or our own `ShapeUtil` **[S-UI]**), `shape` → `geo`, `text` → `text`,
  `connector` → `arrow` and its bindings, `frame` → `frame`, `pen` → `draw` (read-only for agents).
- **References.** A string that names an element is resolved in this order:
  1. a `ref` created earlier in the same `apply`;
  2. a tldraw id (`"shape:…"`);
  3. a **key**: the `ref` an element was created with, kept in the shape's `meta.key`, so later calls can use it (D10).

  Keys are unique on a board: a `create` whose `ref` is already a key on the board fails `REF_EXISTS`.
- **Sizes.** A size that is left out gets what a person gets (tldraw's defaults for the shape; a sticky's fixed size). Text is
  fitted as in a window: a sticky shrinks its font to fit (our sticky), a `geo` grows its height to its text (tldraw's
  `growY`), and a text element without `w` is auto-width.
- **Coordinates.** Page coordinates, the top-left corner of the element, numbers in px. An element inside a frame is still
  given and read in **page** coordinates; the apply converts to the frame's local ones.

### 7.2 The input of `apply`

`apply` gets a new property `ops` in its schema (`internal/boardtools/tools.go:102`). On a tl board, `create` and `update` (the
old properties) are refused: `BAD_ARGS: this is a new board; use ops (see the tool description)`. On an old board, `ops` is
refused the other way round. The descriptions of `apply`, `read_board`, `delete_elements` and `create_board` say this in one
sentence each, with a one-line example.

```ts
// packages/board-tl/src/model/terms.ts
export type StickyColor =
  | "yellow" | "light-yellow" | "orange" | "red" | "pink" | "violet" | "blue" | "light-blue" | "green" | "light-green" | "grey" | "white";
export type Color = "black" | "grey" | "white" | "red" | "orange" | "yellow" | "green" | "light-green"
  | "blue" | "light-blue" | "violet" | "pink";
export type ShapeKind = "rectangle" | "rounded" | "ellipse" | "triangle" | "diamond";
export type Size = "s" | "m" | "l" | "xl";                     // tldraw's size style, one-to-one
export type Align = "start" | "middle" | "end";
export type Arrowhead = "none" | "arrow" | "triangle" | "dot" | "diamond" | "bar";
export type Point = { x: number; y: number };
export type Ref = string;                                       // a ref of this apply, a "shape:…" id, or a key

type Common = { ref?: string; parent?: Ref | null };           // parent: a frame; null = the page

export type CreateSticky = Common & { op: "create"; type: "sticky"; x: number; y: number; w?: number;
  text?: string; color?: StickyColor; fontSize?: "auto" | Size; align?: Align };
export type CreateShape = Common & { op: "create"; type: "shape"; shape?: ShapeKind /* rectangle */; x: number; y: number;
  w?: number; h?: number; text?: string; fill?: Color | "none"; border?: Color; borderWidth?: Size;
  borderStyle?: "solid" | "dashed" | "dotted"; align?: Align; size?: Size };
export type CreateText = Common & { op: "create"; type: "text"; x: number; y: number; text: string;
  w?: number /* fixed width, wraps; absent = auto width */; size?: Size; color?: Color; align?: Align; bold?: boolean };
export type CreateConnector = Omit<Common, "parent"> & { op: "create"; type: "connector"; from: Ref | Point; to: Ref | Point;
  line?: "straight" | "curved" | "elbow"; start?: Arrowhead /* none */; end?: Arrowhead /* arrow */;
  text?: string; color?: Color; width?: Size; dash?: "solid" | "dashed" | "dotted" };
export type CreateFrame = Omit<Common, "parent"> & { op: "create"; type: "frame"; name?: string;
  x?: number; y?: number; w?: number; h?: number;   // absent: fitted around `contains` with 40 px padding
  contains?: Ref[]; color?: Color };

export type Update = { op: "update"; id: Ref } & Partial<{
  x: number; y: number; w: number; h: number; text: string; name: string; color: StickyColor | Color;
  fill: Color | "none"; border: Color; borderWidth: Size; borderStyle: "solid" | "dashed" | "dotted";
  shape: ShapeKind; size: Size; fontSize: "auto" | Size; align: Align; bold: boolean;
  from: Ref | Point; to: Ref | Point; line: "straight" | "curved" | "elbow"; start: Arrowhead; end: Arrowhead;
  width: Size; dash: "solid" | "dashed" | "dotted"; parent: Ref | null; contains: Ref[] }>;
export type Delete = { op: "delete"; id: Ref };                // a frame: its contents stay, moved to the page

export type Op = CreateSticky | CreateShape | CreateText | CreateConnector | CreateFrame | Update | Delete;
export type ApplyArgs = { board?: string; ops: Op[] };
```

- `color` on a sticky is its note colour. On a shape, `color` is not accepted (use `fill`/`border`). On text and connectors it
  is the ink.
- A field that does not apply to an element is an error (`INVALID_OP`), not ignored, so an agent learns the terms.
- Each colour name maps to a stored value in `model/palette.ts`, and **what is stored does not depend on the theme**
  (goal 4.10).

### 7.3 The output of `read_board`

Text: one header line, then one JSON object per element (JSON Lines), in z-order (back to front), frames before what they hold:

```
Board "Sprint" (b_k2j4h1x9), a new board. 6 elements. Coordinates are page px; parent names the frame that holds an element.
{"id":"shape:a1","key":"f1","type":"frame","name":"Sprint","x":-40,"y":-80,"w":620,"h":300}
{"id":"shape:b2","key":"n1","type":"sticky","parent":"shape:a1","x":0,"y":0,"w":200,"h":200,"text":"Idea","color":"yellow","fontSize":"auto","shownSize":24}
{"id":"shape:c3","key":"s1","type":"shape","parent":"shape:a1","shape":"rectangle","x":300,"y":0,"w":200,"h":100,"text":"API","fill":"none","border":"black","borderWidth":"m","borderStyle":"solid","align":"middle","size":"m"}
{"id":"shape:d4","type":"connector","from":{"id":"shape:b2","key":"n1"},"to":{"id":"shape:c3","key":"s1"},"line":"straight","start":"none","end":"arrow","text":"calls"}
{"id":"shape:e5","type":"connector","from":{"id":"shape:c3"},"to":{"x":700,"y":40},"line":"curved","start":"none","end":"arrow"}
{"id":"shape:f6","type":"pen","x":10,"y":400,"w":120,"h":40,"color":"black","width":"m"}
```

```ts
export type TlElement = {
  id: string; key?: string; parent?: string;
  type: "sticky" | "shape" | "text" | "connector" | "frame" | "pen" | "image" | "other";
  x: number; y: number; w: number; h: number;          // page coordinates of the bounds, rounded to 0.1
  text?: string;                                        // rich text flattened to plain text, lines joined with "\n"
  from?: { id: string; key?: string } | Point; to?: { id: string; key?: string } | Point;   // connectors
  shownSize?: number;                                   // sticky: the font size in px it is drawn at after shrinking
  locked?: true;
} & Partial<Omit<CreateSticky & CreateShape & CreateText & CreateConnector & CreateFrame, "op" | "type" | "ref" | "parent">>;
```

The same `TlElement` lines are used for the selection in `get_view`, and as the elements an `apply` answer returns.

### 7.4 Validation, atomicity, answers, errors

The order of one `apply`, all of it synchronous in the host's one JS thread, so no window's message can come in between steps
1 and 5:

1. take the room's current records (`room.getCurrentSnapshot().documents` or the storage's entries);
2. validate every op with `model/validate.ts`: types, required fields, allowed fields, value ranges, refs resolvable (refs of
   earlier ops in this call count). The first invalid op stops everything: nothing is applied;
3. load the records into the room editor's store and run all ops in one `editor.run(() => …)`, collecting the store's changes as
   one diff. An exception there also stops everything;
4. measuring and fitting happen inside the editor's ops, through the Node text measure **[S-HOST]**;
5. write the diff to the room in one transaction (`room.storage.transaction(txn => { txn.set…; txn.delete… })`; or
   `room.updateStore`, the documented (deprecated) form, if the spike finds the transaction does not broadcast), so it becomes
   **one** change, reaching every window together;
6. save the board (4.2) and wait;
7. answer.

**The room editor.** It is one Node `Editor` per room in the board host, on its own store with the shared schema. It is **not**
a sync peer. Before each call its store is set to the room's records (step 3: puts for the changed ones, removes for the
missing ones), and after a failed call it is marked stale and set again next time. The spike may show that a fresh `Editor` per
call is cheap enough. Either way the interface is the same:

```ts
// packages/board-host/src/agent.ts
runOps(records: TLRecord[], ops: Op[], measure: TextMeasure):
  { ok: true; diff: { puts: TLRecord[]; deletes: string[] }; ids: Record<string, string>; touched: string[] }
| { ok: false; error: string /* "CODE: text" */ }
```

`runOps` itself is `model/apply.ts`, which takes an `Editor`. The host only supplies the editor and the records.

**Answer of a successful `apply`** (text, JSON on one line after one sentence):

```
Applied 6 ops on "Sprint" (b_k2j4h1x9); saved.
{"ids":{"n1":"shape:b2","s1":"shape:c3","f1":"shape:a1"},"created":["shape:b2","shape:c3","shape:d4","shape:a1"],"updated":["shape:b2"],"deleted":["shape:e5"],"elements":[<TlElement of every created or updated element>]}
```

**Errors** are `CODE: text`, with the op's index (0-based) and its `op`/`type`/`id` when one op is at fault:

| Code | When |
|---|---|
| `BAD_ARGS` | `ops` missing or not an array; old-board properties on a new board |
| `INVALID_OP` | `INVALID_OP: op 3 (update shape:c3): fill is not one of black, grey, …` |
| `UNKNOWN_REF` | `UNKNOWN_REF: op 2 (create connector): "n9" names no element of this board or of this call` |
| `REF_EXISTS` | a `create` whose `ref` is a key already on the board |
| `NOT_SUPPORTED` | e.g. creating `pen` or `image` |
| `APPLY_FAILED` | tldraw threw during step 3 (the message attached); nothing applied |
| `SAVE_FAILED` | step 6 failed: the change **is** in the room and the windows, but not on disk |
| `HOST_STOPPED`, `TIMEOUT`, `UNAVAILABLE` | from Go (3.3) |

---

## 8. Presence: the agent and people's names (goal 3.4, 9)

- **D11. The agent's marker is a custom message, not a tldraw presence.**
  - After a successful `apply` or `delete_elements`, the host sends this to every session of the room:
    `room.sendCustomMessage(session, {type:"aiwb_agent", label:"Claude", chat:"c_…", bounds:{x,y,w,h}, ttlMs:4000})`.
    `bounds` is the union of the touched elements' page bounds; for a delete it is their bounds before the delete.
  - The window's `TLSyncClient` gets it through `onCustomMessageReceived`. The view draws a dashed outline around `bounds`,
    with a pill labelled with the agent's name at its top-left. Both follow the camera, and the marker fades after `ttlMs`.
  - Another message with the same `chat` replaces the marker.
  - A session that opens within `ttlMs` of the last change gets the last marker too: the room keeps it, and `tl_open` replays it
    after the connect.
  - *Why:* a tldraw presence needs a session in the room (a second sync client per room, with its own copy of the store).
    The custom message is one call of the room's public API, it needs no store, and it gives exactly "a marker labelled with
    the agent's name where it is changing the board".
- **D12. People's names.** The prototype uses a generated name, as goal 3.4 allows:
  - The page keeps `{id, name, color}` in its kv (`aiwb.tl.user`), made the first time from a random adjective + animal
    ("Teal Otter") and a colour of tldraw's user palette.
  - `TlCanvas` passes it to the view, which gives it to tldraw as the user's preferences (`name`, `color`, `id`), so the
    presence record, and the cursors and selection outlines other windows draw, carry it.
  - The page's own client id is not used: the page does not know it (the main process does), and it is one per app anyway.
  - A real build would take the person's name from the server's list of clients or from Settings.

---

## 9. Work breakdown

Rules for every package: own worktree and branch `bb-<name>` made from the integration branch (or the branch its parent names),
`ORCHESTRATION.md`'s testing rules (unit tests for logic, temporary mock data for UI, nothing end-to-end committed; Go default set of the
changed package, plus `-race` where goroutines share state; root `npm test && npm run check` for `packages/*` and `app/`),
commit, report. Each package below says what it may touch; everything else is off limits.

**Interfaces in this document are the contract.** A package that cannot keep one stops and reports, and does not bend it
silently.

### Wave 1: independent of the spikes and of each other (start all at once)

**G1: board kind and snapshot storage** (Go). *Medium.*
- `internal/model`: `Board.Kind`, `KindClassic`, `KindTL`.
- `internal/store/paths.go`: `BoardSnapshot(id)`.
- `internal/boards`:
  - `Create(name, group, isNew, kind)` (update every caller to pass `KindClassic`);
  - `SnapshotAt`, `SaveSnapshot`;
  - `ErrNotTL`, `ErrTLBoard`;
  - `SceneAt`/`SaveAt` refuse a tl board.
- `internal/server`:
  - `POST /api/boards` reads `kind` (`""`/`"tl"`, else 400 `bad_kind`), and does not `TakeBoard` for tl;
  - `GET`/`PUT scene` and `take` answer 409 `tl_board` for a tl board;
  - `follow` on a tl board answers `{rev:0, writer:""}`.
- Tests: `internal/boards` (create both kinds; a tl board has no drawing file; snapshot round trip; atomic write; refusals) and
  `internal/server` (the routes' new answers).
- Check: `go test ./internal/boards ./internal/server ./internal/model`.
- Touch only these packages.

**G2: bridge additions** (Go, `internal/editorbridge` only). *Medium.*
- `CallSpec.Client string`: when set (and not `Screen`), the call goes to that client only, and fails `ErrNoClient` if it has
  no open stream. It never grants a board.
- `CallSpec.Lost error`: the error the call fails with when its client's stream ends (default as today).
- `Bridge.OnEnd func(clientID string)`: called once per ended client record (a stream that ended, or one replaced by a newer
  stream with the same id), **after** the bridge's lock is released. Collect the ids under the lock, call after the unlock, in
  `Serve`'s deferred end and in the replaced case.
- Tests:
  - a call with `Client` reaches only that client;
  - `Lost` is returned when its stream ends;
  - `OnEnd` fires for an end and for a replacement, and is not called under the lock (the hook calls `b.Known`, which would
    deadlock otherwise).
- Check: `go test ./internal/editorbridge` and `go test -race ./internal/editorbridge`.

**G3: a second manager** (Go, `internal/headless` only). *Medium.*
- `Options.Program` (default `"headless.mjs"`), `Options.Folder` (default `"headless"`, used in the bundle lookups `Resources/<folder>`,
  `<exe>/<folder>`, `<exe>/resources/<folder>`), `Options.Name` (default `"headless writer"`, used in log lines and reasons).
  Defaults keep every behaviour and message of today.
- Tests: the find order with `Folder: "boardhost"`, `Program: "boardhost.mjs"`; one start of a stand-in program with these
  options. The existing tests stay unchanged and pass.
- Check: `go test ./internal/headless` and `go test -race ./internal/headless`.

**C1: core: kind, calls, link, registry** (`packages/core` only). *Medium.*
- `types.ts`: `kind?: "tl"`.
- `api.ts`:
  - `newBoard(..., kind?)`;
  - `tlOpen(key) → {session}`, `tlSync(key, session, messages)`, `tlClose(key, session)` (paths `/api/tl/<id>/…` by the board
    key's server, like `thing`; `tlSync` uses the raw `send`, so a status is not thrown away).
- `src/tl/link.ts`: as 2.5, with injected `api`, timers and a clock for tests.
- `src/tl/registry.ts`:
  - `event(server, m)` for `tl_sync`/`tl_closed`;
  - `streamState(server, up)`;
  - `setHandle(board, handle | null)`;
  - `answer(params)` for `get_view`/`show_board` (section 6).
- `state/conn.ts`: the two cases, the stream-state call, and the branch in `answer`.
- Tests (`node --test`): batching (one call in flight, gap, coalescing), `410` → reopen with backoff, stream reopen → reopen, close →
  no reopen, ordering, the event routing by session, `answer` choosing the tl path only for tl boards.
- Check: root `npm test && npm run check`.

**T1a: agent terms, validation and reading** (`packages/board-tl/src/model/{terms,palette,validate,read}.ts`; creates the package
skeleton: `package.json` with `tldraw@5.6.0` pinned, `tsconfig.json` like `packages/board-view`'s, `test` and `check` scripts).
*Medium.*
- `terms.ts` exactly as 7.2/7.3.
- `palette.ts`: names → stored values (theme-free).
- `validate.ts`: pure, ops + a lookup of existing keys/ids → the first error or ok.
- `read.ts`: records → `TlElement`s and the `read_board` text.

  `read.ts` works on **records** (`TLShape`, `TLBinding`), with no `Editor`, so it is testable in Node now. Page bounds of nested
  shapes are computed from parent transforms; rotated shapes use their axis-aligned bounds. The sticky's records come from
  T1b's shape, so use a placeholder type name `aiwb-sticky` until T1b fixes it.
- Tests: hand-written records of each element type → expected lines; every validation error code of 7.4.
- Check: root `npm test && npm run check` (after adding the workspace; run `npm install` once, since `package.json` changes).

**H1: the board host process, without the editor** (`packages/board-host`, new). *Medium.*
- `bin.ts`, `main.ts` (reuse `@aiwb/headless`'s config parsing, `memstore`, the conn client), `link.ts` (2.4), `rooms.ts` (5.2;
  load with `GET snapshot`, save with `PUT snapshot`, throttle, room quiet, `tl_drop`, flush on exit and on `server_stopping`),
  and an `rpc` dispatcher that answers every tool `NOT_SUPPORTED` until H2/H3 plug in (`agent.ts` seam:
  `handleTool(room, params) → Promise<string | {text, image}>`).
- `TLSocketRoom` from `@tldraw/sync-core@5.6.0` with `createTLSchema()` (the default schema until T1b provides the shared one:
  import it from one place, `src/schema.ts`, so the swap is one line).
- Tests (`node --test`, the fake client pattern of `packages/headless/test/support.ts`):
  - two in-memory `TLSyncClient`s connected through the fake server's `tl_sync` events and `out` calls converge;
  - messages before the load are replayed;
  - `gone` closes a session;
  - a save follows a change within `SAVE_DELAY`;
  - the room closes after quiet with a save;
  - stdin end flushes.
- Check: `cd packages/board-host && npm test && npm run check` and the root `npm test && npm run check`.

### Wave 2: after Wave 1's Go parts (G1–G3) and the contract

**G4: `internal/tlrelay`** (Go, new). *Medium, reviewed by a high run* (the transport for multiplayer may not be rough,
goal 4.12).
- Everything of 2.2, 2.3, 2.7, 3.2–3.4, 5.1: sessions, the six handlers, `ClientEnded`, `BoardGone`, `CallTool`,
  `ScreenClient`, `HostAdapter`, counters, `Status`, the log line.
- Tests with a fake `Bridge` (records `SendTo`, scripted `CallBoard`), a fake `Host` and a fake `Boards`, using `httptest` for the
  handlers:
  - open/sync/close and the session checks (wrong client, wrong board → 410);
  - opaque relay (bytes in = bytes out, including odd strings);
  - host end → `tl_closed` to every window;
  - window end → `tl_close` to the host;
  - `out` with `gone`;
  - snapshot routes only for the host;
  - `CallTool` passes `Client`/`Lost`;
  - lost and timeout texts, and `CallTimedOut` on timeout;
  - busy/idle of the adapter;
  - counters.
- Check: `go test ./internal/tlrelay` and `go test -race ./internal/tlrelay`.
- Depends on: G1 (`Boards` methods), G2 (`CallSpec.Client`/`Lost`), G3 (`headless.Status`). It can start before they merge if
  it uses the interfaces as written here.

**G5: agent routing** (Go, `internal/boardapi`, `internal/boardtools`). *Medium.*
- Section 3.1: the `TL` field and interface, the kind branch, `create_board` `kind`, the `list_boards` mark, the screen calls'
  `Client`, and the error texts of 3.3.
- Tool texts (7.2): `apply` gets `ops`, plus the one-sentence notes on `read_board`, `delete_elements`, `create_board`.
- Tests with a fake `TLCaller`:
  - a tl board's `read_board`, `apply`, `delete_elements`, `get_image` reach `CallTool` and never `CallBoard` of the bridge;
  - an old board's calls are unchanged (the existing tests pass);
  - `create_board` with `kind: "new"` makes a tl board;
  - a screen call on a tl chat board uses `ScreenClient`.
- Check: `go test ./internal/boardapi ./internal/boardtools`.
- Depends on: G1, G4's `ToolCall` type (copy the struct as written in 3.1 if G4 has not merged).

**G6: wiring and route lists** (Go `cmd/ai-whiteboard`, `internal/server`, `internal/app`; `packages/conn`). *Medium.*
- Flags `-boardhost-node`, `-boardhost-dir`, `-boardhost-quiet`.
- Make the second `headless.Manager` with `Program: "boardhost.mjs", Folder: "boardhost", Name: "board host"`, `Quiet` = room
  quiet 30 s, the adapter from `tlrelay`.
- Set `bridge.OnEnd = relay.ClientEnded` and `boardapi.Relay.TL`.
- `internal/app` calls `tlrelay.BoardGone` after archive and delete (an optional func field set in main).
- Mount the routes, and add their rows to `ClientRoutes`, `wantRoutes` and `packages/conn/core/routes.json` in the same order.
- `calls.js`: the 32 MiB / 128 MiB limits and `open` in `START`.
- `status -json` `"boardhost"` and a line in the human status.
- `AIWB_TEST_WAITS` gets no new names: `quiet` already lowers the headless quiet time; add `bhquiet` only if the checks need it.
- Check: `go test ./cmd/ai-whiteboard ./internal/server ./internal/app`, `go test ./...` once, `cd packages/conn && npm test`.
- Depends on: G1–G5.

**T1b: the shared shapes and `apply`** (`packages/board-tl/src/model/{schema,shapes/,apply,fonts}.ts`). *High.* Depends on
S-HOST (how an Editor runs in Node for tests) and S-UI (the sticky: restyled `note` or our `ShapeUtil`, and its shrink-to-fit).
- `schema.ts`: the shapes and bindings, and the style props for our palette (goal 7.2: tldraw style props, so "set style for
  the selection" works).
- `shapes/sticky.tsx`: the sticky shape, with the measuring hook that both the window and the host use (the shrink-to-fit
  must give the same `shownSize` in both).
- `apply.ts`: `Op[]` on an `Editor` in one `editor.run`, with frames' `contains`, connectors' bindings and keys in `meta.key`.
- Tests: in Node on the editor setup S-HOST proves: each op of 7.2, refs, atomic failure (nothing changed), the connector
  bound at both ends, the frame holding its children, the sticky's `shownSize` for a long text.

**H2: the agent's tools in the host** (`packages/board-host/src/agent.ts`, `src/node/` from S-HOST). *High* (the proof of
"sizes are right" rests on it, goal 4.12).
- The room editor (7.4); `read_board`, `apply`, `delete_elements` through T1a/T1b; save before the answer; the agent marker
  (D11); the texts of 3.5.
- Tests:
  - fake rooms through the real `TLSocketRoom`: an apply is one change, and a connected `TLSyncClient` sees it at once and
    whole;
  - an invalid op changes nothing;
  - `SAVE_FAILED` when the PUT fails;
  - a long text in a sticky gives the same `shownSize` as the reference value S-HOST measured in Chromium.
- Depends on: H1, T1a, T1b, S-HOST.

**H3: pictures in the host** (`packages/board-host/src/render.ts`). *Medium.* Depends on S-HOST (SVG export in Node, SVG → PNG).
- `get_image` scopes `all`/`refs`/`rect`, `scale`, `background`, the limits and codes of today.
- Tests: a board of each element → a PNG of the expected size with non-blank pixels; `EMPTY`, `UNKNOWN_REF`, `TOO_LARGE`.

**H4: the host bundle** (`packages/board-host/build.mjs`). *Medium.* Depends on H1 (and on S-HOST for the native modules).
- `dist/boardhost.mjs` + `dist/assets/` + `dist/manifest.json` (1.3).
- Test (`node --test`): the build's layout, the manifest, and the fonts listed by `model/fonts.ts` present.

### Wave 3: the window (after S-UI; T2 parts can run in parallel with each other)

**T2a: navigation and the main toolbar** (`packages/board-tl/src/view/{Board.tsx, navigation.ts, MainToolbar.tsx, Zoom.tsx}`).
*Medium.* From S-UI's findings: drag-to-pan in the select tool's states, the wheel options, Space/middle-button, touch, the zoom
controls and shortcuts, `components` all `null` (goal 3.1, 7.3). Check: a dev page on mock data (no server: a local
`TLStore` with a few shapes), looked at in a browser; `npm run check`.

**T2b: the contextual toolbar** (`packages/board-tl/src/view/ContextBar.tsx`). *Medium.* Goal 3.3's controls per selection,
positioned by the selection's screen bounds, hidden while dragging. Same dev page.

**T2c: quick add, double-click sticky, Alt-drag duplicate, keyboard** (`packages/board-tl/src/view/interactions.ts`).
*Medium.* Goal 3.3's remaining behaviours. Same dev page.

**T3: sync in the view, the mount, the build** (`packages/board-tl/src/view/{socket.ts, sync.ts, AgentMarker.tsx, Status.tsx}`,
`src/web/entry.tsx`, `build.mjs`). *Medium.*
- `TransportSocket` (2.5), the `TLSyncClient` + store setup with the shared schema, the user's name (D12), the agent marker
  (D11), the "Reconnecting…" pill, and the handle for `get_view`/`show_board` (section 6).
- `window.aiwbTlView.mount(el, { board, link, user, testID, onHandle }) → { unmount() }`.
- Build into `app/public/tl/`.
- Tests: `TransportSocket` against a fake `TlLink`: status mapping, JSON round trip, restart.
- Depends on: C1 (the `TlLink` type), S-UI (embedding).

**A1: the app** (`app/` files of section 6). *Medium.*
- The `BoardCanvas` split, `TlCanvas`, the two platform files, the New tile, the "New" mark, the `nav.ts`/`rows.tsx`/`side.ts`
  guards, `index.html` and `export-web.mjs`.
- Look at it with a temporary stub `aiwbTlView` that draws a grey box, and on mock data, then remove the stub.
- Check: root `npm test && npm run check`.
- Depends on: C1; the real view arrives with T3.

### Wave 4: confirmation (temporary scripts in `/tmp/<name>/`, nothing committed; results and small PNGs into the findings)

**V1** goal 6.2 and 6.4: two pages through two test hosts on a scratch server. **V2** goal 6.3 and 6.6: MCP calls with a
chat's token, kills of the board host, a server restart. **V3** goal 6.5: the faithfulness corpus and measurements. **V4** goal
6.7: the default Go sets of the changed packages, root `npm test && npm run check`, `away.e2e.mjs` and `readers.e2e.mjs`.
*Each medium.* They run after the parts they check have merged.

### Parallelism at a glance

```
Wave 1 (now):          G1  G2  G3  C1  T1a  H1                      ← all parallel
Wave 2:                G4 (needs G1-G3 interfaces) → G5 → G6
                       T1b, H2, H3, H4 (need S-HOST; H2 also T1a/T1b)
Wave 3 (after S-UI):   T2a  T2b  T2c  T3  A1                        ← parallel; T3 needs C1, A1 needs C1
Wave 4:                V1 V2 V3 V4
```

The critical path to a first live board in two windows: G1/G2/G3 → G4 → G6, with C1 → T3 → A1, and H1 (with tldraw's default
schema). That runs **without** any of the editor-in-Node work. Agents come with T1b → H2/H3.

---

## 10. Assumptions on the spikes, and fallbacks

| # | Assumption | Spike | Fallback |
|---|---|---|---|
| A1 | tldraw's `Editor` runs in Node on a stand-in page or in jsdom, and its text measuring can be replaced by one on skia-canvas with the real fonts that matches Chromium within 0.5 px. | S-HOST | jsdom with tldraw's DOM measuring replaced at the `TextManager` level. If no `Editor` runs at all: `model/apply.ts` writes records directly (our own fit code for stickies and `geo` growY on skia-canvas). That is more code and a deviation from 7.5, and needs the user's view (goal 6.9). |
| A2 | `editor.getSvgString()` works in Node (React components rendered), and the SVG rasterises to PNG with skia-canvas or resvg using the same fonts. | S-HOST | Headless Chromium in the host for pictures only (goal 4.9 says what to report); else ask a window (breaks "agents always headless" for pictures, so it is the user's call). |
| A3 | `TLSocketRoom` runs in Node with proxy sockets. A write through `room.storage.transaction` (or `updateStore`) is broadcast to the sessions as one change. A client that reconnects to a room restored from an older save gets the full state (code read: `getChangesSince`, 2.5) and pushes its unacknowledged changes again. | S-HOST | If the transaction does not broadcast, use `updateStore`. If reconnection after an older state fails, the link does a hard reset: `restart()` with a fresh `TLSyncClient` and store, so local unsent edits are lost and the report says so. |
| A4 | tldraw is embedded as a sibling IIFE (`tl.js`/`tl.css`, `window.aiwbTlView`) loaded by `index.html`, like `board.js`, under the page's CSP (`connect-src 'none'`, no `worker-src`), with its fonts, icons and translations bundled locally. | S-UI | Import tldraw into the Metro web bundle through `tlboard.web.tsx`. The mount interface of section 6 does not change. Any CSP addition is written in `deviations.md`. |
| A5 | The sticky is the restyled `note` shape or a `ShapeUtil` of ours. Either way it lives in `model/shapes/`, and the window and the host measure its shrink-to-fit with the same code. | S-UI (8.3) | No change to this design. |
| A6 | The window's `TLSyncClient` with our own socket (no `useSync`) works with `<Tldraw store>`. | S-UI / S-HOST | `useSync`'s internals as a model: build the `TLStoreWithStatus` ourselves. |
| A7 | The board host's memory (one room plus one editor per open board, fonts, canvas) stays within a few hundred MB for 10 boards. | S-HOST (8.8) | Close room editors after each agent call (an editor per call) and keep only rooms. |

## 11. Open questions for the orchestrator or the user

- The fonts (goal 9): D2 recommends tldraw's own sans. The spikes may say otherwise.
- The agent's terms use our own colour names (7.2). If S-UI keeps tldraw's colour names for the palette, `palette.ts` maps
  them one to one and the names in 7.2 change to those. Decide once T1b starts.
- Whether `read_board`'s JSON-lines form suits agents better than today's text lines. This is a proposal (D13); the findings
  report can say how agents managed.
