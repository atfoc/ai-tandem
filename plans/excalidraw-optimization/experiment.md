# The experiment: is the canvas filter the cause of the lag?

Part 1 of `excalidraw-optimization-goal.md` (sections 3.1, 6.1). Written by the lead of part 1.

## The question

*Is the canvas filter the cause of the lag in dark and flavour themes on a phone or tablet?*

Today every dark and flavour theme puts an SVG filter on Excalidraw's canvases (`filter: url(#aiwb-canvas-<theme>)`: an
`feColorMatrix` and an `feComponentTransfer` with a 256-entry table per channel; `packages/board-view/src/theme.ts`,
`CanvasFilters.tsx`, numbers from `packages/core/src/logic/canvastheme.ts`). Plain light has no filter. The hypothesis: WebKit
draws a `url()` filter on a canvas in software on every repaint, while CSS filter functions such as Excalidraw's own
`invert(93%) hue-rotate(180deg)` are applied cheaply by the compositor.

## What was changed for the experiment

Nothing that ships. The experiment is a **bench**: a variant of the phone's board page (`board.html`) built only with
`AIWB_BOARD_BENCH=1` (`packages/board-view/dev/bench/`, README there). It is the shipped page unchanged plus a driver: it loads
its own fixture boards through the page's own `load` message, sets the theme through the same message the app sends, and drives
a pan and a pinch with synthetic wheel events, one per frame, time-based (the same path in the same time on every run). It
records the interval between animation frames during each gesture. While it runs, the page's messages to the app are held back,
so what is measured is the board page alone (the app's overlays are the same in every theme and are out of scope, goal 5).

The modes (the theme message is the app's own; the extras are injected by the bench only):

| Mode | Canvas filter | Role |
|---|---|---|
| `light` | none (plain light) | the reference |
| `dark` | `url(#aiwb-canvas-dark)`: matrix + tables, exactly what the app sends today | dark as it is today |
| `dark-css` | Excalidraw's own dark: `invert(93%) hue-rotate(180deg)`, CSS functions (theme message with no filter) | **the experiment** (colours differ from today's: allowed) |
| `dark-none` | none, with dark chrome (bench CSS `filter: none`) | control: the dark theme with no filter at all |
| `dark-matrix` | `url()` with only the `feColorMatrix` of today's filter (bench SVG) | informative for part 2: is it any `url()` filter, or the tables? |

Each run records the canvas's computed `filter`, so the result shows which filter was on.

**Names since the replacement.** The mode `dark` of this table (and in the runs of 15 and 16 October, `runs/desktop-webkit.json`,
`runs/bench-simulator-iphone17-20261016-0035.*`) is called **`dark-today`** in the bench now: since the replacement
(`replacement.md`) the phone page draws a theme with a CSS stage and blend layers, so the bench's `dark` is the new filter. The criterion
below reads the set `experiment` (`light`, `dark-today`, `dark-css`, `dark-none`, `dark-matrix`); wherever it says `dark`, read `dark-today`.

Boards (generated in the page from a fixed seed, nothing large in git): `large`, about 3,000 elements (shapes with solid and
hachure fills, text, arrows and lines, freehand strokes) over 8,000 × 5,000 scene px; `images`, 12 photo-like JPEGs of
1600 × 1200 and about 100 shapes.

Gestures (4 s each): `pan`, a figure-eight of the view returning to its start; `pinch`, zoom 1 → 0.3 → 1 around the centre.
Order: for each repetition, for each board, for each mode (the starting mode rotates per repetition, to spread thermal drift).

## The criterion, fixed before the numbers (goal 6.1)

Per board and gesture, over the repetitions, each mode has an fps range (min–max of the runs) and a mean.

- **Confirmed**: on both boards and both gestures, `dark-css`'s range overlaps `light`'s (or its mean is within the larger of the
  two ranges' widths of light's mean), and `dark`'s range lies wholly below both `light`'s and `dark-css`'s.
- **Not confirmed**: `dark` is within light's range (there is no lag to explain in this measurement), or `dark-css` is as far
  below light as `dark` is.
- **Partly / unclear**: anything between, e.g. `dark-css` clearly better than `dark` but still clearly below `light` (goal 7.1:
  the filter is only part of the cause), or the result differs between boards. The answer then says what the numbers show.

The 95th-percentile frame time and the share of janky frames (an interval longer than 1.5 idle frames) are reported beside fps
and are read the same way.

## Device and build

**No physical device was reachable.** The iPhone 15 Pro "Pedja" and the iPad Air 4 "Ana's iPad" were `unavailable` in
`xcrun devicectl list devices` every time they were checked (15 and 16 October). So there is **no result** yet in the sense of goal 4.6 and
7.4. There are two **indicators**, both from this Mac (Apple M4 Pro, macOS 15.7), with the same bench, boards, gestures and order
(3 repetitions × 2 boards × 5 modes × 2 gestures of 4 s):

| Run | Engine and build | Viewport | File |
|---|---|---|---|
| desktop WebKit | Playwright's WebKit (Safari 27.2 engine) on macOS, the bench page from `file://` | 393 × 852 CSS px at 3x | `runs/desktop-webkit.json` |
| simulator | iPhone 17 simulator, iOS 26.3, the app's **Release** build with the bench page (`device.mjs --simulator --auto`), the board in the app's own `WKWebView` | 402 × 723 CSS px at 3x | `runs/bench-simulator-iphone17-20261016-0035.{json,md}` |

Both are the Mac's GPU and CPU drawing. The simulator is the closer of the two (the app's web view, a Release build, the page as it ships
plus the bench), but it is not how a phone draws (goal 7.4). In every run the computed `filter` of the static canvas was what the mode says
(`none`, `url("#aiwb-canvas-dark")`, `invert(0.93) hue-rotate(180deg)`, `none`, `url("#aiwb-bench-matrix")`), every gesture moved the view,
none failed, and the page's messages to the app were held back (`isolated: true`).

The simulator run was made with `TMPDIR` pointing at an empty folder: the first attempt bundled the app from the shared Metro cache, without
the self-test root, and the bench never started (Found on the way, 1). A tap on "Open board self-test" was made with Maestro; the rest ran
by itself.

## Results

**Indicators only, not a result (goal 7.4).** fps mean (min–max over 3 runs); "within" when the range overlaps light's. p95 frame time in ms;
janky = share of frame intervals above 1.5 idle frames (idle frame 17 ms in both).

**Simulator** (iPhone 17 simulator, iOS 26.3, Release build):

| board | gesture | light | dark (today) | dark-css (experiment) | dark-none | dark-matrix |
|---|---|---|---|---|---|---|
| large | pan | 60.4 (60.4–60.5) | 14.0 (13.9–14.1), −77% | 60.4 (60.3–60.4), within | 60.2 (60.2–60.2) | 17.2 (16.7–17.6), −72% |
| large | pinch | 60.1 (60.1–60.2) | 13.6 (13.3–13.7), −77% | 60.1 (60.0–60.1), within | 60.1, within | 16.9 (16.7–17.0), −72% |
| images | pan | 59.9 (59.8–60.0) | 14.0 (13.9–14.2), −77% | 60.0 (59.8–60.1), within | 59.9, within | 17.2 (17.1–17.3), −71% |
| images | pinch | 59.9 (59.8–60.0) | 13.8 (13.6–14.0), −77% | 59.9 (59.8–60.0), within | 59.9, within | 17.0 (16.9–17.0), −72% |

p95 frame time: light, dark-css and dark-none 17 ms; dark 77–81 ms; dark-matrix 63–64 ms. Janky: light, dark-css and dark-none 0–0.4 %;
dark 96–98 %; dark-matrix 97–98.5 %. (dark-none on large pan, 60.2 against 60.4–60.5, does not overlap light's range by 0.2 fps; it is the
same frame rate.)

**Desktop WebKit:** the same picture. light 59.9–60.4 fps, dark 12.9–13.2 fps (−78 to −79 %, p95 80–83 ms), dark-css 59.8–60.5 fps (within
light on all four), dark-none within light on all four, dark-matrix 15.2–15.5 fps (−74 to −75 %, p95 68 ms).

**What dark-matrix shows (for part 2).** A `url()` SVG filter holding only today's `feColorMatrix` (no tables) costs nearly as much as
today's whole filter: 17 fps against 14 on the simulator, 15 against 13 on desktop WebKit, both against 60 for light. So in WebKit the cost
is the `url()` SVG filter path itself, not the 256-entry tables: dropping the tables and keeping an SVG filter would not make dark smooth.
The CSS filter functions (`invert`, `hue-rotate`) cost nothing measurable. On these indicators, a replacement has to avoid `url()` filters
on the canvases (on WebKit; Android's Chromium was not measured, goal 7.3).

## Verdict

**Pending a device run.** No physical iPhone or iPad was reachable, and by goal 4.6 and 7.4 neither indicator can confirm or refute the
cause.

**What the indicators suggest: confirmed.** On both indicators, both boards and both gestures, the numbers meet the fixed criterion:
`dark-css`'s range overlaps `light`'s, and `dark`'s range lies wholly below both (by about 46 fps, far beyond a run-to-run spread of under
0.5 fps). `dark-none` equals light, so nothing else in the dark theme costs anything in this measurement (goal 7.1: no sign that the filter
is only part of the cause). The difference is so large, and lies in a WebKit drawing path rather than in raw speed (an M4 Pro draws the
`url()` filter at 14 fps), that a phone is very unlikely to differ in direction; but that is the question a device run answers.

What the indicators cannot see: the app around the page (the bench holds the page's messages back, so the view messages to the app and the
app's overlays are not measured; they are the same in every theme, goal 5), and frames the compositor drops after `requestAnimationFrame`.

**To get the result**, with the iPhone connected by cable (or paired for the network), unlocked, screen on, on the same Wi-Fi as this Mac,
from this worktree:

```sh
node packages/board-view/dev/bench/device.mjs --device Pedja --auto --label iphone15pro-release
```

It takes the device lock, builds and installs the Release bench build (about 5 minutes), and then needs one tap on the phone, **Open board
self-test**; the bench starts by itself and takes about 10 minutes. It writes `runs/bench-iphone15pro-release-<time>.{json,md}`. Read
the `.md` against the criterion above and fill in this section. The first time, iOS asks to allow AI Whiteboard on the local network: allow
it. Afterwards, put the normal app back with the command the script prints.

## Found on the way (goal 5: written, not fixed)

1. **A Release build can bundle another build's `EXPO_PUBLIC_*` values.** `app/metro.config.js` keys Metro's transform cache by
   `EXPO_PUBLIC_AIWB_VERSION` only, and the cache is in `$TMPDIR/metro-cache`, shared by every worktree on the machine. The first simulator
   install here was built with `EXPO_PUBLIC_AIWB_SELFTEST=1`, yet its bundle had no self-test root (Metro "bundled" 1871 modules in 599 ms,
   all from the cache, although `react-native-xcode.sh` passes `--reset-cache`): the app opened on its normal home screen. The reverse is
   the risk that matters: a normal Release build (an `.ipa` for people, `install.mjs --ipa`) made after a self-test, gallery or probe build
   of the same version can ship the self-test root or a gallery. The bench now builds with its own empty `TMPDIR` and checks the bundle for the self-test root, which avoids it for the
   bench only (`device.mjs`); the app's cache key, which should include every `EXPO_PUBLIC_*` value the code reads, is not changed here.
   **Fixed** in `55d109ea` (branch `xo-metro-cache`): the cache key now hashes every `EXPO_PUBLIC_*` variable (`app/metro-cache-key.js`).
2. **DEVICE.md named the button "Board self-test"**; the self-test screen says "Open board self-test" (`selftest-board`). Corrected in the
   bench's own text.
3. **Nothing else in the dark theme costs anything measurable** in the page: `dark-none` (dark chrome, no filter) equals light within
   0.2 fps on both indicators. So, as far as the page goes, nothing outside the filter matters as much as the filter. What the app does
   around the page (goal 5's list: view messages, overlays) was isolated out on purpose and remains unmeasured.
