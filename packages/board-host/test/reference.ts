// What Chromium stored for a few cases of the corpus (packages/board-tl/src/model/corpus.ts): the reference the board host's
// measuring must match exactly (goal 4.12), reused by later tests (H2).
//
// Measured 2026-11-08 by spikes/tl-host/dev/chromium/run.mjs (out/chromium-corpus.json) in Chromium 156.0.8078.4
// (Playwright 1.64.1, headless, deviceScaleFactor 1), darwin-arm64 (macOS 27, Darwin 27.0.0), tldraw 5.6.0 with
// @tldraw/assets 5.6.0's fonts. Case ids are the corpus's: `<kind>:<text>:<font>:<size>`. The values are rounded to
// 3 decimals as the corpus rounds them; `TEXTS` of the corpus holds the texts.
export const CHROMIUM_REFERENCE = {
  /** A note whose text wraps: it grows (growY), its font is kept. */
  "note:long:sans:m": { growY: 72, fontSizeAdjustment: 1, w: 200, h: 272 },
  /** A note with one word too long for a line: its font shrinks (fontSizeAdjustment), it does not grow. */
  "note:longword:sans:m": { growY: 0, fontSizeAdjustment: 0.636, w: 200, h: 200 },
  /** A geo rectangle 200×100 with a long text: it grows (growY). */
  "geo:long:sans:m": { growY: 172, h: 100, w: 200 },
  /** The same rectangle with a mixed text (an arrow, digits, an e-mail and a URL). */
  "geo:mixed:sans:m": { growY: 112, h: 100, w: 200 },
} as const satisfies Record<string, Record<string, number>>;

export type ReferenceCase = keyof typeof CHROMIUM_REFERENCE;

// What Chromium stored for our own sticky (`aiwb-sticky`, shrink-to-fit: `fitted`) and our geo's `labelSize` (geo `growY`):
// the reference the board host's fit must match exactly (goal 3.5, 4.12; design 10 A5). Measured 2026-11-08 in Chromium
// 156.0.8078.4 (Playwright 1.64.1, headless, deviceScaleFactor 1), darwin-arm64 (macOS 27, Darwin 27.0.0), tldraw 5.6.0 with
// @tldraw/assets 5.6.0's 16 fonts loaded as data: URLs before measuring (O5), on the host's Editor (src/node/editor.ts) with
// tldraw's DOM measuring; the script and the full table (98 cases, all equal in the board host) are in
// plans/better-board/host-stickyref.md. Created through editor.createShapes with apply.ts's props.
// Case ids: `sticky:<text>:<w>:<fontSize>` (a w×w sticky; `auto` = fontSize 0, `s` = the fixed 16 px) and
// `geo:<text>:<labelSize>` (a 200×100 rectangle, font sans, dash solid); `TEXTS` of the corpus holds the texts.
export const STICKY_REFERENCE = {
  /** A short word at the largest automatic size (w × 0.24). */
  "sticky:short:200:auto": { fitted: 48, w: 200, h: 200 },
  "sticky:short:300:auto": { fitted: 72, w: 300, h: 300 },
  /** A long text that shrinks until its lines fit the height. */
  "sticky:long:200:auto": { fitted: 18, w: 200, h: 200 },
  "sticky:long:300:auto": { fitted: 28, w: 300, h: 300 },
  /** A word too long for a line: shrinks by its width (scrollWidth); at 200 it overflows even at the smallest size, 6. */
  "sticky:longword:200:auto": { fitted: 6, w: 200, h: 200 },
  "sticky:longword:300:auto": { fitted: 7, w: 300, h: 300 },
  /** Several paragraphs, one empty. */
  "sticky:multi:200:auto": { fitted: 21, w: 200, h: 200 },
  "sticky:multi:300:auto": { fitted: 35, w: 300, h: 300 },
  "sticky:accented:200:auto": { fitted: 23, w: 200, h: 200 },
  "sticky:accented:300:auto": { fitted: 36, w: 300, h: 300 },
  "sticky:cyrillic:200:auto": { fitted: 21, w: 200, h: 200 },
  "sticky:cyrillic:300:auto": { fitted: 32, w: 300, h: 300 },
  /** A fixed size is kept, fitting or not. */
  "sticky:long:200:s": { fitted: 16, w: 200, h: 200 },
  /** Our geo's label size drives the label's font: the same text grows the rectangle less at `s` than at `xl`. */
  "geo:long:s": { growY: 76, w: 200, h: 100 },
  "geo:long:xl": { growY: 405, w: 200, h: 100 },
} as const satisfies Record<string, Record<string, number>>;
