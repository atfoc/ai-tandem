# Spike: the board host's tldraw in Node (risks 8.1, 8.2, 8.5, 8.8)

Research spike `bb-spike-host`, code in `spikes/tl-host/` (its own `package.json`, exact pins). Every number was measured
on the shared 14-core Mac (darwin-arm64, macOS 27), Node 24.3.0, tldraw 5.6.0, skia-canvas 4.0.0, @resvg/resvg-js 2.6.2,
jsdom 27.4.0. The Chromium reference is Chromium 156.0.8078.4 (Playwright 1.64.1). Marks as in the goal; every
recommendation here is `[proposed]`.

## 0. In short

- **A. tldraw's `Editor` runs in Node on jsdom**, unpatched. It creates, updates and deletes every default shape the
  prototype needs (note, geo with text, text, arrow bound to two shapes that follows when they move and lets go when one
  is deleted, frame with children that move with it, draw) in one transaction. Start: ~0.4 s for jsdom + tldraw +
  skia-canvas, ~2 ms per further editor.
- **B. Its text measuring can be replaced by one on skia-canvas with tldraw's own font files, and it matches Chromium.**
  On a 1,534-case corpus (13 texts × 4 fonts × 4 sizes through notes, geo, ellipses, auto and fixed-width text, arrow
  labels, frame headings, plus raw `measureHtml` calls): **every note (208/208) and every geo shape (208/208) stores the
  same `growY` and `fontSizeAdjustment` as Chromium, exactly**, and all non-CJK cases are within 0.5 px except four
  overflow splits of a single long word in Shantell Sans at a 120 px width and one truncated frame heading. CJK differs
  by +0.4% to +1.7% (one system font, PingFang SC, applies per-size tracking in Chromium only: risk 8.7).
- **C. Pictures without a browser work.** tldraw's own SVG export runs on jsdom; its text comes out as HTML in
  `<foreignObject>`, which no rasterizer outside a browser lays out, so the host replaces each label with glyph outlines
  laid out by the same code as the measuring, then rasterizes with resvg. The reference board: **same size as Chromium's
  export, 0.31% of pixels differ by more than a quarter of a channel** (goal 6.5 allows 2%), text within 0.3 px, no
  shape displaced. 100–180 ms per picture of a small board.
- **D.** see section 4 (from `bb-spike-host-sync`).
- **E.** see section 5.

## 1. A: the Editor in Node

`src/dom.ts` installs one jsdom window on `globalThis` before tldraw is imported (`src/headless.ts` imports tldraw
dynamically after it). `src/editor.ts` builds the editor exactly as the page does (`new Editor` with `defaultShapeUtils`,
`defaultBindingUtils`, `defaultTools` + `defaultShapeTools`, TipTap's default extensions, `registerDefaultSideEffects`):
no React, no UI. The same function builds the Chromium reference's editor (`dev/chromium/page.ts`), so the two sides
differ only in `editor.textMeasure`.

What tldraw reaches for, and what it got:

| Needs | Why | Given by |
|---|---|---|
| `document.createElement`, `innerHTML`, `classList`, `style.setProperty`, `appendChild` | the TextManager's measuring divs (made in its constructor, before it can be replaced) | jsdom |
| a real DOM serializer | TipTap's `generateHTML` (rich text → HTML for measuring and for the export) | jsdom |
| `react-dom/client` rendering into the document, `SVGSVGElement`, `querySelectorAll`, `XMLSerializer` | the SVG export (`exportToSvg` renders the export components into a hidden div and reads the SVG back) | jsdom |
| `Range.getClientRects`, `getBoundingClientRect`, layout | the TextManager's measuring | **nothing in jsdom (all 0)**: replaced, section 2 |
| `window.fetch` of font URLs, `FileReader` | the export embeds the fonts it used as `@font-face` data URLs | a `fetch` for `file:` URLs in `headless.ts` (jsdom Blobs, so jsdom's FileReader reads them) |
| `matchMedia`, `ResizeObserver`, `IntersectionObserver`, `requestIdleCallback`, `FontFace`, `document.fonts` | read at start or by managers | small stand-ins in `dom.ts` |

**Stand-in page vs jsdom.** A hand-made stand-in page like `packages/board-engine/src/page.ts` was enough for
Excalidraw's element code because that code only reached for a canvas and fonts. tldraw needs a DOM: TipTap serializes
ProseMirror nodes with a document, and the export renders React components with react-dom and walks the result. A
stand-in would be a DOM implementation of its own. jsdom works unchanged. Its cost (~80 MB RSS, ~190 ms) and the lighter
DOMs are section 5 (`bb-spike-host-dom`).

**Not patched, not forked (goal 4.1).** The only seam used is replacing `editor.textMeasure` with an object of the same
shape after construction (`installCanvasMeasure`), plus the editor's own `fontAssetUrls` option.

## 2. B: text measuring with skia-canvas and tldraw's fonts (risk 8.2)

### What tldraw measures (5.6.0)

`measureHtml(html, opts)` for every label (geo, note, text, arrow), `measureHtmlBatch` for geo labels in bulk,
`measureTextSpans` for frame headings, `measureText` for the cursor chat bubble. The HTML is TipTap's
(`<div class="tl-rich-text"><p dir="auto">…</p></div>`), measured in a div styled by `editor.css` `.tl-text-measure`:
`width: max-content`, `max-width`/`min-width` from the options, `white-space: pre-wrap`, `overflow-wrap: break-word` (or
`normal` with `disableOverflowWrapBreaking`), `line-height` = round(fontSize × 1.35) px. What is **stored** from it:
note `growY` and `fontSizeAdjustment` (the note shrinks its font by 1 px steps while a word overflows, down to 14 px),
geo `growY`. A text shape's `w` is not rewritten on create in 5.6.0 (its geometry is measured on the fly), so its stored
value is the default on both sides; its bounds are compared instead.

### How the replacement works (`src/measure.ts`, `src/fonts.ts`)

1. **Fonts.** The 16 woff2 files of `@tldraw/assets` 5.6.0 (IBM Plex Sans/Serif/Mono Medium and Bold with italics,
   Shantell Sans Informal; 1.3 MB). skia-canvas loads woff2 directly. Each face is registered under an alias of its own
   (`tldraw_sans__bold_normal`), because the files' metadata disagree with the `@font-face` rules (Shantell "Regular"
   says weight 611, italic): CSS weight/style matching is done in `fonts.ts`, never by the canvas.
2. **Fallback as Chromium does it.** Generic families resolve to what Chromium uses on the platform (macOS: Helvetica,
   Times, Menlo; `Inter` is absent and skipped). For `serif`, Chromium picks fonts **per script**: Han and kana from
   Songti SC, Hangul from AppleMyungjo (measured with CDP `CSS.getPlatformFontsForNode`); the system fallback after
   Times would take the sans ones, so they are listed explicitly. Emoji-presentation clusters (default emoji, VS16, ZWJ,
   skin tones, keycaps, flags) always go to the colour emoji font, as in Chromium: `❤️` in IBM Plex Mono, which has a
   text ❤ of its own, is 36 px in Chromium and was 21.7 px through the family list. Everything else is left to
   skia-canvas's system fallback (CoreText), which agrees with Chromium's.
3. **HTML → blocks of styled runs** (paragraphs, `<br>`, bold, italic, code, mark, links, lists with their `ch` indent,
   headings with their margins), parsed with the DOM's own parser.
4. **Line breaking as Blink does it** for `pre-wrap`: greedy, at UAX #14 opportunities (the `linebreak` package, 1.1.0,
   standing in for ICU) **except between two printable ASCII characters, where Blink uses a table of its own**
   (`kAsciiLineBreakTable`). The table was measured from Chromium (`dev/probe/chromium-ascii-breaks.mjs` →
   `src/ascii-breaks.json`, 241 breaking pairs of 8,836; UAX #14 disagrees on 389 pairs: Chromium does not break a URL
   after `/` or `:`, breaks before `(` `<` `[` `{`, and after `-` before digits). Trailing spaces hang; a word longer
   than the line is split between graphemes only with `overflow-wrap: break-word`; widths are rounded up to Blink's
   LayoutUnit (1/64 px), with a 1/50-unit tolerance because skia-canvas sums advances in float32 (168.0000153 where
   Blink gets 168.0, which decided whether "Hello world" fits a 168 px label).
5. **Widths** are skia-canvas `measureText` of each run shaped as one piece (HarfBuzz, kerning across spaces included,
   as in Blink's line layout; default-ignorable characters such as the U+200B tldraw appends to frame titles have no
   advance). Frame heading spans take their positions from prefix widths of the whole line, not from words measured
   alone (kerning across a space moved the end by 2 px otherwise).
6. **The result** is the box tldraw expects (`w` = clamp(max-content, min, max), `h` = the line boxes, `scrollWidth` =
   the widest line rounded) and, for the export, the lines themselves (`layoutHtml`).

### Measured against Chromium (`dev/node-corpus.ts`, `dev/chromium/run.mjs`, `dev/compare.ts`)

Equal = every field within 0.01 px.

| Kind (what is compared) | Cases | Equal | Within 0.5 px | Worst |
|---|---|---|---|---|
| note (`growY`, `fontSizeAdjustment`, bounds) | 208 | **208** | 208 | 0 |
| geo rectangle 200×100 (`growY`, `h`) | 208 | **208** | 208 | 0 |
| geo ellipse 160×80 | 208 | 207 | 207 | 43 px: one line more, CJK in mono at xl |
| text, auto size (bounds) | 208 | 185 | 199 | 6.0 px: CJK at xl |
| text, fixed width 150 (bounds) | 208 | 207 | 207 | 59 px: one line, Shantell overflow split |
| raw `measureHtml` (w, h, scrollWidth) | 468 | 447 | 458 | 49 px: one line, Shantell overflow split |
| arrow label (size, ends) | 13 | 13 | 13 | 0 |
| frame heading (spans' extent) | 13 | 10 | 12 | 6.0 px: truncated heading |

**Without CJK, every case is within 0.5 px except five:**

- **Four overflow splits in Shantell Sans** (a word longer than a 120 px line, split by `overflow-wrap: break-word`, at
  36 px; e.g. `example.com` → Chromium `exam|ple.co|m`, Node `examp|le.com`). Shantell Sans Informal has contextual
  alternates, so a glyph's width depends on its neighbours. Blink finds the split point with the whole word's shaping;
  measure.ts measures each prefix alone. Fixing it needs glyph positions from one shaping of the word (HarfBuzz in wasm,
  or a skia-canvas API that exposes them), only for this fallback. Notes reach this path only at 14 px and below.
- **One truncated frame heading** (`word-break: break-all` + ellipsis): the UAX #14 rules that still hold under
  break-all (no break before `.` `,` `)` …) are not modelled. Frame headings are not stored, only drawn.

**CJK (risk 8.7, system fonts).** Kana (Hiragino Sans), Hangul (Apple SD Gothic Neo) and the serif fonts are exact. Han
in PingFang SC is not: Chromium applies the font's per-size tracking (`trak`), skia-canvas one ratio (+2.1%) at every
size. Per-character advance, Chromium / Node:

| px | 8 | 12 | 16 | 20 | 22 | 28 | 32 | 36 | 48 | 64+ |
|---|---|---|---|---|---|---|---|---|---|---|
| Chromium | 8.177 | 12.253 | 16.320 | 20.381 | 22.288 | 28.364 | 32.289 | 36.289 | 48.220 | size + 0.25…0.38 |
| Node | 8.168 | 12.252 | 16.336 | 20.420 | 22.462 | 28.588 | 32.672 | 36.756 | 49.008 | size × 1.021 |
| ratio | 1.001 | 1.000 | 0.999 | 0.998 | 0.992 | 0.992 | 0.988 | 0.987 | 0.984 | 0.983 |

So a Han text is up to 1.7% wider in the host on macOS, which can move a line break near the edge (1 of 16 CJK geo
ellipses). Linux (Noto CJK, no `trak`) and Windows were not measured. Two ways out, both cheap: ship a CJK font with the
board (the window and the host then use the same file; Noto Sans CJK is several MB per weight even when cut by script, not measured here), or scale
PingFang runs by the measured table above (a macOS-only correction). Emoji are exact (Apple Color Emoji, every family).

## 3. C: pictures in Node (goal 4.9)

`src/export.ts`:

1. `editor.getSvgElement(ids, opts)` on jsdom: tldraw's own export components rendered by react-dom, as in a window.
   Shapes are SVG paths; the note shadow is an SVG filter; frame headings are SVG `<text>` with explicit tspans; every
   rich-text label is a `<foreignObject>` with HTML.
2. `textToPaths()` replaces each label with the glyph outlines (skia-canvas `outlineText`, the same fonts and fallbacks
   as the measuring) of the lines `layoutHtml` lays out in the label's box (its padding, flex alignment, `text-align`,
   line height). Colour emoji have no outlines and become small PNG `<image>`s drawn by skia-canvas at 2x. tldraw's text
   outline (`text-shadow` of the background colour at ±1 px in six directions) becomes six offset copies under the
   text. `<text>` headings get Blink's `alignment-baseline: mathematical` shift (half the ascent). The embedded
   `@font-face` CSS is dropped (no text is left to use it).
3. resvg rasterizes the result (no text and no HTML left, so it needs no fonts), with the root's CSS background passed
   as resvg's background (resvg ignores CSS on the root `<svg>`).

| | resvg 2.6.2 (chosen) | skia-canvas 4.0.0 (`Image` from SVG) |
|---|---|---|
| Reference board, 904×573 | 100–180 ms | ~650 ms |
| Strongly differing pixels vs Chromium's `toImage` | **0.31%** (weak, > 1/16: 2.4%) | 0.50% |
| Emoji `<image>` (data URL inside the SVG) | drawn | **dropped** |
| Size vs Chromium | same | same |

Stored records of the board (`dev/node-board.ts` vs Chromium's): all 9 identical except the text shape's width, 0.94 px
narrower in Chromium because of its two Han characters (PingFang, above). Where the strong pixels are (`out/diff-board.png`):
glyph edges, the 36 px text's antialiasing, the note shadow's bottom edge. Ink centroids of the labels are within 0.3 px.

Also seen: a frame exported alone comes out as tldraw does it in a window (its contents clipped, no heading); scale 2
works (33 ms); a 189-shape board at scale 1 (4904×3373 px) takes 2.5 s and at 0.25 385 ms, so the host should cap the
picture's pixel size.

**Why not resvg's own text.** resvg reads TTF/OTF only (tldraw ships woff2), shapes with rustybuzz and has its own
fallback; it would be a third text engine beside Chromium's and skia-canvas's. Outlines from the measuring engine draw
exactly what was measured.

## 4. D: the room, the editor as a peer, reconnecting (risk 8.5)

(from `bb-spike-host-sync`)

## 5. E: cost (risk 8.8)

(measured; see below)

## 6. Recommendations for the board host

(see below)
