// The composer's logic that needs no screen (package K3): its keys and the decision on Enter, the kept widths of the toolbar, the model's line. Loaded by Node: the files under test have no React and no react-native.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boxAction, enterSends, keyNames, modEnterSends, refKey, sendByKey, sendTitleFor } from "../src/screens/composer/keys.ts";
import { effortLabel, modelLabel, subline } from "../src/screens/composer/model.ts";
import { createWidths, roundDown, roundUp } from "../src/screens/composer/widths.ts";
import { registerBox } from "../src/screens/composer/focus.ts";

const key = (k: string, o: object = {}) => ({ key: k, shiftKey: false, ...o });
const mod = (code: string, o: object = {}) => ({ key: "", code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe("Enter (C-TX-03)", () => {
  it("sends on web, and is a line break on the native boxes, whatever the keyboard", () => {
    assert.equal(enterSends("web"), true);
    assert.equal(enterSends("ios"), false);
    assert.equal(enterSends("android"), false);
  });
  it("sends with Enter where Enter sends, not with Shift+Enter", () => {
    const s = { mention: false, enterSends: true, stoppable: false };
    assert.equal(boxAction(key("Enter"), s), "send");
    assert.equal(boxAction(key("Enter", { shiftKey: true }), s), null);
  });
  it("leaves Enter to the box where it is a line break", () => {
    assert.equal(boxAction(key("Enter"), { mention: false, enterSends: false, stoppable: false }), null);
  });
  it("sends a hardware keyboard's ⌘Enter / Ctrl+Enter on the native boxes only", () => {
    assert.equal(sendByKey(mod("Enter", { metaKey: true }), "ios"), true);
    assert.equal(sendByKey(mod("Enter", { ctrlKey: true }), "android"), true);
    assert.equal(sendByKey(mod("Enter", { metaKey: true }), "web"), false);
    assert.equal(sendByKey(mod("Enter"), "ios"), false);
    assert.equal(sendByKey(mod("Enter", { metaKey: true, shiftKey: true }), "ios"), false);
    assert.equal(sendByKey(mod("KeyL", { metaKey: true }), "ios"), false);
  });
  it("names no key in Send's title where Enter does not send", () => {
    assert.equal(sendTitleFor("Send (Enter)", true), "Send (Enter)");
    assert.equal(sendTitleFor("Send (Enter)", false), "Send");
    assert.equal(sendTitleFor("The agent is working", false), "The agent is working");
  });
});

describe("Enter on the phone (decided by the input, not the OS)", () => {
  const phoneWeb = { mention: false, enterSends: enterSends("web", true), modEnterSends: modEnterSends("web", true), phone: true, stoppable: false };
  const wideWeb = { mention: false, enterSends: enterSends("web", false), modEnterSends: modEnterSends("web", false), phone: false, stoppable: false };
  it("a plain Enter sends only at the wide web layouts", () => {
    assert.equal(enterSends("web", false), true);
    assert.equal(enterSends("web"), true);
    assert.equal(enterSends("web", true), false);
    assert.equal(enterSends("ios", true), false);
    assert.equal(enterSends("android", true), false);
  });
  it("⌘Enter / Ctrl+Enter given to the box send at the phone layout of the web build alone", () => {
    assert.equal(modEnterSends("web", true), true);
    assert.equal(modEnterSends("web", false), false);
    assert.equal(modEnterSends("ios", true), false);
    assert.equal(modEnterSends("android", true), false);
  });
  it("on the phone's web box Enter and Shift+Enter are line breaks, ⌘Enter and Ctrl+Enter send", () => {
    assert.equal(boxAction(key("Enter"), phoneWeb), null);
    assert.equal(boxAction(key("Enter", { shiftKey: true }), phoneWeb), null);
    assert.equal(boxAction(key("Enter", { metaKey: true }), phoneWeb), "send");
    assert.equal(boxAction(key("Enter", { ctrlKey: true }), phoneWeb), "send");
    assert.equal(boxAction(key("Enter", { ctrlKey: true, shiftKey: true }), phoneWeb), null);
  });
  it("at the wide web layouts Enter sends as it did, ⌘Enter too", () => {
    assert.equal(boxAction(key("Enter"), wideWeb), "send");
    assert.equal(boxAction(key("Enter", { metaKey: true }), wideWeb), "send");
    assert.equal(boxAction(key("Enter", { shiftKey: true }), wideWeb), null);
  });
  it("on a native box the key port's ⌘Enter sends; the box itself never sends on Enter", () => {
    const native = { mention: false, enterSends: enterSends("ios", true), modEnterSends: modEnterSends("ios", true), phone: true, stoppable: false };
    assert.equal(boxAction(key("Enter"), native), null);
    assert.equal(sendByKey(mod("Enter", { metaKey: true }), "ios"), true);
  });
  it("with the @ dock open on the phone Return is a line break (a tap picks); the arrows and Tab still work", () => {
    const dock = { ...phoneWeb, mention: true };
    assert.equal(boxAction(key("Enter"), dock), null);
    assert.equal(boxAction(key("Enter", { ctrlKey: true }), dock), "send");
    assert.equal(boxAction(key("ArrowDown"), dock), "next");
    assert.equal(boxAction(key("ArrowUp"), dock), "prev");
    assert.equal(boxAction(key("Tab"), dock), "pick");
    assert.equal(boxAction(key("Escape"), dock), "close");
    assert.equal(boxAction(key("Enter"), { ...dock, enterSends: false, modEnterSends: false }), null);
  });
  it("with the @ list open on the wide layouts Enter picks, as it did", () => {
    assert.equal(boxAction(key("Enter"), { ...wideWeb, mention: true }), "pick");
  });
});

describe("the keys of the box", () => {
  const list = { mention: true, enterSends: true, stoppable: true };
  it("the @ list takes the arrows, Enter, Tab and Esc first", () => {
    assert.equal(boxAction(key("ArrowDown"), list), "next");
    assert.equal(boxAction(key("ArrowUp"), list), "prev");
    assert.equal(boxAction(key("Enter"), list), "pick");
    assert.equal(boxAction(key("Tab"), list), "pick");
    assert.equal(boxAction(key("Escape"), list), "close");
  });
  it("Esc stops the agent only while it can be stopped, and arrows are the box's with no list", () => {
    assert.equal(boxAction(key("Escape"), { mention: false, enterSends: true, stoppable: true }), "stop");
    assert.equal(boxAction(key("Escape"), { mention: false, enterSends: true, stoppable: false }), null);
    assert.equal(boxAction(key("ArrowDown"), { mention: false, enterSends: true, stoppable: true }), null);
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
    assert.deepEqual(keyNames("MacIntel"), { ref: "⌘L", point: "⌘⇧L", insert: "⌘P" });
    assert.deepEqual(keyNames("iPad"), { ref: "⌘L", point: "⌘⇧L", insert: "⌘P" });
    assert.deepEqual(keyNames("Win32"), { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P" });
    assert.deepEqual(keyNames("Android"), { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P" });
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
