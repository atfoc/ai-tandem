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
