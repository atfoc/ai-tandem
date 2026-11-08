// The view's handle (view/handle.ts) on a fake editor, the agent marker's pure parts (view/sync.ts) and the status line's words.
import "./tsx-hook.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createViewHandle, resolveRefs, unionBounds, type HandleEditor } from "../src/view/handle.ts";
import { AgentMarkers, MARKER_FADE_MS, liveMarkers, parseAgentMessage, putMarker, type SyncState } from "../src/view/sync.ts";
import { PAGE, geo, sticky } from "./records.ts";

const { statusText } = await import("../src/view/Status.tsx");
const { markerBox } = await import("../src/view/AgentMarker.tsx");

after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));

const records = [
  PAGE,
  sticky("shape:a", { x: 0, y: 0, key: "idea" }),
  geo("shape:b", { x: 300, y: 100, key: "box", props: { w: 100, h: 50 } }),
  { typeName: "camera", id: "camera:page:page" },
];

test("refs resolve by id (with or without the prefix) and by key, in order, once each; unknown ones are skipped", () => {
  assert.deepEqual(resolveRefs(records, [{ id: "shape:b" }]), ["shape:b"]);
  assert.deepEqual(resolveRefs(records, [{ id: "a" }]), ["shape:a"]);
  assert.deepEqual(resolveRefs(records, [{ key: "box" }, { key: "idea" }, { id: "shape:b" }, { key: "nope" }, { id: "camera:page:page" }]), ["shape:b", "shape:a"]);
  assert.deepEqual(resolveRefs(records, [{ key: "" }, { id: "page:page" }]), []);
});

test("unionBounds", () => {
  assert.equal(unionBounds([]), null);
  assert.equal(unionBounds([undefined]), null);
  assert.deepEqual(unionBounds([{ x: 0, y: 0, w: 200, h: 200 }, undefined, { x: 300, y: 100, w: 100, h: 50 }]), { x: 0, y: 0, w: 400, h: 200 });
});

function fakeEditor(selected: string[]) {
  const zooms: unknown[][] = [];
  const bounds: Record<string, { x: number; y: number; w: number; h: number }> = {
    "shape:a": { x: 0, y: 0, w: 200, h: 200 },
    "shape:b": { x: 300, y: 100, w: 100, h: 50 },
  };
  const editor: HandleEditor = {
    getViewportPageBounds: () => ({ x: -10.4, y: 20, w: 1280, h: 720 }),
    getZoomLevel: () => 0.5,
    getSelectedShapeIds: () => selected,
    getCurrentPageId: () => PAGE.id,
    getShapePageBounds: (id) => bounds[id],
    zoomToBounds: (b, o) => void zooms.push([b, o]),
    store: { allRecords: () => records },
  };
  return { editor, zooms };
}

test("getView: the viewport, the zoom, the selected elements in the agent terms", () => {
  const { editor } = fakeEditor(["shape:b"]);
  const v = createViewHandle(editor).getView();
  assert.deepEqual(v.bounds, { x: -10.4, y: 20, w: 1280, h: 720 });
  assert.equal(v.zoom, 0.5);
  assert.equal(v.selected.length, 1);
  assert.equal(v.selected[0].id, "shape:b");
  assert.equal(v.selected[0].key, "box");
  assert.equal(v.selected[0].type, "shape");
  assert.deepEqual([v.selected[0].x, v.selected[0].y, v.selected[0].w, v.selected[0].h], [300, 100, 100, 50]);
  assert.deepEqual(createViewHandle(fakeEditor([]).editor).getView().selected, []);
});

test("zoomTo fits the union of what resolves; false (and no camera move) when nothing does", () => {
  const { editor, zooms } = fakeEditor([]);
  const h = createViewHandle(editor, { animationMs: 0 });
  assert.equal(h.zoomTo([{ key: "nope" }]), false);
  assert.equal(zooms.length, 0);
  assert.equal(h.zoomTo([{ key: "idea" }, { id: "b" }, { key: "nope" }]), true);
  assert.deepEqual(zooms[0][0], { x: 0, y: 0, w: 400, h: 200 });
  createViewHandle(editor).zoomTo([{ key: "box" }]);
  assert.deepEqual(zooms[1], [{ x: 300, y: 100, w: 100, h: 50 }, { animation: { duration: 300 } }]);
});

test("agent messages: parsed and checked; same chat replaces; markers live for ttl + fade", () => {
  assert.equal(parseAgentMessage(null), null);
  assert.equal(parseAgentMessage({ type: "other" }), null);
  assert.equal(parseAgentMessage({ type: "aiwb_agent", bounds: { x: 0, y: 0, w: -1, h: 1 } }), null);
  assert.equal(parseAgentMessage({ type: "aiwb_agent", bounds: { x: "0", y: 0, w: 1, h: 1 } }), null);
  assert.deepEqual(parseAgentMessage({ type: "aiwb_agent", bounds: { x: 0, y: 0, w: 1, h: 1 } }), {
    type: "aiwb_agent", label: "Agent", chat: "", bounds: { x: 0, y: 0, w: 1, h: 1 }, ttlMs: 4000,
  });
  const m = (chat: string, x: number) => parseAgentMessage({ type: "aiwb_agent", label: "Claude", chat, bounds: { x, y: 0, w: 1, h: 1 }, ttlMs: 1000 })!;
  let list = putMarker([], m("c1", 1), 0, 1);
  list = putMarker(list, m("c2", 2), 10, 2);
  list = putMarker(list, m("c1", 3), 20, 3);
  assert.deepEqual(list.map((x) => [x.chat, x.bounds.x, x.seq]), [["c2", 2, 2], ["c1", 3, 3]]);
  assert.equal(liveMarkers(list, 10 + 1000 + MARKER_FADE_MS - 1).length, 2);
  assert.deepEqual(liveMarkers(list, 10 + 1000 + MARKER_FADE_MS).map((x) => x.chat), ["c1"]);
});

test("AgentMarkers expires each marker on its own timer; a replaced marker's timer is cancelled", () => {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const t = { setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id), clearTimeout: (k: unknown) => void timers.delete(k as number), now: () => now };
  const run = (to: number) => { now = to; for (const [k, v] of [...timers]) if (v.at <= now) { timers.delete(k); v.fn(); } };
  const mk = new AgentMarkers(t);
  let changes = 0;
  mk.subscribe(() => changes++);
  const msg = (chat: string) => ({ type: "aiwb_agent", label: "Claude", chat, bounds: { x: 0, y: 0, w: 1, h: 1 }, ttlMs: 1000 });
  assert.equal(mk.receive({ type: "nope" }), false);
  mk.receive(msg("c1"));
  run(500);
  mk.receive(msg("c1")); // replaces: the first timer is gone
  mk.receive(msg("c2"));
  assert.equal(timers.size, 2);
  run(1000 + MARKER_FADE_MS + 100);
  assert.equal(mk.getSnapshot().length, 2, "the first c1's timer did not remove the second");
  run(500 + 1000 + MARKER_FADE_MS);
  assert.equal(mk.getSnapshot().length, 0);
  assert.equal(changes, 5); // three receives, two expiries
});

test("markerBox follows the camera; the status line's words", () => {
  assert.deepEqual(markerBox({ x: 100, y: 50, w: 200, h: 100 }, { x: -100, y: 10, z: 2 }), { left: 0, top: 120, width: 400, height: 200 });
  const s = (o: Partial<SyncState>): SyncState => ({ store: { status: "loading" }, link: "online", loaded: true, fatal: false, ...o });
  assert.equal(statusText(s({})), null);
  assert.deepEqual(statusText(s({ loaded: false, link: "connecting" })), { text: "Connecting…", error: false });
  assert.deepEqual(statusText(s({ link: "offline" })), { text: "Reconnecting…", error: false });
  assert.deepEqual(statusText(s({ link: "connecting" })), { text: "Reconnecting…", error: false });
  assert.equal(statusText(s({ error: "INVALID_RECORD", loaded: false }))!.error, true);
  assert.match(statusText(s({ error: "CLIENT_TOO_OLD", fatal: true }))!.text, /refused.*CLIENT_TOO_OLD/);
});
