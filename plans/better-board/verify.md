# Verification of goal section 6 (better-board prototype)

Branch `bb-verify` from `better-board-prototype` at `5a3f9d66`, 2026-11-08. darwin-arm64 (14 cores, shared with other
agents; load average 1.7–2.8 during the runs), Node 24.3.0, Playwright 1.64.1 / Chromium 156 (1248), tldraw 5.6.0.

**How.** Temporary scripts in `/tmp/bb-verify/` (never committed, ORCHESTRATION.md "Testing", O6), all on **real scratch
servers** (`go build` of this branch, `-boardhost-dir packages/board-host/dist`, `-boardhost-node`), the **real app web
build** (`app/scripts/export-web.mjs` with `connect-src 'self'`, its `tl/tl.js`) through the **test host**
(`web/dev/host.mjs`, `web/e2e/lib/rig.mjs`), and the agent driven only by **direct MCP calls with a chat's token** (the
stand-in agent; no paid model). The page's editor is read through the mount's existing `onMount(editor)` option, wrapped
by a Playwright init script (no product seam was added). A shared rig: `/tmp/bb-verify/rig/rig.mjs` (scratch server +
board host flags, test host with an optional cuttable `Link`, page on a tl board, MCP client).

**Bugs found and fixed** (each in its own `bb-verify-fix-*` branch, merged, then only the affected check re-run):

| Found by | Bug | Fix | Re-check |
|---|---|---|---|
| 6.4 undo | An undo in a window put back the properties the agent (or another window) had changed on the same element since: tldraw's history writes the whole "before" record | `packages/board-tl/src/view/localundo*.ts`: undo/redo take the history's value only for fields this window wrote and nobody changed since (field-wise ownership; tldraw's `undo`/`redo` actions overridden, public store side effects, no patch). First try (whole-record "left") still failed on the real server; second try fixed it. V1 | 6.4.8 pass; 6.1 toolbar ⌘Z pass |
| 6.5 pictures | `get_image` of a tall board: height derived by resvg from a rounded width, so capped pictures came out 1974–2009 px on the long side (over the 2000 cap) and 1 px off the window's export | `packages/board-host/src/node/export.ts` `pictureSize` (floor of each side, as tldraw's own export), root `<svg>` sized with `preserveAspectRatio="none"`, `fitScale` in `render.ts`. V2 | 6.5 pictures 5/5 same size; cap exact |
| 6.1 spot | Space+drag did not pan on a new board, and holding Space started the voice pill's hold (also against voice goal 4.9) | `app/src/screens/voice/pill/holdkeys.web.ts`: Space is the board's inside `.aiwb-tl-root` too | 6.1 Space+drag pass |
| 6.1 spot | The contextual toolbar of an element near the left edge sat under the main toolbar (a click on Colour pressed the frame tool) | `ctxModel.ts` `placeBar`/`placePopover` keep clear of the main toolbar and the zoom bar. V3 | 6.1 pass (no button covered) |
| known (H-4) | `get_image`'s description stated only old boards' 8192 px refusal | `internal/boardtools/tools.go`: a new board's picture is drawn at most 2000 px by lowering the scale; TOO_LARGE only below 0.1; selection not known there | `go test ./internal/boardtools` and its users |

## 6.1 Navigation and interaction

The window lane checked most of 6.1 on board-tl's dev page (`win-view.md` T2a 53 rows, T2b 62/62, T2c 41/41). Here: the
gaps, and spot checks, on the real web build (desktop 1280×800, board pane 616×760 beside the chat). Scripts
`/tmp/bb-verify/nav/c1…c7*.mjs`.

| Check | Result | Evidence |
|---|---|---|
| Drag on empty canvas pans, moves nothing; drag on an element moves it, camera unchanged; Shift-drag brushes | pass | real build spot check (`c5-spot`); dev page: win-view T2a rows 1–3 |
| Wheel pans; Ctrl+wheel zooms around the pointer | pass | drift 0.000 px (`c5-spot`) |
| Space+drag pans over an element | **pass after fix** | failed first (voice pill took Space, see above); after the fix camera moved (109, 55), element unmoved. Middle-drag also pans |
| Touch, phone: one finger pans / moves, pinch zooms | pass (lane) | win-view T2a rows P (phone, CDP touch) |
| Touch, tablet (new here) | pass | one finger on canvas pans (×2), on a shape moves it with camera unchanged (×2), spread ×3.0 / pinch ×0.39, drift 0.00 px; the page itself does not zoom (`c6-touch`) |
| Contextual toolbar for sticky, shape, text, connector, frame, two elements; colour change stored; undo restores | pass | 7/7 on the real build, the colour also in `read_board`, ⌘Z restores both (`c5-spot`, re-run after the undo fix); full control lists: win-view T2b 62/62. Shots `verify-ctx-sticky.png`, `verify-ctx-connector.png` |
| Contextual toolbar clear of the main toolbar | **pass after fix** | bar [728,488] vs toolbar [676..720]: no button covered |
| Creating each element through the main toolbar, by click and by drag | pass | 20/20 on the real build: click sticky 200×200, 5 shapes 200×200, text 59×32 (editing), connector 200×0, frame 320×180, pen 9×9; drag sticky 240×240 (square), shapes/connector/frame/pen 240×160, text 240×32; back to select except pen; every element in `read_board` with the same type and size (`c1-create`) |
| Sticky with a lot of text keeps its size, font shrinks; resize refits | pass | 205 characters typed: 200×200 kept, font 48 → 13 px (`read_board` 13); resized to 320×320 (square kept): 24 px; to 170×170: 11 px (`c3-sticky`). Shot `verify-sticky-fit.png` |
| Connector attached to two elements touches both after either moves | pass | drawn by mouse from A to B; after a mouse move of A, of B, and an MCP move of each: bindings and `read_board` `from`/`to` still A and B; start on A's outline (0 px), arrowhead end 12–13 px off B's outline (tldraw's 10 px arrowhead gap + half stroke); the agent's move shown in 38 ms (`c2-connector`) |
| tldraw's default UI absent | pass, with notes | 16/16: no `tlui-` element, no dialog or menu after selections, right-click, `?`, ⌘/, ⌘⌥/, ⌘K, ⌘⇧E, ⌘P, ⌘⇧C, ⌘A (`c4-noui`). Notes (V4): right-click opens the browser's own context menu; ⌘⇧C still copies a PNG silently |
| Screenshots | done | `shots/verify-board.png` (every element kind), `verify-ctx-sticky.png`, `verify-ctx-connector.png`, `verify-sticky-fit.png` |

Seen in passing: tldraw's text editor turns `'` into `’`; a 120-px shape breaks "Rounded" mid-word (tldraw's label
wrapping, the same in the host and the window).

## 6.2 Multiplayer

One server, pages A and B through two test hosts (B through a cuttable `Link`), desktop. `/tmp/bb-verify/mp/c62.mjs`.

| Check | Result | Evidence |
|---|---|---|
| Create, move, text, colour, delete in A appear in B within 2 s | pass | 5 tries each: medians 27–39 ms, slowest of 25: 50 ms |
| Each page shows the other's cursor | pass | B lists A ("Coral Fox") at the exact page point under A's mouse after 27 ms, A lists B after 35 ms; the name tag is drawn in both. `shots/verify-cursors.png` |
| Different elements changed at the same moment | pass | 5/5 rounds: both changes in both pages, converged in median 67 / max 79 ms |
| Same sticky's text changed at the same moment | pass | 10/10 rounds end with one text in both pages (B won 7, A 3: the last write to reach the room), no page/console error, no failed request, nothing in the server log or the board host's lines |
| B cut and restored: back without reload | pass | "Reconnecting…" 110 ms after the cut; after restore back in 1.17 s (host `backoff=2s`), same editor (token unchanged), 0 navigations |
| Traffic only through the transport | pass | every request to the page's own host origin, no WebSocket in either page; A 54 and B 23 `/host/call` → `/api/tl/<id>/sync` (+ 1 / 2 `open`, the second is the reconnect) |

**B's edits made while cut off** (matches W8): all kept. The create reached A and `read_board`; the move and the text
edit were kept; the delete of an element that existed (and was confirmed) before the cut was kept. A's edit to another
element made meanwhile reached B. **The same property changed on both sides** (colour: B offline red, A online blue
later in wall time; also text): **B's offline value wins** everywhere, because its push reaches the room last (last write
wins). W8's rare case (an offline delete of an element created within a round trip before the cut comes back) was
deliberately avoided here; the window lane documented it as a tldraw limit.

## 6.3 Agent, headless, no window

host-lane.md's joint smoke already proved the windowless part on a real server (list/create board, 3 stickies, 2 shapes
with text, a frame, 2 connectors, update, delete, read in agent terms with connector ends, pictures of all and of the
frame, the status counter; `shots/host-smoke-all.png`). Here the rest. `/tmp/bb-verify/sf/a.mjs`.

| Check | Result | Evidence |
|---|---|---|
| A window then opens the board and shows exactly those elements | pass | the page's 7 elements equal `read_board`'s: ids, types, page bounds within 0.5 px, keys, parent, text, colours, connector bindings. `shots/verify-headless-then-window.png` |
| No call reached a window | pass | `status -json` `running.boardhost.calls`: 18 calls, all ok (no error/lost/timeout/unavailable), `screenCalls` 0; every log line `tl: <tool> … -> board host ok`; with the window open 3 more calls (counter 5 → 8), still `screenCalls` 0 and no `/api/rpc-reply` from the page |

## 6.4 Agent and people together

`/tmp/bb-verify/mp/c64.mjs`, page A on a new board, the agent through MCP.

| Check | Result | Evidence |
|---|---|---|
| Agent adds and moves elements: each change in A within 2 s; the agent's marker | pass | shown in A median 14–17 / max 27 ms after the answer (n=7); the marker (`.aiwb-agent-marker`, dashed outline, pill "Claude") appears 13–35 ms after each answer, covers the changed element, gone 4.6 s later. `shots/verify-agent-marker.png` |
| Person drags a sticky (real mouse) while the agent changes its text mid-drag | pass | 5/5 (`select.translating` when the answer came): the person's position and the agent's text both kept, in A, in `read_board`, and in `snapshot.tl.json` 3 s later |
| The person's undo touches only their own changes | **pass after fix** | person: colour of P; agent: P's x/y and font size, Q's colour/text; person: P's text; ⌘Z ×2 → P's text and colour back, P's x/y (40, 760) and font size (l) and Q kept, in A and in `read_board`. Before the fix tldraw's undo put P's x/y and font size back too (V1) |

## 6.5 The board host is faithful

`/tmp/bb-verify/ff/check1…3.mjs`, `repro-cap.mjs`. Already proven at the measuring level: host-h0.md (notes and geo
208/208), host-stickyref.md (our sticky's `fitted` 46/46, our geo's `growY` 52/52 in IBM Plex Sans). New here: the whole
path MCP → Go → board host → room → sync → the real app page, text elements, all five geo kinds, fixed sticky sizes.

**Text corpus** (corpus.ts: short, long, multi-line, accented Latin, Cyrillic, CJK, emoji, …; the agent wrote 377
elements in 3 `apply`s; the page re-created each with the same props and the computed fields reset, so the window's own
code measured them):

| kind | cases | equal | ≤ 0.5 px | worst |
|---|---:|---:|---:|---:|
| sticky (`fitted`, w, h; auto and fixed s/m/l/xl) | 78 | 78 | 78 | 0 |
| shape (`growY`, w, h; 5 kinds × label s/m/xl; 135 grew) | 195 | 195 | 195 | 0 |
| text, fixed width (bounds) | 52 | 52 | 52 | 0 |
| text, auto width (bounds) | 52 | 47 | 49 | 6.0 px |

Result: **pass**, except **limit**: CJK auto-width text, host 1.7 / 4.2 / 6.0 px wider at sizes m / l / xl (0.26–0.51%);
heights and line breaks equal. Chromium draws the Han characters in PingFang SC (system font, CDP
`getPlatformFontsForNode`), whose per-size tracking spike-host.md section 2 already recorded. Kana, Hangul and emoji exact.

**Pictures** (host `get_image` vs tldraw's `editor.toImage` in the page with the same ids, bounds, padding 32, scale;
after V2):

| board / scope | host | page | strongly differing (>64) | worst shift |
|---|---|---|---:|---:|
| kinds (27 elements, every kind and colour) / all | 1914×880 | 1914×880 | 0.475% | 1 px |
| kinds / refs frame | 554×344 | 554×344 | 0.234% | 0 |
| kinds / refs 2 shapes + connector | 504×194 | 504×194 | 0.383% | 0 |
| corpus / all (capped, scale 0.463) | 741×2000 | 741×2000 | 0.574% (1.95% before V2) | 1 px |
| corpus / refs CJK + emoji rows | 1104×694 | 1104×694 | 0.965% | 1 px |

**pass** (same size, ≤ 2%, no shape displaced). Shots `verify-picture-sbs.png` (host | page), `verify-picture-diff.png`
(host | page | diff in red). The cap (H-4): every board over 2000 px answers "drawn at scale s (the board host's limit is
2000 px…)" and, after V2, the long side is exactly 2000 (1539.55×4260 → 741×2000, 500.5×12000 → 93×2000, 302.9×19000 →
38×2000, 400×5000 → 183×2000; wide ones were always right).

**Measurements** (3 fresh servers, median / max, under the load above):

| what | value |
|---|---|
| board host start (its log: process start → ready) | 171 / 175 ms |
| first agent call (starts the host), client | 234 / 235 ms |
| RSS: 1 empty room / 1 board of 10 stickies / 10 boards of 20 elements | 149 / 158 / 352 MB |
| RSS after the rooms closed (quiet) | 353 MB, not given back (limit V4) |
| `apply` 1 op / 20 ops (client) | 2–3 ms (max 17) / 11–12 ms (max 23); the log's `-> board host ok` 1 ms less |
| `get_image` 1 sticky / 20 elements / capped 110 elements | 6 / 25 / 57 ms |

No call errored, was lost or timed out in any round.

## 6.6 Saving and failure

`/tmp/bb-verify/sf/b.mjs`, `c.mjs`, two pages and the agent.

| Check | Result | Evidence |
|---|---|---|
| An agent's change is on disk when answered | pass | 10/10: `snapshot.tl.json` read right after the answer holds it |
| A person's edit is on disk within a few seconds | pass | median 1048 / max 1059 ms (5 tries; the 1 s throttle, D8) |
| Board host killed (SIGKILL) with two pages and the agent: pages show reconnecting, come back as of the last save | pass | both pages "Reconnecting…" within 10–500 ms, back after 0.8–0.9 s on a new host, no reload; both equal `read_board` after. `shots/verify-host-killed.png` |
| The agent's call in progress fails clearly; the next call works | pass | 14/14 calls in flight (`get_image`, 400-op `apply`) failed 4–11 ms after the kill with `HOST_STOPPED: the board host stopped while it ran this call, so the call did not finish. …` (status counts them `lost`); every next call worked on a new board host (new pid) |
| Server restart: new boards load from disk | pass | relaunched on the same home: `read_board` line for line as before, a new page the same; a person's edit made 300 ms before the stop (not yet on disk) was saved by the host at shutdown. `shots/verify-after-restart.png` |
| Quiet times (`quiet=6s`) | pass | nothing starts at boot; the host stopped 15.2 s after the last agent call; with a page open it kept running, and stopped 9.9 s after the page closed; the next call started a new one |

**What the host kill showed about a person's last edit:** killed 0 ms after A's edit, the room had not confirmed it, so A
pushed it again on reconnect and it was kept everywhere. Killed 60 ms after, the room had confirmed it but not yet saved
it (1 s throttle), so it was lost in both pages and on disk: the window had already dropped it from its unconfirmed
changes. That loss is bounded by the save throttle (goal 3.6 allows "the last few seconds of people's edits"; limit V4).

## 6.7 – 6.9

Not this run: the orchestrator runs `web/e2e/away.e2e.mjs` and `readers.e2e.mjs` once at the end (O6). On `bb-verify`
after every merge: root `npm test` (0 failures in every workspace) and `npm run check` pass; `go test ./internal/boardtools
./internal/claude ./internal/boardapi ./internal/pibridge ./internal/cursor ./internal/chats` pass (the only Go change is a
tool description).

## Departures from section 7

None new. The per-window undo (V1) is goal 3.3 made true on top of tldraw's history; section 7 says nothing about undo.
