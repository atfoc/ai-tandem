# Board host lane (`bb-host`): what was built, measured, and what is left

Packages H0 (node runtime), T1b-apply, H2 (agent tools), H3 (pictures), H4 (bundle), plus a Chromium reference of the window
lane's sticky. Decisions: `decisions.md` H-1 … H-9. Per-package notes: `host-h0.md`, `host-stickyref.md`.

## Where things are

| | |
|---|---|
| `packages/board-host/src/node/` | the page (linkedom; jsdom with `AIWB_BOARDHOST_DOM=jsdom`), fonts, `measure.ts`, `export.ts` (SVG → textToPaths → resvg), `editor.ts`, `runtime.ts` (lifted from `spikes/tl-host`, measuring code unchanged) |
| `packages/board-host/src/restore.ts` | `snapshotForRestore` (O3); `rooms.ts` loads every room through it |
| `packages/board-host/src/schema.ts` | the shared model's schema and shape utils (`@aiwb/board-tl/model`) |
| `packages/board-tl/src/model/apply.ts` | `applyOps(editor, ops)`: one `editor.run`, atomic, refs → ids (`meta.key`) |
| `packages/board-tl/src/model/corpus.ts` | the measuring corpus both sides run |
| `packages/board-host/src/{agent,roomeditor,render}.ts` | the tools, the room editor (D15), `get_image` |
| `packages/board-host/build.mjs` | `dist/boardhost.mjs` + `dist/assets/fonts/` + `dist/node_modules/` (natives) + `dist/manifest.json` |

Run against a server: `cd packages/board-host && npm run build`, then the server with
`-boardhost-dir packages/board-host/dist -boardhost-node "$(command -v node)"` (or `AIWB_BOARDHOST_NODE`).

## The agent's answers as built

- `read_board`: `Board "Sprint" (b1), a new board. 4 elements. Coordinates are page px; parent names the frame that holds an element.` then one `TlElement` JSON line per element (design 7.3).
- `apply`: `Applied 4 ops on "Sprint" (b1); saved.` then `{"ids":{…},"created":[…],"updated":[…],"deleted":[…],"elements":[…]}` (1 op: `1 op`).
- `delete_elements`: `Deleted 1 element on "Sprint" (b1); saved.` then the same JSON line.
- `get_image`: `{text, image}`; text `scope all, bounds x=0 y=0 w=900 h=450 (board coordinates), 8 elements, "Plan" (b1)`, plus `, drawn at scale 0.395 (the board host's limit is 2000 px on the longest side)` when capped (H-4).
- Errors: `BAD_ARGS: this is a new board; apply takes ops (a list of create, update and delete operations; see the tool description)`; `BAD_ARGS: refs is a non-empty list of {"id": "shape:…"} or {"key": "…"}`; `INVALID_OP: op 0 (update n1): fill does not apply to a sticky`; `UNKNOWN_REF: refs[0] {"key":"zz"} names no element of this board`; `REF_EXISTS`; `APPLY_FAILED: op i (…): <tldraw's message>`; `SAVE_FAILED: the change was made but could not be saved: <reason>`; `NO_SELECTION: no window's selection is known to the board host; use scope all, refs or rect`; `EMPTY: <name> has no elements to draw`; `TOO_LARGE: the picture would be W×H px at scale 1; the board host draws at most 2000 px on the longest side, which would need scale s (below 0.1); ask for a smaller scope (refs or rect)`; `RENDER_FAILED: …`; `NOT_SUPPORTED: the board host does not answer <name>`.
- Marker (D11): `{type:"aiwb_agent", label, chat, bounds:{x,y,w,h}, ttlMs:4000}` to every connected session after a write; replayed to a session that opens within the ttl.

## Measured (darwin-arm64, Node 24.3.0, the shared machine)

- **Measuring vs Chromium 156** (lifted code byte-identical to the spike's output): notes 208/208 and geo rectangles 208/208
  exactly equal; the rest as spike-host.md section 2 (CJK and two edge cases). Our sticky's `fitted` 46/46 and our geo's
  `labelSize` `growY` 52/52 exactly equal, in IBM Plex Sans (`host-stickyref.md`).
- **Pictures:** the spike's reference board, host vs Chromium: same size, 0.31% of pixels differ strongly (goal 6.5: 2%).
  `get_image` of a small board 8–30 ms; capped 5000 px board 7 ms.
- **Bundle:** 7.1 MB `boardhost.mjs`, 41 MB folder; ready in ~0.2 s warm (0.45–0.75 s cold or under load), RSS ~138 MB at
  ready, ~175 MB with one room after applies and pictures.
- **apply:** 10 ops in the editor ~3.5 ms; end to end in the host on a fake server 10–11 ms; through the real Go server (smoke)
  5–6 ms per apply once the host runs, 633–824 ms for the first call (it starts the host). `read_board` 1–2 ms.

## Joint smoke (temporary, `/tmp/bb-host/smoke.mjs`, not committed)

Built `dist/` and a scratch Go server of this branch (Go lane merged), no window: `create_board kind new`, `list_boards`
(`(new board)`), `apply` of 8 ops (3 stickies, 2 shapes, a frame containing two stickies, 2 connectors), an update + delete, an
invalid op, `read_board` (connectors name their ends; the one whose element was deleted has a free end), `get_image` of all
(784×524) and of the frame by key (584×344), `delete_elements` by key; `snapshot.tl.json` on disk holds the result;
`status -json` counts every call under `boardhost` with no `lost`/`timeout`; the log has `tl: <tool> … -> board host ok`.
All passed. Picture: `shots/host-smoke-all.png`.

## Left, or for someone else

- **6.5's picture comparison** against a window's own export is a later verification step: `get_image` passes explicit
  `bounds` (the drawn shapes' masked page bounds) and the drawn ids to tldraw's export, so the Chromium side must export with
  the same ids and bounds to compare like with like.
- **Window lane:** the marker message above is the contract; the host's editor copies the window's `setNextStyles` (H-9): one
  shared function in the model would keep them from drifting; apply's other defaults (100×100 geo, tldraw's sizes) are tldraw's.
- **Go lane:** `get_image`'s tool description still says old boards' 8192 px refusal; on a new board the host lowers the scale
  to fit 2000 px instead (H-4). O1 named `updateStore`; the host writes with `storage.transaction` (H-7).
- **Not done:** jsdom is not shipped in the bundle (H-2); only the build machine's os/arch builds (H-6); React's development
  build prints one "React DevTools" line to the server log at each start (harmless); packaging into the app is out of scope.
- The 6.4/6.6 checks with windows (live changes, kill and restart) are the orchestrator's joint checks.
