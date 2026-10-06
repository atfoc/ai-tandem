import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { K, buildAxis, layoutTimeline } from "../src/logic/runtimeline.ts";
import {
  LIVE_PPM, NEEDS_MIN, ZOOM_FIT, ZOOM_STEPS, defaultPpm, fitPpm, fitZoom, followAfterScroll, followLeft, followOffset, futureRoom, kindShown, labelWidth,
  needsShown, nowInView, relayoutDue, relayoutQuantum, resolveZoom, revealLeft, rowCounts, rowFilter, scrollFor, stepIn, timeAt, zoomAt, zoomIn, zoomOut,
} from "../src/logic/runzoom.ts";
import { freeze, type ScRun } from "./fixtures/runscenario.ts";

const M = 60000;
const qaRun = (): ScRun => JSON.parse(readFileSync(new URL("./fixtures/run-qa.json", import.meta.url), "utf8"));
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("the label column is 34% of the timeline, between 168 and 372 px, and at least 300 px from 700 px on: it shows the needs cell from 300 px", () => {
  // Under 494 px the floor; from 700 px the floor of the needs cell, up to 883 px; from 1094 px the cap; 34% between them.
  assert.deepEqual([300, 494, 495, 600, 699, 700, 800, 883, 1000, 1094, 1095, 1400, 2400].map(labelWidth), [168, 168, 168, 204, 238, 300, 300, 300, 340, 372, 372, 372, 372]);
  assert.equal(labelWidth(497), 169); assert.equal(labelWidth(1093), 372); assert.equal(labelWidth(1092), 371); assert.equal(labelWidth(884), 301);
  assert.equal(NEEDS_MIN, 300);
  assert.deepEqual([168, 299, 300, 372].map(needsShown), [false, false, true, true]);
  // The stage of a 1000 px window (736 px) and of a 1440 px one beside a transcript (776 px) have the cell; under 700 px there is none.
  assert.deepEqual([699, 700, 736, 776, 900].map((w) => [labelWidth(w), needsShown(labelWidth(w))]), [[238, false], [300, true], [300, true], [300, true], [306, true]]);
  // The kind word gives its room to the title under 340 px (a timeline of 1000 px).
  assert.deepEqual([238, 300, 339, 340, 372].map(kindShown), [false, false, false, true, true]);
  assert.deepEqual([736, 998, 1000, 1176].map((w) => kindShown(labelWidth(w))), [false, false, true, true]);
});

test("the room right of now is 28% of the chart, between 96 and 150 px, and only in a live run", () => {
  assert.deepEqual([300, 420, 500, 720].map((w) => futureRoom(w, true)), [96, 118, 140, 150]);
  assert.equal(futureRoom(720, false), 0);
  // The layout's axis reserves the same.
  const live = freeze(qaRun(), qaRun().createdAt + 6400_000);
  for (const w of [300, 420, 720]) assert.equal(buildAxis(live, { width: w, now: live.frozenAt! }).future, futureRoom(w, true));
});

test("fit: the real run is 2.56 px/min in a 720 px chart and 1.45 in a 420 px one", () => {
  const run = qaRun();
  near(fitPpm(run, 720, run.endedAt!), 2.56, 0.005); near(fitPpm(run, 420, run.endedAt!), 1.45, 0.005);
  near(fitPpm(run, 720, run.endedAt!), (720 - K.PAD_L - K.PAD_R) / ((run.endedAt! - run.createdAt) / M), 1e-9);
});

test("the automatic zoom: the whole run; a live run stays at 2 px/min once fit is below that", () => {
  assert.equal(defaultPpm(2.56, false), 2.56); assert.equal(defaultPpm(0.4, false), 0.4);
  assert.equal(defaultPpm(5.1, true), 5.1); assert.equal(defaultPpm(2, true), 2); assert.equal(defaultPpm(1.99, true), LIVE_PPM);
  assert.deepEqual(resolveZoom(null, 2.56, false), { ppm: 2.56, fit: true, layoutPpm: null, canZoomIn: true, canZoomOut: false });
  assert.deepEqual(resolveZoom(null, 1.2, true), { ppm: 2, fit: false, layoutPpm: 2, canZoomIn: true, canZoomOut: true });
  // The live run frozen at 1 h 46 m fits at 5.1 px/min in 720 px; eight hours later it would not.
  const live = freeze(qaRun(), qaRun().createdAt + 6400_000);
  near(fitPpm(live, 720, live.frozenAt!), 5.1, 0.01);
  assert.equal(resolveZoom(null, fitPpm(live, 720, live.frozenAt! + 480 * M), true).ppm, 2);
});

test("a zoom is never below fit: at or under it the whole run shows", () => {
  assert.deepEqual(resolveZoom(1, 2.56, false), { ppm: 2.56, fit: true, layoutPpm: null, canZoomIn: true, canZoomOut: false });
  assert.deepEqual(resolveZoom(2.56, 2.56, false).fit, true);
  assert.deepEqual(resolveZoom(ZOOM_FIT, 1.2, true), { ppm: 1.2, fit: true, layoutPpm: null, canZoomIn: true, canZoomOut: false });
  assert.deepEqual(resolveZoom(8, 2.56, false), { ppm: 8, fit: false, layoutPpm: 8, canZoomIn: true, canZoomOut: true });
  assert.deepEqual(resolveZoom(64, 2.56, false), { ppm: 64, fit: false, layoutPpm: 64, canZoomIn: false, canZoomOut: true });
  // A run so short that fit is past the last step: nothing to zoom.
  assert.deepEqual(resolveZoom(null, 272, true), { ppm: 272, fit: true, layoutPpm: null, canZoomIn: false, canZoomOut: false });
});

test("steps: 1, 2, 4, 8, 16, 32, 64, the ones at or below fit skipped; out ends at the whole run", () => {
  assert.deepEqual(ZOOM_STEPS, [1, 2, 4, 8, 16, 32, 64]);
  // In from fit 2.56: 4, 8, … 64, then no further.
  const ins: (number | undefined)[] = [];
  for (let z: number | undefined = 2.56; z !== undefined; z = zoomIn(z, 2.56)) ins.push(z);
  assert.deepEqual(ins, [2.56, 4, 8, 16, 32, 64]);
  assert.equal(zoomIn(64, 2.56), undefined); assert.equal(zoomIn(2, 2), 4); assert.equal(zoomIn(0.3, 0.3), 1);
  // Out from 16 with fit 2.56: 8, 4, then the whole run (2 would be below fit), then nothing.
  assert.equal(zoomOut(16, 2.56, false), 8); assert.equal(zoomOut(8, 2.56, false), 4);
  assert.equal(zoomOut(4, 2.56, false), null); assert.equal(zoomOut(2.56, 2.56, false), undefined);
  // A zoom between steps goes to the next step, not past it.
  assert.equal(zoomOut(5, 0.3, false), 4); assert.equal(zoomIn(5, 0.3), 8);
  // A long live run: automatic is 2 px/min, so the whole run has to be asked for as ZOOM_FIT.
  assert.equal(zoomOut(2, 0.4, true), 1); assert.equal(zoomOut(1, 0.4, true), ZOOM_FIT); assert.equal(zoomOut(0.4, 0.4, true), undefined);
  assert.equal(zoomOut(2, 1.2, true), ZOOM_FIT);
  assert.equal(fitZoom(0.4, true), ZOOM_FIT); assert.equal(fitZoom(0.4, false), null); assert.equal(fitZoom(3, true), null);
});

test("zooming at the pointer keeps the time under it where it is", () => {
  const run = qaRun(), now = run.endedAt!;
  const a = buildAxis(run, { width: 720, ppm: 4, now }), b = buildAxis(run, { width: 720, ppm: 8, now });
  const scrollLeft = 300, pointerX = 250, t = timeAt(a, scrollLeft, pointerX);
  near(a.x(t), 550, 1e-6);
  const left = zoomAt(a, b, pointerX, scrollLeft);
  near(b.t(left + pointerX), t, 1); near(left, b.x(t) - pointerX, 1e-9);
  assert.equal(scrollFor(b, t, pointerX), left);
  // Out again: back where it was.
  near(zoomAt(b, a, pointerX, left), scrollLeft, 1e-6);
  // Never a negative scroll: near the start the pointer cannot keep its time.
  assert.equal(zoomAt(b, a, 600, 0), 0);
  // Across a stop break the same holds (the axis is piecewise).
  const stopped: ScRun = { ...run, stops: [{ at: run.createdAt + 100 * M, resumedAt: run.createdAt + 160 * M }] };
  const c = buildAxis(stopped, { width: 720, ppm: 4, now }), d = buildAxis(stopped, { width: 720, ppm: 16, now });
  const t2 = timeAt(c, 500, 100);
  near(d.t(zoomAt(c, d, 100, 500) + 100), t2, 1);
});

test("follow: scrollLeft = the content's end − viewport width, and a user's scroll within view is kept", () => {
  const live = freeze(qaRun(), qaRun().createdAt + 6400_000), now = live.frozenAt!;
  const L = layoutTimeline(live, { width: 420, ppm: 8, now }), nowX = L.nowX!;
  assert.ok(L.width > 420);
  const offset = followOffset(420, L.axis.future);
  assert.equal(offset, 420 - 118 - K.PAD_R);
  const left = followLeft(nowX, offset);
  near(left, nowX + L.axis.future + K.PAD_R - 420, 1e-9);
  // Now is in view, with the room for the tail texts right of it: the viewport ends where the content does.
  assert.ok(nowInView(nowX, left, 420)); near(left + 420, L.width, 1);
  // Half an hour later, at the same zoom, now is at the same place in the viewport.
  const later = layoutTimeline(live, { width: 420, ppm: 8, now: now + 30 * M });
  near(later.nowX! - followLeft(later.nowX!, offset), offset, 1e-9); near(later.nowX! - nowX, 240, 1e-6);
  // The user scrolls 60 px back: now is still in view, following goes on from that place.
  assert.deepEqual(followAfterScroll(nowX, left - 60, 420), { follow: true, offset: offset + 60 });
  near(followLeft(later.nowX!, offset + 60), left - 60 + 240, 1e-6);
  // The user scrolls now out of view, either way: following ends.
  assert.deepEqual(followAfterScroll(nowX, left - 200, 420), { follow: false, offset: null });
  assert.deepEqual(followAfterScroll(nowX, nowX + 1, 420), { follow: false, offset: null });
  assert.equal(nowInView(nowX, nowX, 420), true); assert.equal(nowInView(nowX, nowX - 420, 420), true);
  // A short run: nothing to scroll.
  assert.equal(followLeft(100, offset), 0); assert.equal(followOffset(80, 96), 0); assert.equal(followOffset(100, 96), 0);
});

test("the layout is due again after the time of half a pixel, at least a second", () => {
  assert.deepEqual([1, 2, 8, 30, 64, 0.5].map(relayoutQuantum), [30000, 15000, 3750, 1000, 1000, 60000]);
  const q = relayoutQuantum(8), t = 1_000_000 * q;
  assert.equal(relayoutDue(t, t + 1000, 8), false); assert.equal(relayoutDue(t, t + q - 1, 8), false);
  assert.equal(relayoutDue(t, t + q, 8), true); assert.equal(relayoutDue(t + q - 1, t + q, 8), true);
  // At 64 px/min every second is due; a run of 1 s ticks at 2 px/min is due once in fifteen.
  assert.equal(relayoutDue(t, t + 1000, 64), true);
  let last = 1_791_148_986_596, due = 0;
  for (let i = 1; i <= 150; i++) if (relayoutDue(last, 1_791_148_986_596 + i * 1000, 2)) { due++; last = 1_791_148_986_596 + i * 1000; }
  assert.equal(due, 10);
});

test("bringing marks into view moves as little as it can", () => {
  assert.equal(revealLeft(300, 500, 100, 600), 100);                 // In view already.
  assert.equal(revealLeft(50, 200, 100, 600), 26);                   // Left of it: to its start, with the margin.
  assert.equal(revealLeft(900, 1000, 100, 600), 424);                // Right of it: to its end.
  assert.equal(revealLeft(5, 80, 100, 600), 0);                      // Never negative.
  assert.equal(revealLeft(0, 2000, 400, 600), 400);                  // Wider than the viewport and showing: left alone.
  assert.equal(revealLeft(1500, 2400, 100, 600), 1824);              // Wider and out of view: its end.
});

test("the row filter: open tasks, or the chain of the selected task; counts for the toolbar", () => {
  const done = qaRun(), live = freeze(qaRun(), qaRun().createdAt + 6400_000);
  assert.equal(rowFilter(done, "all", "T21"), null);
  assert.deepEqual(rowCounts(done, null), { all: 53, open: 0, related: null });
  assert.deepEqual(rowCounts(done, "T21"), { all: 53, open: 0, related: 27 });
  assert.deepEqual(rowCounts(done, "nope"), { all: 53, open: 0, related: null });
  assert.deepEqual(rowCounts(live, "T21"), { all: 33, open: 10, related: rowFilter(live, "related", "T21")!.size });
  const open = rowFilter(live, "open")!;
  assert.deepEqual([...open], ["T11", "T22", "T23", "T27", "T28", "T29", "T30", "T31", "T32", "T33"]);
  const rel = rowFilter(done, "related", "T21")!;
  assert.equal(rel.size, 27); assert.ok(rel.has("T21") && rel.has("T02") && rel.has("T22") && !rel.has("T16"));
  // "related" with nothing selected, or with a task the run does not have, is all.
  assert.equal(rowFilter(done, "related", null), null); assert.equal(rowFilter(done, "related", "nope"), null);
  // The layout keeps creation order under either filter.
  const ids = layoutTimeline(done, { width: 720, now: done.endedAt!, only: rel }).rows.map((r) => r.id);
  assert.deepEqual(ids, done.tasks.map((t) => t.id).filter((id) => rel.has(id)));
  // A dependency on a task the run does not have is no row: the count is the rows shown.
  const ghost = { tasks: [{ id: "A", createdAt: 1, dependsOn: ["T404"], attempts: [] }, { id: "B", createdAt: 2, dependsOn: ["A", "GHOST"], attempts: [] }] };
  assert.deepEqual([...rowFilter(ghost, "related", "A")!], ["A", "B"]);
  assert.equal(rowCounts(ghost, "A").related, 2);
});

test("↑ / ↓ step through a list and stop at its ends", () => {
  const rows = ["T01", "T05", "T09"];
  assert.equal(stepIn(rows, "T05", 1), "T09"); assert.equal(stepIn(rows, "T05", -1), "T01");
  assert.equal(stepIn(rows, "T09", 1), "T09"); assert.equal(stepIn(rows, "T01", -1), "T01");
  // Nothing selected, or a selection the filter hides: ↓ takes the first, ↑ the last.
  assert.equal(stepIn(rows, null, 1), "T01"); assert.equal(stepIn(rows, null, -1), "T09"); assert.equal(stepIn(rows, "T02", 1), "T01");
  assert.equal(stepIn([], "T01", 1), null);
  assert.equal(stepIn([3, 4, 5], 4, 1), 5); assert.equal(stepIn([3, 4, 5], 0, -1), 5);
});
