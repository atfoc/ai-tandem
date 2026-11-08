# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.


## tldraw 5.6.0, pinned exactly (orchestrator's spike bb-spike-ui)

`tldraw` 5.6.0 and `@tldraw/assets` 5.6.0 (the matching `@tldraw/*` come with it at 5.6.0), the latest stable on
2026-11-08 (released 2026-10-28). No `^`. bb-spike-host had not recorded a version when bb-spike-ui started; the first
spike to pin was this one (`spikes/tl-ui/package.json`).

## The new board is a second web target like `board.js` (spike bb-spike-ui, orchestrator's spike)

`board-tl.js` + `board-tl.css` + `fonts/`, an IIFE defining `window.aiwbBoardTl.mount(element, …)`, loaded by the app's
page and mounted in a box like `aiwbBoardView`; a one-file page for phones. No iframe. Why: it is how the app already
ships a board (same build, CSP, `file://`, web view); details in `spike-ui.md` (A).

## The prototype's board bundle is built with `NODE_ENV=development` (spike bb-spike-ui)

tldraw 5.6 treats a `file://` page with a production bundle and no licence key as unlicensed production and replaces the
editor with an empty licence gate after 5 s (seen in the spike). The Electron window loads the page from `file://`. The
development bundle is what tldraw itself treats as development (goal 4.2 accepts that for the prototype); its watermark
stays. A release needs a key (a `NATIVE_LICENSE` key matches `location.href`). `spike-ui.md` ("Licence").

## The sticky is a custom ShapeUtil `sticky` with its own colour style prop `aiwb:sticky-color` (spike bb-spike-ui)

tldraw's `note` grows instead of shrinking its text and resizes only by scale (7.2's fallback applies). The colour is a
style prop of its own, not `DefaultColorStyle`, so a sticky's last colour does not become the next shape's colour.
Shrink-to-fit is `fit.ts`, a pure function of a text measure, run in `onBeforeCreate/onBeforeUpdate` through
`editor.textMeasure`, so the board host runs the same code. `spike-ui.md` (D).

## Fonts: tldraw's own IBM Plex Sans (`sans`) for every element (spike bb-spike-ui; goal 9 asked)

The woff2 files of `@tldraw/assets`, the same for the window and the board host; skia-canvas 4.0.0 measures them exactly as
Chromium does. New elements get `sans` (tldraw's default is `draw`). A Miro-like font later is one theme entry.
`spike-ui.md` (E).
