# Departures from goal section 7

Each entry: what, why.


## 7.2: the sticky is a custom ShapeUtil, not tldraw's `note` (spike bb-spike-ui)

What: a `sticky` shape of our own (square, `aiwb:sticky-color`, shrink-to-fit text stored as `fitted`), the fallback 7.2
names. Why: tldraw 5.6's `note` grows (`growY`) instead of shrinking its text, shrinks the font only for long words, does
both in private methods, resizes only by scale, and hard-codes its paper look. `spike-ui.md` (D).

## 7.3: the select tool overrides go beyond the idle / pointing-canvas pan (spike bb-spike-ui)

What: besides drag-to-pan from `pointing_canvas` (as 7.3 says), the override (a) clears the selection on pointer up instead
of pointer down, so a pan keeps the selection; (b) hands a pointer down inside an unfilled shape to `pointing_shape`, so a
drag there moves the shape instead of panning (tldraw treats a hollow shape's inside as canvas); (c) replaces `idle`'s
double-click on empty canvas to create a sticky (goal 3.3) with tldraw's text-on-double-click turned off by option.
Why: Miro's behaviour (goal 3.1, 3.3); all through subclasses of tldraw's own states, no patch. `spike-ui.md` (C).
