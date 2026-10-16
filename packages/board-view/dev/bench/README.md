# The board bench

A dev tool that measures how the phone's board page draws frames while it is panned and pinched, in each theme mode. It exists to
answer one question (`excalidraw-optimization-goal.md` 3.1, 6.1): *is the canvas filter `filter: url(#svg-filter)` the cause of the lag
in dark themes on an iPhone or iPad?* It is kept after that, to measure the replacement filter (`src/phonetheme.ts`, which the phone
page now has): **a new mode is a new entry in `modes.ts`**.

**It is never in a shipped build.** `build.mjs` bundles it only with `AIWB_BOARD_BENCH=1`; without it `board.html` is byte for byte the
shipped one (a build before and after the change have the same sha256). A bench build says `BENCH BUILD (not for shipping)` on the console.

## What it is

The bench page is the shipped page (`src/webview/entry.tsx`, imported first, untouched) with the bench on top (`entry.tsx`). The bench talks
to the page only as the app does: messages in through `window.aiwbBoardReceive(json)`, messages out seen by wrapping
`window.ReactNativeWebView.postMessage` (a stub is defined in a plain browser). While a run is on, and after it, the page's messages are
**held back** (not forwarded to the app), so the measurement is the page alone; `env.isolated` says whether the wrap took. After a run the
app's mirror of the board no longer matches the page: **restart the app before using the board** (the panel says so).

| File | What it is |
|---|---|
| `entry.tsx` | imports the shipped entry, then `installBench()` |
| `bench.ts` | the driver: `window.aiwbBench.run(opts)`, the wrap, the gestures, the small UI, the report, AUTO |
| `fixtures.ts` | the two boards, built in the page from a seeded PRNG (mulberry32); nothing large is in git |
| `modes.ts` | the modes: a `theme` message each, plus bench-only CSS/SVG put in the document before the board loads and removed after |
| `modeset.mjs` | the sets of modes (`experiment`, `replacement`, `all`), the page's timings and the expected duration of a run (plain JS, read by the page, the scripts and the tests) |
| `stats.mjs`, `types.ts` | the numbers per gesture and the summary table (plain JS, also used by the Node scripts); the types of the result |
| `webkit.mjs` | the desktop runner (an indicator only) |
| `device.mjs` | the route to a real device, written separately (see its own header) |

## Boards

- `large`: 3000 elements over about 8000 × 5000 scene px centred on the origin: rectangles, ellipses and diamonds (solid, hachure and
  cross-hatch fills, roughness 0 and 1, Excalidraw's palette), short text labels, arrows and lines of 2–5 points, 400 freedraw strokes of
  40–100 points. Passed through Excalidraw's `restoreElements`.
- `images`: 12 JPEG pictures of 1600 × 1200 (gradients, blobs, shapes and grain, made with a canvas in the page, once, then kept) shown at
  400 × 300 in a 4 × 3 grid, and about 100 shapes and labels around them.

## Modes

The phone page no longer draws a dark or flavour theme with the SVG filter: it turns the `theme` message's filter into a CSS stage on the
canvases plus up to three blend layers (`phonetheme.ts`). So there are two modes per canvas theme (`CANVAS_THEMES` of `@aiwb/core`: `dark`,
`latte`, `frappe`, `macchiato`, `mocha`): the new look as the page makes it, and today's look as the page made it before.

| Mode | `theme` message | What is on the canvases |
|---|---|---|
| `light` | `{ mode: "light", filter: null }` | no filter |
| `<theme>` (`dark`, `latte`, `frappe`, `macchiato`, `mocha`) | what the app sends: `{ mode: resolveTheme(theme), filter: canvasFilter(theme), chrome: null }` | **the replacement, as the page makes it**: the CSS stage (`invert(93%) hue-rotate(180deg)`, or none for Latte) and the blend layers (`.aiwb-canvas-layer`, 1 to 3) |
| `<theme>-today` | the same message | **today's look as the page drew it before the replacement**: `filter: url(#aiwb-canvas-<theme>)` (feColorMatrix + feComponentTransfer tables), and no blend layers. Bench CSS: a rule `filter: url(#id) !important` on the canvases over the page's own stage, and `.aiwb-canvas-layer { display: none }` |
| `dark-css` | `{ mode: "dark", filter: null }` — **the experiment** | Excalidraw's own `filter: invert(93%) hue-rotate(180deg)` |
| `dark-none` | as `dark-css`, plus CSS `filter: none !important` on the canvases | no filter (control: what dark costs without any filter) |
| `dark-matrix` | as `dark-css`, plus a hidden `<svg>` with only today's feColorMatrix and CSS `filter: url(#aiwb-bench-matrix) !important` | the matrix stage alone, as an SVG filter (informative) |

`dark-today` is what `experiment.md` and the results before the replacement call `dark` (those files, `runs/desktop-webkit.json` and
`runs/bench-simulator-iphone17-20261016-0035.*`, say `dark`). Since the replacement, `dark` is the new filter.

The chrome that the app sends with a flavour (custom properties of Excalidraw's toolbar and panels, `canvaschrome.ts`) is not modelled:
`chrome: null` in every mode. A pan and a pinch do not repaint the chrome, and it is the same in `<theme>` and `<theme>-today`.

Each run records `filter`, the computed `filter` of Excalidraw's static canvas (`canvas.excalidraw__canvas.static`), and `blendLayers`, how
many `.aiwb-canvas-layer` elements were in the page (`present`) and how many of them were drawn (`visible`: not `display: none`, with a blend
mode), both read at the start of the gesture. So the result proves which filter was on: `<theme>-today` has `url("#aiwb-canvas-<theme>")` and
`visible: 0`; `<theme>` has the stage (or `none` for Latte) and `visible` equal to `present` (dark 2, latte 2, frappe 3, macchiato 3, mocha 3 in the runs of 16 October); `light` and the experiment's modes have `present: 0`.

### Sets of modes

A run takes a set, a list, or both (`replacement,dark-css`). `modeset.mjs` is the one place that names them.

| Set | Modes | Why |
|---|---|---|
| `experiment` | `light`, `dark-today`, `dark-css`, `dark-none`, `dark-matrix` | what the criterion of `experiment.md` reads (its `dark` is `dark-today`) |
| `replacement` | `light`, the five `<theme>`, the five `<theme>-today` (11) | the new filter against today's and against light, per theme |
| `all` | both, each mode once (14: `dark-today` is in both) | |

The duration is printed at the start of `webkit.mjs` and `device.mjs` (and in the page's first progress line). It is computed by
`estimateMs`: the idle frames, then per repetition, board and mode one load (about 0.5 s on a Mac's WebKit and on the simulator, taken as 4 s
for a physical phone, which has not been measured), the settling (1 s, 1.5 s for `images`), the two gestures of 4 s and the pause between them.
At 3 repetitions of 2 boards and 2 gestures: `experiment` about 7 min on a phone (5 on a Mac), `replacement` 15 (11), `all` 19 (14). A phone's
real time is longer if its loads are slow.

## Gestures

Synthetic `WheelEvent`s on Excalidraw's interactive canvas, one per animation frame, computed from the elapsed time (so a slow device
covers the same path in the same time). Excalidraw's `handleWheel` takes them as it takes a trackpad's. A `pointermove` at the centre comes
first (a ctrl-wheel zooms around the last pointer position).

- `pan`: plain wheel; the view follows `x = 0.8·width·sin(2π·2t)`, `y = 0.4·height·sin(2π·t)`, `t = elapsed / gestureMs`, and ends where it
  began.
- `pinch`: ctrl-wheel; the zoom follows `1 − 0.7·sin(πt)` (1 → 0.3 → 1), `deltaY = (zoom − target)·100` clamped to ±10 (Excalidraw's
  largest step), the zoom read from the page's `view` messages.

Per board and mode: one load, wait for `loaded` (30 s; a run that did not load is recorded with `failed`), `document.fonts.ready` and 1 s
(2.5 s for `images`, whose pictures are decoded when first drawn), then pan, a 500 ms pause, pinch. The first mode rotates with the
repetition, so no mode always runs on a cold or a warm device.

## Metrics

`idleMs` is the median rAF interval of about 1.5 s with nothing moving: the display's refresh as the page sees it. For each gesture the
frames are the rAF timestamps during it; `intervals` are their differences (ms, 0.1). `frameStats` (`stats.mjs`) gives `fps`, `meanMs`,
`medianMs`, `p95Ms`, `maxMs` and `jankyPct` (the share of intervals above 1.5 × `idleMs`). `moved` says the view really changed (from the
page's `view` messages): a run that did not move measured nothing. The summary is per board, mode and gesture over the repetitions (mean and
range), with "within" in the `vs light` column when the fps ranges overlap. The result schema is the header of `stats.mjs`; a run that did
not take place has an extra `failed` (the reason) and is left out of `summary`.

The result is `window.aiwbBenchResult` and what `run` returns. rAF intervals see what holds the page back from starting its next frame; they
do not see the frames the compositor drops after it. The device run adds what the device's own tools show.

## Running it

```sh
# desktop: an INDICATOR ONLY (a Mac's WebKit is not the phone's)
node packages/board-view/dev/bench/webkit.mjs [--browser webkit|chromium] [--reps 3] [--gesture-ms 4000] \
     [--boards large,images] [--modes experiment|replacement|all|<list>] [--gestures pan,pinch] \
     [--viewport 393x852] [--dpr 3] [--headed] [--out result.json]
```

It builds the bench page into a temp folder, opens it from `file://`, calls `window.aiwbBench.run(opts)`, writes the JSON and prints the
table. Needs Playwright (`cd web && npm install --no-save playwright@1.64.1 && npx playwright install webkit chromium`). The default run
is the `experiment` set, 60 gestures of 4 s, about 5 minutes (`--modes replacement`: about 11). `plans/excalidraw-optimization/runs/desktop-webkit.json` is one
(before the replacement, so its `dark` is `dark-today`).

On a device, the app's own web view is the page: `device.mjs` builds the app with the bench, collects the result and says how to run it.

## Environment variables of `build.mjs webview`

| Variable | Effect |
|---|---|
| `AIWB_BOARD_BENCH=1` | bundle `dev/bench/entry.tsx` instead of `src/webview/entry.tsx` |
| `AIWB_BOARD_BENCH_REPORT=<http url>` | the CSP's `connect-src` is that URL's origin (instead of `'none'`); the page POSTs `{"kind":"aiwb-board-bench-progress","text":…}` at each run's start and the result JSON at the end to it (`fetch`, `no-cors`, `text/plain`; a failed POST never stops the bench) |
| `AIWB_BOARD_BENCH_MODES=<set or list>` | what a run measures when it names no modes (the page's "Run bench" button, AUTO, `run()` with no `modes`); default `all`. `device.mjs --modes` sets it |
| `AIWB_BOARD_BENCH_AUTO=1` | the page starts the bench by itself once it has received a `load` from outside and then nothing from outside for 10 s (the app's self-test screen loads a few boards first) |

Without the first, the others do nothing. By hand the page has a "Run bench" button at the top centre (hidden during a run); at the end a
panel shows the summary and "bench done: restart the app before using the board".
