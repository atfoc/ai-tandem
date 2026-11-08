# Sync spike: TLSocketRoom, the agent as a peer, reconnects (better-board 3.4, 7.4, 7.5, risk 8.5)

tldraw 5.6.0, @tldraw/sync-core 5.6.0, jsdom 27.4.0, Node 24.3, all in one process. Code: `src/room.ts`, `dev/sync.ts`,
`dev/reconnect.ts`, `dev/common.ts`. Run: `cd spikes/tl-host && node dev/sync.ts && node dev/reconnect.ts` (both exit by
themselves, about 5 s and 25 s; `VERBOSE=1` echoes tldraw's console). Text measuring is stubbed (`stubMeasure`: one 10x10
span) until `src/measure.ts` lands. That doesn't matter for sync. `src/dom.ts` and `src/editor.ts` are unchanged.

## Verdict

- **It all works with the stock pieces.** A `TLSocketRoom` and `TLSyncClient` over a hand-made in-process socket pair.
  The headless `Editor` is created on the sync client's store. Edits, deletes, bindings, presence and concurrent edits all
  converge. Snapshots round-trip as JSON. `dev/sync.ts` passes every check and prints no console warnings.
- **Risk 8.5 is real but has a cheap fix.** If you restore a room from an older snapshot exactly as saved, a client can
  end up permanently out of sync with no error at all (a2/a3 below). If the board host shifts the clock when it restores
  (`snapshotForRestore()`), every scenario converges. What can't be fixed is that edits the room acknowledged but never
  saved are lost: they disappear from every window, including the one that made them.
- **Offline edits are kept (goal 3.4's question).** A window cut off from a live room keeps everything it did and
  resends it on reconnect. Edits to the same property made by others in the meantime are overwritten by whichever
  arrives last.
- **A side finding that affects the agent design:** tldraw's sync client throttles to **1 fps while it sees no other
  presence** ("solo" mode). A window alone on a board whose agent writes through `room.updateStore` sees each change
  about 0.8 s late. An agent peer that publishes presence keeps the window at 30 fps (about 35 ms).

## What `src/room.ts` provides

| Piece | What it is |
|---|---|
| `createRoom({snapshot?, onDataChange?, log?})` | `TLSocketRoom<TLRecord>` with `createTLSchema({shapes: defaultShapeSchemas, bindings: defaultBindingSchemas})` (it serializes the same as a client store built from `defaultShapeUtils`/`defaultBindingUtils`, so connecting needs no migration). |
| `snapshotForRestore(snap, gap=1e6)` | The fix for 8.5 (see below). |
| `ProxySocket` | The **server half** of a session: `send`/`close`/`readyState`, and that's all `handleSocketConnect` needs. It has no `addEventListener`, so the room doesn't subscribe to it. The host feeds client messages with `room.handleSocketMessage(sessionId, data, proxy)` and ends the session with `room.handleSocketClose(sessionId, proxy)`. This is the 7.4 shape: a window's proxy `send()` goes back through Go. It knows nothing about the client half. |
| `ClientSocket` | The client half (`TLPersistentClientSocket`): `connectionStatus`, `sendMessage`, `onReceiveMessage`, `onStatusChange`, `restart`, `close`, driven by its transport through `receive(json)` and `setStatus()`. The window's custom socket of 7.4 has the same shape. |
| `InProcessConnection` | Joins the two. JSON strings in both directions, delivered on `setImmediate` (or `setTimeout(delayMs)`), FIFO, so nothing is shared. A per-connection generation drops in-flight messages on a cut. `cut()`, `restore(room?)` (the same room or a restored one), `close()`, `stats`, and a `tap` for research. A room close with code 4099 becomes client status `error` with its reason; any other close becomes `offline`. |
| `connectClient(room, {userId, userName, presence?})` | A bare `TLSyncClient` on a bare store (the window stand-in), with a fixed presence record and useSync's solo/full mode. |
| `connectEditor(room, {userId, userName, color?})` | The agent: a sync client with presence, then `createEditor({container, store})` once the first hydration is in (useSync also only hands the store over after load). Adds `setCursor(x, y)`. |
| `peer.whenConnected()` / `peer.whenSettled()` | Waits for the next connect handshake, or until every local change is pushed **and acknowledged** (so it is in the room's storage and `onDataChange` has fired). `whenSettled` reads `pendingPushRequests`/`unsentChanges`, which are private in 5.6.0, and has to call `store._flushHistory()` first, because the store tells the sync client about changes lazily. Without that it resolves before the change has even been queued. |

### What was needed (the details that cost time)

- Node runs `.ts` in strip-only mode, which rejects TypeScript parameter properties (`constructor(private x)`). Use
  plain fields.
- **Presence `userId` must be a `user:` id** (`createUserId(...)`). A bare `'alice'` makes the room reject the whole
  session with `INVALID_RECORD`. Rejection is fatal: the client gets status `error`, `TLSyncClient` closes itself and
  doesn't reconnect. Any invalid record in a push does the same, so the board host must never let the agent push records
  that fail validation (going through the Editor validates locally first).
- `presenceMode` must be passed. With it undefined, `TLSyncClient` never pushes presence (`if (mode !== 'full')
  return`). For the agent pass `atom('full')`: in useSync's computed mode it would stay 'solo', and so invisible, until it
  saw someone else's presence.
- tldraw 5.6 puts a `user:` **document** record (attribution) into the store when the editor starts. It syncs and is
  saved like a shape.

## Results of `dev/sync.ts` (in-process, M-series Mac, a quiet run)

1. **Room + editor + plain client.** Editor connected and ready in ~12 ms; client in ~1 ms. `buildBoard` (9 shapes, 2
   bindings, one transaction): the client has every record, equal to the editor. It arrived after 912 ms, which is the
   solo-mode frame (see 5); later boards arrive in ~30 ms. Update text 49 ms, delete 36 ms, move of a bound geo 27 ms
   (the arrow follows: the bindings are unchanged, so the client recomputes the arrow from the same records). Client to
   editor 45 ms. 20 moves: min 0, median 32, max 48 ms. **Latency is set by tldraw's 30 fps throttle (~33 ms) on push
   and on rebase, not by the transport.**
2. **Presence.** After `setCursor(123, 456)` + `editor.select(note, geo)` the client has an `instance_presence` within
   30 ms with `userId user:agent`, `userName "Claude (agent)"`, `color`, `cursor {x:123, y:456, type:'default'}`,
   `selectedShapeIds [note, geo]` and `currentPageId`. The editor sees the window in `getCollaborators()`. Cursor moves
   take a steady 32 ms. Presence is not in the room snapshot and doesn't trigger `onDataChange`.
3. **Concurrency.** Same property of the same shape at once: both stores equal the room, and the last push to reach the
   room wins ("window wins?"). Different properties of the same shape at once: both kept, because pushes are per-property
   patches. Different shapes: both kept. A burst of 50 interleaved edits from both sides converges.
4. **Persistence.** `onDataChange` fires on every committed document change (33 calls over the run), synchronously and
   unthrottled, so the host has to throttle saves itself. Agent change → `whenSettled()` → room has it: ~36 ms.
   `getCurrentSnapshot()` is 5.7 KB of JSON for the board: `{documentClock: 33, tombstoneHistoryStartsAtClock: 0,
   documents: [{state, lastChangedClock}], tombstones: {"shape:draw": 3}, schema}`. A room built from the JSON has the
   same records and clock, and a client of it equals the editor.
5. **A lone window (solo mode).** Five changes, latency at the window:

   | Agent writes via | ms |
   |---|---|
   | `room.updateStore` (short-lived editor style, no peer) | 2, 800, 800, 802, 803 |
   | editor peer, first change before its presence was seen | 913, 35, 35, 34, 36 |
   | editor peer, presence seen first | 42, 38, 33, 34, 32 |

   Why: `TLSyncClient` runs both `sendUnsentChanges` and `rebase` (applying incoming diffs) through one `FpsScheduler`.
   Its fps is 1 when `presenceMode` is 'solo', which useSync sets when the store holds no other `instance_presence`; with
   a target frame of `floor(1000/1)*0.9` that means 900 ms frames. The first change after solo always pays one slow frame,
   because the presence that switches the mode arrives through that same throttled rebase. The first change of a
   restored or reconnected session pays too (b: ~600 ms).

## Reconnect (risk 8.5): `dev/reconnect.ts`

Every scenario runs for a plain client (A) and for the headless editor (Agent), with a second window O as the observer.
Base: shapes s1, s2, gone. "Restored raw" means `createRoom({snapshot: S1})` with S1 exactly as saved. "+jump" means
`createRoom({snapshot: snapshotForRestore(S1)})`. The client and editor results were identical in every scenario, and
no run printed a console warning or error.

| | Scenario | Restored raw | Restored + jump |
|---|---|---|---|
| a | S1 saved; A makes C1 (s1.x=111, creates c1new, deletes gone), acknowledged; room closed; new room from S1; A and O reconnect | **wipe_all**. A and O drop C1 and match S1 exactly (s1 x0, no c1new, gone back). Consistent. C1 is lost everywhere, silently. | Same (wipe_all), consistent, C1 lost. |
| a2 | as a, but O reconnects first and edits until the room's clock passes A's lastServerClock; then A reconnects | **DIVERGED, permanently, no error.** A gets `wipe_presence` with a diff of only s2. A keeps s1 x111, c1new, and no gone; the room and O don't have them. | wipe_all, consistent. |
| a3 | as a2 but the room's clock ends **equal** to A's | **DIVERGED.** The room sends no document diff at all (`sinceClock === clock`). | wipe_all, consistent. |
| b | as a, then while disconnected A makes C2 (s2.color red, creates c2new, c1new.color green, s1.color blue), reconnects to the room from S1 | wipe_all, then A **resends C2**. Kept: s2 red, c2new, s1 blue. **Dropped silently:** c1new green (a patch to a record the room doesn't have), along with all of C1 (s1 is x0 blue). A, O and the room converge (~620 ms, solo frames). | Same, consistent. |
| c | connection drops, room alive; A edits offline (s1.x=333, creates c2new, deletes gone); O meanwhile sets s2 violet, s1 orange | `wipe_presence` with a diff of s1, s2. A's offline edits are **resent and kept**; O's edits are merged in (s1 x333 orange). Consistent. | n/a (same room) |
| c2 | as c, but O sets s1.x=444 while A (offline) set s1.x=333 | Consistent. A's offline value arrives last and **overwrites O's** (x333). | n/a |
| d | A away, O changes s1, creates c1new, deletes gone; A reconnects | `wipe_presence`, diff exactly those three. Normal catch-up, consistent. | n/a |
| e | room restarted from an up-to-date save (nothing lost) | `wipe_presence`, empty diff, consistent. | (would be wipe_all: a full resend, still consistent) |

### Why, from the source

- **Client.** `TLSyncClient` keeps `lastServerClock` (the room clock of the last diff it applied) and
  `speculativeChanges`: its local changes not yet confirmed. On a drop, `resetConnection()` clears
  `pendingPushRequests` and `unsentChanges` but **keeps `speculativeChanges`**. On reconnect it sends `{type:'connect',
  lastServerClock}`. In `didReconnect` it reverts the speculative changes, applies the room's diff (first removing every
  document record if `hydrationType === 'wipe_all'`), then re-applies the speculative changes as a network diff and
  pushes them. Hence c and b: offline edits are resent. Updates are re-applied as **patches** (`getNetworkDiff` turns
  `updated` into `Patch`), and `applyNetworkDiff` skips a patch whose record is missing. Hence c1new green is dropped,
  and s1 blue applies on top of the room's s1 (x0) rather than A's (x111). Acknowledged changes are no longer
  speculative (after a `commit` push_result, `speculativeChanges` is recomputed from the pending requests only), so
  they're never resent. Hence C1 is lost in a and b.
- **Room.** `handleConnectRequest` calls `storage.getChangesSince(lastServerClock)` (`InMemorySyncStorage`):
  - `since === clock` → `undefined`: no document diff, `wipe_presence`. Fine if the content is really the same (e);
    silent divergence if the room was restored and moved on to that clock with different content (a3).
  - `since > clock` → `since = -1`, which is below `tombstoneHistoryStartsAtClock` (0 or more), so `wipeAll`: a full
    snapshot, the client wipes its documents. That is a and b: the restored room's clock (1) is behind the client's (2).
  - `since < clock` → the records with `lastChangedClock > since` plus tombstones newer than `since`: an incremental
    diff, which assumes the client's state at `since` is the room's state at `since`. After a restore to an older
    snapshot that's false: clock values 2..k were reused for different commits. That is a2: A's C1 records were never
    touched again in the new room, so they're never sent or removed.
  - `wipeAll` is also chosen when `since < tombstoneHistoryStartsAtClock`.
- **Does the snapshot include the clock?** Yes. `getCurrentSnapshot()` returns `documentClock`, `tombstones`,
  `tombstoneHistoryStartsAtClock` and each document's `lastChangedClock`, and `createRoom({snapshot})` restores them.
  So "save the clock with the snapshot" is already what happens, and it doesn't help: the danger comes from the clock
  being *reused* after a lost tail, not from it being reset.
- **The fix (`snapshotForRestore`).** On every load from the file, set `documentClock` and
  `tombstoneHistoryStartsAtClock` to `saved clock + gap`, and empty the tombstones. Every client that comes back then
  has `lastServerClock < tombstoneHistoryStartsAtClock` (or `> clock` → -1), so it gets `wipe_all`: it ends with exactly
  the room's records plus its own unacknowledged edits. The only hole is a client whose `lastServerClock` equals the new
  clock exactly, which needs the lost room to have made `gap` commits after its last save. With saves every few seconds
  and `gap = 1e6` that can't happen. (Alternatives: persist a restart counter and use `clock = (restarts+1) * 2^32`, or
  save the room's clock separately and more often than the snapshot. All the same idea.) The cost is one full
  hydration per client after each restart, which is the board's size in JSON. Clocks stay well inside safe integers.

### What the board host must do so that no window loses edits or ends up inconsistent

1. **Always load a room through `snapshotForRestore()`.** It costs nothing in the normal case and removes a2/a3, the
   only silent divergence found.
2. **Keep the unsaved tail short.** The room acknowledges an edit before it's saved, and an acknowledged edit that
   misses the save is gone after a restart, even from the window that made it. There is no client-side recovery. Save
   on `onDataChange` throttled (goal 3.6: within a few seconds), on room close, and on process shutdown signals. For the
   agent: change → `whenSettled()` → save the snapshot → only then answer the tool call (3.6).
3. **Offline edits are fine against a live room** (c). After a restart (b) they're resent, but patches to records the
   lost tail created are dropped. That's acceptable for the prototype; the report should say so.
4. **Never push an invalid record.** A rejected push (`INVALID_RECORD`) kills the session for good: the client goes to
   `error`, closes, and doesn't reconnect.
5. **Windows reconnect themselves only if their socket does.** `TLSyncClient` reacts to `onStatusChange('online')` by
   sending `connect`. The window's custom socket (7.4) must go `offline` when the stream or session ends and `online`
   when a new session is open (as `ClientWebSocketAdapter` does with backoff). `room.close()` closes every proxy socket
   without a code, so windows see `offline`, not `error`. A session id can be reused or fresh; the room handles both
   (`handleSocketConnect` replaces the old socket of the same id).

## Persistent editor peer vs short-lived editor per call, seen from sync

| | Persistent editor peer (7.5 first option) | Short-lived editor + `room.updateStore` |
|---|---|---|
| Agent marker (3.4) | Free: presence with name, cursor (`setCursor`) and selection, ~32 ms per update | None. Faking one would need a presence-only client anyway. |
| A lone window | Stays at 30 fps (~35 ms) once it has seen the agent's presence | Solo mode: each agent change shows ~0.8 s late, unless our window client always passes `presenceMode: 'full'` (we own that code, so it's possible). |
| Saving before "done" | Needs `whenSettled()` (private fields of 5.6.0, ~35 ms: one throttle frame) and then a save | `await room.updateStore(...)` resolves after the commit; save right after. Simpler. |
| Concurrency with people | Same path as any window: rebase, per-property patches | `updateStore` validates and writes the whole record, read at the start of the call. With a synchronous updater nothing can interleave, so window patches are not lost. With an async updater (awaiting a measurement) a window's edit made meanwhile would be overwritten. Not tested. |
| Restarts | One more client to reconnect. It behaves exactly like a window in every scenario (table above), so it needs no special code. | Nothing to reconnect. |
| Cost | An Editor and store per board with agent activity, for as long as it lives (8.8 measures it) | An Editor per call (startup ~10 ms here, plus a snapshot load) |

**Recommendation:** a persistent editor peer per room with agent activity, created on the agent's first call and
disposed with the room (or after the agent's quiet time). It is the only option that gives the 3.4 marker, it keeps
lone windows fast without changing tldraw's client defaults, and on reconnect it behaves exactly like a window. Its one
wrinkle is `whenSettled()`, which reads private fields. If the board host wants to avoid that, watching
`room.getCurrentDocumentClock()` or `onCommittedChanges` until the agent's records appear works too. Independently of
this choice, have the window's sync client use `presenceMode` 'full' or keep useSync's default, and account for the
first slow solo frame in 6.2's "within a second" check.

## Uncertain / not done

- All numbers are in-process. The relayed transport (7.4, risk 8.4) adds its own batching on top of tldraw's 33 ms
  frames.
- `whenSettled()` relies on private `TLSyncClient` fields, which may change after 5.6.0.
- Not tried: schema migrations between client and room versions, `clientTimeout` pruning of silent sessions,
  `handleSocketResume`, very large boards (wipe_all after every restart sends the whole board to every window).
