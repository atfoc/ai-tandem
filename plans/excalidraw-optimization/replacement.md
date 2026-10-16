# The replacement canvas filter of the phone target (part 2)

Part 2 of `excalidraw-optimization-goal.md` (3.2, 3.3, 4.1–4.8, 6.2, 7.2, 7.3). Branch `xo-filter`. It is merged only if the
experiment (part 1) confirms that the canvas filter is the cause.

## 1. What is expensive, and what is not

Today the board view lays `filter: url(#aiwb-canvas-<theme>)` on Excalidraw's canvases: an SVG filter of an feColorMatrix
and an feComponentTransfer of 256-entry tables (`packages/core/src/logic/canvastheme.ts`).

- **WebKit (iOS, iPadOS).** A composited layer (an accelerated canvas is one) gets its filter from Core Animation only when
  every operation of the filter can be composited: `GraphicsLayerCA::filtersCanBeComposited` refuses a *reference* filter
  (`url(...)`). The CSS functions (`invert`, `hue-rotate`, `saturate`, `sepia`, `grayscale`, `brightness`, `contrast`,
  `opacity`, `blur`, `drop-shadow` last) become CA filters, drawn on the GPU by the render server. A reference filter makes
  WebKit paint the layer's contents through its software filter path on every repaint of the canvas, which is every frame
  of a pan or a pinch. `mix-blend-mode` on a composited layer is a CA `compositingFilter` (multiply, screen, color-dodge, …),
  also on the GPU.
- **Chromium (Android).** cc composites both CSS filter functions and reference filters made of colour primitives
  (feColorMatrix and feComponentTransfer become Skia colour filters), and blend modes, on the GPU. The SVG filter may already
  be cheap there (7.3). The phone target is one build for both platforms, so both get the same new filter, and both
  engines are checked.

So the cheap filter may use CSS filter functions and constant colour layers with blend modes, and nothing else.

## 2. What a cheap filter can and cannot do

Every CSS filter function is, per pixel, an affine map of the colour followed by a clamp to 0–1. Every separable blend
mode with a constant colour is a per-channel function of the canvas's colour: multiply `m·v`, screen `s + (1 − s)·v`,
color-dodge `min(1, v / (1 − d))`. Today's filter is, per channel, a piecewise-linear curve through four points of the
first stage's output v:

    dark themes: (0 → 0), (v(white) → Ground), (v(#1e1e1e) → Ink), (1 → 1)        Latte: (0 → 0), (#1e1e1e → Ink), (1 → Ground)

A chain of clamped affine maps can only make, per channel, one sloped segment between flat ones. It cannot bend between
two sloped segments. So no cheap filter can reproduce the bends of today's tables. The best it can do is the straight line
through the two anchors, per channel, clipped at 0 and 1. That line is exact for every colour whose channels lie between
the two anchors (greys, the default colours, most of the palette). It differs only where a channel lies outside them:
pale, warm colours in the dark flavours (their blue channel), and fully saturated warm colours in Latte. Section 5 gives
the numbers.

Two ways to get that line were measured (scripts in section 7):

1. **A chain of CSS filter functions alone** (the tint from `sepia` turned by `hue-rotate`, around Excalidraw's own
   `invert(93%) hue-rotate(180deg)`). The anchors can be reached (dark 1.3/255, the flavours about 1/255, Mocha 1.9/255),
   but a tint made with `sepia` mixes every colour toward a tinted grey. In the flavours, palette colours move up to
   30–45° of hue from today, and Latte fails (the anchors not reached without breaking the colours). **Rejected.**
2. **Excalidraw's own CSS filter on the canvases, then constant colour layers with blend modes over them.** Exactly the
   per-channel line through the anchors. **Chosen.**

## 3. The design

Per theme, from the `theme` message alone (4.4: nothing on the app's side changes):

1. **The stage on the canvases.** The message's matrix is recognised as one of the two that `canvastheme.ts` makes:
   Excalidraw's `invert(93%) hue-rotate(180deg)` (to 1e-4) → CSS `invert(93%) hue-rotate(180deg)`. The identity (Latte)
   → no filter. Any other matrix → **fallback**: the board view keeps today's SVG filter on the canvases and warns once.
   No current theme takes that path.
2. **The anchors, from the tables.** v_w = the stage's output for the stored white, v_k for the stored `#1e1e1e` (a grey
   stays a grey, so one number each). Ground_c and Ink_c = channel c's table at v_w and v_k, with the linear interpolation
   of feComponentTransfer (exactly what `shown()` computes).
3. **The line per channel.** y_c(v) = a_c + b_c·v through (v_w, Ground_c) and (v_k, Ink_c).
4. **Three colour layers** over the canvases, under everything else of Excalidraw, in this order (each left out when it
   is the identity):
   - `color-dodge` with d_c = 1 − v*_c, where v*_c = min(1, (1 − a_c) / b_c) is where channel c's line reaches 1: each
     channel is clipped where its own line reaches 1 and not before;
   - `multiply` with m_c = b_c · v*_c / (1 − a_c);
   - `screen` with s_c = a_c.

   On the canvas's colour v this gives y_c = s_c + (1 − s_c)·m_c·min(1, v_c / v*_c) = a_c + b_c·v_c up to where it reaches
   1. A channel that would fall under 0 (a_c < 0) does not occur in the five themes. If it does, the derivation answers
   the fallback.
5. **Where the layers go.** Excalidraw's container is not a stacking context. Its canvases are positioned at z-index 1
   (static, and the canvas of the element being drawn) and 2 (interactive). The text editor and the laser layer are at 3,
   its UI at 4, the eye dropper at 5, the link popup at 7. The dialogs are in a container of their own at 1000. Three
   `<div>`s that the board view renders after Excalidraw, inside `.aiwb-board`, with `position: absolute; inset: 0;
   z-index: 2; pointer-events: none` and the blend mode, are therefore painted after both canvases and under all the
   rest. That is CSS and DOM around Excalidraw, not in it (4.2). Only the phone target renders them (4.3), and only
   while a board is shown.
6. **The canvases.** The board's own canvases (`.aiwb-board canvas.excalidraw__canvas`) get the stage in place of
   `var(--theme-filter)`. `--theme-filter` stays `url(#id)` as today, so everything else of Excalidraw that wears it
   keeps today's look exactly: the colour picker's swatches, the library, the text editor while text is edited (it sits
   above the layers), and any canvas in the dialogs' container. The SVG `<filter>` stays in the document for them. They
   are small and repaint only when they change.
7. **Live switch.** A theme message changes the CSS text and the three layers' colours: at once, nothing reloaded
   (3.2). Plain light and plain Excalidraw dark (filter null): no rules, no layers, as today.
8. **What is not touched.** The desktop target (`src/web/`) renders exactly what it does today: the default of the
   option is today's `themeCss` and no layers. The export (`get_image`) draws with `exportWithDarkMode: false` and no
   CSS; it does not see any of this. The board is never written by a theme.

Cost on the GPU: the CA filters on the two canvases, which Excalidraw's own dark mode has too, plus up to three
full-screen blend passes. That is to be measured on the device (6.2), not here.

## 4. How the look is checked

- **The model** (unit test, `packages/board-view/test/phonetheme.test.ts`) computes what the browser computes: the CSS
  filter functions by the Filter Effects formulas, clamped after each, then the blend formulas of Compositing Level 1.
  Held against `shown()` (today) of `@aiwb/core`.
- **Anchors:** stored `#ffffff` and `#1e1e1e` within 3/255 per channel of `shown()`, in all five themes.
- **Colour family**, over Excalidraw's palette (open-color shades 0, 2, 4, 6, 8 of its eleven colours, the five bronzes,
  the canvas background picks), in OKLCH:
  - every colour: |ΔL| ≤ 0.06;
  - a colour that is coloured today (C ≥ 0.05): the hue within 30° of today's, and the chroma not under 0.25 of today's.
  The numbers of section 5 are what these limits are set from. A colour that fails is a finding to report, not a limit
  to raise.
- **A real engine** (`packages/board-view/dev/canvascheck.mjs`, Playwright Chromium and WebKit): the phone page and the
  desktop page draw the same boards in every theme, and the pixels are read back and compared with the model and with
  each other. The script also writes the side-by-side contact sheets.

## 5. Numbers (model)

The anchors' greatest error per channel (/255), then the palette colours that move most (today → new):

| Theme | Anchors (white, ink) | Colours that move most |
|---|---|---|
| dark | 0.10, 0.13 | `#fff9db` `#282300`→`#28230e` (C 0.053→0.035, 6°) |
| latte | 0.00, 0.00 | `#e8590c` `#de792a`→`#de795e` (17°); `#f08c00` `#e49e00`→`#e49e56` (C 0.157→0.121, 12°) |
| frappe | 0.39, 0.15 | `#ffd8a8` `#5e4807`→`#5d4837` (C 0.081→0.040, 27°); `#ffec99` `#4c4400`→`#4c4435` (C 0.080→0.025, 20°); `#fff9db` `#393900`→`#393935` (C 0.073→0.006) |
| macchiato | 0.29, 0.17 | `#ffd8a8` (23°); `#ffec99` (C 0.071→0.030, 19°); `#fff9db` (C 0.062→0.008, 15°) |
| mocha | 0.20, 0.17 | `#fff9db` (C 0.054→0.017, 17°); `#ffd8a8` (14°); `#ffec99` (C 0.065→0.039, 14°) |

The default stroke colours (`#1e1e1e`, `#e03131`, `#2f9e44`, `#1971c2`, `#f08c00`) and the default fills (`#ffc9c9`,
`#b2f2bb`, `#a5d8ff`) stay within a few degrees and units in the dark themes. The pale yellows and pale oranges of the
three dark flavours lose most of their colour: today their blue channel falls to 0 on the steep first segment of the table,
while the line keeps it at the screen colour, the ground's blue. Pale yellow `#ffec99` (a default fill) shows as a dark
olive grey in Frappé where it is a dark olive today. In Latte, fully saturated oranges lose a quarter of their chroma.
That is 7.2 come true for these colours, and it is reported here, not hidden. Measured in the unit test with the limits of
section 4, three colour-theme pairs fail the chroma limit, and they are held there as a named list with their values pinned:
`#fff9db` in Frappé (C 0.073 → 0.007) and in Macchiato (0.062 → 0.009), and `#fffce8` in Frappé (a canvas background pick,
0.056 → 0.006). `#ffec99` in Frappé keeps 0.31 of its chroma and passes, at 20° of hue.

## 6. Results

Branch `xo-filter`: the design (`4c9c71f4`), the filter (`00df02b8`, merged `2392e83f`) and the real-engine check (merged
`3baeb35e`).

### What was built

- `packages/board-view/src/phonetheme.ts`: `phoneCanvas(filter)` (the derivation of section 3, or `none`, or `fallback`
  with the reason), `phoneShown(filter, colour)` (the model of what the browser draws), and `phoneThemeCss(filter)`.
- `EndpointOptions.canvas`. The default is today's `themeCss` and no layers (the web/desktop target, unchanged). Only
  `src/webview/entry.tsx` passes the phone's. `Board.tsx` renders the layers as `<div class="aiwb-canvas-layer">` after
  Excalidraw, only while a board is shown.
- `packages/board-view/test/phonetheme.test.ts` (9 tests): the anchors, the colour family with the named exceptions
  pinned, the harness's filter, the fallback, no filter, and the desktop's `themeCss` pinned to the letter.
- `packages/board-view/dev/harness.mjs`: the theme step differs by page. The phone's canvas wears the stage and the
  layers are there, gone in plain light and back. The web page is as before.
- `packages/board-view/dev/canvascheck.mjs`: the real-engine check and the contact sheets (section 4).

### Numbers

Model (`phoneShown` against `shown()`): **the anchors are exact (0/255) in all five themes.** The 0.1–0.4 of section 5
were the rounding of the tables. The largest |ΔL| over the palette is 0.028.

Real engines (`node dev/canvascheck.mjs --sheets`, Playwright 1.64.1: Chromium 156 and WebKit), the largest channel
error in /255:

| Engine | Theme | Desktop page vs `shown()` (anchors, palette) | Phone page anchors vs `shown()` | Phone palette vs `phoneShown()` | Family fails |
|---|---|---|---|---|---|
| Chromium | dark | 1, 1 | 1 | 2 | 0 |
| Chromium | latte | 1, 1 | 0 | 1 | 0 |
| Chromium | frappe | 1, 2 | 1 | 1 | 1 (`#fff9db`) |
| Chromium | macchiato | 1, 2 | 1 | 2 | 1 (`#fff9db`) |
| Chromium | mocha | 1, 2 | 1 | 1 | 0 |
| WebKit | dark | 1, 1 | 2 | 2 | 0 |
| WebKit | latte | 1, 1 | 0 | 1 | 0 |
| WebKit | frappe | 1, 2 | 2 | 3 | 1 (`#fff9db`) |
| WebKit | macchiato | 1, 2 | 1 | 2 | 1 (`#fff9db`) |
| WebKit | mocha | 1, 2 | 1 | 2 | 0 |

**The anchors are within 2/255 in both engines, against the limit of 3.** In every engine and theme, the same run also
held the following:

- Excalidraw's chrome on the phone page equals the desktop page's (0/255): no layer is over the UI.
- A live switch through every theme, back and forth, then to plain light: each takes effect at once. In plain light the
  stored colours are drawn exactly and no layer is left. No `changed` is posted by any switch or by the `unload` after.
- `get_image`: the same bytes in all six theme states, on both pages, and between the two pages.

### What looks different (to decide, 4.5)

Today and new, side by side, per theme and engine: `node packages/board-view/dev/canvascheck.mjs --sheets --out <dir>`
(after `npm run build:webview` in `packages/board-view`). The sheets are not committed: about 150–230 KB each, ten of them.

- **Dark, Mocha:** the boards look the same. The palest yellow is a little greyer.
- **Frappé, Macchiato:** the defaults, the reds, greens, blues and violets, and the pictures look the same. The yellow and
  orange rows are visibly duller and browner. The pale yellow default fill `#ffec99` is a dark olive today and a greyish
  olive-brown now. `#fff9db` and `#fffce8` become nearly grey.
- **Latte:** the boards look the same. The fully saturated yellows and oranges, in the palette and in pictures, are a
  little duller.

Every anchor is within the tolerance, and every colour but the three pairs of section 5 stays in its family by the
criterion of section 4. The look is not the same for warm pale colours in Frappé and Macchiato, and that is visible side
by side. No cheap filter can do better (section 2: the tables bend, and composited CSS cannot). Shipping it, or not, is
the user's decision.

### Tests run (all pass)

- Root `npm test` (516, 62, 23, 204 and 1555 tests) and `npm run check`. `cd web && npm test` (44). `cd desktop && npm test`
  (133).
- `packages/board-view`: `npm run build:web && npm run build:webview && node dev/harness.mjs`, giving `harness: ok`.
  `node dev/canvascheck.mjs --sheets`, giving `canvascheck: ok`.
- The desktop target is unchanged. The browser checks that cover the theme on the web build: `cd web && npm run uicheck --
  P7.5 P7.1 L24 A6.3`. 5 of 5 pass on Chromium 156 (P7.5 the canvas's ground and filter in each theme, P7.1, L24 the stored
  file the same in every theme, A6.3 board and markdown).
- Not run: the device flow and the smoothness measurement (not part 2's, see below), Go tests (no Go changed), paid tests.

### For the device (6.2, after the experiment's verdict)

- **Build.** From this branch: `node app/scripts/install.mjs --platform ios --device <name>` (under `zsh -ic`, with the
  device lock of ORCHESTRATION.md). It is a Release build and rebuilds the board's page itself (`npm run prebuild:board`, i.e.
  `npm run build:webview -w @aiwb/board-view`). Android: `--platform android`. Measure in plain light, Dark, the flavours,
  and on at least one Android device (7.3).
- **To watch on the device** (not knowable from a desktop engine):
  - Whether WebKit composites the canvases' CSS filter. A canvas that is not a composited layer has its filter painted in
    software even for CSS functions. Accelerated 2D canvases are composited on iOS, so it should be. If it is not, adding
    `will-change: filter` to the stage's rule is the lever to try.
  - The three full-screen blend passes (`color-dodge`, `multiply`, `screen`; Latte has two) on top of what Excalidraw's own
    dark mode costs.
  - Colours on a wide-gamut screen: the blend is done by Core Animation, as on the desktop engines the arithmetic was
    checked in. A difference there would show in the anchors.
- **If the layers turn out not to be smooth:** the measured alternative is a chain of CSS functions alone (section 2,
  option 1). It is cheaper but looks worse (hue up to 30–45° off in the flavours, Latte not reachable).

## 7. Scripts of the study

The fits of section 2 were made with throw-away scripts (a Nelder–Mead search over chains of CSS functions, and the
derivation of section 3 in a few lines). The derivation is now `packages/board-view/src/phonetheme.ts`, and its test
holds the numbers above.

## 8. The replacement, indicators

**Indicators only, not a result (goal 7.4).** No physical iPhone or iPad was used. Both runs are from this Mac (Apple M4 Pro) with the
bench of `packages/board-view/dev/bench/` (README there): the phone page as it is on this branch, the same two boards (`large`, 3000
elements; `images`, 12 pictures), a pan and a pinch of 4 s each, 3 repetitions, the set `replacement` (11 modes). `<theme>` is the
theme message the app sends, drawn by the page's new filter (CSS stage + blend layers); `<theme>-today` is the same message drawn as the
page drew it before the replacement (the SVG `url(#aiwb-canvas-<theme>)` filter, no blend layers); `light` is the reference. In every
run the computed `filter` and the blend layers were what the mode says: `<theme>` the stage (`invert(0.93) hue-rotate(180deg)`, `none` for
Latte) with its layers drawn (dark 2, Latte 2, Frappé, Macchiato and Mocha 3); `<theme>-today` the `url()` filter with no layer drawn;
`light` none and no layer. Every gesture moved the view, none failed, the page's messages to the app were held back.

fps, then p95 frame time (ms), then the janky share (frame intervals above 1.5 idle frames, %): the lowest and highest of the four
cells (board × gesture), each cell the mean over the 3 repetitions. The idle frame is 17 ms. Files: `runs/desktop-webkit-replacement.json`,
`runs/bench-replacement-release-20261016-0131.{json,md}` (the `.md` has the full tables with the ranges over the repetitions).

**Desktop WebKit** (Playwright WebKit, Safari 27.2 engine, 393 × 852 CSS px at 3x):

| theme | light fps (p95, janky) | new: fps | p95 | janky % | today: fps | p95 | janky % |
|---|---|---|---|---|---|---|---|
| dark | 59–60 (18–19, 0–1) | 59–60 | 18–19 | 0–1.3 | 12 | 90–94 | 96.5–97.9 |
| latte | 59–60 (18–19, 0–1) | 59–60 | 19 | 0.4–1.3 | 26–27 | 40–43 | 97.1–98.4 |
| frappe | 59–60 (18–19, 0–1) | 59–60 | 18–19 | 0–0.9 | 12 | 89–97 | 94.3–97.9 |
| macchiato | 59–60 (18–19, 0–1) | 60 | 18 | 0–0.6 | 12 | 91–94 | 95.8–97.9 |
| mocha | 59–60 (18–19, 0–1) | 60 | 18–19 | 0.1–0.3 | 11–12 | 93–96 | 95.8–97.8 |

**iOS simulator** (iPhone 17, iOS 26.3, the app's Release build with the bench page, the board in the app's own `WKWebView`, 402 × 723 CSS px at 3x):

| theme | light fps (p95, janky) | new: fps | p95 | janky % | today: fps | p95 | janky % |
|---|---|---|---|---|---|---|---|
| dark | 60 (17, 0–0.4) | 60 | 17 | 0–0.4 | 14 | 78–82 | 96.5–98.2 |
| latte | 60 (17, 0–0.4) | 60 | 17 | 0–0.4 | 21 | 51–53 | 97.6–98.8 |
| frappe | 60 (17, 0–0.4) | 60 | 17 | 0–0.4 | 14 | 77–81 | 96.4–98.2 |
| macchiato | 60 (17, 0–0.4) | 60 | 17 | 0–0.4 | 14 | 78–80 | 96.4–98.2 |
| mocha | 60 (17, 0–0.4) | 60 | 17 | 0–0.4 | 14 | 76–81 | 96.4–98.2 |

What the indicators say, and do not say:

- On both, in all five themes, on both boards and both gestures, the new filter's fps range overlaps light's (the bench's "within"; the
  worst single run is 56.8 fps in Frappé on desktop against light's 60), and today's filter is 55–81 % below light. The blend layers
  (two or three full-screen passes over the canvases) cost nothing that these frame intervals show.
- Latte is the cheapest of today's filters (21–27 fps against 12–14 for the others): its first stage is the identity, so only the
  tables are left. The other four are the same within the spread.
- The set `experiment` was also run on desktop (`runs/desktop-webkit-experiment.json`): light 59.9–60.5, `dark-today` 12.5–13.2,
  `dark-css` 59.8–60.9, `dark-none` 59.8–60.3, `dark-matrix` 15.1–15.6 fps. It agrees with the earlier run (`dark-today` is that run's `dark`).
- Not seen: how a physical phone draws (a different GPU and a thermal limit), Android's Chromium (goal 7.3), frames the compositor drops after
  `requestAnimationFrame` (the rAF intervals do not see them), the look (section 6, "What looks different"; the bench measures speed
  only), and the chrome of a flavour (`chrome: null` in the bench). The question for the device run is whether Core Animation on a
  phone composites the canvases' CSS filter and the three blend layers as smoothly as these Macs do (section 6, "To watch on the device").

To get the device numbers for this section: `node packages/board-view/dev/bench/device.mjs --device Pedja --auto --label replacement`
(set `all`, about 19 min) or with `--modes replacement` (about 15 min), `DEVICE.md` there.
