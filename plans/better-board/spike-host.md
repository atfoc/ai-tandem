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
- **D. `TLSocketRoom` runs in Node with the headless editor as a sync client** over an in-process socket pair, beside
  a second client standing in for a window. Changes reach the other side in ~30–50 ms (tldraw's 30 fps throttle), the
  agent has presence (name, cursor, selection), and concurrent edits converge. **Risk 8.5 is real:** restoring a room
  from an older snapshot as saved can leave a reconnecting window **permanently out of sync with no error**. Shifting
  the room's clock on every load (`snapshotForRestore`) fixes it: every returning client then reloads the room's state
  and resends its own unacknowledged edits. Edits the room acknowledged but never saved are lost everywhere.
- **E. Cost**, bundled as it would ship, with linkedom as the DOM: ready in ~170 ms, 121 MB RSS loaded, **139 MB with
  one room** (room + the agent's editor peer + a window client), **166 MB with ten**, an agent batch ~5 ms of CPU and
  ~65–70 ms until the room has acknowledged it, a PNG of a small board ~100 ms. With jsdom: 176 / 191 / 213 MB.
  Today's headless writer: 120–135 MB.

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

**Stand-in page vs a DOM.** A hand-made stand-in page like `packages/board-engine/src/page.ts` was enough for
Excalidraw's element code because that code only reached for a canvas and fonts. tldraw needs a DOM: TipTap serializes
ProseMirror nodes with a document, and the export renders React components with react-dom and walks the result. A
stand-in would be a DOM implementation of its own. Three real DOMs were tried (`TLHOST_DOM=jsdom|happy|linkedom`,
`src/dom-pick.ts`; `spikes/tl-host/notes/dom.md`). On each one the corpus gives byte-identical JSON and the board PNG is
byte-identical:

| DOM (exact pin) | Shims beyond the common ones | RSS of the DOM alone | Import + install |
|---|---|---|---|
| jsdom 27.4.0 | none | +80 MB | 197 ms |
| happy-dom 21.0.4 | 1 (iframe `contentDocument`), plus reading the `font` shorthand in `export.ts` | +56 MB | 119 ms |
| linkedom 0.18.15 | 9, ~40 lines (`requestAnimationFrame`, `location`, `createHTMLDocument`, Blob/FileReader, `SVGSVGElement` by tag, empty `getComputedStyle`, iframe document, `XMLSerializer`, `styleSheets`) | +21 MB | 52 ms |

The cost of an editor does not depend on the DOM (~2 MB each). The DOM is a fixed cost per process.

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

Code: `src/room.ts`, `dev/sync.ts`, `dev/reconnect.ts`; the full write-up with the source reading is
`spikes/tl-host/notes/sync.md` (`bb-spike-host-sync`). Both scripts pass on jsdom and on linkedom.

**What `room.ts` is** (the shape the board host can lift):

- `createRoom({snapshot?, onDataChange?})`: a `TLSocketRoom` with tldraw's default schema.
- `ProxySocket`: the server half of one session. It needs only `send`, `close` and `readyState`, and the host feeds it
  with `room.handleSocketMessage` / `handleSocketClose`. This is goal 7.4's per-window proxy whose `send()` goes back
  through Go.
- `ClientSocket`: the client half (`TLPersistentClientSocket`), driven by its transport. The window's custom socket has
  this shape.
- `InProcessConnection`: joins the two halves with JSON strings, delivered asynchronously, and can cut and restore the
  link (also onto a restored room).
- `connectEditor(room, {userId, userName})`: **the agent as a peer**, a `TLSyncClient` with presence and the headless
  Editor (canvas measuring) on its store, plus `setCursor(x, y)`. `connectClient`: a bare client (the window stand-in).
  `whenSettled()`: resolves when every local change is pushed and acknowledged (it is in the room's storage).

**Results:**

1. The editor runs `buildBoard` in one transaction and the other client gets every record. Update, delete, and moving a
   bound shape (the arrow follows) arrive in 27–49 ms, the other way round in 45 ms. **Latency comes from tldraw's
   30 fps throttle**, not the transport.
2. **Presence:** within ~30 ms the window gets an `instance_presence` with the agent's `userName`, color, cursor (page
   point) and selection. What it needed: a `user:` id, `presenceMode` forced to `'full'` (otherwise the agent stays
   invisible until it sees someone), and the cursor written to the pointer record directly (the editor only writes it on
   pointer events).
3. **Concurrency:** the same property changed at once ends with the last push to reach the room, the same in every
   store; different properties or shapes are all kept (per-property patches); a burst of 50 interleaved edits converges.
4. **Persistence:** `getCurrentSnapshot()` is plain JSON (5.7 KB for the board) with the clock and tombstones; a room
   built from it is equal. `onDataChange` fires on every committed document change, synchronously and unthrottled, and
   not for presence.
5. **A lone window is slow unless the agent has presence.** `TLSyncClient` drops to 1 fps while it sees no other
   presence ("solo" mode). Agent changes written with `room.updateStore` reached a lone window ~800 ms late; with the
   editor peer publishing presence, ~35 ms. The first change after solo mode pays one ~900 ms frame.

**Reconnecting (risk 8.5)**, the same for a plain client and for the headless editor:

| Scenario | Room restored as saved | Restored with the clock shifted (`snapshotForRestore`) |
|---|---|---|
| a. Edits acknowledged, not yet saved; the room restarts from the older save | every client wipes and reloads: consistent, those edits lost everywhere | same |
| a2/a3. Another client moves the restored room's clock up to or past the returning client's before it reconnects | **permanently diverged, no error** (incremental diff from a reused clock) | consistent (full reload) |
| b. As a, plus edits made while cut off | they are resent and kept; patches to records only the lost edits had created are dropped silently | same |
| c. The connection drops, the room stays up, edits made while cut off | **resent and kept** (goal 3.4's question); on the same property, the last to arrive wins | – |
| d. Normal catch-up | incremental diff, consistent | – |

Why: the client resends only its unacknowledged ("speculative") changes. On connect the room answers with the changes
since the client's `lastServerClock`, which is only right if the clock was never reused. The snapshot already holds the
clock, so saving it changes nothing. Moving the clock and the start of the tombstone history far ahead on every load
forces a full reload for every returning client.

## 5. E: cost (risk 8.8)

`dev/cost.ts`, built as one bundle per DOM (`dev/bundle-cost.mjs <dom>`, so no type stripping and no other DOM loaded),
`node --expose-gc out/cost-<dom>.mjs`, gc before each reading, two runs each (they agreed within 2 MB). A "room" is a
`TLSocketRoom`, the agent's editor peer (canvas measuring) and one window client, holding the reference board.

| | linkedom | jsdom |
|---|---|---|
| Host loaded (DOM, tldraw, sync-core, skia-canvas, fonts), since process start | ~170 ms, 121 MB RSS / 32 MB heap | ~305 ms, 176 MB / 51 MB |
| First room ready, since process start | ~270 ms | ~415 ms |
| 1 room | **139 MB** / 35 MB | 191 MB / 54 MB |
| 10 rooms | **166 MB** / 41 MB | 213 MB / 61 MB |
| After 10 PNGs (resvg's native memory is not handed back) | 231 MB | 316 MB |
| Agent batch (`buildBoard`: 9 shapes, 2 bindings, measured text) + acknowledged by the room | 68–72 ms (≈5 ms CPU + one or two 33 ms sync frames) | 65–69 ms |
| Room snapshot to JSON (the save) | < 1 ms | < 1 ms |
| PNG of the board (904×573), warm / first | 95–111 / ~180 ms | 98–113 / ~190 ms |

Running the TypeScript sources directly adds ~32 MB (Node's type stripping). Other measurements:

- A fresh editor costs 1–2 ms, loading a 450-shape snapshot into it 7 ms, and the first batch in a cold editor 5–15 ms
  more than in a warm one (`dev/cost-editor.ts`).
- The corpus (1,534 measured cases) takes ~0.8 s in Node and ~0.2 s in Chromium. A label is measured in ~0.5 ms
  uncached; widths are cached per font and text.
- A 189-shape board as a 4904×3373 PNG takes 2.5 s; at scale 0.25, 385 ms.

Against today's headless writer (120–135 MB): about +20 MB for the first board, then ~3 MB per open board. That holds
with linkedom. With jsdom, add ~55 MB.

## 6. Recommendations for the board host `[proposed]`

1. **A real DOM, linkedom, behind one module.** Run the editor on linkedom 0.18.15 with the shims of
   `src/dom-linkedom.ts`, and keep jsdom selectable as the fallback (one module, the same `installPage()`). linkedom
   saves ~55 MB and ~150 ms of start-up over jsdom with identical results. The risk is a tldraw upgrade that reaches for
   a DOM API linkedom lacks: the faithfulness harness (corpus + picture against Chromium, and against jsdom) must run on
   every tldraw upgrade. A hand-made stand-in page is not worth it: it would be a DOM implementation of its own.
2. **A persistent editor peer per room with agent activity**, created at the agent's first call and disposed with the
   room or after the agent's quiet time. It is the only way to get the agent's marker (3.4). It keeps a lone window at
   30 fps instead of tldraw's 1 fps solo mode, behaves like a window in every reconnect case, and costs ~2–3 MB. One
   agent call: apply the operations in one `editor.run`, then `whenSettled()` (pushed and acknowledged), then save the
   room's snapshot, then answer.
   - `whenSettled()` reads private fields of `TLSyncClient` 5.6.0. Watching `room.getCurrentDocumentClock()` until the
     agent's records appear is the public alternative.
   - A short-lived editor per call would also be cheap (~10–20 ms), but loses the marker and needs our window client to
     force `presenceMode: 'full'`.
3. **Rooms.** Always load a board's room through `snapshotForRestore()` (clock shifted). Save on `onDataChange` with a
   throttle of a few seconds, on room close and on shutdown signals. Never push a record that fails validation: the
   room closes that session for good (`INVALID_RECORD`) and the client does not reconnect. Going through the Editor
   validates first.
4. **Measuring: `src/measure.ts` + `src/fonts.ts` as they are**, with:
   - `src/ascii-breaks.json` regenerated by the probe whenever the reference Chromium changes;
   - the `serif` per-script fallback list made per platform;
   - a decision on CJK (ship a CJK font with the board, or the PingFang correction on macOS);
   - glyph positions from one shaping only if the Shantell overflow splits matter.

   It goes into the board model package that both sides import, so the window can run the same corpus.
5. **Pictures: tldraw's SVG export → `textToPaths` → resvg.** Not skia-canvas's SVG loader: it drops the emoji images and
   is 6× slower. Cap the output size (for example 2000 px on the long side, scale chosen from it): a large board at
   scale 1 takes seconds and the memory resvg does not hand back. Running the export on the editor peer reuses its
   warm caches.
6. **Fonts: tldraw's own 16 files from `@tldraw/assets` 5.6.0** (IBM Plex Sans/Serif/Mono, Shantell Sans; 1.3 MB woff2),
   unless the board picks a Miro-like sans (goal 9). Then that face replaces one family in `TLDRAW_FACES` and the
   window's `fontAssetUrls`; nothing else changes.
7. **What the window must do so both sides agree:**
   - Load the very same font files: bundled with the app, through tldraw's `fontAssetUrls` or `@font-face` rules
     pointing at those files, never a CDN.
     - The URLs must not equal the family names: tldraw's font embedder then rewrites the family name in the SVG
       (seen by `bb-spike-host-chromium`).
   - Let tldraw measure only once its fonts are loaded. A window that measures with a fallback font stores wrong sizes,
     the same defect EN2 fixed for Excalidraw.
   - Use tldraw's own DOM measuring (it *is* the reference). The host follows Chromium, not the other way round.
   - CJK and emoji come from system fonts on both sides, so they follow the machine (risk 8.7). Shipping a CJK font
     would make them agree too.
   - `src/corpus.ts` and `dev/chromium/run.mjs` are the harness that shows whether the two sides still agree.
8. **Open:** Linux and Windows (fallbacks and generic families there were not measured); tldraw's production React
   build (the spike ran the development build); schema migrations between client and room versions; very large boards
   (every window reloads the whole board after a host restart); the relayed transport's own batching on top of tldraw's
   33 ms frames (risk 8.4).

## 7. How to run it (`spikes/tl-host`)

```sh
cd spikes/tl-host && npm install && npm install --no-save playwright@1.64.1   # Chromium 156 for the reference
node dev/chromium/run.mjs                              # Chromium: out/chromium-corpus.json, -board.png/.svg/-records.json, -fonts.json, -env.json
node dev/node-corpus.ts && node dev/compare.ts out/chromium-corpus.json out/node-corpus.json   # B
node dev/node-board.ts && node dev/picdiff.ts out/chromium-board.png out/node-board.png out/diff-board.png   # C
node dev/sync.ts && node dev/reconnect.ts             # D (about 5 s and 25 s)
node dev/bundle-cost.mjs linkedom && node --expose-gc out/cost-linkedom.mjs   # E (also jsdom)
node --expose-gc dev/cost-editor.ts                    # persistent vs per-call editor
ROUNDS=5 node dev/cost-dom.ts                          # the three DOMs
node dev/probe/diff-lines.mjs cases.json               # research: Chromium's lines vs Node's for given texts
node dev/probe/chromium-ascii-breaks.mjs               # regenerates src/ascii-breaks.json from Chromium
TLHOST_DOM=jsdom|happy|linkedom                        # picks the DOM for any of the above (default jsdom)
```

| Module | What it is (what `board-host` lifts) |
|---|---|
| `src/dom.ts`, `dom-linkedom.ts`, `dom-happy.ts`, `dom-shims.ts`, `dom-globals.ts`, `dom-pick.ts` | the page: a DOM on `globalThis` before tldraw is imported |
| `src/editor.ts` | the Editor, built the same in Node and in the page |
| `src/headless.ts` | `loadHost()`: the page, tldraw, the canvas measuring, the font URLs and a `fetch` for `file:` |
| `src/fonts.ts`, `src/measure.ts`, `src/ascii-breaks.json` | text measuring (B) |
| `src/export.ts` | SVG export without HTML or text, PNG with resvg (C) |
| `src/room.ts` | the room, the proxy socket, the client socket, the agent's editor peer (D) |
| `src/corpus.ts`, `src/board.ts`, `dev/` | the faithfulness harness and the measurements |
