// Which controls stay in a chat composer's toolbar (src/logic/composerfit.ts), on the widths the
// browser check P0.6 measured in the page for every seeded state of the composer, its chips'
// names capped, and for the "more" chip, the meter's ring and the error meter's icon
// (test/fixtures/composer-widths.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTROLS, LEAVING, fit, needs, widthKey, type Control, type Fit, type Row } from "../src/logic/composerfit.ts";

type Measured = { kind: string; label: string; fixed?: boolean; w: number; margin?: number };
type State = { composer: "chat" | "goal"; pane: string; sum: number; controls: Measured[] };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/composer-widths.json", import.meta.url), "utf8")) as { gap: number; chrome: number; more: number; ring: number; icon: number; states: Record<string, State> };
const chats = Object.entries(fixture.states).filter(([, s]) => s.composer === "chat");
const { gap, chrome, more: MORE, ring: RING } = fixture;
/** The meter that says why the context is not known is cut to its icon, not to a ring. */
const cut = (s: State) => (s.controls.some((c) => c.kind === "meter" && c.label === "Context unavailable") ? fixture.icon : RING);

/** What stands in the model's place. */
const KIND: Record<string, Control> = { server: "server", agent: "agent", folder: "folder", model: "model", "model-effort": "model", loading: "model", effort: "effort", subagents: "subagents" };

/** The fixed Subagents chip of a chat on the default settings: the toolbar gives it to the fit as optional. */
const spare = (c: Measured) => c.kind === "subagents" && !!c.fixed && c.label === "Subagents1 level";

/** A measured state as the toolbar gives it to the fit: the lock is counted into its folder, with its margin and the gap between the two.
 *  The optional chip is left out unless asked for (withSpare): the rules of the others are the same with it and without. */
function rowOf(s: State, box: number, held: Control[] | null = null, withSpare = false): Row {
  const lock = s.controls.find((c) => c.kind === "lock");
  const controls = s.controls.filter((c) => c.kind in KIND && (withSpare || !spare(c))).map((c) => ({ id: KIND[c.kind], w: c.w + (c.kind === "folder" && lock ? lock.w + (lock.margin ?? 0) + gap : 0),
    ...(spare(c) ? { optional: true } : {}) }));
  return {
    room: box - chrome, gap, controls, more: MORE, held,
    meter: { full: s.controls.find((c) => c.kind === "meter")!.w, ring: cut(s) },
    fixed: s.controls.filter((c) => c.kind === "stop" || c.kind === "send").map((c) => c.w),
  };
}
const hidden = (f: Fit) => f.popup.length + (f.meter === "ring" ? 1 : 0);
/** The controls of a row in the order they leave it. */
const leavingOf = (r: Row) => LEAVING.filter((id) => r.controls.some((c) => c.id === id));

test("the fixture's states are the toolbar's controls: each kind is one the fit knows, at most once", () => {
  assert.ok(chats.length >= 30, `${chats.length} chat states`);
  for (const w of [gap, chrome, MORE, RING, fixture.icon]) assert.ok(w > 0);
  // the long names are among them, capped: no chip is wider than the widest name's cap lets it be
  for (const id of ["plain-new-long", "plain-started-long", "plain-move-long", "plain-remote-started-long", "board-long"]) assert.ok(fixture.states[id], id);
  for (const [id, s] of chats) for (const c of s.controls) assert.ok(c.w < 210, `${id}: ${c.kind} "${c.label}" is ${c.w} px wide`);
  for (const [id, s] of chats) {
    for (const c of s.controls) assert.ok(c.kind in KIND || ["lock", "meter", "stop", "send"].includes(c.kind), `${id}: ${c.kind}`);
    const ids = rowOf(s, 800).controls.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${id}: ${ids}`);
    // all of it on one line is the sum the page measured
    const all = rowOf(s, 800, null, true), every = all.controls.map((c) => c.id);
    assert.ok(Math.abs(needs(all, { toolbar: every, popup: [], more: false, meter: "full" }) - s.sum) < 0.35, `${id}: ${needs(all, { toolbar: every, popup: [], more: false, meter: "full" })} against ${s.sum}`);
  }
});

test("at every box of 260 to 800 px what stays needs no more than the box, and left in the order of leaving", () => {
  for (const [id, s] of chats) {
    let before = Infinity;
    for (let box = 260; box <= 800; box++) {
      const r = rowOf(s, box), f = fit(r), at = `${id} at ${box}`;
      assert.ok(needs(r, f) <= r.room, `${at}: needs ${needs(r, f)} of ${r.room}`);
      // every control is in one place, and both lists are left to right
      assert.deepEqual([...f.toolbar, ...f.popup].sort(), r.controls.map((c) => c.id).sort(), at);
      for (const list of [f.toolbar, f.popup]) assert.deepEqual(list, CONTROLS.filter((c) => list.includes(c)), at);
      // the popup holds the first of the order, and nothing is there while the meter still has its text
      assert.deepEqual(LEAVING.filter((c) => f.popup.includes(c)), leavingOf(r).slice(0, f.popup.length), at);
      assert.equal(f.more, f.popup.length > 0, at);
      if (f.popup.length) assert.equal(f.meter, "ring", at);
      // nothing left that could have stayed: one step less does not fit
      if (f.popup.length) {
        const back = leavingOf(r).slice(0, f.popup.length - 1);
        const less: Fit = { toolbar: CONTROLS.filter((c) => r.controls.some((x) => x.id === c) && !back.includes(c)), popup: back, more: back.length > 0, meter: "ring" };
        assert.ok(needs(r, less) > r.room, `${at}: ${f.popup.at(-1)} left though it fits`);
      } else if (f.meter === "ring") {
        assert.ok(needs(r, { ...f, meter: "full" }) > r.room, `${at}: the meter's text left though it fits`);
      }
      // a wider box never hides more
      assert.ok(hidden(f) <= before, `${at}: hides ${hidden(f)}, a narrower box ${before}`);
      before = hidden(f);
    }
  }
});

test("the last step is the more chip, the ring, Stop and Send, and it fits the narrowest box", () => {
  const busy = fixture.states["plain-busy"], r = rowOf(busy, 100), f = fit(r);
  assert.deepEqual(f, { toolbar: [], popup: ["folder", "model"], more: true, meter: "ring" });
  // (the row's children: the chip, the ring, the spacer, Stop and Send; 148 px, as the plan counted)
  assert.equal(needs(r, f) + chrome, MORE + RING + 2 * 28 + 4 * gap + chrome);
  assert.equal(needs(r, f) + chrome, 148);
  assert.ok(needs(r, f) + chrome <= 260, `the last step needs a box of ${needs(r, f) + chrome}`);
});

test("agent and model stay in the default panel's box beside more, the ring, Stop and Send, whatever the model's name", () => {
  const send = fixture.states["plain-busy"].controls.filter((c) => c.kind === "stop" || c.kind === "send").map((c) => c.w);
  assert.equal(send.length, 2);
  let n = 0;
  for (const [id, s] of chats) {
    if (!s.controls.some((c) => c.kind === "agent") || !s.controls.some((c) => c.kind === "model")) continue;
    // (the state at work: Stop beside its Send)
    const r: Row = { ...rowOf(s, 375), fixed: send }, f = fit(r);
    assert.ok(f.toolbar.includes("agent") && f.toolbar.includes("model"), `${id}: ${f.toolbar} stay`);
    assert.ok(needs(r, f) <= r.room, id);
    n++;
  }
  assert.ok(n >= 5 && fixture.states["plain-new-long"].controls.some((c) => c.kind === "model" && c.label.length > 40), "the long model is among them");
});

test("at the default panel a started chat is whole, and an unstarted one keeps agent and model", () => {
  for (const id of ["board-started", "run-started", "board-quotes"]) {
    assert.deepEqual(fit(rowOf(fixture.states[id], 375)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "full" }, id);
  }
  for (const id of ["board-new", "run-new"]) {
    const f = fit(rowOf(fixture.states[id], 375));
    assert.ok(f.toolbar.includes("agent") && f.toolbar.includes("model"), `${id}: ${f.toolbar}`);
    assert.ok(f.popup.includes("server"), `${id}: ${f.popup}`);
  }
});

test("a control with no width stays in the toolbar and counts nothing", () => {
  const s = fixture.states["plain-new"];
  const r = rowOf(s, 200);
  assert.deepEqual(fit(r).toolbar, [], "all of them leave a 200 px box");
  // the folder is not measured yet: it stays, and what leaves before it and after it does
  const folder: Row = { ...r, controls: r.controls.map((c) => (c.id === "folder" ? { id: c.id } : c)) };
  assert.deepEqual(fit(folder), { toolbar: ["folder"], popup: ["server", "agent", "model", "effort", "subagents"], more: true, meter: "ring" });
  // none is: nothing leaves, whatever the room, and the row asks for its gaps alone
  // (the row's children: its six controls, the meter, the spacer and Send)
  const none: Row = { ...r, room: 8 * gap, controls: r.controls.map((c) => ({ id: c.id })), meter: {}, more: undefined, fixed: [undefined] };
  assert.deepEqual(fit(none), { toolbar: CONTROLS, popup: [], more: false, meter: "full" });
  assert.equal(needs(none, fit(none)), 8 * gap);
  assert.deepEqual(fit({ ...none, room: 0 }).toolbar, CONTROLS);
  // a meter whose text is not measured keeps it while the rest fits
  const wide = rowOf(s, 800);
  assert.equal(fit({ ...wide, meter: { ring: RING } }).meter, "full");
});

test("while the popup is open nothing it holds returns, however wide the box, and the toolbar still gives to it", () => {
  for (const [id, s] of chats) {
    const all = rowOf(s, 800).controls.map((c) => c.id);
    for (let n = 1; n <= all.length; n++) {
      const held = leavingOf(rowOf(s, 800)).slice(0, n);
      for (let box = 260; box <= 800; box += 7) {
        const r = rowOf(s, box, held), f = fit(r), at = `${id} at ${box}, holding ${held}`;
        for (const c of held) assert.ok(f.popup.includes(c), `${at}: ${c} returned`);
        assert.equal(f.meter, "ring", at);
        assert.equal(f.more, true, at);
        assert.ok(needs(r, f) <= r.room, `${at}: needs ${needs(r, f)} of ${r.room}`);
        // what the toolbar gave is the next of the order
        assert.deepEqual(LEAVING.filter((c) => f.popup.includes(c)), leavingOf(r).slice(0, f.popup.length), at);
        // closed again, at least as much is in the toolbar
        assert.ok(fit(rowOf(s, box)).popup.length <= f.popup.length, at);
      }
    }
  }
  // a wide box, the popup opened when it was narrow: all of it stays there until it closes
  const s = fixture.states["plain-new"], open = fit(rowOf(s, 260)).popup;
  assert.deepEqual(fit(rowOf(s, 800, open)).popup, open);
  assert.deepEqual(fit(rowOf(s, 800)).popup, []);
});

test("in the open popup a control with no width stays, one the chat lost is gone, and one it got is placed", () => {
  const s = fixture.states["plain-new"], r = rowOf(s, 800, ["server", "model"]);
  // a pick in the popup changed the model's label: not measured yet
  const relabelled: Row = { ...r, controls: r.controls.map((c) => (c.id === "model" ? { id: c.id } : c)) };
  assert.deepEqual(fit(relabelled), { toolbar: ["agent", "folder", "effort", "subagents"], popup: ["server", "model"], more: true, meter: "ring" });
  // the chat no longer has a server chip: the popup holds the model alone, and nothing else joins it
  const lost: Row = { ...r, controls: r.controls.filter((c) => c.id !== "server") };
  assert.deepEqual(fit(lost).popup, ["model"]);
  // it holds none of what the chat has: no popup, and the meter's text is back
  assert.deepEqual(fit({ ...lost, held: ["server"] }), { toolbar: ["agent", "folder", "model", "effort", "subagents"], popup: [], more: false, meter: "full" });
  // the effort chip arrives while the popup holds server and model: it goes where it fits
  const without: Row = { ...r, controls: r.controls.filter((c) => c.id !== "effort") };
  assert.deepEqual(fit(without).toolbar, ["agent", "folder", "subagents"]);
  assert.deepEqual(fit(r).toolbar, ["agent", "folder", "effort", "subagents"]);
  const narrow = rowOf(s, 300, ["server", "model"]);
  assert.ok(fit(narrow).popup.includes("effort"), "in a narrow box it joins the popup");
  // not measured yet, it is in the toolbar
  assert.ok(fit({ ...narrow, controls: narrow.controls.map((c) => (c.id === "effort" ? { id: c.id } : c)) }).toolbar.includes("effort"));
});

test("a width is kept by the control's kind, its label, fixed or choice, with or without lock", () => {
  const keys = [widthKey("folder", "shop"), widthKey("folder", "shop", { fixed: true }), widthKey("folder", "shop", { fixed: true, lock: true }), widthKey("folder", "web"),
    widthKey("model", "shop"), widthKey("agent", "Claude Code", { mark: "glyph" }), widthKey("agent", "Claude Code", { mark: "warn" }), widthKey("more"), widthKey("send")];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(widthKey("folder", "shop", { fixed: false, lock: false }), widthKey("folder", "shop"));
  // a label with the separator in it is another label, not another kind
  assert.notEqual(widthKey("model", "a|b"), widthKey("model", "a", { mark: "b" }));
});

test("the Subagents chip is the first to leave; pinned, it is the last", () => {
  assert.deepEqual(CONTROLS.at(-1), "subagents");
  assert.equal(LEAVING[0], "subagents");
  const s = fixture.states["plain-new"];
  const withSubs = (box: number, pinned?: Control): Row => { const r = rowOf(s, box); return { ...r, controls: [...r.controls, { id: "subagents", w: 150 }], pinned }; };
  const full = needs(withSubs(2000), fit(withSubs(2000)));
  // as the box narrows, the chip goes into the popup first
  let order: Control[] = [];
  for (let box = full + chrome; box > 150; box -= 3) for (const id of fit(withSubs(box)).popup) if (!order.includes(id)) order.push(id);
  assert.deepEqual(order, leavingOf(withSubs(0)));
  assert.equal(order[0], "subagents");
  // with its list open it stays while any other can leave, and the toolbar still fits its row
  for (let box = full + chrome; box > 150; box -= 3) {
    const r = withSubs(box, "subagents"), f = fit(r);
    if (f.popup.includes("subagents")) assert.deepEqual(f.toolbar, [], `${box}: it left before ${f.toolbar}`);
    else if (f.toolbar.length > 1) assert.ok(needs(r, f) <= r.room + 1e-6, `${box}: the row needs ${needs(r, f)} of ${r.room}`);
  }
});

test("an optional control is beside the others when all of them are whole, in the popup when it holds another, else nowhere", () => {
  let beside = 0, inPopup = 0, nowhere = 0;
  for (const [id, s] of chats) {
    if (!s.controls.some(spare)) continue;
    for (let box = 260; box <= 800; box++) {
      const r = rowOf(s, box, null, true), without = fit(rowOf(s, box)), f = fit(r), at = `${id} at ${box}`;
      // the others are where they are without it, and the row still fits
      assert.deepEqual({ ...f, toolbar: f.toolbar.filter((c) => c !== "subagents"), popup: f.popup.filter((c) => c !== "subagents") }, without, at);
      assert.ok(needs(r, f) <= r.room + 1e-6, `${at}: needs ${needs(r, f)} of ${r.room}`);
      if (f.toolbar.includes("subagents")) { beside++; assert.ok(f.meter === "full" && !f.more, at); }
      else if (f.popup.includes("subagents")) { inPopup++; assert.ok(f.popup.length > 1, at); }
      else { nowhere++; assert.equal(f.popup.length, 0, at); }
    }
    // while the popup is open with another control, it is there
    const held = leavingOf(rowOf(s, 800)).slice(0, 1);
    assert.ok(fit(rowOf(s, 800, held, true)).popup.includes("subagents"), id);
    // not measured yet, it is in the toolbar like any other
    const r = rowOf(s, 300, null, true);
    assert.ok(fit({ ...r, controls: r.controls.map((c) => (c.id === "subagents" ? { id: c.id, optional: true } : c)) }).toolbar.includes("subagents"), id);
  }
  assert.ok(beside > 0 && inPopup > 0 && nowhere > 0, `${beside} beside, ${inPopup} in the popup, ${nowhere} nowhere`);
  // a started chat in the default panel: its toolbar is whole and the chip is not drawn; in a wider pane it is there
  const started = fixture.states["board-started"];
  assert.deepEqual(fit(rowOf(started, 375, null, true)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "full" });
  assert.deepEqual(fit(rowOf(started, 520, null, true)), { toolbar: ["folder", "model", "subagents"], popup: [], more: false, meter: "full" });
});
