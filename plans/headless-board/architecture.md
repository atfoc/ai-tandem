# Headless board: architecture of holding, readers and the headless writer

This is the architecture for `headless-board-goal.md` ("the goal"), for everything except running the board engine in Node,
which the `hb-engine` architect designs (Excalidraw's element code in Node, the native canvas, fonts, images, `get_image` in
Node, the faithfulness harness of 6.1 and 6.4). The two meet in section 4, the engine interface.

Marks as in the goal: `[user]` (the user decided), `[standing]` (in the code or the architecture already, kept), `[proposed]`
(proposed here), `[not verified]` (an assumption nobody has checked). A decision is `D<n>`. Section 5 lists what the user should
decide. Section 6 is the work packages.

Line numbers are those of the branch `headless-board` at `4055b5a0`.

---

## 1. How a board is held today

### 1.1 The holder

The server keeps who holds each board in the **editor bridge**, `internal/editorbridge/bridge.go`, and nowhere else. Nothing
about holding is stored on disk.

- `Bridge` has `clients` (one record per open event stream, by client id), `holders` (board → client), `waiters` (board → the
  one client waiting for it, with its timer), `freeing` (an archive or delete waiting for the holder) and `rpcs` (board calls in
  flight).
- A client is any connection that opened `GET /api/events` with the secret, a valid client id (`X-AIWB-Client`, a UUID v4) and
  level 6 (`internal/server/clients.go` `ClientHandler`, 1–6). The stream is served by `Bridge.Serve` (`bridge.go:131`), which sends
  `hello`, then the snapshot (`internal/app/apiclient.go` `APISnapshot`), then events. A new stream with an id that is open
  replaces the old record (`startLocked`): the old one's boards are freed.
- When a stream ends, `endLocked` (`bridge.go:587`) frees its boards (a waiter gets each one), drops its waits and follows and
  fails all its calls.

### 1.2 Take, hand-off and its time limit (goal 4.2) `[standing]`

- `POST /api/boards/{id}/take` (`internal/server/server.go:366`) calls `Bridge.TakeBoard(client, board, ifFree)`
  (`bridge.go:222`). Free board, or already the caller's: `held` with the scene's revision. Held by another and `ifFree`: `busy`,
  nothing sent. Held by another, not `ifFree`: `waiting`; the caller becomes the waiter (an older waiter is sent `superseded`
  and replaced: the last press wins), and the holder is sent one `release_request`.
- The hand-off timer is `handoverDelay = 10 * time.Second` (`bridge.go:28`), started at the first take of a held board and not
  restarted when another waiter replaces the first (`waiter`). When it fires (`handover`), `passLocked` (`bridge.go:553`) gives
  the board to the waiter anyway. Tests lower it with `SetHandoverDelay` (`handover.go`). (The doc comment of `TakeBoard` says
  the delay "is longer for a holder that is an API client": no code does that any more; the comment is stale.)
- The holder answers `release_request` with `POST /api/boards/{id}/release` after it saved (`ReleaseBoard`, `bridge.go:273`:
  `handed` when somebody waited, `free` when nobody did, `none` when it did not hold it).
- `passLocked`: the old holder is sent `superseded` and its open calls on the board fail (`failCallsLocked`, with
  `ErrNoClient`); the waiter becomes holder and is sent `held {board, rev}`.
- Archive and delete use `FreeBoard(board, wait)` (`bridge.go:320`; called from `internal/app/app.go:250-270`, `:500-509`):
  release_request, then the board is taken from the holder at `wait` or at its release, and stays free.
- `LoseBoard` takes a board at once with no request. `Regrant` (`bridge.go:300`) sends the present holder a new `held` with the
  stored revision after a write of a client that lost the board between the holder check and the save.
- A board made with `POST /api/boards` is given to the client that made it (`server.go:520`, `TakeBoard(..., true)`).
- At shutdown `StopAndFlush` (`bridge.go:462`, called with 2 s in `cmd/ai-whiteboard/main.go:266`) sends `server_stopping` to
  every holder and waits for `POST /api/client/flushed`.

### 1.3 Revisions and the refusal of writes `[standing]`

- `internal/boards/boards.go`: each board has `scene.rev`. `SaveAt(id, base, body)` writes only when `base` is the stored
  revision (else `StaleError{Rev}`), writes `scene.rev` first and the drawing second, both atomically, so a crash never leaves a
  drawing ahead of its revision. `SceneAt` returns the drawing with its revision.
- `PUT /api/boards/{id}/scene?rev=` (`server.go:537`) refuses a write from a client that is not the holder (`409 not_holder`),
  refuses a write on a board nobody holds (`409 not_holder`), refuses a stale base (`409 stale` with the stored rev), and
  calls `Regrant` after a stored write. **It sends no event**: no other client hears that the revision moved (1.7).
- `GET /api/boards/{id}/scene` (`server.go:524`) answers the drawing with `X-AIWB-Scene-Rev`; it needs no hold and starts no
  follow.

### 1.4 How an agent's board call reaches the holding window and comes back

1. The agent calls a tool on the MCP listener (`127.0.0.1:6006/mcp`); `boardapi.Relay.ServeFixedMCP` → `serveRPC` → `dispatch`
   (`internal/boardapi/mcp.go`). The bearer token gives the chat (`Chats.ResolveToken`).
2. `Relay.CallResult` (`mcp.go:70`) answers `list_boards` and `create_board` itself (no client is asked; the new board is held by
   nobody). For every other board tool it picks the target (the `board` argument, else the chat's own board), checks it exists
   and is not archived, and builds `CallSpec{Method: "tool", Params: {chat, branch, board, name, args, target}, Board: target,
   ChatBoard: chat's board}`; `get_view` and `show_board` are `Screen` calls about no board.
3. `Bridge.CallBoard(spec, 30s)` (`bridge.go:388`; `callTimeout`, `mcp.go:28`) picks the client with `chooseLocked`
   (`bridge.go:432`): the holder of the target; **if nobody holds the target, the holder of the chat's board** (that window then
   takes the target itself, see 1.6); for a Screen call, the holder of the chat's board. It sends that one client an
   `rpc {id, method, params}` event and waits.
4. In the app the event arrives in `packages/core/src/state/conn.ts` `onEvent` → `answer` (`conn.ts:155`), which calls the board
   side, `packages/core/src/board/side.ts` `runTool` (`side.ts:856`), and posts `POST /api/rpc-reply {id, result | error}`.
   `Bridge.ReplyFrom` accepts the answer only from the client that was asked (`409 not_asked` otherwise).
5. `runTool`: `read_board`, `apply`, `delete_elements`, `get_image` go through `heldTarget` (`side.ts:766`, which **takes the
   target if free** when the window does not hold it), `loadScene` (`GET scene`, then the engine's `restore`), then the work: on
   the board on screen the view does it live, otherwise the "engine" (the view, or on a phone a web view picked by
   `setEngine`) does it on `{elements}` (`edit`, `side.ts:717`; `getImage`, `side.ts:790`). After an agent edit the scene is
   saved 50 ms later (`AGENT_SAVE`), after a person's change 500 ms later (`SAVE_DEBOUNCE`). `get_view` reads the store's view and
   selection; `show_board` selects the board on screen with `ifFree` (it takes the board if free).
6. The relay turns the answer into the MCP result (`pageResult`); a picture becomes an image part, or a file for Cursor.

### 1.5 What an agent is told when no board is open

`CallBoard` returns `ErrNoClient` when there is no client to ask (no holder of the target and none of the chat's board), or
when the asked client's stream ends or it loses the board during the call. The relay then answers (`mcp.go:126-128`):

> `NoClientText` = "The board isn't open: the AI Whiteboard window is closed. Board work needs the window open. Tell the user,
> and don't retry until they ask again." (`mcp.go:39`)

The agent's prompt, `internal/prompts/whiteboard.md` rule 7, tells it to stop and say the window must be open.

### 1.6 Where the app takes a board today

Besides the user's "Use here", a window takes a board in all of these places. Each one breaks goal 3.2 ("pressing it is the
only way a window becomes the writer") and is changed by this design:

| # | Where | What it does |
|---|---|---|
| T1 | `app/src/screens/shell/nav.ts:56` `select` via `logic/roles.ts` `takeOnSelect` | a click on a board's row takes it **with hand-off**; selecting a chat takes its board if free |
| T2 | `app/src/screens/board/BoardCanvas.tsx:86` | a board on screen with no role is taken if free |
| T3 | `side.ts:604` `takeAfterSnapshot` | after connecting: the board on screen and boards with an unsaved edit, if free |
| T4 | `side.ts:617` `sectionBack` | when a remote server's section is back: the same, if free |
| T5 | `side.ts:766` `heldTarget` | an agent call on a board the window does not hold takes it, if free |
| T6 | `side.ts:576` `handOver` | after a release answered `free` (the presser went away), takes it back, if free |
| T7 | `side.ts:921` `show_board` | `ui().select(..., { ifFree: true })`: the agent's wish takes a free board |
| T8 | `server.go:520` | the server gives a new board to the client that made it |
| — | `app/src/screens/board/TakeoverPanel.tsx:22` "Use here" | the user's explicit take (the button of the goal) |

### 1.7 What readers get today (risk 7.6): nothing `[standing, checked]`

Today a window that does not hold a board does not show it: `BoardCanvas` shows the **take-over panel** in place of the canvas
(`showsPanel(role)` for `taking`, `other`, `lost`; `roles.ts`). There is no reader.

A throwaway probe (an `internal/server` test, run once and deleted) connected two API clients, let the first take a board and
write it, after the second had read the scene: the second got **0 events** after the write, and its own write was refused
`409 not_holder`. The code agrees: `SaveAt` and the PUT route send nothing, and the event table (`editorbridge/events.go`
`Events`) has no event of a revision. The `board` list event carries the board's record (name, group, archive), not its
revision. So 3.1 needs a new event (D3).

### 1.8 The board view today

- `@aiwb/board-view` `endpoint.ts`: `load` replaces the shown board and **remounts Excalidraw** (`Board.tsx` keys it by `gen`),
  starting from the scene's stored scroll and zoom. `viewMode` already exists: the board side sends `viewMode: true` when the
  role is not `held` (`side.ts:180` `viewModeOf`).
- The board side keeps a scene per board and a mirror of the view (`changed` deltas, `snapshot`). A change the view tells is
  kept and saved soon (`keep` → `saveSoon` → `runSave`); `runSave` never writes a board the window does not hold, but marks the
  edit failed, so the next grant saves it (`onGrant`, `roles.ts`).
- Work off screen goes to an engine `BoardChannel` (`core/src/board/channel.ts`) with the requests `restore`, `apply`, `delete`,
  `export` on `{elements}` targets (`board-bridge/src/messages.ts` `EngineOp`). This is the seam the headless writer reuses (D21).

---

## 2. The design

### 2.1 In one picture

```
 window A (writer)          window B (reader)         headless writer (Node, on the server's machine)
 board side + view          board side + view         board side (same code) + Node board engine
   | take (button)            | follow                  | stream, rpc, PUT scene, release
   v                          v                         v
 ------------------------- the client API (same secret, client id, level) -------------------------
 server: editorbridge (holders, waiters, follows, writer/scene events, routing of agent calls)
         boardapi (agent calls: held board -> its holder; free board -> headless writer, started on demand)
         headless.Manager (finds Node, starts/stops the process, gives it its credentials)
```

One writer per board, always `[standing]`. The server keeps refusing every write that is not from the holder or is stale
`[standing]`. What changes: windows stop taking boards on their own, readers follow, the server announces revisions and writers,
and free boards that an agent wants are given to a headless client.

### 2.2 Wire contract (what every package builds against)

This is the one list of what changes between server and clients. Packages refer to it as "the contract".

**New events** (both `Class: Content, Per: PerBoard` in `editorbridge.Events`: sent to the clients that follow the board):

| Event | When | Fields |
|---|---|---|
| `scene` | after every accepted `PUT /api/boards/{id}/scene` | `{"type":"scene","board":"<id>","rev":<new rev>}` |
| `writer` | whenever the holder of the board changes (grant, hand-off, release, a stream that ends, archive/delete); not when it stays | `{"type":"writer","board":"<id>","writer":"window" \| "headless" \| ""}` (`""`: nobody) |

**New routes** (added to `ClientRoutes`, `packages/conn/core/routes.json` and the test host's table):

| Route | Answer |
|---|---|
| `POST /api/boards/{id}/follow` | `200 {"rev": <stored rev>, "writer": "window" \| "headless" \| ""}`; the client follows the board from now on (its `scene` and `writer` events reach it); again is no change. Unknown board: `404` as `GET scene`. Archived: allowed. |
| `POST /api/boards/{id}/unfollow` | `200 {"ok": true}`; no follow is no error. |

A follow ends with the client's stream, with `unfollow`, and with `board_removed` (the bridge forgets follows of a removed item
already, `events.go` `route`).

**Changed routes and events:**

| What | Change |
|---|---|
| `POST /api/boards/{id}/release` | takes an optional body `{"ifIdle": true}`: when nobody waits for the board and the caller has a board call open on it (an `rpc` sent and not answered), the answer is `{"state":"kept"}` and nothing changes. Without `ifIdle`, as today. |
| board calls on a board nobody holds | given to the headless writer (D5): the server makes it the holder and sends it `held {board, rev}` before the `rpc`. |
| board calls on a free board, chat's board held by a window | no longer go to that window (the fallback of `chooseLocked` goes) |
| `get_view`, `show_board` (Screen calls) | go to a window that follows the chat's board, else to the window that holds it, else the server answers in plain words (D7) |
| a call whose board changes hands while it runs | fails with a text of its own (D8), no longer the "window is closed" one |

**Unchanged** `[standing]`: `take` (still the one way to become holder, with its hand-off and `ifFree`), the `PUT scene` checks,
`superseded`, `held`, `release_request`, `rpc`, `server_stopping`, the board file and the messages of the board bridge
(goal section 5).

**Feature level**: see D40 and section 5 (recommended: 7, both ways).

### 2.3 Readers follow live (goal 3.1, 4.8, risk 7.6)

- **D1** `[proposed]` A client follows a board while it shows it: the app calls `follow` when a board comes on screen and
  `unfollow` when it leaves the screen (whether or not it holds it), and calls `follow` again for the board on screen after each
  new stream. Follows are what the server needs for two things: who to tell about revisions and writers, and which windows show a
  board for Screen calls (D7). They are kept in the bridge's per-client `follows` map (the one chats use), with the item
  `editorbridge.Board(id)`, and a follow sequence number so the latest follower can be found.
  *Why a route of its own and not "a scene read starts a follow" as chat reads do:* the board side also reads scenes of boards it
  is not showing (agent work off screen); a follow must mean "on screen".
- **D2** `[proposed]` The `follow` answer carries the stored revision and the writer, so a client that starts to follow knows at
  once whether its kept scene is current and who writes, without waiting for an event.
- **D3** `[proposed]` After each accepted write the PUT route sends `scene {board, rev}` through `Bridge.SendBoard` to the board's
  followers. The writer may get its own event; it ignores a rev that is its own base. Events are queued without blocking
  (`sendRawLocked`), and no follower is waited for: following never delays or blocks the writer (4.8). The scene itself is not in
  the event (scenes reach 128 MB; the stream's buffer is 4096 messages): a reader reads it with `GET scene`.
- **D4** `[proposed]` The bridge sends `writer` to the followers of a board each time `holders[board]` changes (in
  `grantLocked`, `passLocked`, `endLocked` and `ReleaseBoard`'s paths; one helper `writerChangedLocked(board)`). The writer kind is
  `headless` when the holder is the headless writer's client id (D30), `window` for any other client, `""` for none. No client
  id of another client is ever sent (a client id is how the server tells a holder's writes apart; it stays private).
- **A reader's side** (core): on `scene` for a board it does not hold, with a revision that is not its kept scene's base, the board
  side drops the kept scene (`dropScene`, which voids reads in flight and raises the store's `sceneGen`), and the screen shows it
  again: `GET scene`, then `load` to the view. Reads coalesce by themselves: `loadScene` keeps one read in flight per board and
  reads again when the scene was dropped meanwhile (`voided`). A reader that still has an unsaved edit of its own (a writer back
  from a network loss, D16) loses it at a newer revision, with the existing note (`setDropped`, `DROPPED_TEXT`).
- **D6b** `[proposed]` **No reload of the canvas.** The board view applies a `load` of the board it already shows in place:
  `updateScene` with the new elements, the new files added, the reader's own scroll and zoom kept, no new Excalidraw, no undo
  step, the baseline of the deltas reset to the loaded scene, and `loaded` posted again. The message is the same `load`; only
  how the endpoint carries it out changes, so the messages between app and view are not changed (goal 5). The board side shows
  no loading state for such a reload (the status stays `loaded`). *Why:* today every `load` remounts Excalidraw and jumps to the
  stored scroll: a reader would flicker and be thrown to the writer's position after each save.

### 2.4 Routing agent calls (goal 3.3, "a held board is never taken from a person")

- **D5** `[proposed]` A board tool call (`read_board`, `apply`, `delete_elements`, `get_image`) goes:
  1. to the holder of the target when there is one, window or headless writer, as today `[standing]`;
  2. else (away) to the headless writer: the relay first ensures the process runs and its stream is open
     (`headless.Manager.Ensure`, D31), then calls `CallBoard` with `Away: true`. Under the bridge's lock, `chooseLocked` finds the
     target still free, makes the headless client its holder (`grantLocked`), sends it `held {board, rev}` and then the `rpc`, in
     that order on its one stream. If a window took the board meanwhile, the call goes to that window (case 1). This is atomic:
     no window can be overtaken.
  3. If the headless writer cannot run: as today, the call fails with no client (D35 for the text).

  The fallback "the holder of the chat's board takes the target" goes, on both ends: `chooseLocked` no longer falls back to
  `ChatBoard` for board calls, and the board side no longer takes a target (`heldTarget` without the take). *Why:* an agent's
  wish must never make a window the writer (3.2), and away boards are the headless writer's (3.3).
- **D6** `[proposed]` `list_boards` and `create_board` stay answered by the server, so creating a board while away works today
  already and keeps working: the new board is held by nobody, and the agent's next call on it is away (case 2).
- **D7** `[proposed]` Screen calls (`get_view`, `show_board`) need a person's screen. They go to, in this order: the window that
  holds the chat's board if it follows it; else the window that followed the chat's board last; else the window that holds the
  chat's board; never to the headless writer. With none, the relay answers itself, **not as an error**, in plain words (2.10).
  A reader may answer them: they change no board. `show_board` in a window selects the board and never takes it (T7 goes).
  *Why readers:* with the button as the only way to write, the person often looks at a board as a reader; their view and selection
  are what `get_view` is for.
- **D8** `[proposed]` The errors of a call that started but did not finish are told apart (`editorbridge`):
  `ErrNoClient` (nobody to ask, or a window's stream ended during the call: the text of today), `ErrTaken` (the board changed
  hands during the call: a hand-off, an archive, a delete) and `ErrAwayLost` (the headless writer's stream ended during the call).
  Each has its text (2.10). This changes the result only of a call cut by a hand-off, which today wrongly says the window is
  closed; every other answer of a window is unchanged (6.6).

### 2.5 No change from a reader, by any route (goal 3.1)

- **D9** `[standing]` The server's checks already refuse it: `PUT scene` only from the holder; an agent call only to the holder or
  the headless writer it just made holder; `rpc-reply` only from the asked client. This design adds no way for a non-holder to
  write and removes the one indirect way (D5: agent calls through the chat board's holder).
- **D10** `[proposed]` In the app, a reader keeps no edit: the board side ignores `changed` and `snapshot` scenes of a board it does
  not hold (nothing is kept, so nothing can be saved later by a grant), and the view is in view mode for every role but `held`
  `[standing]`. A paste or a drop that Excalidraw lets through in view mode is therefore never kept and never written.
  Edits made while the window was the writer and not yet saved stay until a grant saves them (same revision) or a newer revision
  drops them (D16).

### 2.6 The button (goal 3.2)

- **D11** `[user]` A reader has a visible button; pressing it is `take` (not `ifFree`) — the existing hand-off `[standing]`.
  Opening, switching to, connecting to a board never takes it: T1–T7 are removed (T1: `select` never takes; T2: the canvas no
  longer takes; T3/T4: after a snapshot or a section's return the board on screen is followed, not taken; T5: no take for agent
  calls; T6: no take back after a release answered `free`; T7: `show_board` does not take).
- **D12** `[proposed]` Creating a board in a window (T8 and `nav.ts` `newBoard`) makes that window its writer: the server keeps
  giving the new board to its maker, and the app takes it explicitly after creating it. *Why:* creating is the person's explicit
  act, and a new empty board opened view-only would ask for a second press at once. This is for the user to confirm (section 5,
  Q2).
- **D13** `[standing]` Press on a free board: `held` at once. Press on a held board: the holder is asked, saves its pending change
  (`handOver` flushes first) and releases; the presser gets `held` with the revision after that save, so it starts from it and
  nothing is overwritten by an older version (`onGrant` compares revisions). If the holder does not answer within 10 s it loses the
  board anyway and its later saves are refused `not_holder`.
- **D14** `[standing]` Two presses together: the second take replaces the first waiter, which is sent `superseded` (it stays a
  reader); one window ends as writer. Nothing in this design changes that.
- **D15** `[proposed]` The old writer is told at once: `superseded` (existing, to the holder) and `writer: "window"` (D4) to the
  followers, which include the old writer as long as the board is on its screen. Its bar then says another window took the board.
- **D16** `[user]` A writer that lost its network returns as a reader: its old stream's end freed the board on the server
  `[standing]`; the new stream holds nothing, and T3/T4 no longer take. An edit it made while cut off stays in its kept scene: the
  button saves it when the stored revision is still the one it was made on (`onGrant`), and a newer revision drops it with the note
  (`scene` event or the `follow` answer).
- **D17** `[proposed]` The headless writer yields like a window (3.2): on `release_request` it stops starting new calls on that
  board (they are answered `TAKEN`, 2.10), waits for the call in progress on it (at most the hand-off time minus a margin, 8 s
  by default), saves, releases. A call that does not finish by then fails when the server passes the board (`ErrTaken`), and its
  save, if it comes later, is refused `not_holder`. The board then holds the agent's last finished change (D25).
- **D18** `[proposed]` After a server restart every window comes back as a reader, the one that was writing too (it is D16 for
  every window at once). This follows from D11/D16; it is listed in section 5 (Q3) because it is the most visible effect.

### 2.7 What a window shows (goal 3.1 last bullet)

- **D19** `[proposed]` The take-over panel goes. Every window shows the canvas of the board on screen; for a reader in view mode,
  with a bar over the canvas:

  | Role | Writer | Bar text | Button |
  |---|---|---|---|
  | not held, nobody writes | `""` | "View only." | **Edit here** |
  | not held | `window` | "View only. Another window is editing this board." | **Edit here** |
  | not held | `headless` | "View only. An agent is editing this board." | **Edit here** |
  | lost (taken from this window) | `window` | "Another window took over this board. View only." | **Edit here** |
  | taking | any | "Taking over…" (spinner) | — |
  | held | — | a small "Editing" mark | — |

  With the existing dropped note (`DROPPED_TEXT`) when an edit was dropped. The texts are proposals (section 5, Q5); test ids:
  `board-role` (the bar, with `role` and `writer` attributes as `tid` makes them), `board-take` (the button), `board-editing` (the
  mark). The store keeps `writers[boardKey]` from the `follow` answer and the `writer` events.
- "Who the writer is" is a kind (another window, or the headless writer), not a name: windows have no names today, and naming
  them is outside this goal (section 5, Q5).

### 2.8 The headless writer: what it is (goal 3.3, 4.3, 4.4)

- **D20** `[proposed]` It is a Node program, `packages/headless` (`@aiwb/headless`), bundled by esbuild into one file
  `headless.mjs` with the board engine's assets beside it (2.12). It is a client of the client API like a window `[proposed in the
  goal]`: the connection module in Node (`createClient` of `@aiwb/conn` with `nodeConnector`, pinned TLS and HTTP/2), its own client
  id, the server's secret and level, one event stream.
- **D21** `[proposed]` It runs the app's own board side, `createBoardSide` of `@aiwb/core` (`side.ts`), with no view attached and
  with an engine channel (`setEngine`) made over the Node board engine (section 4). So `runTool`, the formatting of every result,
  `loadScene`/`restore`, `edit`, `getImage`, the save with its revision, `onGrant` and the refusals are the window's code: the same
  `apply` call gives the same result whichever answers it (3.4, 4.4), except what the engine itself computes, which is hb-engine's
  6.1. (Off-screen agent work in a window already goes through this engine path, so the window's own results for boards not on
  screen are produced by exactly this code.)
- **D22** `[proposed]` It does not run the app's state layer (`state/conn.ts`): it has its own small loop over its one stream
  (`packages/headless/src/loop.ts`), which calls the board side and the store functions the board side needs (`boards` and
  `connected` from the snapshot and the `board`/`board_removed` events, `setRole`). *Why:* `conn.ts` serves the app's screens
  (chats, threads, drafts, the library, sections) and keys everything of a non-"local" server entry as a section; the loop needs
  eight event types. Its `BoardApi` (`scene`, `saveScene`, `takeBoard`, `releaseBoard`) is made over the `@aiwb/conn` Client and
  throws core's `ApiError`, which the board side reads.
- **D23** `[proposed]` What it answers:
  - `read_board`, `apply`, `delete_elements`, `get_image` (scopes `all`, `refs`, `rect`; no scope is `all`): through `runTool`.
  - `get_image` with `scope: "selection"`: `NO_SELECTION` with the away text (2.10), before `runTool`.
  - `get_view`, `show_board`: never sent to it (D7); if one comes, the plain words of 2.10.
- **D24** `[proposed]` Text is measured with the real fonts by the engine (4.6 `[user]`): that is section 4's and hb-engine's.

### 2.9 The headless writer: how it behaves

- **D25** `[proposed]` **Saved after each finished change** (4.7): after `apply` and `delete_elements` the loop waits for the save
  (`side.flush(target)`) before it replies; if the board still has an unsaved edit then (`side.boardUnsaved`), it replies
  `SAVE_FAILED: the change was made but could not be saved: …` instead of the result. So "the agent was told it is done" means
  "it is in the board file". (A window keeps its 50 ms save after the reply: unchanged, 6.6.)
- **D26** `[proposed]` **Quiet time** (3.3, goal 8): after the last finished call on a board, the loop waits the quiet time
  `Q`, then, if no call on the board is in progress, saves and sends `release {ifIdle: true}`. `kept` (a call was routed to it
  meanwhile): it keeps the board and waits `Q` again. `free`/`handed`/`none`: it forgets the board (`forgetBoard`: the scene and
  its save state go). `Q` is one value, set by the server (`-headless-quiet`, default `QuietDefault`), passed to the process in its
  start-up configuration, and lowered in tests through `AIWB_TEST_WAITS` (`quiet=`). The number is chosen by measurement
  (package `M1`, section 5 Q1); until then the default is 60 s as a placeholder.
- **D27** `[proposed]` **It takes nothing by itself.** It holds a board only when the server gave it one for an agent's call
  (D5), never the boards that were open when the last window left (3.3 `[user]`), never a held one.
- **D28** `[proposed]` **Its life.** The server starts it when an agent's call needs it and none runs (D31). It stops when it holds
  no board: the server's manager looks every linger (5 s, `linger=` in tests) and, when the headless client held nothing and had
  no call open at two looks in a row, closes its stdin. (A look, not a hook on the last release: a process whose first call went to
  a window that took the board meanwhile never holds anything, and must stop too.) The process also ends by itself, after saving what it holds
  (bounded 2 s), when its stdin closes (the server stopped or died) or when its one stream ends (it never reconnects: the next call
  starts a new one with the then current secret). So with no agent working away it is not running (4.10).
- **D29** `[proposed]` **When it dies mid-change** (3.4, 6.5): its stream ends, so the bridge frees its boards and fails its calls
  with `ErrAwayLost`; the agent is told the call failed (2.10). The board is as after the last finished change, because each
  finished change was saved before it was answered (D25) and a save is atomic `[standing]`. The board is free: a window's button
  gets it at once, and the agent's next call starts a new process. A call to it that times out (30 s) makes the manager kill it,
  with the same outcome.

### 2.10 What the agent is told

| Case | Text (code prefix where it is an error) | Error? |
|---|---|---|
| headless writer cannot run, no window connected | `NoClientText`, unchanged `[standing]` | yes |
| headless writer cannot run, a window is connected | "Nobody is editing this board in a window, and this server cannot edit a board without one. Tell the user that they can press Edit here on the board; don't retry until they ask again." | yes |
| the headless writer stopped during the call (`ErrAwayLost`) | "The board's background editor stopped while it ran this call, so the call did not finish. The board is as it was after your last finished change. Read the board again before you change it." | yes |
| the board changed hands during the call (`ErrTaken`) | "The board was taken over in a window while this call ran, so the call did not finish. Your earlier changes are saved. Read the board again before you change it." | yes |
| a call reaches the headless writer while it yields | "TAKEN: <name> is being taken over in a window; call again in a moment and that window answers." | yes |
| `get_view`, no window shows the chat's board | "No window shows <name> now, so there is no view and no selection to read. The board itself can be read and changed as usual: use read_board, and get_image for a picture." | no |
| `show_board`, no window to show it on | "No window shows this chat's board now, so <name> could not be put on a screen. Your changes are saved in the board; the user sees them when they open it." | no |
| `get_image` `scope: selection`, headless writer | "NO_SELECTION: no window shows <name> now, so nothing is selected on it; use scope all, refs or rect" | yes (as today's NO_SELECTION) |

`<name>` is the board's name and id as `boardRef` writes them. The texts that are "not a failure of the board" (3.3) are plain
results for the two screen tools; the selection one keeps `NO_SELECTION`, the code agents already know. Prompt rule 7 of
`whiteboard.md` and the descriptions of `get_view`, `get_image` and `show_board` (`internal/boardtools/tools.go`) say that a
board can be worked on while no window is open, and that the screen tools need a window.

### 2.11 Starting, finding and authenticating it (goal 4.9, 4.10, risk 7.5)

- **D30** `[proposed]` **Identity.** The server's manager makes a new client id (UUID v4) for each start and tells the bridge
  (`Bridge.SetAway(id)`), so the bridge knows which client is the headless writer: for routing (D5), the writer kind (D4) and to
  keep Screen calls away from it (D7). That id is never sent to another client.
- **D31** `[proposed]` **Start, by the server, only for an away call.** `headless.Manager.Ensure(ctx)`: if a process runs and
  `Bridge.Known(id)`, its id; else start one and wait until its stream is open (the process opens its stream only after its engine
  said `ready`, so an open stream means it can work), at most the start limit (20 s; `hstart=` in tests); callers at the same time
  share one start. A failed start is remembered for 60 s (`hretry=`): calls in that time fail at once with the 2.10 text, and the
  log has one line per failure with the reason.
- **D32** `[proposed]` **Credentials** (4.9 `[standing]`): the process gets, as one JSON line on its stdin and nowhere else (not in
  argv, not in its environment): the address `127.0.0.1:<client port>`, the certificate fingerprint to pin, the server's current
  secret, its client id, the instance id, the quiet time and the hand-off margin. It then calls the client API with the secret, the
  id and level 7 (or 6, D40) like any app: the server checks it as it checks every client. It is no way in without them; a
  process started by anyone else gets nothing it could not get with the secret. After `remote setup --new-secret` the server
  closes every stream (`ReloadSecret`), the process ends (D28), and the next start gets the new secret.
- **D33** `[proposed]` **Finding a Node runtime** (7.5). In this order, the first that exists:
  1. `-headless-node <path>` (or `AIWB_HEADLESS_NODE`): that program;
  2. the desktop app's own Electron, when the server binary runs from `…/AI Whiteboard.app/Contents/MacOS/` and
     `Contents/MacOS/AI Whiteboard` is there: run with `ELECTRON_RUN_AS_NODE=1` `[not verified]` (package `W14` confirms it on the
     built app, including the native canvas module, which must be N-API to load in both);
  3. `node` on the server's `PATH`, with `node --version` of v22 or later.
  None: the headless writer is unavailable; agents are told as in 2.10; nothing else changes (4.10, 6.5). Looked up at the first
  away call, not at boot (no process is started for it at boot), and again after the retry wait (Node may be installed later).
  *Why this order:* the app on a Mac always carries a Node (Electron), so the common case needs no install; a server folder on
  another machine uses the Node that its agent CLIs usually need already; a flag covers the rest.
- **D34** `[proposed]` **Finding the bundle.** `-headless-dir <dir>`; else `<exe dir>/../Resources/headless/` (the Mac app); else
  `<exe dir>/headless/` (the server folder of `build-server.sh`). It holds `headless.mjs` and `manifest.json` `{version, os, arch}`;
  a bundle of another version than the server (other than `dev`) is not used (logged), so the server and its headless writer are
  always one build.
- **D35** `[proposed]` **Running it.** Working folder: the bundle folder; its own process group (`internal/agent/procgroup.go`
  `StartGroup`); environment: the server's, plus `ELECTRON_RUN_AS_NODE=1` for Electron; stdout and stderr go to the server's log,
  line by line, prefixed `headless:` (the process never prints the secret or board content). Stop: close stdin, 3 s, `SIGTERM` to
  the group, 2 s, `SIGKILL`. At the server's shutdown: `StopAndFlush` (the headless writer is a holder like any other and gets
  `server_stopping`), then the manager stops it.
- **D36** `[proposed]` `ai-whiteboard status -json` gets `"headless": {"available": bool, "reason": "…", "running": bool, "pid": n,
  "boards": n}`; the e2e scripts use the pid. No client-API route about it.

### 2.12 Where it lives and how it ships

- **D37** `[proposed]` Repository:
  - `packages/headless/` — the process: `src/main.ts` (stdin configuration, engine start, the loop, exit), `src/loop.ts` (events →
    board side, rpc handling, quiet time, yield), `src/api.ts` (the `BoardApi` over the conn Client), `src/texts.ts` (2.10's
    headless texts), `src/memstore.ts` (a `Store` port holding the one entry and the given client id), `build.mjs` (esbuild →
    `dist/headless.mjs` + the engine's assets + `manifest.json`), `test/` (node --test, a fake engine and a fake client).
  - `internal/headless/` — the Go manager (`Manager`, `find.go`, `run.go`), imported by `cmd/ai-whiteboard`.
  - The engine for Node: hb-engine's package (named `ENGINE` below; section 4).
- **D38** `[proposed]` Shipping:
  - The Mac app (`scripts/build-app.sh`, `desktop/electron-builder.yml`): `packages/headless` is built into
    `desktop/build/headless/`, and `extraResources` copies it to `Contents/Resources/headless/`. The runtime is the app's Electron
    (D33.2).
  - The server folder (`scripts/build-server.sh <os>/<arch>`): the same build for that target into `<out>/headless/`, with the
    engine's native module for that target (ENGINE says how it is fetched per target; risk 7.4). The folder's README says that
    editing boards with no window open needs Node 22 or later on the machine, and that without it the server works as before.
  - No change to the phone app.
- **D39** `[proposed]` Development and tests: `-headless-dir packages/headless/dist -headless-node "$(command -v node)"`.

### 2.13 Feature level

- **D40** `[proposed]` Raise `FeatureLevel` and `MinClientLevel` (`internal/server/clients.go`) and `MIN_FEATURE_LEVEL` and
  `CLIENT_LEVEL` (`packages/conn/core/outcomes.js`) from 6 to 7. *Why:* the new rules need both ends. A new app on an old server
  would get agent calls routed through it for boards it does not hold (refused now), and no reader would follow live; an old app
  on a new server would take boards when it opens them, against 3.2. With 7 both ways, a mix shows "too old" with its existing
  texts, as level 6 did. Cost: a remote server on another machine must be updated together with the app. For the user to confirm
  (section 5, Q4).

---

## 3. What stays as it is (goal 3.5, 6.6)

- The board file, its colours, `scene.rev`, the PUT checks, the hand-off and its 10 s, `FreeBoard` for archive and delete.
- The result of every board call that a window holding the board answers (only a call cut by a hand-off gets a better text, D8).
- The messages between the app and the board view (only the endpoint's handling of a `load` of the board already shown, D6b).
- Chats, agents, the library, sections, remote servers: the headless writer belongs to the server that stores the board, and a
  board of another server is followed, taken and routed on that server by the same rules.

---

## 4. The boundary with the engine (for `hb-engine`)

The headless writer process = connection client + the app's board side (D21) + the board engine. The board side already talks to
an engine through a `BoardChannel` (`packages/core/src/board/channel.ts`) with the board bridge's messages; on a phone that
engine is a web view. The headless writer makes the same channel over a Node endpoint. So the engine module has to be **the board
view's endpoint, in Node, for the requests on given elements** — the same messages, the same values, the same error codes:

```ts
// What packages/headless expects of ENGINE (its Node entry, e.g. "@aiwb/board-engine/node").
import type { ToBoard, FromBoard } from "@aiwb/board-bridge/messages.ts";

export type NodeEndpointOptions = {
  /** The folder of the engine's files inside the headless bundle (fonts, the native canvas, …): the process passes
   *  `<bundle dir>/engine`. */
  assets: string;
  /** What `ready` tells as its version. */
  version?: string;
  /** Where the engine logs a line; never board content. Default: stderr. */
  warn?: (text: string) => void;
};

export type NodeEndpoint = {
  /** A message of the app, already validated (validateToBoard). A `req` is answered with one `res` through `post`; every
   *  other message (`load`, `unload`, `viewMode`, `theme`, `select`, `scrollTo`) is ignored and answered with nothing. */
  receive(m: ToBoard): void;
  /** A message that failed validation: logged; a `req` among them is answered `res ok:false code BAD_MESSAGE`, as the board
   *  view's endpoint does. */
  refuse(raw: unknown, error: string): void;
  /** Frees what the engine holds (the canvas). */
  close(): Promise<void>;
};

/** Starts the engine (the stand-in page, the fonts registered with the canvas). Resolves once it can work, after posting
 *  `{ t: "ready", version }` once. Rejects, posting nothing, with an Error whose message says why it cannot run here (the
 *  native canvas did not load, a font file is missing): the process prints it and exits, and the server tells agents that it
 *  cannot edit boards with no window (2.10). */
export function createNodeEndpoint(post: (m: FromBoard) => void, options: NodeEndpointOptions): Promise<NodeEndpoint>;

/** Build-time, for packages/headless/build.mjs: the module names esbuild must leave external (native modules), and the copy
 *  of the engine's files for one target into `<dir>` (the bundle's `engine/` folder). */
export const ENGINE_EXTERNALS: string[];
export function copyEngineAssets(dir: string, target: { os: "darwin" | "linux"; arch: "arm64" | "x64" }): Promise<void>;
```

The requests it must answer, as `@aiwb/board-view` `endpoint.ts` `ops` answers them for a target that is not `"live"`
(`EngineOp`, `EngineValues` in `packages/board-bridge/src/messages.ts`, checked by `validateEngineValue`):

| Request | Answer |
|---|---|
| `{op:"restore", elements}` | `RestoreValue` — Excalidraw's `restoreElements` (this is "load a scene": the board side keeps the scene, the engine keeps nothing) |
| `{op:"apply", target:{elements}, params, rev}` | `ApplyValue` with `elements` — `apply.ts` `applyChanges` on the given elements, as `ops.apply` |
| `{op:"delete", target:{elements}, refs, cascade, rev}` | `ApplyValue` with `elements` — as `ops.delete`, the cascaded bound labels included |
| `{op:"export", target:{elements, files, appState}, ids, scale, background}` | `ExportValue` — as `exportPicture`, with the same limits and codes (`TOO_LARGE`, `EMPTY`, `RENDER_FAILED`) (this is "draw a picture") |
| `{op:"snapshot"}`, or any `target:"live"` | `res ok:false code NO_BOARD` "no board is shown" |

- Errors are `res ok:false` with the `RpcError` code and message, `FAILED` for anything else, as `endpoint.ts` `request()`.
- "Take the current scene to save" is not the engine's: the board side keeps the scene (the elements every `apply` answers) and
  saves it itself, as it does in a window. The engine is stateless between requests; the board side sends one request at a time
  per board.
- The headless process wires it as `createChannel((m) => endpoint.receive(m))` with the channel's `receive` as the endpoint's
  `post`, in-process (objects, no JSON text).
- Expectation (4.4 "one engine"): the code that answers these four requests is the same module in the board view and in Node —
  hb-engine may move the non-live half of `endpoint.ts`'s `ops` into a module both import. That is hb-engine's call; this
  interface only fixes the messages.
- If hb-engine needs something else (state between requests, another request, a different start), it says so, and the
  headless package's `src/engine.ts` adapter is the one place that changes.

---

## 5. Open for the user

| # | Question | Recommendation |
|---|---|---|
| Q1 | The quiet time before the headless writer lets a board go (goal 8). | Decide after package `M1` measures a reload (process start, engine ready, a small and a large board): a quiet time a few times the reload cost, likely 30–120 s. Until then 60 s. |
| Q2 | Does creating a board in a window make that window its writer (D12)? The goal makes the button the only way to become writer; creating is not named. | Yes: creating is an explicit act, and a new empty board opened view-only asks for a second press at once. |
| Q3 | After a restart of the server (an update) every window comes back as a reader, the one that was writing too (D18), and has to press the button. | Accept: it is the network-loss rule (3.2, `[user]`) for everybody at once; any automatic return would be a way to become writer without the button. |
| Q4 | Raise the feature level to 7 on both sides (D40), so an updated app and an older remote server (or the other way) refuse each other with "too old"? | Yes. |
| Q5 | The words of the reader bar and the button (D19: "View only. An agent is editing this board." / "Edit here"), and whether "another window" should one day name the device. | Take the proposed words; naming windows is a later goal. |

**Taken by the orchestrator (Opus) for now, to be confirmed by the user at the end:** Q2 yes (creating a board in a window
makes it the writer), Q3 accepted, Q4 yes (level 7, W7 runs), Q5 the proposed words. Q1 stays at 60 s until M1 measures it.

---

## 6. Work packages

Each package is for Sonnet 5.5 unless it says otherwise. Each one: works in its own worktree off `headless-board` (or the branch its
parent names), follows `AGENTS.md`, commits, and reports with the commands below and their results. "The contract" is section 2.2.
Go acceptance always includes, before finishing, `go test ./...` once and the full set of each changed package
(`AIWB_TEST_FULL=1 go test ./internal/<pkg>`), and `-race` where goroutines share state. JavaScript acceptance from the root is
`npm test && npm run check`, plus the package's own commands.

### Wave 1 (independent of each other)

**W1 — Bridge: follows, writer and scene events, away routing, call errors** (`internal/editorbridge` only)
- Board items may be followed: `Follow`/`Unfollow` with `Board(id)`; a follow sequence per client so the latest follower is found;
  `FollowBoard(clientID, board) (rev int64, writer string, ok bool)` (follows and answers the rev via `SceneRev` and the writer
  kind). Update the comment "Board … is not followed".
- Event table: `scene` and `writer` as `Content, PerBoard` (`events.go`). `writerChangedLocked(board)` sends `writer` to the
  board's followers whenever `holders[board]` changes (grant, pass, release, end of a stream, `FreeBoard`, `LoseBoard`), and only
  when the kind changed or the holder changed.
- `SetAway(clientID string)` (the headless writer's id; `""` none) and `WriterOf(board) string` (`window`/`headless`/`""`).
- `CallSpec.Away bool`: in `chooseLocked`, a non-Screen call on a free `Board` with `Away` set and the away client connected:
  `grantLocked(away, board)`, send it `held {board, rev}` (then `writer`), and choose it. Remove the `ChatBoard` fallback for
  non-Screen calls. Screen calls (D7): the non-away holder of `ChatBoard` if it follows it, else the latest non-away follower of
  `ChatBoard`, else the non-away holder of `ChatBoard`, else none.
- Errors (D8): `ErrTaken` for calls failed by `passLocked` (hand-off, `FreeBoard`, `LoseBoard`), `ErrAwayLost` for calls of the away
  client whose stream ended, `ErrNoClient` as today for the rest. Keep `ErrNoClient`'s text.
- `ReleaseBoardIf(clientID, board string, ifIdle bool) string`: `kept` when `ifIdle`, nobody waits, and the caller has an open call
  on the board; else as `ReleaseBoard`.
- `HoldsAny(clientID) bool`, `HasCalls(clientID) bool`, `WindowsConnected() bool` (a connected client other than the away one).
- Fix the stale `TakeBoard` comment about API clients.
- Tests in `internal/editorbridge` (bridge_test.go style, with `bridgetest` pages): every bullet, including: a reader follower gets
  `writer` on grant, hand-off and stream end; the away grant is atomic against a take; a Screen call prefers a following window and
  never the away client; a call cut by a hand-off is `ErrTaken`; release `ifIdle` with an open call is `kept`.
- Accept: `go test ./internal/editorbridge`, `go test -race ./internal/editorbridge`, `AIWB_TEST_FULL=1 go test ./internal/editorbridge`,
  then `go test ./...`. Other packages must still build and pass (the server and boardapi call `CallBoard`/`ReleaseBoard` as today).
- Do not touch: routes (`internal/server`), the relay (`internal/boardapi`), anything outside the package.

**W2 — Go manager of the headless writer** (`internal/headless`, new; no wiring into `cmd`)
- `Manager` as D30–D36: `New(b Bridge, l Listener, o Options) *Manager` with `Bridge interface{ Known(string) bool; SetAway(string);
  HoldsAny(string) bool; HasCalls(string) bool }`, `Listener{Port int; Fingerprint string; Secret func() string; InstanceID string}`,
  `Options{Node, Dir string; Quiet, StartLimit, Linger, Retry, Handover time.Duration; Env []string; Logf func(string, ...any)}`
  (zero durations: 60 s, 20 s, 5 s, 60 s, 8 s; `QuietDefault` exported).
- `Ensure(ctx) (clientID string, err error)` (D31; shared start; remembered failure with reason; `ErrUnavailable` wrapping the
  reason), the idle stop of D28 (a look every `Linger` while a process runs: `!HoldsAny && !HasCalls` at two looks in a row stops
  it), `CallTimedOut()` (kill), `Close()`, `Status() Status` (D36).
- `find.go`: runtime (D33) and bundle (D34, with the manifest version check against `internal/version.Version`, `dev` accepts
  any), each a function with injectable lookups for tests (executable path, `exec.LookPath`, a `--version` runner).
- `run.go`: start (D35), the stdin JSON line `{"address","fingerprint","secret","clientId","instanceId","quietMs","handoverMs",
  "version"}`, log lines, process group, stop sequence, `SetAway` before the start and `SetAway("")` after the exit.
- Tests: with a fake `Bridge` and a stand-in program (a tiny script written by the test into `t.TempDir()`, run with `/bin/sh`
  as the "runtime", that reads the stdin line, writes it to a file, and waits for stdin to close); check: the config line (and
  that the secret is not in argv or the environment), shared start, start limit, a start that exits early (reason kept), retry
  wait, idle stop after linger, kill on timeout, find order (flag, Electron next to a `…/Contents/MacOS/ai-whiteboard`, PATH,
  version too old), bundle version check. Lower every wait through `Options`.
- Accept: `go test ./internal/headless`, `go test -race ./internal/headless`, `AIWB_TEST_FULL=1 go test ./internal/headless`,
  `go test ./...`.
- Do not touch: `cmd/`, `internal/editorbridge`, `internal/boardapi`.

**W4 — Core: no automatic take, a reader keeps no edit** (`packages/core` only)
- `side.ts`: `heldTarget` without the take (`NOT_HOLDER` when not held); `takeAfterSnapshot` and `sectionBack` take nothing (keep
  their reload of the on-screen scene; rename `takeAfterSnapshot` → `afterSnapshot` in `ports.ts` `BoardSide` and its caller in
  `conn.ts`); `handOver` does not take back after `free`; `show_board` selects with no take option; `changed`, `syncLive` and
  `keep` do nothing for a board whose role is not `held` (D10); edits kept from while it was held stay (D16).
- `roles.ts`: `takeOnSelect` answers `null` always (marked to be deleted by W11, which removes its caller); add
  `readOnly(role) = role !== "held"`; keep `showsPanel` for W11 to remove. Update the comments that describe the old takes.
- Tests (`packages/core/test/roles.test.ts`, `test/board/*.test.ts`): each removed take is gone (a board on screen after a snapshot
  is not taken; an agent call on a board not held answers `NOT_HOLDER` and makes no take call; `show_board` makes no take call;
  a release answered `free` makes no take call); a reader's `changed` and paste are not kept and never written, also after a
  later grant; an edit kept from before a network loss is saved by a grant at the same revision and dropped at another.
- Accept: from the root `npm test && npm run check`.
- Do not touch: `app/`, `api.ts`'s routes, the store's shape (W8 adds to it), `conn.ts` beyond the one rename.

**W5 — The headless writer process, with a fake engine** (`packages/headless`, new)
- As D20–D29 and section 4: `src/main.ts`, `src/loop.ts`, `src/api.ts`, `src/memstore.ts`, `src/texts.ts`, `src/engine.ts`
  (adapter: `createNodeEndpoint` from ENGINE, behind a seam so tests pass a fake; until ENGINE exists the import is a stub that
  rejects "the board engine is not built"), `build.mjs`, `package.json` (workspace `@aiwb/headless`, `test` and `check` scripts
  like `packages/core`'s).
- The loop takes a client-like object `{ subscribe(onEnvelope), call(req) }` so tests use an in-memory fake; `main.ts` makes the
  real one with `createClient({ connector: nodeConnector(), store: memStore(entry, clientId), local: null })`.
- Event handling: `hello` → `side.streamOpened()`; `snapshot` → boards and `connected` into the store; `board`/`board_removed`;
  `held` → `side.granted`; `superseded` → `side.boardLost` then forget; `release_request` → yield (D17, own code: stop new calls on
  the board, wait for the one in progress up to `handoverMs`, `side.flush`, `POST release`, forget); `rpc` → 2.8/2.9 (screen tools'
  words, selection text, TAKEN while yielding, `runTool`, save before reply D25, reply with `POST /api/rpc-reply`, ignore 409);
  `server_stopping` → `side.flushAll()` then `POST /api/client/flushed`. Quiet time D26 with `release {"ifIdle": true}`. Exit D28
  (stdin end, the stream ending after it was connected, exit code 3 with the reason when the engine or the first connection
  fails within 20 s).
- Test knob for E3: with `AIWB_HEADLESS_TEST=hold-before-save` in its environment the loop, after `runTool` of an `apply` and before
  the save, prints `headless: HOLD apply <board>` to stderr and waits forever.
- `build.mjs`: esbuild, platform node, ESM, target node22, one file `dist/headless.mjs`, externals `ENGINE_EXTERNALS`, then
  `copyEngineAssets` into `dist/engine/` and `dist/manifest.json`. Until ENGINE exists the build works without them (a stub).
- Tests (`node --test`, fake client + fake endpoint that answers `restore`/`apply`/`delete`/`export` deterministically): the order
  `held` then `rpc` gives a result; apply is saved before the reply (the fake client sees `PUT scene` before `rpc-reply`); a failed
  save answers `SAVE_FAILED`; quiet release after `Q` (lowered), `kept` re-arms; yield waits for the call in progress and releases;
  a call while yielding is `TAKEN`; screen tools and the selection scope give the 2.10 words; stdin end saves and exits;
  `server_stopping` flushes then posts flushed; the secret never appears in any log line.
- Accept: `cd packages/headless && npm test && npm run check && node build.mjs` (the build may use the engine stub), and from the
  root `npm test && npm run check`.
- Do not touch: `packages/core` (if the board side lacks something, report it; do not patch it), `packages/conn`.

**W6 — Board view: a `load` of the shown board is applied in place** (`packages/board-view` only)
- D6b in `endpoint.ts` (and `Board.tsx` if needed): same board id, already drawn (`api` set) → `updateScene` with the elements
  (no undo capture), `addFiles` for files not there, the current scroll and zoom kept, `viewBackgroundColor` from the message,
  `viewMode`/`theme`/`style` of the message applied, the delta baseline reset to the loaded scene (`told`), `loaded` posted again,
  and no `changed` caused by the update itself. Any other `load` as today.
- Tests: the package's unit tests for the in-place path (no remount: the Excalidraw key does not change; baseline; no `changed`);
  the harness's `behaviours` gets a case "a reader's board follows a load in place, keeps its scroll".
- Accept: `cd packages/board-view && npm test && npm run check && npm run build:web && npm run build:webview && ONLY=behaviours node dev/harness.mjs`
  (Playwright, see `AGENTS.md`), and from the root `npm test && npm run check`.
- Do not touch: `packages/board-bridge` (messages unchanged), `packages/core`.

### Wave 2

**W3 — Server routes: follow, unfollow, scene event, release if idle** (`internal/server`, `packages/conn/core/routes.json`,
`web/dev/hostface.mjs`'s table) — depends on W1
- `POST /api/boards/{id}/follow` and `/unfollow` (the contract), in `ClientRoutes`, `routes.json` and the host's table; the
  `PUT scene` route sends `scene` after a stored write (`Bridge.SendBoard`); `release` reads `{"ifIdle": true}` and calls
  `ReleaseBoardIf`.
- Tests: `internal/server` (route table tests stay green: `routes_file_test.go`, `clienthandler_test.go`), a test that a reader that
  followed gets `scene` with the new rev after the writer's PUT and gets no event before following; follow's answer; `unfollow`
  stops the events; `ifIdle`. Host: `node --test web/dev/hostface.test.mjs`.
- Accept: `go test ./internal/server`, `AIWB_TEST_FULL=1 go test ./internal/server`, `go test ./...`,
  `cd packages/conn && npm test`, `node --test web/dev/host.test.mjs`, `cd web && npm test`.
- Do not touch: the relay, the bridge's API (ask W1's owner via the orchestrator if it lacks something).

**W8 — Core: follow the board on screen, writers in the store** (`packages/core`) — depends on W4
- `api.ts`: `followBoard(id)` → `{rev, writer}`, `unfollowBoard(id)`, `releaseBoard(id, ifIdle?)`; `BoardApi` gets `followBoard`
  and `unfollowBoard` as optional members (the headless writer's `BoardApi` has none).
- Store: `writers: Record<boardKey, "window" | "headless" | "">`, `setWriter`; cleared for a server's boards at its `hello`, and with
  a removed board.
- `ports.ts` `BoardSide`: `sceneMoved(id, rev)`; `side.ts`: `show(id)` follows (and `leave` unfollows) through the api; the follow's
  answer sets the writer and, for a board not held, drops a kept scene at another revision; `sceneMoved` does the same (with the
  dropped note when an edit was kept, D16); `afterSnapshot`/`sectionBack` follow the board on screen again; a reload of the board
  on screen keeps the status `loaded` (no loading state; W6 draws it in place).
- `conn.ts`: `scene` → `boardSide().sceneMoved(key(board), rev)`, `writer` → `setWriter(key(board), writer)`, both in `OF_A_THING`
  (section boards are keyed as the other events are).
- Tests: core tests for each, including a section's board (a remote server's ids).
- Accept: from the root `npm test && npm run check`.
- Do not touch: `app/`, `packages/conn`.

**W9 — Relay: away routing and the agent's texts** (`internal/boardapi`, `internal/boardtools`, `internal/prompts`) — depends on W1
- `Relay.Away interface{ Ensure(ctx context.Context) (string, error); CallTimedOut() }` (nil: no headless writer). `CallResult`:
  D5 (if the target has no holder, `Ensure` then `CallSpec{Away: true}`), D7 (Screen calls: no client → the plain words, not an
  error), the error texts of 2.10 for `ErrTaken`, `ErrAwayLost`, unavailable (with `WindowsConnected` choosing between the two
  texts), and `CallTimedOut()` when a call routed to the away client timed out. Keep every other answer byte for byte.
- `boardtools/tools.go`: the descriptions of `get_view`, `get_image` (selection) and `show_board` say they need a window showing
  the board; `whiteboard.md` rule 7 (and 8) as 2.10 says. Update the prompt tests that pin the text.
- Tests in `internal/boardapi` with a fake `Away` and `bridgetest` clients: away call is answered by the away client and it got
  `held` first; a held board's call never reaches the away client; window-held results unchanged (the existing tests stay green
  untouched); each 2.10 text.
- Accept: `go test ./internal/boardapi ./internal/boardtools ./internal/prompts`, the full set of each, `go test -race ./internal/boardapi`,
  `go test ./...`.
- Do not touch: `cmd/`, the bridge.

### Wave 3

**W10 — Wiring in the server program** (`cmd/ai-whiteboard`) — depends on W2, W3, W9
- Flags `-headless-node`, `-headless-dir`, `-headless-quiet` (D26, D33, D34) on the server's run and on `launch` (passed through as
  the other flags are); `AIWB_TEST_WAITS` names `quiet`, `hstart`, `linger`, `handover` (the bridge's hand-off) in
  `testwaits.go` and the `clock` helper; the manager made in `main.go` with the bridge and the client listener's port, fingerprint,
  secret and instance id; `relay.Away = m`; shutdown: `StopAndFlush` then `m.Close()`; `status
  -json` gets `headless` (D36); `docs/server-reference.md` names the flags.
- Tests: default set: flags parse, `testwaits` names; full set (real server processes, `testset.SkipUnlessFull` with reasons naming
  the default-set tests): (a) `-headless-node /nonexistent`: a fake-claude chat's `[[mcp read_board …]]` on a free board gets the
  unavailable text and no process is started; (b) with a stand-in headless (`-headless-node` set to a small Go or Node stand-in
  built once per test binary that connects with the given credentials using `bridgetest`-like code over HTTPS, takes nothing,
  answers `rpc` with a fixed result) an away call is answered by it and `status -json` shows it running, then it is stopped after
  the lowered linger.
- Accept: `go test ./cmd/ai-whiteboard`, `AIWB_TEST_FULL=1 go test ./cmd/ai-whiteboard`, `go test ./...`.
- Do not touch: `internal/*` beyond what the wiring needs (report anything else).

**W11 — App: the reader bar, no takes on navigation** (`app/` only) — depends on W4, W8
- `BoardCanvas.tsx`: no take when a board is shown; the canvas for every role (view mode unless held); `TakeoverPanel.tsx` replaced
  by a `RoleBar` (D19 texts and test ids; the button takes with `boardApp.takeBoard(board)`; the dropped note stays); the "Editing"
  mark for the writer. `nav.ts`: `select` never takes, `newBoard` takes the new board explicitly (D12), remove `takeOnSelect` and
  `showsPanel` from `roles.ts` and their tests. Update `web/e2e/lib/ui.mjs` selectors for the new test ids.
- Accept: from the root `npm test && npm run check`; `cd web && npm test`. Browser checks are W12's (they need the mock).
  (`web/e2e/twopages.e2e.mjs` checks (b), (c), (e), (f) assume the old takes and are moved by E2.)
- Do not touch: `packages/*`, `web/dev/mock.mjs`.

**W7 — Feature level 7** (`internal/server/clients.go`, `packages/conn/core/outcomes.js`, the tests that pin 6) — depends on W3;
only if the user answers yes to Q4
- Accept: `go test ./...`, full set of `internal/server` and `cmd/ai-whiteboard`, `cd packages/conn && npm test`,
  `node --test web/dev/host.test.mjs`, `cd web && npm test`, `cd desktop && npm test`.

### Wave 4

**W12 — Mock and browser checks** (`web/dev/mock.mjs`, `web/dev/checks/`) — depends on W6, W8, W11
- Mock: the follow/unfollow routes and answers; a take answers `held` and the board is held by the page only after a take (as
  the server); knobs `writer(board, kind)` (sends `writer`) and `othersave(board, scene)` (stores a new rev and sends `scene`), so a
  check can show a reader following another writer or the headless writer.
- Checks: update `L5-board-roles`, `SEC.7-board`, `AAC.2-board`, `SEC.9-storage`, `L6-agenttools` (and `web/dev/agenttools.mjs`),
  `L24-boardui` to the button (press **Edit here** where a check draws); a new check `HB.1-reader` (desktop and phone): the bar's
  three texts, the button takes, a reader follows a save of another writer without a reload and keeps its scroll, a reader's
  paste is not saved, opening a board does not take it.
- Accept: `cd web && npm test`; `cd web && npm run uicheck -- L5 SEC.7 AAC.2 SEC.9 L6 L24 HB.1` (Playwright 1.64.1, `AGENTS.md`).
- Do not touch: `app/`, `packages/*` (report a product fault instead).

**W13 — Shipping the headless writer** (`scripts/build-app.sh`, `desktop/electron-builder.yml`, `scripts/build-server.sh`,
`scripts/remote/README.md`) — depends on W5 and ENGINE (its assets and per-target native module)
- D38. Accept: `scripts/build-app.sh` builds and `AI Whiteboard.app/Contents/Resources/headless/{headless.mjs,manifest.json,engine/}`
  are there; `scripts/build-server.sh` for this machine's target has `headless/`; both manifests carry the build's version.

**W15 — Documentation** (`docs/architecture.md`, `docs/server-reference.md`, `docs/troubleshooting.md`, `README.md` where it says
boards change only with the window open) — after W9, W10, W11; only documentation, no tests.

### Wave 5 (confirmation; all need ENGINE, W1–W13; no paid model anywhere: the agent is `internal/agenttest/fake-claude`)

**E1 — Away (goal 6.2)**: `web/e2e/away.e2e.mjs`. A `Scratch` server with `-claude <standInAgent>`, `-headless-dir
packages/headless/dist -headless-node <node>`, no window: a board chat (made through the API) is sent one message with
`[[mcp read_board {}]]`, `[[mcp apply {…three creates, a bound arrow, an update…}]]`, `[[mcp get_image {"scope":"all"}]]`,
`[[mcp create_board {"name":"second"}]]`, `[[mcp apply {"board":"<second>", …}]]`; the reply contains no `NoClientText`; the
picture is a PNG. Then a page (test host + Playwright) connects and shows the board: every element is there, in the order made, the
stored rev equals `scene.rev`, the page is a reader with the bar "An agent is editing…" or "View only." (after the quiet time,
lowered with `AIWB_TEST_WAITS=quiet=3s`). Accept: `node web/e2e/away.e2e.mjs` passes; its header says how it runs.

**E2 — Readers, writer and the button (goal 6.3)**: `web/e2e/readers.e2e.mjs`, and `web/e2e/twopages.e2e.mjs` moved onto the
button. Three pages (three hosts, as `twopages` does) on one server: (a) opening, switching, reconnecting never makes a page writer;
(b) page 1 presses **Edit here**, draws: pages 2 and 3 show each change without a reload; (c) a reader's drawing, paste and a direct
`PUT scene` with its client id are refused, the stored rev does not move; (d) page 2 presses while page 1 has an unsaved change:
the change is in the board, page 2 starts from that rev, page 1 shows "Another window took over this board."; (e) the headless
writer holds the board (a fake-claude `apply` loop with `[[sleep]]` between calls) and page 3 presses: the agent's finished changes
are kept, the call in progress finishes or fails with the `ErrTaken`/`TAKEN` text, page 3 is writer; (f) a holder whose release is
held up (as `twopages` (d)) loses the board at the hand-off time (lowered `handover=`) and its later save is refused; (g) two pages
press together: one writer, one reader, the board file valid. Accept: both scripts pass.

**E3 — Failure (goal 6.5)**: `web/e2e/headlessfail.e2e.mjs`. With `AIWB_HEADLESS_TEST=hold-before-save` in the server's
environment, a fake-claude chat does one `apply`, then a second; when the server log shows `HOLD apply`, the script kills the
headless process (`status -json` pid); the board file is valid JSON and has exactly the first change, `scene.rev` is the first
save's, the board is free (a page's **Edit here** gets `held` at once), and the agent's reply has the `ErrAwayLost` text; a new call
starts a new process. Second part: a server with `-headless-node /nonexistent` answers an away call with the unavailable text,
starts nothing, and everything else (a chat, a board shown in a page) works. Accept: `node web/e2e/headlessfail.e2e.mjs` passes.

**W14 — The Mac app's Electron as the runtime** (probe, report in `plans/headless-board/w14-electron-node.md`) — after W13: on the
built app, the server binary of the bundle with no `node` on `PATH` (an empty `PATH` for the server) starts the headless writer
with `ELECTRON_RUN_AS_NODE=1`, the native canvas loads, `get_image` draws; no Dock icon or window appears. If it fails, the report
says why and the fallback (ship a Node, or require one) is for the user.

**M1 — Measure the quiet time** (Opus or Sonnet; report `plans/headless-board/m1-quiet-time.md`) — after E1: the cost of a cold
start (process, engine ready, stream open) and of a reload of a small and a large board, a few runs each, and a proposed quiet
time with its reason for the user (Q1).

### Wave 6

**E4 — Nothing else moved (goal 6.6)** — after everything: `go test ./...`; `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once while
nothing else tests; `go test -race ./internal/editorbridge ./internal/headless ./internal/boardapi`; from the root
`npm test && npm run check`; `cd web && npm test`; `cd desktop && npm test`; `cd packages/conn && npm test`;
`node --test web/dev/host.test.mjs`; the free e2e scripts (`newchat`, `twopages`, `remotechat` also with `VIEWPORT=phone`,
`localserver`, `away`, `readers`, `headlessfail`) and `cd desktop && npm run e2e`; the browser checks of W12; a check that a board
opened and shown by a reader is not written (its `drawing.excalidraw` and `scene.rev` unchanged after a reader session); and the
device flow that covers the board, `node app/e2e/run.mjs board-webview --platform ios --device hb-e4` on a simulator made for it
and deleted after (the board in a web view changed with W6 and W11; adapt the flow to press **Edit here** if it draws). Report
each command with its result.

### Dependencies at a glance

| Package | Needs | Wave |
|---|---|---|
| W1 bridge | — | 1 |
| W2 Go manager | — (its `Bridge` interface is W1's methods; a fake in its tests) | 1 |
| W4 core no-take | — | 1 |
| W5 headless process | — (fake engine; ENGINE for the real one) | 1 |
| W6 board view in place | — | 1 |
| W3 routes | W1 | 2 |
| W8 core follow | W4 | 2 |
| W9 relay | W1 | 2 |
| W10 server wiring | W2, W3, W9 | 3 |
| W11 app UI | W4, W8 | 3 |
| W7 level 7 | W3, user's Q4 | 3 |
| W12 mock + checks | W6, W8, W11 | 4 |
| W13 shipping | W5, ENGINE | 4 |
| W15 docs | W9, W10, W11 | 4 |
| E1, E2, E3 | all of W1–W13, ENGINE | 5 |
| W14 Electron probe | W13, ENGINE | 5 |
| M1 quiet time | E1 | 5 |
| E4 | everything | 6 |

---

## 7. Risks this part leaves open

- `[not verified]` Electron as Node on the built app (D33.2): `W14`.
- `[not verified]` Excalidraw in view mode lets no paste or drop change the scene; D10 makes it harmless either way (nothing kept,
  nothing written), `HB.1` and E2 (c) check it.
- `[not verified]` A large board's reload for every save of a writer, for each reader (D3): a full `GET scene` per save, as large
  as the writer's own `PUT`. Measured in M1 alongside the quiet time; if it is too heavy, a reader can wait for a quiet moment
  before it reads (a debounce in `sceneMoved`), still inside 4.8.
- `[not verified]` The cross-target native canvas for `build-server.sh` (risk 7.4): ENGINE's.
