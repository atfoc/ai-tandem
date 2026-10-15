import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_MARK, SOURCE_END, WINDOW_EVENTS, dropMark, takesFrom, type DropEvent, type DropMark } from "../src/logic/dropmark.ts";
import { isUngrouped, keyOn, sameServer, serverOfKey, ungroupedOn } from "../src/logic/keys.ts";
import { LOCAL_SERVER } from "../src/types.ts";

// ---- the reducer

test("a zone, a header's upper half, the dragged group and its server make the mark", () => {
  assert.deepEqual(NO_MARK, { zone: null, before: null, group: null, server: null });
  let m = dropMark(NO_MARK, { type: "start", group: "g", server: "local" });
  assert.deepEqual(m, { zone: null, before: null, group: "g", server: "local" });
  m = dropMark(m, { type: "in", zone: "shop" });
  assert.deepEqual(m, { zone: "shop", before: null, group: "g", server: "local" });
  m = dropMark(m, { type: "before", head: "shop" });
  assert.deepEqual(m, { zone: null, before: "shop", group: "g", server: "local" }, "the header takes the light from the zone");
  m = dropMark(m, { type: "in", zone: "sub" });
  assert.deepEqual(m, { zone: "sub", before: null, group: "g", server: "local" }, "and a zone from the header");
  assert.deepEqual(dropMark(m, { type: "end" }), NO_MARK);
});

test("leaving empties only the zone or the header that was left", () => {
  const inSub: DropMark = { zone: "sub", before: null, group: null, server: "local" }, onHead: DropMark = { zone: null, before: "shop", group: "g", server: "local" };
  assert.deepEqual(dropMark(inSub, { type: "out", zone: "sub" }), { zone: null, before: null, group: null, server: "local" });
  assert.equal(dropMark(inSub, { type: "out", zone: "shop" }), inSub, "the leave of another zone, heard late");
  assert.equal(dropMark(inSub, { type: "off", head: "sub" }), inSub);
  assert.deepEqual(dropMark(onHead, { type: "off", head: "shop" }), { zone: null, before: null, group: "g", server: "local" });
  assert.equal(dropMark(onHead, { type: "off", head: "sub" }), onHead);
  assert.equal(dropMark(onHead, { type: "out", zone: "shop" }), onHead);
});

test("where nothing takes the drag nothing is lit, and the dragged group and its server stay", () => {
  assert.deepEqual(dropMark({ zone: "shop", before: null, group: "g", server: "local" }, { type: "nowhere" }), { zone: null, before: null, group: "g", server: "local" });
  assert.deepEqual(dropMark({ zone: null, before: "shop", group: "g", server: "local" }, { type: "nowhere" }), { zone: null, before: null, group: "g", server: "local" });
  assert.deepEqual(dropMark({ zone: "s_1~far", before: null, group: null, server: "s_1" }, { type: "nowhere" }), { zone: null, before: null, group: null, server: "s_1" }, "a row's drag keeps its server");
});

test("a start sets the dragged group and the server anew and lights nothing", () => {
  const stale: DropMark = { zone: "shop", before: null, group: "old", server: "s_1" };
  assert.deepEqual(dropMark(stale, { type: "start", group: "g", server: "local" }), { zone: null, before: null, group: "g", server: "local" });
  assert.deepEqual(dropMark(stale, { type: "start", group: null, server: "local" }), { zone: null, before: null, group: null, server: "local" }, "a row's drag: no group is dragged");
  assert.deepEqual(dropMark(stale, { type: "start", group: "s_2~g", server: "s_2" }), { zone: null, before: null, group: "s_2~g", server: "s_2" }, "a group of another section");
});

test("only an end forgets the server of what is dragged", () => {
  const m: DropMark = { zone: "s_1~far", before: null, group: null, server: "s_1" };
  for (const e of [{ type: "in", zone: "shop" }, { type: "before", head: "shop" }, { type: "out", zone: "s_1~far" }, { type: "off", head: "shop" }, { type: "nowhere" }] as DropEvent[])
    assert.equal(dropMark(m, e).server, "s_1", e.type);
  assert.equal(dropMark(m, { type: "end" }).server, null);
});

test("an event that changes nothing gives the same mark back", () => {
  const marks: DropMark[] = [NO_MARK, { zone: "shop", before: null, group: null, server: "local" }, { zone: null, before: "shop", group: "g", server: "local" },
    { zone: null, before: null, group: "g", server: "local" }, { zone: null, before: null, group: null, server: "s_1" }, { zone: "shop", before: null, group: null, server: null }];
  const events: DropEvent[] = [{ type: "start", group: "g", server: "local" }, { type: "start", group: null, server: "local" }, { type: "start", group: null, server: "s_1" },
    { type: "in", zone: "shop" }, { type: "before", head: "shop" },
    { type: "out", zone: "shop" }, { type: "off", head: "shop" }, { type: "nowhere" }, { type: "end" }];
  for (const m of marks) for (const e of events) {
    const once = dropMark(m, e);
    assert.equal(dropMark(once, e), once, `${JSON.stringify(e)} twice on ${JSON.stringify(m)}`);
    assert.equal(once === m, JSON.stringify(once) === JSON.stringify(m), `${JSON.stringify(e)} on ${JSON.stringify(m)}: a new mark only when it differs`);
  }
});

// ---- which server's zones take a drag

test("a zone takes only what is dragged on its own server", () => {
  const local = dropMark(NO_MARK, { type: "start", group: null, server: LOCAL_SERVER });
  assert.equal(takesFrom(local, LOCAL_SERVER), true);
  assert.equal(takesFrom(local, "s_1"), false, "nothing goes from the local part into a section");
  const far = dropMark(NO_MARK, { type: "start", group: "s_1~g", server: "s_1" });
  assert.equal(takesFrom(far, "s_1"), true);
  assert.equal(takesFrom(far, LOCAL_SERVER), false, "nor from a section into the local part");
  assert.equal(takesFrom(far, "s_2"), false, "nor from one section into another");
});

test("a drag that did not begin in this window is taken by every server's zones: its drop is judged by what it carries", () => {
  assert.equal(takesFrom(NO_MARK, LOCAL_SERVER), true);
  assert.equal(takesFrom(NO_MARK, "s_1"), true);
  assert.equal(takesFrom({ server: null }, "s_2"), true);
});

// ---- the window

test("the window: a drop, a drag's end and a dragover as they bubble; a press, a move and a key as they are captured", () => {
  const of = (type: string) => WINDOW_EVENTS.filter((w) => w.type === type);
  for (const type of ["drop", "dragend"]) assert.deepEqual(of(type), [{ type, capture: false, event: { type: "end" } }]);
  assert.deepEqual(of("dragover"), [{ type: "dragover", capture: false, event: { type: "nowhere" } }]);
  for (const type of ["pointerdown", "pointermove", "keydown"]) assert.deepEqual(of(type), [{ type, capture: true, event: { type: "nowhere" } }]);
  // a browser sends pointercancel and pointerout right after dragstart: none of these may touch the mark
  for (const type of ["pointercancel", "pointerout", "pointerleave", "mouseout", "mouseleave", "dragstart", "dragenter", "dragleave"]) assert.deepEqual(of(type), [], type);
});

test("the sidebar keeps no highlight of its own and hears the window through the table", () => {
  // and the dragged element hears the end of its drag itself: the window does not, once the element has left the page
  assert.deepEqual(SOURCE_END, { type: "dragend", event: { type: "end" } });
});

// ---- G2's scenarios as the events a browser sends, in the order it sends them

// G2's tree (§4): Shop > Sub and Other > Mid > Leaf, and the ungrouped area. Below it the section of the server
// s_1, with that server's own tree: Far > Deep, a group Shop of its own (the same id as the local one) and its
// ungrouped area. A place is where the pointer is: in a zone (on a row or the body of that group), on a half of a
// group's header, or outside every zone (PAGE). A zone is named by its key, as the sidebar names it.
const FAR = keyOn("s_1", "Far"), DEEP = keyOn("s_1", "Deep"), FAR_SHOP = keyOn("s_1", "Shop");
const PARENT: Record<string, string> = { Sub: "Shop", Mid: "Other", Leaf: "Mid", [DEEP]: FAR };
const LOOSE = ungroupedOn(LOCAL_SERVER), FAR_LOOSE = ungroupedOn("s_1");
type Place = { zone: string; head?: "upper" | "lower" } | null;
const PAGE: Place = null;
const on = (zone: string): Place => ({ zone });
const head = (zone: string, half: "upper" | "lower"): Place => ({ zone, head: half });
/** The zones around a point of a group, the innermost first. */
const zonesOf = (g: string): string[] => [g, ...(PARENT[g] ? zonesOf(PARENT[g]) : [])];
const within = (p: Place, zone: string) => !!p && zonesOf(p.zone).includes(zone);

/** item: a row; it is on the server of the zone its drag starts in. foreign: text or a file. */
type Dragged = { kind: "item" } | { kind: "group"; group: string } | { kind: "foreign" };
type Moved = { into: string } | { before: string } | null;

/** A page with the sidebar's handlers as Sidebar.tsx has them (which event each takes, what it tells the mark, where
 *  it stops the event), the dragged element's own listener (SOURCE_END) and the window's listeners of WINDOW_EVENTS,
 *  each in its phase. Every mark is held to what must be true all through a drag. */
class Page {
  mark = NO_MARK;
  private dragged: Dragged | null = null;
  private from = LOCAL_SERVER;  // the server what is dragged is on
  private here = false;         // the drag began in this page: a row or a header of it is the dragged element
  private at: Place = PAGE;
  private taken = false;        // the last dragover was taken: the browser will send a drop
  private lostLeave = false;    // the node under the pointer was removed: its dragleave reaches no handler
  private lostEnd = false;      // the dragged node was removed: its dragend reaches the node alone, not the window

  private tell(e: DropEvent) {
    const next = dropMark(this.mark, e);
    assert.ok(next.zone === null || next.before === null, `a zone and a header are lit at once: ${JSON.stringify(next)}`);
    if (this.here && this.dragged?.kind === "group" && e.type !== "end") assert.equal(next.group, this.dragged.group, `the dragged group left the mark at ${JSON.stringify(e)}`);
    if (this.here && e.type !== "end") assert.equal(next.server, this.from, `the server of what is dragged left the mark at ${JSON.stringify(e)}`);
    this.mark = next;
  }
  private window(type: string, capture: boolean) { for (const w of WINDOW_EVENTS) if (w.type === type && w.capture === capture) this.tell(w.event); }
  /** An event that no handler of the sidebar takes: it passes the window twice, captured and bubbling. */
  plain(...types: string[]) { for (const t of types) { this.window(t, true); this.window(t, false); } }
  /** canTakeGroup of Sidebar.tsx, with no archived group. */
  private canTake(target: string, into: boolean) {
    const g = this.mark.group;
    if (!g || !sameServer(g, target)) return false;
    if (into && isUngrouped(target)) return true;
    return !zonesOf(target).includes(g);
  }

  /** A press on a row or a header and the first move, then the drag's start as measured in Chromium (FG M1):
   *  pointerdown > mousedown > pointermove > mousemove > dragstart > pointercancel > pointerout. */
  start(what: Dragged, from: Place) {
    this.plain("pointerdown", "mousedown", "pointermove", "mousemove");
    this.window("dragstart", true);
    this.dragged = what; this.here = true; this.at = from; this.taken = false;
    this.from = serverOfKey(what.kind === "group" ? what.group : from!.zone);
    this.tell({ type: "start", group: what.kind === "group" ? what.group : null, server: this.from }); // the row's or the header's handler, which stops it
    this.plain("pointercancel", "pointerout");
    return this;
  }
  /** A drag that comes from outside the page (text, a file; a row or a group of another window of the app): no
   *  press and no dragstart here. */
  enter(what: Dragged, from = LOCAL_SERVER) { this.dragged = what; this.here = false; this.from = from; this.at = PAGE; this.taken = false; return this; }

  /** The pointer goes to a place and lingers: dragenter there, dragleave where it was, then dragovers. */
  over(to: Place, times = 3) {
    const from = this.at;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      this.plain("dragenter");
      this.leave(from, to);
    }
    this.at = to;
    for (let i = 0; i < times; i++) this.dragover();
    return this;
  }
  private leave(from: Place, to: Place | undefined) { // to undefined: relatedTarget null
    this.window("dragleave", true);
    if (this.lostLeave) { this.lostLeave = false; return; }
    if (!from) return this.window("dragleave", false);
    const sameHead = !!to && !!from.head && !!to.head && to.zone === from.zone;
    if (from.head && !sameHead) this.tell({ type: "off", head: from.zone });
    for (const z of zonesOf(from.zone)) if (!to || !within(to, z)) this.tell({ type: "out", zone: z });
    this.window("dragleave", false);
  }
  private dragover() {
    const p = this.at, d = this.dragged!;
    this.window("dragover", true);
    this.taken = false;
    if (p && d.kind !== "foreign") {
      if (p.head && d.kind === "group" && p.head === "upper" && this.canTake(p.zone, false)) { this.taken = true; return this.tell({ type: "before", head: p.zone }); }
      // the innermost zone stops the event, whether it takes the drag or not
      if (!takesFrom(this.mark, serverOfKey(p.zone)) || (d.kind === "group" && !this.canTake(p.zone, true))) return this.tell({ type: "nowhere" });
      this.taken = true;
      return this.tell({ type: "in", zone: p.zone });
    }
    this.window("dragover", false);
  }

  /** The node under the pointer is removed by a store update. */
  removeUnderPointer() { this.lostLeave = true; return this; }
  /** The dragged row or header is removed, or mounted anew elsewhere. */
  removeDragged() { this.lostEnd = true; return this; }
  /** A pointer move or a key that reaches the page in mid-drag. */
  stray(type: "pointermove" | "keydown") { this.plain(type); return this; }

  /** The button is released: a drop where the drag is taken (then the drag's end), else a dragleave and the end. */
  release(): Moved {
    const p = this.at;
    let moved: Moved = null;
    if (!this.taken) this.leave(p, undefined);
    else {
      this.window("drop", true);
      // the header's handler when its upper half is lit, else the innermost zone's: each empties the mark and stops the
      // event, and moves only what is on its own server (moveTo, moveGroup)
      const before = !!p!.head && this.mark.before === p!.zone;
      const carried = this.dragged!.kind === "group" ? this.dragged!.group : keyOn(this.from, "x");
      if (sameServer(carried, p!.zone)) moved = before ? { before: p!.zone } : { into: p!.zone };
      this.tell({ type: "end" });
    }
    this.end();
    return moved;
  }
  /** Esc, as the driven browser gives it: the drag's end alone. */
  cancel() { this.end(); }
  /** Esc, or a release outside the window, as the HTML model has it: a dragleave with no related target, then the end. */
  cancelWithLeave() { this.leave(this.at, undefined); this.end(); }
  private end() {
    if (this.here) { // a drag from outside ends outside
      if (!this.lostEnd) this.window("dragend", true);
      this.tell(SOURCE_END.event); // the dragged element's own listener, in the page or not
      if (!this.lostEnd) this.window("dragend", false);
    }
    this.dragged = null; this.here = false; this.lostEnd = false; this.taken = false;
  }
  /** The first pointer event after a drag (drop > dragend > pointermove). */
  moveOn() { this.plain("pointermove", "mousemove"); return this; }
  click() { this.plain("pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"); return this; }
  lit() { return this.mark.zone !== null ? `zone ${this.mark.zone}` : this.mark.before !== null ? `before ${this.mark.before}` : ""; }
}

const ITEM: Dragged = { kind: "item" }, FOREIGN: Dragged = { kind: "foreign" };
const group = (g: string): Dragged => ({ kind: "group", group: g });

/** S2 of G2: a chat of Shop over Shop's own rows, dropped on the subgroup Sub. */
const s2 = (p: Page) => p.start(ITEM, on("Shop")).over(on("Shop")).over(on("Sub")).release();

// Each scenario answers what the drop moved. The mark is empty when the drag has ended, before any pointer event
// after it; that event is sent too, and changes nothing.
const SCENARIOS: Record<string, { what: string; run: (p: Page) => Moved; moved: Moved }> = {
  S1: { what: "a chat dropped on its own group", moved: { into: "Shop" }, run: (p) => p.start(ITEM, on("Shop")).over(on("Shop")).release() },
  S2: { what: "a chat over Shop, dropped on the subgroup Sub", moved: { into: "Sub" }, run: (p) => {
    p.start(ITEM, on("Shop")).over(on("Shop"));
    assert.equal(p.lit(), "zone Shop");
    p.over(on("Sub"));
    assert.equal(p.lit(), "zone Sub", "the innermost zone alone");
    return p.release();
  } },
  S2b: { what: "an ungrouped chat dropped on Sub, the pointer never over Shop's own area", moved: { into: "Sub" }, run: (p) => p.start(ITEM, on(LOOSE)).over(on(LOOSE)).over(on("Sub")).release() },
  S2c: { what: "a chat of Sub over Shop and back, dropped on Sub", moved: { into: "Sub" }, run: (p) => p.start(ITEM, on("Sub")).over(on("Sub")).over(on("Shop")).over(on("Sub")).release() },
  S2d: { what: "an ungrouped chat over Other, over Mid, dropped on Leaf", moved: { into: "Leaf" }, run: (p) => p.start(ITEM, on(LOOSE)).over(on("Other")).over(on("Mid")).over(on("Leaf")).release() },
  S3: { what: "the group Other over Shop's body, dropped on the upper half of Shop's header", moved: { before: "Shop" }, run: (p) => {
    p.start(group("Other"), head("Other", "lower")).over(on("Shop")).over(head("Shop", "lower"));
    assert.equal(p.lit(), "zone Shop");
    p.over(head("Shop", "upper"));
    assert.equal(p.lit(), "before Shop", "the line before the header, and not the zone");
    return p.release();
  } },
  S3b: { what: "the same, coming from above", moved: { before: "Shop" }, run: (p) => p.start(group("Other"), head("Other", "lower")).over(on(LOOSE)).over(head("Shop", "upper")).release() },
  S3c: { what: "the group Leaf over Other and Mid's body, dropped before Mid", moved: { before: "Mid" }, run: (p) =>
    p.start(group("Leaf"), head("Leaf", "lower")).over(on("Other")).over(on("Mid")).over(head("Mid", "upper")).removeDragged().release() },
  S4: { what: "a chat over Shop, released on the page", moved: null, run: (p) => p.start(ITEM, on("Shop")).over(on("Shop")).over(PAGE).release() },
  S4b: { what: "a chat over Shop, released on the sidebar's head", moved: null, run: (p) => p.start(ITEM, on("Shop")).over(on("Shop")).over(PAGE, 1).release() },
  S5: { what: "a chat over Shop, cancelled (the page gets the drag's end alone)", moved: null, run: (p) => { p.start(ITEM, on("Shop")).over(on("Shop")).cancel(); return null; } },
  S5b: { what: "a chat over Shop then Sub, cancelled", moved: null, run: (p) => { p.start(ITEM, on("Shop")).over(on("Shop")).over(on("Sub")).cancel(); return null; } },
  S6: { what: "a chat row nested under a board: no drag starts", moved: null, run: (p) => { p.plain("pointerdown", "mousedown", "pointermove", "mousemove", "pointermove", "mousemove", "pointerup", "mouseup"); return null; } },
  S7: { what: "the group Mid over Other, released over its own body", moved: null, run: (p) => {
    p.start(group("Mid"), head("Mid", "lower")).over(on("Other"));
    assert.equal(p.lit(), "zone Other");
    p.over(on("Mid"));
    assert.equal(p.lit(), "", "a refused group drag lights nothing");
    return p.release();
  } },
  S7b: { what: "the group Shop released over its own subgroup", moved: null, run: (p) => {
    p.start(group("Shop"), head("Shop", "lower")).over(on("Sub"));
    assert.equal(p.lit(), "");
    p.over(head("Sub", "upper"));
    assert.equal(p.lit(), "", "nor before a header of its own subtree");
    return p.release();
  } },
  S8: { what: "the row under the pointer removed, the next dragover outside the zone", moved: null, run: (p) => {
    p.start(ITEM, on("Shop")).over(on("Shop")).removeUnderPointer().over(PAGE);
    assert.equal(p.lit(), "", "the dragover that no zone took emptied the zone whose dragleave was lost");
    return p.release();
  } },
  S8b: { what: "the dragged row removed during the drag, dropped on Shop", moved: { into: "Shop" }, run: (p) => p.start(ITEM, on("Shop")).over(on("Shop")).removeDragged().release() },
  S9: { what: "a chat moved to Other by the drop: its row is mounted anew", moved: { into: "Other" }, run: (p) => p.start(ITEM, on("Shop")).over(on("Shop")).over(on("Other")).removeDragged().release() },
  S10: { what: "text from outside, dropped on a group", moved: null, run: (p) => {
    p.enter(FOREIGN).over(on("Shop")).over(on("Sub"));
    assert.equal(p.lit(), "", "text from outside lights nothing");
    return p.release();
  } },
  S10b: { what: "a file from outside, cancelled over a group", moved: null, run: (p) => { p.enter(FOREIGN).over(on("Shop")); assert.equal(p.lit(), ""); p.cancelWithLeave(); return null; } },
  S11: { what: "clicks only", moved: null, run: (p) => { p.click().click().click(); return null; } },
  S12: { what: "S2, then a second drag that crosses Shop and leaves it", moved: null, run: (p) => { s2(p); p.moveOn(); return p.start(ITEM, on(LOOSE)).over(on("Shop")).over(PAGE).release(); } },
  S12b: { what: "S2, then a second drag that never touches Shop", moved: { into: "Other" }, run: (p) => { s2(p); p.moveOn(); return p.start(ITEM, on(LOOSE)).over(on(LOOSE)).over(on("Other")).release(); } },
};

test("G2's 23 scenarios end with an empty mark, and each move is the scenario's", () => {
  assert.equal(Object.keys(SCENARIOS).length, 23);
  for (const [id, s] of Object.entries(SCENARIOS)) {
    const p = new Page();
    assert.deepEqual(s.run(p), s.moved, `${id} ${s.what}: what the drop moved`);
    assert.deepEqual(p.mark, NO_MARK, `${id} ${s.what}: the mark when the drag has ended`);
    const ended = p.mark;
    assert.equal(p.moveOn().mark, ended, `${id}: the pointer event after the drag changes nothing`);
    assert.equal(p.click().mark, ended, `${id}: nor does a click`);
  }
});

test("a pointer move or a key in mid-drag empties what is lit and leaves the dragged group", () => {
  for (const type of ["pointermove", "keydown"] as const) {
    const p = new Page();
    p.start(group("Other"), head("Other", "lower")).over(on("Shop"));
    assert.equal(p.lit(), "zone Shop");
    p.stray(type);
    assert.deepEqual(p.mark, { zone: null, before: null, group: "Other", server: "local" }, type);
    p.over(on("Shop"), 1);
    assert.equal(p.lit(), "zone Shop", "the next dragover lights the zone again");
    p.over(head("Shop", "upper")).stray(type);
    assert.deepEqual(p.mark, { zone: null, before: null, group: "Other", server: "local" }, type + " on a header");
    p.over(head("Shop", "upper"), 1);
    assert.deepEqual(p.release(), { before: "Shop" }, "and the group still goes where it is dropped");
    assert.deepEqual(p.mark, NO_MARK);
  }
  const into = new Page();
  into.start(group("Other"), head("Other", "lower")).over(on("Shop")).stray("keydown").over(on("Shop"), 1);
  assert.deepEqual(into.release(), { into: "Shop" });
});

test("a drag that ends after its row or header was removed: the element itself hears the end", () => {
  const p = new Page();
  p.start(ITEM, on("Shop")).over(on("Shop")).over(on("Sub")).removeDragged().cancel(); // no dragend at the window, and no dragleave came
  assert.deepEqual(p.mark, NO_MARK);
  // a group's header: the group leaves the mark with what was lit
  p.start(group("Leaf"), head("Leaf", "lower")).over(head("Mid", "upper")).removeDragged().cancel();
  assert.deepEqual(p.mark, NO_MARK);
  p.start(group("Other"), head("Other", "lower")).over(on("Mid"));
  assert.equal(p.lit(), "", "Other is refused by its own subgroup, judged by the group this drag set");
});

test("a drag whose end reaches nobody: the first pointer event or key empties what is lit", () => {
  for (const after of ["pointermove", "pointerdown", "keydown"]) {
    const p = new Page();
    p.enter(ITEM).over(on("Shop")).over(on("Sub")).cancel(); // a row of another window of the app: its end is that window's, and no dragleave came
    assert.deepEqual(p.mark, { zone: "Sub", before: null, group: null, server: null });
    p.plain(after);
    assert.deepEqual(p.mark, NO_MARK, after);
  }
  // a group of another window is no group dragged here: it lights nothing
  const p = new Page();
  p.enter(group("Leaf")).over(on("Shop")).over(head("Mid", "upper")).cancel();
  assert.deepEqual(p.mark, NO_MARK);
  // and the dragged group of a mark that an end never emptied lights nothing, and is set anew by the next drag
  p.mark = { zone: null, before: "Mid", group: "Leaf", server: "local" };
  p.moveOn();
  assert.deepEqual(p.mark, { zone: null, before: null, group: "Leaf", server: "local" });
  assert.equal(p.lit(), "");
  p.start(ITEM, on("Shop"));
  assert.deepEqual(p.mark, { zone: null, before: null, group: null, server: "local" }, "a row's drag: no group is dragged any more");
});

// ---- a section: nothing is dragged across

test("inside a section a row and a group are dragged as in the local part", () => {
  const p = new Page();
  p.start(ITEM, on(FAR_LOOSE)).over(on(FAR));
  assert.equal(p.lit(), `zone ${FAR}`);
  assert.deepEqual(p.mark, { zone: FAR, before: null, group: null, server: "s_1" });
  p.over(on(DEEP));
  assert.equal(p.lit(), `zone ${DEEP}`, "the innermost zone alone");
  assert.deepEqual(p.release(), { into: DEEP });
  assert.deepEqual(p.mark, NO_MARK);
  assert.deepEqual(p.start(ITEM, on(DEEP)).over(on(FAR_LOOSE)).release(), { into: FAR_LOOSE }, "to that server's ungrouped area");
  assert.deepEqual(p.start(group(DEEP), head(DEEP, "lower")).over(head(FAR_SHOP, "upper")).release(), { before: FAR_SHOP });
  assert.deepEqual(p.start(group(FAR_SHOP), head(FAR_SHOP, "lower")).over(on(DEEP)).release(), { into: DEEP });
  assert.deepEqual(p.start(group(DEEP), head(DEEP, "lower")).over(on(FAR_LOOSE)).release(), { into: FAR_LOOSE }, "a group to the top level of its section");
  p.start(group(FAR), head(FAR, "lower")).over(on(DEEP));
  assert.equal(p.lit(), "", "a group is refused by its own subgroup there too");
  assert.equal(p.release(), null);
  assert.deepEqual(p.mark, NO_MARK);
});

test("a row dragged from the local part lights no zone of a section, and its drop there moves nothing", () => {
  const p = new Page();
  p.start(ITEM, on("Shop")).over(on("Shop"));
  assert.equal(p.lit(), "zone Shop");
  for (const zone of [FAR, DEEP, FAR_SHOP, FAR_LOOSE]) {
    p.over(on(zone));
    assert.equal(p.lit(), "", zone);
    assert.deepEqual(p.mark, { zone: null, before: null, group: null, server: "local" }, zone);
  }
  assert.equal(p.release(), null, "no drop is offered: the drag ends with a leave");
  assert.deepEqual(p.mark, NO_MARK);
  p.start(ITEM, on(LOOSE)).over(on(FAR)).over(on("Sub"));
  assert.equal(p.lit(), "zone Sub", "back over the local part its zones light again");
  assert.deepEqual(p.release(), { into: "Sub" });
});

test("a row dragged from a section lights no zone of the local part or of another section", () => {
  const other = keyOn("s_2", "Far");
  const p = new Page();
  p.start(ITEM, on(FAR)).over(on(FAR_SHOP));
  assert.equal(p.lit(), `zone ${FAR_SHOP}`);
  for (const zone of ["Shop", "Sub", LOOSE, other, ungroupedOn("s_2")]) {
    p.over(on(zone));
    assert.equal(p.lit(), "", zone);
  }
  assert.equal(p.release(), null);
  assert.deepEqual(p.mark, NO_MARK);
});

test("a group is dragged neither into nor before a group of another server, the one with its own id included", () => {
  const p = new Page();
  p.start(group("Shop"), head("Shop", "lower")).over(on(FAR));
  assert.equal(p.lit(), "");
  p.over(head(FAR, "upper"));
  assert.equal(p.lit(), "", "nor before its header");
  p.over(on(FAR_LOOSE));
  assert.equal(p.lit(), "", "nor to the top level of the section");
  assert.equal(p.release(), null);
  p.start(group(FAR_SHOP), head(FAR_SHOP, "lower")).over(on("Shop"));
  assert.equal(p.lit(), "", "the section's Shop into the local Shop");
  p.over(head("Shop", "upper"));
  assert.equal(p.lit(), "");
  p.over(on(LOOSE));
  assert.equal(p.lit(), "");
  assert.equal(p.release(), null);
  assert.deepEqual(p.mark, NO_MARK);
  p.start(group("Shop"), head("Shop", "lower")).over(on(FAR_SHOP));
  assert.equal(p.lit(), "", "the local Shop into the section's Shop: the same id is another group");
  p.over(on("Sub"));
  assert.equal(p.lit(), "", "and its own subgroup still refuses it");
  p.over(on("Other"));
  assert.equal(p.lit(), "zone Other");
  assert.deepEqual(p.release(), { into: "Other" });
});

test("a row of another window lights the zone it is over on any server, and is moved only where it is on that server", () => {
  const p = new Page();
  p.enter(ITEM, "s_1").over(on("Shop"));
  assert.deepEqual(p.mark, { zone: "Shop", before: null, group: null, server: null }, "this window does not know its server");
  assert.equal(p.release(), null, "the drop reads what it carries: a chat of s_1 goes into no local group");
  assert.deepEqual(p.mark, NO_MARK);
  assert.deepEqual(p.enter(ITEM, "s_1").over(on(FAR)).release(), { into: FAR });
  assert.equal(p.enter(ITEM, LOCAL_SERVER).over(on(FAR)).release(), null);
  assert.deepEqual(p.enter(ITEM, LOCAL_SERVER).over(on("Sub")).release(), { into: "Sub" });
  assert.deepEqual(p.mark, NO_MARK);
});
