# M1 — The quiet time (Q1, D26, goal 3.3 and 8)

Package M1 of `architecture.md` section 6. It measures what the headless writer costs to start and to reload, and proposes the
quiet time and the linger. Nothing in the product was changed; the script that made the numbers is `plans/headless-board/m1/`.

## Result in one paragraph

A cold start (no headless process, a free board, an agent's call) takes **about 0.2 s** (median 185 ms for a small board, 213 ms
for a large one; worst 241 ms). Of that, 110 ms is the engine loading in the new process. A reload (the writer let the board go,
the process still runs, the board is taken again) takes **3 ms for a small board and 45 ms for a large one** (1,818 elements,
1.2 MB). A call on a board it holds takes 1–5 ms to read and 2–18 ms to change. These costs are small against a model's turn
between two tool calls (seconds), so *no* quiet time is needed for speed: the rule "the next call of a chat does not pay for a
reload" holds for any value, because the reload it saves is under 50 ms. The number is therefore chosen for what the board being
held does to a person (the bar reads "An agent is editing this board." while the writer holds it) and to the machine (a process of
170–400 MB). **Proposal: quiet time 30 s (down from the placeholder 60 s), linger unchanged at 5 s.** 60 s would also be fine;
nothing measured argues for more.

## Method

- **Setup.** A scratch server as `web/e2e/away.e2e.mjs` starts it (`web/e2e/lib/rig.mjs` `Scratch`: its own home, free ports, the
  stand-in agent `fake-claude`, no Cursor, no pi) with the real headless writer: the bundle `packages/headless/build.mjs` builds, run
  by this machine's Node 24.3 (`-headless-node`). The real server on 4748/6006 was never touched. No window is connected; no paid
  model is called.
- **The call.** The agent's call is made as an agent makes it: `tools/call` on the chat's MCP endpoint (`<home>/chats/<id>/mcp.json`).
  `t0` is taken in the script just before the request and `t1` when the answer is read, so every "total" is what the agent waits
  for. Tools: `read_board` for cold and reload (the cheapest call that needs the board); `read_board`, `apply` (move one element) and
  `get_image` (all, scale 0.5) for warm.
- **The phases.** The product is not changed. `plans/headless-board/m1/preload.cjs` is loaded into the headless process only
  (`NODE_OPTIONS=--require`, filtered to the bundle) and appends one timestamped line to a file when the process starts
  (`performance.timeOrigin`), when the bundle's first line runs, when the first TLS connection opens (the engine said `ready` just
  before: the connection is only made after the engine), and for each HTTP/2 request and response. `status -json` of the server
  gives the process id and whether it runs and holds boards (`running.headless.{running,pid,boards}`); the script uses it to know
  that the process has gone (cold) or that it let the board go and still runs (reload).
- **Cold.** A server with `AIWB_TEST_WAITS=quiet=1s,linger=1s`. Per run: wait until `status` says no headless process, then the
  call. The first call that made each board's content (not measured) is a cold start too; it took 163–453 ms with the apply in it.
- **Reload.** A server with `quiet=2s,linger=120s`. Per run: wait until `status` says the process runs and holds no board (the quiet
  time passed, the linger did not), then the call. The board's file is read from the server again, restored in the engine, and the
  tool runs. Then, on the board it now holds: warm `read_board`, `apply`, and `get_image`.
- **Boards.** Small: 10 elements as the file stores them (4 labelled shapes, 2 arrows; 6 KB). Large: 1,818 elements, the grid of
  `packages/board-engine/dev/cases.mjs` "large" (30×20 labelled shapes and 600 arrows; 1.2 MB, made by one `apply`).
- **Memory.** `ps -o rss` of the headless process (resident set; the Node plus the engine's native canvas), sampled right after the
  start, with no board, holding the board, after the calls, and every 20 ms during `get_image` (the peak).
- **Runs.** 10 per cell. Machine: Apple M4 Pro, 14 cores, macOS 24.6, **load average 3–5 from other agents working at the same
  time** (the numbers are what this loaded machine gives; an idle one is a little faster, one four times slower is about four times
  slower in the process phases, see "Slow machines").
- `node plans/headless-board/m1/measure.mjs --runs 10 --out results.json` makes them again (about 4 minutes);
  `--summarize results.json` prints the tables from the saved run; `results.json` holds every run's events.

## Numbers

All times in milliseconds, **min / median / max** of 10 runs.

### 1. Cold start (no process, a free board, an away call)

| | spawn | node boot | engine ready | stream open | grant | load + call | answer back | **total** | RSS right after (MB) |
|---|---|---|---|---|---|---|---|---|---|
| small (10) | 19 / 39.5 / 57 | 8 / 12.5 / 18 | 105 / 111.5 / 116 | 11 / 12 / 13 | 2 / 7 / 13 | 1 / 2 / 3 | 1 / 1 / 1 | **156 / 185.5 / 211** | 115 / 118 / 121 |
| large (1,818) | 15 / 38 / 59 | 9 / 12.5 / 18 | 101 / 111.5 / 116 | 11 / 12 / 13 | 1 / 6.5 / 12 | 26 / 28 / 32 | 3 / 3 / 9 | **175 / 213 / 241** | 131 / 135 / 138 |

What the columns are, in order:

- *spawn*: the call reaches the server, the server finds the runtime and the bundle, starts the process (D31, D35), and the process
  exists (`timeOrigin`). *node boot*: Node starts to the first line of the bundle.
- *engine ready*: the bundle loads, the configuration line is read from stdin, the engine (skia-canvas, fonts) says `ready`, and the
  first connection starts. This is the one big part: about 110 ms, the same for either board.
- *stream open*: TLS, `GET /api/hello`, and the event stream is open (the writer is a client then).
- *grant*: from the open stream to the request for the board's scene; the call is routed to the new client and the board is
  granted to it (`held`).
- *load + call*: the scene is read from the server (1.2 MB for the large board), restored in the engine, the tool runs, and the
  reply is sent. *answer back*: the reply reaches the agent.

### 2. A reload (the process runs, the board is taken again)

| | grant | load + call | answer back | **total** |
|---|---|---|---|---|
| small (10) | 0 / 1 / 1 | 1 / 1 / 2 | 0 / 1 / 1 | **2 / 3 / 4** |
| large (1,818) | 0 / 2 / 4 | 22 / 38.5 / 44 | 2 / 3.5 / 4 | **24 / 44.5 / 50** |

### 3. A call on a board the writer holds (warm)

| | read_board | apply (move one element, saved before it answers: D25) | get_image (all, scale 0.5) |
|---|---|---|---|
| small (10) | 1 / 1 / 2 | 1 / 2 / 4 | 6 / 8 / 40 |
| large (1,818) | 4 / 5 / 6 | 16 / 17.5 / 18 | 128 / 134 / 148 |

So a reload costs, over a warm call, about **+2 ms (small) and +40 ms (large)**; a cold start costs another **about +170 ms**.

### 4. Memory of the process (RSS, MB)

| | right after the start | holds no board | holds the board | after read + apply | peak during get_image |
|---|---|---|---|---|---|
| small (10) | 115–121 | 170 / 179 / 180 | 170 / 179 / 180 | 169 / 179 / 180 | 178 / 179.5 / 180 |
| large (1,818) | 131–138 | 180 / 295 / 363 | 185 / 295 / 361 | 188 / 297.5 / 363 | 238 / 317 / 383 |

The engine alone is about 120 MB at the start and 170–180 MB once it has measured text and drawn a picture (fonts and the canvas
are loaded then). **A board in the process costs little (5–10 MB for the large one); the process does not give memory back when it
lets a board go**, and the large board's figures above rise from run to run (180 MB at the first run, 363 MB at the ninth). A
longer run (`drift.json`: the large board taken again 25 times with `read_board` alone, then 25 times with a picture each time)
shows that it **levels off, in steps**: 174 MB at the start, about 230 MB for reloads 9–17, a step to about 290 MB at the 18th,
flat after it (293 MB at the 25th); with a picture each time it goes from 292 to about 400 MB within 15 pictures and stays there
(404 MB at the 25th). It is memory that the allocator and V8 hold, not a leak that grows without end, but a process that lives long
with a large board can sit at 300–400 MB. The process ends at the linger and gives it all back.

## How far apart an agent's calls are

Not measured with a real model (no paid call). From how the tool loop works: after a call returns, the model reads the result and
writes the next call, so the gap is the model's time to produce that turn:

- a short call (a `read_board`, a `get_image`, a one-element `apply`): a few hundred output tokens, **2–10 s**;
- an `apply` that creates a diagram of 10–40 elements: 1,000–4,000 output tokens at 50–100 tokens/s, **10–60 s**;
- a very large `apply`, or a turn that thinks a long time first: **a minute or more** (rare);
- the picture the agent asked for adds the time it takes to look at it before it goes on;
- between two *messages* of the person in the same chat: minutes.

So most gaps inside one task are under 30 s, a long tail goes to a minute and beyond, and anything after the person's next
message is far beyond any quiet time worth having.

## What the quiet time can and cannot buy

- **It buys at most 45 ms per call** (a reload of the large board; 3 ms for the small one), or 0.2 s when it also keeps the process.
  A gap of 5 s or of 50 s makes no difference to what the agent waits for in any way it could notice. The rule of 3.3 ("so the
  next call of a chat does not pay for a reload") is met by every value above about 1 s, because the reload it saves is that small.
- **What it costs.** (a) While the writer holds the board, a window that opens it is a reader and its bar says "An agent is editing
  this board."; the button works at once whatever the time (the writer gives the board up, D17), so the cost is the words, not a
  wait. (b) The process lives for the quiet time plus the linger (5–10 s), at 170–400 MB. (c) A quiet time shorter than the gaps
  makes the board go back and forth between "held" and "free" during one task (two more requests per call, and the bar of a window
  watching the board changes with each), which is what a person watching the agent would see as flicker.
- So the number should cover **most of one task's gaps** (so that the board stays held while the agent works, and the bar does not
  flicker) and not be much longer than that (so that the board is free soon after the agent stops, and the process ends). That is a
  range of **about 20–60 s**.

## Proposal

- **Quiet time: 30 s** (`QuietDefault` of `internal/headless` and `QUIET_DEFAULT_MS` of `packages/headless`; today 60 s). It covers
  the usual gaps of a tool loop (a short call and most diagram `apply`s), frees the board half a minute after the agent's last call
  instead of a minute, and when a gap is longer the cost is a reload of 3–50 ms. 60 s is just as safe for performance, and a
  reasonable choice if the user prefers the board to stay held through a long `apply`; the measurements give no reason to go above it.
- **Linger: unchanged, 5 s.** It only decides when an idle process ends (two looks in a row, so 5–10 s after the last release). A
  cold start is 0.16–0.24 s, so ending the process early costs the next call a fifth of a second at worst and gives back 170–400 MB;
  keeping it longer buys nothing the quiet time does not.
- Nothing else in the design changes: the 8 s hand-over, the start limit of 20 s and the 2 s save limit are far above what was
  measured (a start is 0.2 s).

The user decides Q1; if the answer is another number, it is one constant in each of the two places above, and `-headless-quiet`
overrides it per server.

## Slow machines and what was not measured

- The load on this machine was 3–5 throughout. The process phases (spawn, boot, engine) are CPU-bound; at four times slower a cold
  start is under a second and a large reload about 0.2 s, still small against a model's turn and still far inside the start limit of
  20 s.
- The runtime was this machine's Node 24.3. The product finds its own (Electron's Node in the desktop app, D35); `engine.md` section 9
  measured the engine under Electron at 69 ms against 70–100 ms in Node, so the same order.
- The first start after the machine has been idle (the bundle and the native library not in the file cache) is slower than the runs
  here: the two first applies of the set-up, which also include the apply itself, took 163–453 ms. Still under half a second.
- Two things were not measured because they are other packages': the cost for a window to take a board from the writer (the
  hand-over, D17, E1 covers that it works), and the cost of a reader's extra work when the writer is a headless process
  (architecture section 6, the open point after this table).
- RSS counts the pages the process touched; the machine-wide cost of the engine's shared libraries is lower.
