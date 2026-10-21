// Which controls stay in a chat composer's toolbar (src/logic/composerfit.ts), on the widths the
// browser check P0.6 measured in the page for every seeded state of the composer, its chips'
// names capped, and for the "more" chip, the meter's ring and the error meter's icon
// (test/fixtures/composer-widths.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTROLS, LEAVING, fit, fitWithInsert, fitWithTail, needs, widthKey, type Control, type Fit, type Row } from "../src/logic/composerfit.ts";

type Measured = { kind: string; label: string; fixed?: boolean; w: number; margin?: number };
type State = { pane: string; sum: number; controls: Measured[] };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/composer-widths.json", import.meta.url), "utf8")) as { gap: number; chrome: number; more: number; ring: number; icon: number; states: Record<string, State> };
const chats = Object.entries(fixture.states);
const { gap, chrome, more: MORE, ring: RING } = fixture;
/** The meter that says why the context is not known is cut to its icon, not to a ring. */
const cut = (s: State) => (s.controls.some((c) => c.kind === "meter" && c.label === "Context unavailable") ? fixture.icon : RING);

/** The button of the insert popup, as the page measured it beside Send. */
const INSERT = fixture.states["plain-started"].controls.find((c) => c.kind === "insert")!.w;
const ATTACH = fixture.states["plain-started"].controls.find((c) => c.kind === "attach")!.w;

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
    fixed: s.controls.filter((c) => c.kind === "attach" || c.kind === "stop" || c.kind === "send").map((c) => c.w), // (the attach button never leaves the row, as Stop and Send do not)
  };
}
const hidden = (f: Fit) => f.popup.length + (f.meter === "ring" ? 1 : 0);
/** The controls of a row in the order they leave it. */
const leavingOf = (r: Row) => LEAVING.filter((id) => r.controls.some((c) => c.id === id));

test("the fixture's states are the toolbar's controls: each kind is one the fit knows, at most once", () => {
  assert.ok(chats.length >= 27, `${chats.length} chat states`);
  for (const w of [gap, chrome, MORE, RING, fixture.icon]) assert.ok(w > 0);
  // the long names are among them, capped: no chip is wider than the widest name's cap lets it be
  for (const id of ["plain-new-long", "plain-started-long", "plain-move-long", "plain-remote-started-long", "board-long"]) assert.ok(fixture.states[id], id);
  for (const [id, s] of chats) for (const c of s.controls) assert.ok(c.w < 210, `${id}: ${c.kind} "${c.label}" is ${c.w} px wide`);
  for (const [id, s] of chats) {
    for (const c of s.controls) assert.ok(c.kind in KIND || ["lock", "meter", "insert", "attach", "stop", "send"].includes(c.kind), `${id}: ${c.kind}`);
    assert.equal(s.controls.filter((c) => c.kind === "attach").length, 1, id); // every chat composer has the attach button, in its row
    const ids = rowOf(s, 800).controls.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${id}: ${ids}`);
    // all of it on one line is the sum the page measured, the Insert button among them: the page is measured where the row has room for it
    assert.equal(s.controls.filter((c) => c.kind === "insert").length, 1, id);
    const all = { ...rowOf(s, 800, null, true), fixed: s.controls.filter((c) => ["insert", "attach", "stop", "send"].includes(c.kind)).map((c) => c.w) }, every = all.controls.map((c) => c.id);
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

test("the last step is the more chip, the ring, the attach button, Stop and Send, and it fits the narrowest box", () => {
  const busy = fixture.states["plain-busy"], r = rowOf(busy, 100), f = fit(r);
  assert.deepEqual(f, { toolbar: [], popup: ["folder", "model"], more: true, meter: "ring" });
  // (the row's children: the chip, the ring, the spacer, the attach button, Stop and Send; 148 px as the plan counted, and 30 for the attach button with its gap)
  assert.equal(needs(r, f) + chrome, MORE + RING + ATTACH + 2 * 28 + 5 * gap + chrome);
  assert.equal(needs(r, f) + chrome, 178);
  assert.ok(needs(r, f) + chrome <= 260, `the last step needs a box of ${needs(r, f) + chrome}`);
});

test("agent and model stay in the default panel's box beside more, the ring, the attach button and Send, whatever the model's name", () => {
  let n = 0;
  for (const [id, s] of chats) {
    if (!s.controls.some((c) => c.kind === "agent") || !s.controls.some((c) => c.kind === "model")) continue;
    // (a chat whose agent is a choice has not started: nothing of it works, so its row has no Stop)
    assert.ok(!s.controls.some((c) => c.kind === "stop"), id);
    const r = rowOf(s, 375), f = fit(r);
    assert.equal(r.fixed.length, 2, id);
    assert.ok(f.toolbar.includes("agent") && f.toolbar.includes("model"), `${id}: ${f.toolbar} stay`);
    assert.ok(needs(r, f) <= r.room, id);
    n++;
  }
  assert.ok(n >= 4 && fixture.states["plain-new-long"].controls.some((c) => c.kind === "model" && c.label.length > 40), "the long model is among them");
});

test("at the default panel a started chat keeps its folder and model with the meter cut to its ring, and an unstarted one keeps agent and model", () => {
  for (const id of ["board-started", "board-quotes"]) {
    // (the attach button with its gap is 30 px, and a whole row of short names left 16.5: the meter's text is the first to go.
    // The row is whole in a box 14 px wider)
    assert.deepEqual(fit(rowOf(fixture.states[id], 375)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "ring" }, id);
    assert.deepEqual(fit(rowOf(fixture.states[id], 375 + 14)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "full" }, id);
  }
  const f = fit(rowOf(fixture.states["board-new"], 375));
  assert.ok(f.toolbar.includes("agent") && f.toolbar.includes("model"), `board-new: ${f.toolbar}`);
  assert.ok(![...f.toolbar, ...f.popup].includes("server"), "board-new: a chat on this computer has no server chip");
  // a chat on another server names its server: the chip is the first to give way
  const remote = fit(rowOf(fixture.states["plain-remote-new"], 375));
  assert.ok(remote.toolbar.includes("agent") && remote.toolbar.includes("model") && remote.popup.includes("server"), `plain-remote-new: ${remote.toolbar} | ${remote.popup}`);
});

test("a control with no width stays in the toolbar and counts nothing", () => {
  const s = fixture.states["plain-remote-new"]; // (an unstarted chat on another server: the state with all six controls)
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

test("the Insert button is drawn where the row has room left for it, and takes nothing from the others", () => {
  assert.ok(INSERT > 0);
  for (const [id, s] of chats) {
    let drawn = 0;
    for (let box = 260; box <= 1000; box++) {
      for (const held of [null, leavingOf(rowOf(s, box)).slice(0, 1)]) {
        const r = rowOf(s, box, held), { fit: f, insert } = fitWithInsert(r, INSERT), at = `${id} at ${box}${held ? `, the popup open with ${held}` : ""}`;
        // every control is where it is without the button, and the meter says what it says without it
        assert.deepEqual(f, fit(r), at);
        // the button is there exactly where the row, placed so, has room for it and its gap besides
        const room = needs(r, f) + INSERT + gap <= r.room + 1e-6;
        assert.equal(insert === "row", room, `${at}: the row needs ${needs(r, f)} of ${r.room}`);
        // where it has none, the "more" popup has the entry exactly where the row has that chip anyway
        if (!room) assert.equal(insert, f.more ? "more" : "", at);
        if (insert === "row" && !held) drawn++;
      }
    }
    assert.ok(drawn > 300, `${id}: the button is drawn at ${drawn} of the 741 widths`);
    assert.equal(fitWithInsert(rowOf(s, 1000), INSERT).insert, "row", `${id}: on a wide page`);
  }
});

test("where the row has no room for the Insert button, the \"more\" popup has the entry when the chip is there, and holds it while it is open", () => {
  // a row too narrow for the button beside the chip: the entry is in the popup, and the row is as it is without it
  let inPopup = 0, nowhere = 0;
  for (const [id, s] of chats) {
    for (let box = 150; box <= 1000; box++) {
      const r = rowOf(s, box), { fit: f, insert } = fitWithInsert(r, INSERT), at = `${id} at ${box}`;
      if (insert === "more") { inPopup++; assert.equal(f.more, true, at); assert.deepEqual(f, fit(r), at); }
      if (insert === "") { nowhere++; assert.equal(f.more, false, `${at}: the chip is there, and the entry is not in its popup`); }
      // the entry is somewhere whenever the row has the chip: with a control in the popup the popup is never opened by the key alone
      if (f.more) assert.notEqual(insert, "", at);
    }
  }
  assert.ok(inPopup > 0, "no state of the fixture has a row with the chip and no room for the button");
  assert.ok(nowhere > 0, "no state of the fixture has a whole row with no room for the button");
  const narrow = rowOf(fixture.states["plain-busy"], 150);
  assert.deepEqual(fitWithInsert(narrow, INSERT), { fit: fit(narrow), insert: "more" });
  // open with the entry in it, the popup keeps the entry however wide the row gets, as it keeps its controls
  const s = fixture.states["plain-new"], held = fit(rowOf(s, 260)).popup;
  assert.ok(held.length > 0);
  for (let box = 260; box <= 1000; box += 20) assert.equal(fitWithInsert(rowOf(s, box, held), INSERT, true).insert, "more", `at ${box}`);
  assert.equal(fitWithInsert(rowOf(s, 1000, held), INSERT).insert, "row", "an entry that was in the row stays there");
  // closed again, the entry returns to the row where it has room
  assert.equal(fitWithInsert(rowOf(s, 1000), INSERT).insert, "row");
  // a popup that lost what it held has no chip, and no entry to keep
  assert.equal(fitWithInsert(rowOf(s, 1000), INSERT, true).insert, "row");
});

test("the Insert button is there unless a started chat's whole row leaves it no room, and it never takes the meter's text", () => {
  for (const id of ["board-started", "board-quotes"]) {
    // at the default panel the meter is cut to its ring (the attach button has the room of its text): what is left is the button's
    assert.deepEqual(fitWithInsert(rowOf(fixture.states[id], 375), INSERT), { fit: { toolbar: ["folder", "model"], popup: [], more: false, meter: "ring" }, insert: "row" }, id);
    // (a whole row of short names, in a box 14 px wider: half a px is left, and the button with its gap needs 30. The row is whole and has
    // no "more" chip: the entry is nowhere, and the popup is opened by its key alone)
    const r = rowOf(fixture.states[id], 375 + 14);
    assert.deepEqual(fitWithInsert(r, INSERT), { fit: { toolbar: ["folder", "model"], popup: [], more: false, meter: "full" }, insert: "" }, id);
    assert.equal(fitWithInsert(rowOf(fixture.states[id], 375 + 14 + 30), INSERT).insert, "row", `${id}: 30 px wider still`);
  }
  // where the meter is cut to its ring, by long names or by Stop, the text's room is the button's
  const { fit: busy, insert } = fitWithInsert(rowOf(fixture.states["plain-busy"], 375), INSERT);
  assert.deepEqual([busy.meter, busy.popup, insert], ["ring", [], "row"]);
  // and where a control is in the popup, what the row has left
  const long = fitWithInsert(rowOf(fixture.states["plain-started-long"], 375), INSERT);
  assert.deepEqual([long.fit.popup, long.insert], [["folder"], "row"]);
  // in the narrowest box the folder is in the popup of the "more" chip, and what the row has left is under the button's 30 px: the entry is in that popup
  assert.deepEqual(fitWithInsert(rowOf(fixture.states["plain-started"], 260), INSERT), { fit: { toolbar: ["model"], popup: ["folder"], more: true, meter: "ring" }, insert: "more" });
  assert.equal(fitWithInsert(rowOf(fixture.states["plain-started"], 260 + 18), INSERT).insert, "row");
  // and a row that does not fit even at its last step has it in the popup of its "more" chip
  assert.equal(fitWithInsert(rowOf(fixture.states["plain-busy"], 150), INSERT).insert, "more");
});

test("the Insert button whose width is not known is drawn, to be measured; an optional chip gives way to it", () => {
  const s = fixture.states["plain-new"];
  for (const box of [300, 800]) assert.deepEqual(fitWithInsert(rowOf(s, box)), { fit: fit(rowOf(s, box)), insert: "row" }, `at ${box}`);
  // nothing is measured yet: every control is in the toolbar, and the button with them
  const r = rowOf(s, 300), none: Row = { ...r, controls: r.controls.map((c) => ({ id: c.id })), meter: {}, more: undefined, fixed: [undefined] };
  assert.deepEqual(fitWithInsert(none), { fit: { toolbar: r.controls.map((c) => c.id), popup: [], more: false, meter: "full" }, insert: "row" });
  // the fixed Subagents chip of a chat on the default settings: where the row has room for one of the two, it is the button
  const started = Object.entries(fixture.states).find(([, x]) => x.controls.some(spare))!;
  const sub = started[1].controls.find(spare)!.w, bare = rowOf(started[1], 2000), whole = needs(bare, fit(bare)) + chrome;
  const at = (box: number) => { const { fit: f, insert } = fitWithInsert(rowOf(started[1], box, null, true), INSERT); return [insert === "row", f.toolbar.includes("subagents")]; };
  assert.ok(sub > INSERT, `${started[0]}: the chip is ${sub} px wide`);
  assert.deepEqual(at(Math.ceil(whole + INSERT + gap) - 2), [false, false]);
  assert.deepEqual(at(Math.ceil(whole + INSERT + gap)), [true, false]);
  assert.deepEqual(at(Math.ceil(whole + sub + gap)), [true, false], "the chip alone would fit here");
  assert.deepEqual(at(Math.ceil(whole + INSERT + gap + sub + gap)), [true, true]);
  // with the chip or without, the others are where fit puts them
  for (let box = 260; box <= 1000; box += 3) {
    const r = rowOf(started[1], box, null, true), f = fitWithInsert(r, INSERT).fit, plain = fit(r), firm = (x: Fit) => [x.meter, x.more, x.toolbar.filter((c) => c !== "subagents"), x.popup.filter((c) => c !== "subagents")];
    assert.deepEqual(firm(f), firm(plain), `${started[0]} at ${box}`);
  }
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
  const s = fixture.states["plain-remote-new"], r = rowOf(s, 800, ["server", "model"]);
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
  // a started chat in the default panel, and in a box where its toolbar is whole: the chip is not drawn; in a wider pane it is there
  const started = fixture.states["board-started"];
  assert.deepEqual(fit(rowOf(started, 375, null, true)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "ring" });
  assert.deepEqual(fit(rowOf(started, 389, null, true)), { toolbar: ["folder", "model"], popup: [], more: false, meter: "full" });
  assert.deepEqual(fit(rowOf(started, 520, null, true)), { toolbar: ["folder", "model", "subagents"], popup: [], more: false, meter: "full" });
});

/** The voice pair (Dictate and Speech mode) as one child of the row: two buttons the width of the insert button and the gap between. */
const PAIR = 2 * INSERT + gap;
const tail = (r: Row, held = { insert: false, voice: false }, w: { insert?: number; voice?: number } = { insert: INSERT, voice: PAIR }) => fitWithTail(r, w, held);
const free = { insert: false, voice: false };

test("the voice pair is in the row where the row has room for it with every control where it is without it, and takes nothing from them", () => {
  let inRow = 0, inPopup = 0;
  for (const [id, s] of chats) {
    for (let box = 150; box <= 1000; box++) {
      const r = rowOf(s, box), { fit: f, insert, voice } = tail(r), at = `${id} at ${box}`, plain = fit(r);
      // the pair is in the row exactly where the row, placed with it and its gap, has room for it
      const room = needs(r, plain) + PAIR + gap <= r.room + 1e-6;
      assert.equal(voice === "row", room && fitWithInsert(r, PAIR).insert === "row", at);
      if (voice === "row") {
        inRow++;
        // every control and the meter are where they are without the pair, and the row, with the pair and what is drawn beside it, fits
        assert.deepEqual(f, fit({ ...r, fixed: [PAIR, ...r.fixed] }), at);
        assert.deepEqual(f.popup, plain.popup, at);
        assert.equal(f.meter, plain.meter, at);
        assert.equal(f.more, plain.more, at);
        const drawn = needs({ ...r, fixed: [PAIR, ...(insert === "row" ? [INSERT] : []), ...r.fixed] }, f);
        assert.ok(drawn <= r.room + 1e-6, `${at}: needs ${drawn} of ${r.room}`);
        // the insert button gives way first: it is in the row only where the row has room for it beside the pair
        assert.equal(insert === "row", needs({ ...r, fixed: [PAIR, ...r.fixed] }, f) + INSERT + gap <= r.room + 1e-6, at);
        if (insert !== "row") assert.equal(insert, f.more ? "more" : "", at);
      } else {
        inPopup++;
        // in the popup as two entries; the chip is there, and the button's entry is in the popup too
        assert.equal(f.more, true, at);
        assert.equal(insert, "more", at);
        // the controls are where they are without the pair, unless the chip it brought took room that the row needed
        if (plain.more) assert.deepEqual(f, plain, at);
        else assert.ok(f.popup.length > 0 || f.meter === plain.meter || needs(r, f) <= r.room + 1e-6, at);
        assert.ok(needs(r, f) <= r.room + 1e-6 || f.popup.length === r.controls.length, `${at}: needs ${needs(r, f)} of ${r.room}`);
      }
    }
  }
  assert.ok(inRow > 0 && inPopup > 0, `${inRow} in the row, ${inPopup} in the popup`);
  for (const [id, s] of chats) assert.deepEqual(tail(rowOf(s, 1000)), { fit: { toolbar: rowOf(s, 1000).controls.map((c) => c.id), popup: [], more: false, meter: "full" }, insert: "row", voice: "row" }, `${id}: on a wide page`);
});

test("narrower than room for both, the insert button gives way and the pair stays in the row", () => {
  let seen = 0;
  for (const [id, s] of chats) {
    for (let box = 150; box <= 1000; box++) {
      const r = rowOf(s, box), t = tail(r), at = `${id} at ${box}`;
      if (t.voice === "row" && t.insert !== "row") {
        seen++;
        // the button is in the popup when the row has the chip, else nowhere; the pair is in the row
        assert.equal(t.insert, t.fit.more ? "more" : "", at);
        assert.deepEqual(t.fit, fit({ ...r, fixed: [PAIR, ...r.fixed] }), at);
      }
      // the pair never gives way to the button: where the button is in the row, the pair is too
      if (t.insert === "row") assert.equal(t.voice, "row", at);
    }
  }
  assert.ok(seen > 0, "no state of the fixture has room for the pair and none for the button");
  // a whole row of short names: the button needs 30 px more than the pair
  const s = fixture.states["board-started"], whole = rowOf(s, 375 + 14);
  assert.equal(fitWithInsert(whole, INSERT).insert, "", "(the row is whole, and has no room for the button)");
  const roomForPair = rowOf(s, Math.ceil(needs(whole, fit(whole)) + PAIR + gap + chrome) + 0);
  assert.deepEqual(tail(roomForPair), { fit: fit({ ...roomForPair, fixed: [PAIR, ...roomForPair.fixed] }), insert: "", voice: "row" });
});

test("narrower still, the pair is two entries of the \"more\" popup and brings the chip, with no control in it where all of them fit", () => {
  // a whole row with the chip's room but not the pair's
  const s = fixture.states["board-started"], whole = rowOf(s, 2000), base = needs(whole, fit(whole)) + chrome;
  const box = Math.ceil(base + MORE + gap + 1); // (the chip fits; the pair, wider than the chip, does not)
  assert.ok(PAIR > MORE, "the pair is wider than the chip");
  const r = rowOf(s, box), t = tail(r);
  assert.deepEqual(t, { fit: { toolbar: fit(r).toolbar, popup: [], more: true, meter: "full" }, insert: "more", voice: "more" });
  assert.equal(needs(r, t.fit) <= r.room + 1e-6, true);
  // the chip needs room that the row does not have: a control goes to the popup for it, as in any fit
  const tight = rowOf(s, Math.ceil(base) + 2), u = tail(tight);
  assert.equal(u.voice, "more");
  assert.equal(u.insert, "more");
  assert.equal(u.fit.more, true);
  assert.ok(needs(tight, u.fit) <= tight.room + 1e-6 || u.fit.popup.length === tight.controls.length);
  assert.ok(u.fit.popup.length > 0 || u.fit.meter === "ring", "the chip took the room of the meter's text or of a control");
  // a row that already has the chip is as it is without the pair
  const narrow = rowOf(fixture.states["plain-started"], 260);
  assert.deepEqual(tail(narrow), { fit: fit(narrow), insert: "more", voice: "more" });
});

test("the chip the pair brings costs the meter its text only where the chip does not fit beside it, and no control leaves for it then", () => {
  // A started chat beside a board (a 430 px panel is a row of 385 px): the row is whole with the meter's text and has less to spare than the pair
  // is wide, and than the chip is (28 px and a gap). The pair goes into the popup; the chip takes the room of the text, which is the first to go.
  const s = fixture.states["board-started"], bare = rowOf(s, 2000), whole = needs(bare, fit(bare));
  const row430 = rowOf(s, 385 + chrome);
  assert.equal(fit(row430).meter, "full", "(without voice the row keeps the text at 430 px)");
  assert.ok(needs(row430, fit(row430)) + PAIR + gap > row430.room, "(the pair does not fit beside the controls)");
  assert.ok(needs(row430, fit(row430)) + MORE + gap > row430.room, "(nor the chip beside the text)");
  assert.deepEqual(tail(row430), { fit: { toolbar: ["folder", "model"], popup: [], more: true, meter: "ring" }, insert: "more", voice: "more" });
  // with the chip's room to spare (one px less is the ring): the pair is in the popup with the text kept, and not a control in it
  const fits = rowOf(s, Math.ceil(whole + MORE + gap + chrome));
  assert.deepEqual(tail(fits), { fit: { toolbar: ["folder", "model"], popup: [], more: true, meter: "full" }, insert: "more", voice: "more" });
  assert.deepEqual(tail({ ...fits, room: fits.room - 1 }).fit.meter, "ring");
  // everywhere the row had no chip and the pair is in the popup: the meter has its text exactly where the row with the chip has room for it,
  // and a control leaves only where the ring alone does not make room (as in any fit with the chip)
  let seen = 0;
  for (const [id, x] of chats) {
    for (let box = 150; box <= 1000; box++) {
      const r = rowOf(x, box), t = tail(r), at = `${id} at ${box}`;
      if (t.voice !== "more" || fit(r).more) continue;
      seen++;
      const withChip = fit({ ...r, fixed: [r.more, ...r.fixed] });
      assert.deepEqual({ ...t.fit, more: true }, { ...withChip, more: true }, at);
      assert.equal(t.fit.meter === "full", needs({ ...r, fixed: [MORE, ...r.fixed] }, { ...withChip, meter: "full" }) <= r.room + 1e-6 && withChip.popup.length === 0, at);
      if (fit(r).popup.length === 0 && withChip.popup.length === 0) assert.equal(t.fit.popup.length, 0, `${at}: no control leaves where the ring makes room for the chip`);
    }
  }
  assert.ok(seen > 0);
});

test("while the popup is open it keeps the pair, however wide the row, as it keeps a control; and a popup that lost what it held keeps nothing", () => {
  const s = fixture.states["plain-new"], held = fit(rowOf(s, 260)).popup;
  assert.ok(held.length > 0);
  for (let box = 260; box <= 1000; box += 20) {
    const r = rowOf(s, box, held), t = tail(r, { insert: false, voice: true });
    assert.equal(t.voice, "more", `at ${box}`);
    assert.equal(t.fit.more, true, `at ${box}`);
    assert.deepEqual(t.fit.popup, held, `at ${box}: nothing returns`);
    // the button is in the row with the pair gone from it, where the row has room: it was in the row before
    assert.equal(tail(r, { insert: true, voice: false }).insert, "more", `at ${box}`);
  }
  // the pair held with the chip not there: the popup is closed with nothing in it, the pair returns
  assert.equal(tail(rowOf(s, 1000), { insert: false, voice: true }).voice, "row");
  assert.equal(tail(rowOf(s, 1000), { insert: true, voice: true }).voice, "row");
  // the pair that was in the row stays there with the popup open, held by something else
  assert.equal(tail(rowOf(s, 1000, held), free).voice, "row");
  // the button held in the popup stays there; the pair is in the row
  const t = tail(rowOf(s, 1000, held), { insert: true, voice: false });
  assert.deepEqual([t.voice, t.insert], ["row", "more"]);
});

test("a pair whose width is not known is drawn in the row, to be measured, and the button with it where it has room", () => {
  for (const box of [150, 300, 800]) {
    const r = rowOf(fixture.states["plain-new"], box), t = tail(r, free, { insert: INSERT });
    assert.equal(t.voice, "row", `at ${box}`);
    // it counts nothing: the others are as they are without it
    assert.deepEqual(t.fit, fitWithInsert(r, INSERT).fit, `at ${box}`);
    assert.equal(t.insert, fitWithInsert(r, INSERT).insert, `at ${box}`);
  }
  // nothing is measured yet: every control is in the toolbar, the button and the pair with them
  const r = rowOf(fixture.states["plain-new"], 300), none: Row = { ...r, controls: r.controls.map((c) => ({ id: c.id })), meter: {}, more: undefined, fixed: [undefined] };
  assert.deepEqual(fitWithTail(none, {}, free), { fit: { toolbar: r.controls.map((c) => c.id), popup: [], more: false, meter: "full" }, insert: "row", voice: "row" });
});

test("the optional chip gives way to the pair, and the pair to nothing but the controls", () => {
  const started = Object.entries(fixture.states).find(([, x]) => x.controls.some(spare))!;
  const bare = rowOf(started[1], 2000), whole = needs(bare, fit(bare)) + chrome;
  const at = (box: number) => { const t = tail(rowOf(started[1], box, null, true)); return [t.voice, t.insert, t.fit.toolbar.includes("subagents")]; };
  assert.deepEqual(at(Math.ceil(whole + PAIR + gap)), ["row", "", false]);
  assert.deepEqual(at(Math.ceil(whole + PAIR + gap + INSERT + gap)), ["row", "row", false]);
  // with the chip, the others are where fit puts them
  for (let box = 260; box <= 1000; box += 3) {
    const r = rowOf(started[1], box, null, true), f = tail(r).fit, plain = fit(r), firm = (x: Fit) => [x.meter, x.toolbar.filter((c) => c !== "subagents"), x.popup.filter((c) => c !== "subagents")];
    if (tail(r).voice === "row") assert.deepEqual(firm(f), firm(plain), `${started[0]} at ${box}`);
  }
});

test("the optional chip goes to the popup where the pair brought the \"more\" chip: a choice is not left out of both", () => {
  const started = Object.entries(fixture.states).find(([, x]) => x.controls.some(spare))!;
  let inPopup = 0;
  for (let box = 150; box <= 1000; box++) {
    const r = rowOf(started[1], box, null, true), t = tail(r), at = `${started[0]} at ${box}`;
    if (t.voice !== "more") continue;
    inPopup++;
    assert.ok(t.fit.more, at);
    // in the toolbar or in the popup, never in neither
    assert.ok(t.fit.toolbar.includes("subagents") || t.fit.popup.includes("subagents"), at);
    assert.deepEqual(t.fit.popup, CONTROLS.filter((id) => t.fit.popup.includes(id)), `${at}: in the order of CONTROLS`);
  }
  assert.ok(inPopup > 0, "the pair is in the popup at some width");
});
