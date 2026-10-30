// The composer's logic that needs no screen (package K3): its keys and the decision on Enter and ⌘Enter / Ctrl+Enter, the kept widths of the toolbar, the model's line. Loaded by Node: the files under test have no React and no react-native.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boxAction, keyNames, refKey, sendByKey, sendTitleFor } from "../src/screens/composer/keys.ts";
import { effortLabel, modelLabel, subline } from "../src/screens/composer/model.ts";
import { createWidths, roundDown, roundUp } from "../src/screens/composer/widths.ts";
import { registerBox } from "../src/screens/composer/focus.ts";

const key = (k: string, o: object = {}) => ({ key: k, shiftKey: false, ...o });
const mod = (code: string, o: object = {}) => ({ key: "", code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe("Enter: a line break everywhere, ⌘Enter / Ctrl+Enter send", () => {
  const s = { stoppable: false };
  it("leaves Enter and Shift+Enter to the box (a line break): no state of the box makes Enter send", () => {
    assert.equal(boxAction(key("Enter"), s), null);
    assert.equal(boxAction(key("Enter", { shiftKey: true }), s), null);
    assert.equal(boxAction(key("Enter"), { stoppable: true }), null);
  });
  it("sends with ⌘Enter and Ctrl+Enter given to the box; not with Shift or Alt held too", () => {
    assert.equal(boxAction(key("Enter", { metaKey: true }), s), "send");
    assert.equal(boxAction(key("Enter", { ctrlKey: true }), s), "send");
    assert.equal(boxAction(key("Enter", { metaKey: true, shiftKey: true }), s), null);
    assert.equal(boxAction(key("Enter", { ctrlKey: true, altKey: true }), s), null);
  });
  it("sends whatever the box holds: the decision has no text (a message of quotes or images alone goes; Composer.tsx submit decides)", () => {
    assert.equal(boxAction({ key: "Enter", shiftKey: false, ctrlKey: true }, s), "send");
  });
  it("sends a hardware keyboard's ⌘Enter / Ctrl+Enter through the keys port on the native boxes only (on web the box reports it)", () => {
    assert.equal(sendByKey(mod("Enter", { metaKey: true }), "ios"), true);
    assert.equal(sendByKey(mod("Enter", { ctrlKey: true }), "android"), true);
    assert.equal(sendByKey(mod("Enter", { metaKey: true }), "web"), false);
    assert.equal(sendByKey(mod("Enter", { ctrlKey: true }), "web"), false);
    assert.equal(sendByKey(mod("Enter"), "ios"), false);
    assert.equal(sendByKey(mod("Enter", { metaKey: true, shiftKey: true }), "ios"), false);
    assert.equal(sendByKey(mod("Enter", { metaKey: true, altKey: true }), "ios"), false);
    assert.equal(sendByKey(mod("KeyL", { metaKey: true }), "ios"), false);
  });
  it("names the send key in Send's title, none on the phone's touch Send, and leaves a reason as it is", () => {
    assert.equal(sendTitleFor("Send", keyNames("MacIntel").send), "Send (⌘Enter)");
    assert.equal(sendTitleFor("Send", keyNames("Win32").send), "Send (Ctrl+Enter)");
    assert.equal(sendTitleFor("Send", ""), "Send");
    assert.equal(sendTitleFor("The agent is working", "⌘Enter"), "The agent is working");
  });
});

describe("the keys of the box", () => {
  it("Esc stops the agent only while it can be stopped, and arrows and Tab are the box's", () => {
    assert.equal(boxAction(key("Escape"), { stoppable: true }), "stop");
    assert.equal(boxAction(key("Escape"), { stoppable: false }), null);
    assert.equal(boxAction(key("ArrowDown"), { stoppable: true }), null);
    assert.equal(boxAction(key("Tab"), { stoppable: true }), null);
  });
  it("⌘L and Ctrl+L are the composer's, ⌘⇧L the board's", () => {
    assert.equal(refKey(mod("KeyL", { metaKey: true })), "selection");
    assert.equal(refKey(mod("KeyL", { ctrlKey: true })), "selection");
    assert.equal(refKey(mod("KeyL", { metaKey: true, shiftKey: true })), "point");
    assert.equal(refKey(mod("KeyL", { metaKey: true, altKey: true })), null);
    assert.equal(refKey(mod("KeyL")), null);
    assert.equal(refKey(mod("KeyK", { metaKey: true })), null);
  });
  it("names the keys by platform", () => {
    assert.deepEqual(keyNames("MacIntel"), { ref: "⌘L", point: "⌘⇧L", insert: "⌘P", send: "⌘Enter" });
    assert.deepEqual(keyNames("iPad"), { ref: "⌘L", point: "⌘⇧L", insert: "⌘P", send: "⌘Enter" });
    assert.deepEqual(keyNames("Win32"), { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P", send: "Ctrl+Enter" });
    assert.deepEqual(keyNames("Android"), { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P", send: "Ctrl+Enter" });
  });
});

describe("the kept widths of the toolbar", () => {
  it("keep the first measurement of a key, rounded up to a tenth", () => {
    const w = createWidths(() => 1);
    assert.equal(w.keep("a", 115.61), true);
    assert.equal(w.get("a"), 115.7);
    assert.equal(w.keep("a", 200), false);
    assert.equal(w.get("a"), 115.7);
    assert.equal(w.get("b"), undefined);
    assert.equal(w.count, 1);
  });
  it("drop everything when the zoom changes, and count what is kept again", () => {
    let zoom = 1;
    const w = createWidths(() => zoom);
    w.keep("a", 10); w.keep("b", 20);
    zoom = 1.25;
    assert.equal(w.get("a"), undefined);
    assert.equal(w.keep("a", 12), true);
    assert.equal(w.get("a"), 12);
    assert.equal(w.count, 3);
    assert.deepEqual(w.dump(), { a: 12 });
  });
  it("read a row's width down and a control's up, by a tenth", () => {
    assert.equal(roundDown(355.97), 355.9);
    assert.equal(roundUp(28), 28);
    assert.equal(roundUp(28.0000001), 28);
    assert.equal(roundUp(28.01), 28.1);
  });
});

describe("the model's line", () => {
  const cat = { models: [{ id: "a", label: "Model A", efforts: ["high"] }, { id: "b", label: "Model B" }] } as never;
  it("names the model with its effort, as the catalog labels them", () => {
    assert.equal(modelLabel({ model: "a" }, cat), "Model A");
    assert.equal(modelLabel({ model: "zzz" }, cat), "zzz");
    assert.equal(subline({ model: "a", effort: "high" }, cat), `Model A · ${effortLabel("high", (cat as { models: never[] }).models[0])}`);
    assert.equal(subline({ model: "b", effort: "high" }, cat), "Model B"); // (a model with no efforts has none)
    assert.equal(subline({ model: "a" }, cat), "Model A");
  });
});

describe("where the focus goes", () => {
  it("is the box of the chat registered, and goes with it", () => {
    const calls: string[] = [];
    const off = registerBox("c", { focus: (atEnd) => calls.push(`c ${atEnd}`) });
    off();
    assert.deepEqual(calls, []);
  });
});
