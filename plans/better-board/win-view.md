# The window's view (window lane): findings

Each task of the window lane adds its own section.

## T3: sync in the view, the mount, the agent marker, the connection line, the handle

Branch `bb-win-t3`. Files: `packages/board-tl/src/view/{socket.ts, sync.ts, AgentMarker.tsx, Status.tsx, handle.ts, sync.css}`,
`src/web/{entry.tsx, types.ts}`, a few lines in `src/view/Board.tsx` (props `user`, `markers`; `<AgentMarker/>` as a child of
`<Tldraw>`). Tests `test/{socket,sync,handle}.test.ts` with `test/fakelink.ts`.

**What it does.** `TransportSocket` is tldraw's `TLPersistentClientSocket` over core's `TlLink` (design 2.5). `TlSync` makes the
`TLStoreWithStatus`: the shared schema, the person as the store's current user and tldraw user preferences (D12), a
`TLSyncClient` always in `presenceMode: 'full'` (O2), the agents' markers from custom messages (D11), the rejection handling of
design 2.5 "as built". The mount (`window.aiwbTlView`, design 6 "as built") renders `div.aiwb-tl-root[data-testid]` (focused at
mount) with the board and the connection line (outside `<Tldraw>`, so "Connecting…" shows during the first load too, top centre:
never over the watermark or the toolbars). A rejected-for-good board renders only the red line.

**Unit tests** (`cd packages/board-tl && npm test`: 61 pass, of which T3's 17): the socket's status mapping, JSON both ways,
restart, close leaving the link open; two `TlSync`s on fake links into one in-process `TLSocketRoom` (`tlSchema`): a sticky put
by A arrives at B, B has A's presence with A's name and colour; a link cut and reopened converges; a custom message becomes a
marker (same chat replaces, another adds); a lone window gets `room.updateStore` changes in well under the 900 ms of tldraw's
solo frame; a rejection gives a fresh store and shows the reason, a connect clears it, two in a row without a connect are fatal
and nothing is retried after; the handle's refs (`{id}` with or without `shape:`, `{key}`), its `getView` and `zoomTo` on a fake
editor; the marker's timers; the status line's words.

**Edits made while the link is offline** (test "a link cut and opened again converges…", and the browser check): they stay in
the window's store (tldraw's speculative changes) and are pushed on the next connect, rebased on what the room has then. A
create, a move and a delete made offline all reached the other window; the other window's edits made meanwhile reached this
one. The same property changed on both sides ends with the offline window's value, because its push reaches the room last
(last write wins, as spike-host 4 c2). Not covered here: a board host that restarted from an older save (spike-host 4 a/b; the
host loads through `snapshotForRestore`). After a rejection the unacknowledged edits are dropped (a fresh store).

**In the browser** (temporary, `/tmp/bb-win-t3/`: a page with the built `tl.js` mounted twice side by side, each on a fake link
into one `TLSocketRoom` running in the page, bundled with esbuild; Playwright 1.64.1, Chromium 1248):

| Check | Result |
|---|---|
| "Connecting…" before the first load, nothing after | yes / 0 lines shown |
| focus at mount | tldraw's container has the focus |
| a sticky and a box made in A show in B | 81 ms |
| A's cursor in B with its generated name | B's collaborators `["Teal Otter"]`, the label drawn at the cursor (`shots/win-sync-two.png`) |
| `aiwb_agent` custom message | dashed outline + pill "Claude" around the bounds (`shots/win-agent-marker.png`); panned the camera by (100, 50): the marker moved by (100, 50) px; gone after 4 s + the fade |
| handle | `getView()` `{bounds: {x:0,y:0,w:697,h:640}, zoom: 1, selected: []}`; `zoomTo([{key:"idea"}])` true (camera fitted), `zoomTo([{key:"nope"}])` false |
| A's link cut | "Reconnecting…" pill at 12 px from the top, centred; a move and a create made in A while cut did not cross |
| A's link opened again | the offline edits arrived in B, the pill went, the same editor (no remount) |
| console | no error or warning |

**Left or uncertain.**
- The real `TlLink` and board host were not in the loop (fake links into an in-page room); the app child wires `openTlLink`.
- The user record tldraw 5.6 writes for attribution (`user:<id>`, name and colour) is a document record: it syncs and is saved
  with the board.
- At a pane 697 px wide the main toolbar's left end touches the zoom controls (bottom left), seen in the shots; T2a's area.
- A rejection that repeats on every fresh client (e.g. `CLIENT_TOO_OLD`) stops after 3; the link keeps reopening sessions that
  carry nothing until the app closes it.
