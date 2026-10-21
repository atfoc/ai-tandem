// The rules of the stand-in devices (devices.mjs; plans/voice-devices/architecture.md VD-19 item 3), run on the layer's own page script in a fake global
// (Node: no browser). Run: `node --test dev/checks/devices.test.mjs` (`cd web && npm test` runs it too). The page that the checks see is the same script,
// installed through addInitScript; web/dev/checks/VC.8-devices.mjs (later) proves it in Chromium.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STANDIN_DEVICES, deviceLayer, installDevices } from "./devices.mjs";

const tick = () => new Promise((ok) => setTimeout(ok, 5));

class FakeTrack extends EventTarget {
  readyState = "live";
  stop() { this.readyState = "ended"; }
  getSettings() { return { sampleRate: 48000 }; }
}
class FakeContext {
  static made = [];
  state = "suspended";
  closed = false;
  constructor(options) { this.options = options; FakeContext.made.push(this); }
  async resume() { this.state = "running"; }
  async close() { this.closed = true; this.state = "closed"; }
  createOscillator() { const osc = { frequency: { value: 0 }, started: false, stopped: false, connect() {}, start() { osc.started = true; }, stop() { osc.stopped = true; } }; this.osc = osc; return osc; }
  createMediaStreamDestination() { const track = new FakeTrack(); this.track = track; return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } }; }
  async setSinkId() { throw new Error("the real setSinkId is never called with a stand-in id"); }
}
class FakeOverconstrained extends Error {
  constructor(constraint, message) { super(message); this.name = "OverconstrainedError"; this.constraint = constraint; }
}

/** A fake page global, with the layer installed. */
function page(config = {}, over = {}) {
  FakeContext.made = [];
  class Ctx extends FakeContext {}
  const store = new Map();
  const g = {
    navigator: { mediaDevices: new EventTarget() },
    AudioContext: Ctx, Event, EventTarget, DOMException, OverconstrainedError: FakeOverconstrained,
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), clear: () => store.clear() },
    ...over,
  };
  deviceLayer({ ...STANDIN_DEVICES, granted: false, persist: true, setSinkId: true, ...config }, g);
  const md = g.navigator.mediaDevices, control = g.__aiwbDevices;
  const changes = [];
  md.addEventListener("devicechange", () => changes.push(Date.now()));
  return { g, md, control, store, changes, ctx: () => new g.AudioContext() };
}

const reject = async (promise) => { try { await promise; } catch (e) { return e; } throw new Error("it did not reject"); };

describe("listing", () => {
  test("one blank entry per kind until the permission is given, then the default entry and each device", async () => {
    const p = page();
    const before = await p.md.enumerateDevices();
    assert.deepEqual(before.map((d) => [d.kind, d.deviceId, d.label, d.groupId]), [["audioinput", "", "", ""], ["audiooutput", "", "", ""]]);
    p.control.grant();
    assert.equal(p.control.granted(), true);
    const after = await p.md.enumerateDevices();
    assert.deepEqual(after.map((d) => [d.kind, d.deviceId, d.label]), [
      ["audioinput", "default", "Default - Desk Mic"], ["audioinput", "mic-desk", "Desk Mic"], ["audioinput", "mic-headset", "Stand-in Headset"],
      ["audiooutput", "default", "Default - Desk Speakers"], ["audiooutput", "out-desk", "Desk Speakers"], ["audiooutput", "out-headphones", "Stand-in Headphones"],
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(after[1])), { deviceId: "mic-desk", kind: "audioinput", label: "Desk Mic", groupId: "group-mic-desk" });
  });

  test("list() is the devices themselves, granted or not, with the tones and without the default entry", () => {
    const p = page();
    assert.deepEqual(p.control.list(), [
      { kind: "input", id: "mic-desk", label: "Desk Mic", groupId: "group-mic-desk", hz: 300 },
      { kind: "input", id: "mic-headset", label: "Stand-in Headset", groupId: "group-mic-headset", hz: 700 },
      { kind: "output", id: "out-desk", label: "Desk Speakers", groupId: "group-out-desk" },
      { kind: "output", id: "out-headphones", label: "Stand-in Headphones", groupId: "group-out-headphones" },
    ]);
  });

  test("granted: true at the start; a kind with no device lists nothing; every enumerateDevices is counted", async () => {
    const p = page({ granted: true, outputs: [] });
    assert.deepEqual((await p.md.enumerateDevices()).map((d) => d.kind), ["audioinput", "audioinput", "audioinput"]);
    await p.md.enumerateDevices();
    assert.deepEqual(p.control.calls(), { enumerateDevices: 2, getUserMedia: 0, setSinkId: 0 });
  });

  test("plug adds a device and fires devicechange; a repeated id is refused; unplug removes it and fires devicechange", async () => {
    const p = page({ granted: true });
    p.control.plug({ kind: "input", id: "mic-usb", label: "USB Mic", hz: 900 });
    p.control.plug({ kind: "audiooutput", id: "out-usb", label: "USB Speaker" });
    await tick();
    assert.equal(p.changes.length, 2);
    assert.equal((await p.md.enumerateDevices()).filter((d) => d.deviceId === "mic-usb" || d.deviceId === "out-usb").length, 2);
    assert.throws(() => p.control.plug({ kind: "input", id: "mic-usb", label: "Again" }), /already/);
    assert.throws(() => p.control.plug({ kind: "input", id: "x" }), /needs a kind/);
    assert.equal(p.control.unplug("mic-usb"), true);
    assert.equal(p.control.unplug("mic-usb"), false);
    await tick();
    assert.equal(p.changes.length, 3, "an unplug of nothing fires nothing");
    assert.ok(!(await p.md.enumerateDevices()).some((d) => d.deviceId === "mic-usb"));
  });

  test("the default entry follows the first device of the kind", async () => {
    const p = page({ granted: true });
    p.control.unplug("mic-desk");
    const inputs = (await p.md.enumerateDevices()).filter((d) => d.kind === "audioinput");
    assert.deepEqual(inputs.map((d) => d.label), ["Default - Stand-in Headset", "Stand-in Headset"]);
  });

  test("grant() fires no devicechange (Chromium fires none on a permission)", async () => {
    const p = page();
    p.control.grant();
    await tick();
    assert.equal(p.changes.length, 0);
  });
});

describe("getUserMedia", () => {
  test("no deviceId: the first microphone, at its tone; the track has its label and settings; the open is recorded", async () => {
    const p = page({ granted: true });
    const stream = await p.md.getUserMedia({ audio: true });
    const [track] = stream.getAudioTracks();
    assert.equal(track.label, "Desk Mic");
    assert.deepEqual([track.getSettings().deviceId, track.getSettings().groupId, track.getSettings().sampleRate], ["default", "group-mic-desk", 48000]);
    assert.equal(FakeContext.made[0].osc.frequency.value, 300);
    assert.equal(FakeContext.made[0].osc.started, true);
    assert.deepEqual(p.control.opened(), [{ requested: null, deviceId: "mic-desk", label: "Desk Mic", hz: 300, live: true }]);
  });

  test("exact, ideal, a string and a list ask for a device by id; the track's settings give the id asked for", async () => {
    const p = page({ granted: true });
    const hzOf = async (audio) => { const s = await p.md.getUserMedia({ audio }); return [FakeContext.made.at(-1).osc.frequency.value, s.getAudioTracks()[0].getSettings().deviceId]; };
    assert.deepEqual(await hzOf({ deviceId: { exact: "mic-headset" } }), [700, "mic-headset"]);
    assert.deepEqual(await hzOf({ deviceId: "mic-headset" }), [700, "mic-headset"]);
    assert.deepEqual(await hzOf({ deviceId: { ideal: ["nobody", "mic-headset"] } }), [700, "mic-headset"]);
    assert.deepEqual(await hzOf({ deviceId: { ideal: "nobody" } }), [300, "default"], "an ideal id nobody has gives the default");
    assert.deepEqual(await hzOf({ deviceId: { exact: ["nobody", "mic-desk"] } }), [300, "mic-desk"]);
    assert.deepEqual(await hzOf({ deviceId: { exact: "default" } }), [300, "default"]);
    assert.deepEqual(await hzOf({ deviceId: { exact: "communications" } }), [300, "communications"]);
    assert.equal(p.control.opened().length, 7);
  });

  test("an exact id nobody has is an OverconstrainedError and opens nothing; no microphone and video are NotFoundError; nothing asked is a TypeError", async () => {
    const p = page({ granted: true });
    const e = await reject(p.md.getUserMedia({ audio: { deviceId: { exact: "gone" } } }));
    assert.equal(e.name, "OverconstrainedError");
    assert.equal(e.constraint, "deviceId");
    assert.equal(FakeContext.made.length, 0);
    assert.deepEqual(p.control.opened(), []);
    assert.equal((await reject(p.md.getUserMedia({ audio: true, video: true }))).name, "NotFoundError");
    assert.equal((await reject(p.md.getUserMedia({}))).name, "TypeError");
    p.control.unplug("mic-desk");
    p.control.unplug("mic-headset");
    assert.equal((await reject(p.md.getUserMedia({ audio: true }))).name, "NotFoundError");
    assert.equal(p.control.calls().getUserMedia, 4);
  });

  test("a success gives the permission, as a browser does", async () => {
    const p = page();
    assert.equal(p.control.granted(), false);
    await p.md.getUserMedia({ audio: true });
    assert.equal(p.control.granted(), true);
    assert.equal((await p.md.enumerateDevices()).length, 6);
  });

  test("unplugging a device ends its live tracks (stopped, an ended event), not the others', and fires devicechange", async () => {
    const p = page({ granted: true });
    const desk = (await p.md.getUserMedia({ audio: { deviceId: { exact: "mic-desk" } } })).getAudioTracks()[0];
    const headset = (await p.md.getUserMedia({ audio: { deviceId: { exact: "mic-headset" } } })).getAudioTracks()[0];
    const viaDefault = (await p.md.getUserMedia({ audio: true })).getAudioTracks()[0];
    const ended = [];
    for (const [name, t] of Object.entries({ desk, headset, viaDefault })) t.addEventListener("ended", () => ended.push(name));
    p.control.unplug("mic-desk");
    await tick();
    assert.deepEqual(ended, ["desk", "viaDefault"], "the default request was the desk microphone too");
    assert.deepEqual([desk.readyState, headset.readyState], ["ended", "live"]);
    assert.deepEqual(p.control.opened().map((o) => o.live), [false, true, false]);
    assert.equal(FakeContext.made[0].osc.stopped, true);
    assert.equal(FakeContext.made[0].closed, true);
    assert.equal(FakeContext.made[1].closed, false);
    assert.equal(p.changes.length, 1);
  });

  test("track.stop() stops the sound and sends no ended event (a browser sends none either)", async () => {
    const p = page({ granted: true });
    const track = (await p.md.getUserMedia({ audio: true })).getAudioTracks()[0];
    let ended = 0;
    track.addEventListener("ended", () => { ended++; });
    track.stop();
    track.stop();
    p.control.unplug("mic-desk");
    await tick();
    assert.equal(ended, 0);
    assert.equal(track.readyState, "ended");
    assert.equal(p.control.opened()[0].live, false);
    assert.equal(FakeContext.made[0].osc.stopped, true);
  });
});

describe("setSinkId", () => {
  test("the default, none, and the listed outputs resolve; an unknown id rejects NotFoundError; sinkId reads back; the calls are recorded", async () => {
    const p = page({ granted: true });
    const ctx = p.ctx();
    assert.equal(ctx.sinkId, "");
    await ctx.setSinkId("out-headphones");
    assert.equal(ctx.sinkId, "out-headphones");
    await ctx.setSinkId("");
    assert.equal(ctx.sinkId, "");
    await ctx.setSinkId("default");
    await ctx.setSinkId({ type: "none" });
    assert.deepEqual(ctx.sinkId, { type: "none" });
    const e = await reject(ctx.setSinkId("not-there"));
    assert.equal(e.name, "NotFoundError");
    assert.deepEqual(ctx.sinkId, { type: "none" }, "a refused id changes nothing");
    assert.equal((await reject(ctx.setSinkId(7))).name, "TypeError");
    assert.equal((await reject(ctx.setSinkId("mic-desk"))).name, "NotFoundError", "an input is no output");
    assert.deepEqual(p.control.sinks().map((s) => s.calls), [["out-headphones", "", "default", "none", "not-there", "(not an id)", "mic-desk"]]);
    assert.equal(p.control.calls().setSinkId, 7);
  });

  test("before the permission a listed id is not known: it rejects NotFoundError; the default still resolves", async () => {
    const p = page();
    const ctx = p.ctx();
    assert.equal((await reject(ctx.setSinkId("out-desk"))).name, "NotFoundError");
    await ctx.setSinkId("");
    p.control.grant();
    await ctx.setSinkId("out-desk");
    assert.equal(ctx.sinkId, "out-desk");
  });

  test("sinks() lists the page's contexts in the order made, with their state, sink, default and gone; the stand-in's own contexts are left out", async () => {
    const p = page({ granted: true });
    const a = p.ctx(), b = p.ctx();
    await b.setSinkId("out-headphones");
    await p.md.getUserMedia({ audio: true });
    await a.resume();
    assert.deepEqual(p.control.sinks(), [
      { index: 0, state: "running", sinkId: "", default: true, gone: false, calls: [] },
      { index: 1, state: "suspended", sinkId: "out-headphones", default: false, gone: false, calls: ["out-headphones"] },
    ]);
  });

  test("an unplugged output leaves the context's sink as it was and the record says gone; devicechange; setSinkId('') brings it back; a plug back does not move it", async () => {
    const p = page({ granted: true });
    const ctx = p.ctx();
    await ctx.setSinkId("out-headphones");
    p.control.unplug("out-headphones");
    await tick();
    assert.equal(p.changes.length, 1);
    assert.equal(ctx.sinkId, "out-headphones");
    assert.deepEqual(p.control.sinks().map((s) => [s.sinkId, s.default, s.gone]), [["out-headphones", false, true]]);
    assert.equal((await reject(ctx.setSinkId("out-headphones"))).name, "NotFoundError");
    await ctx.setSinkId("");
    assert.deepEqual(p.control.sinks().map((s) => [s.sinkId, s.default, s.gone]), [["", true, false]]);
    p.control.plug({ kind: "output", id: "out-headphones", label: "Stand-in Headphones" });
    assert.equal(ctx.sinkId, "", "a device that comes back moves nothing");
  });

  test("a sinkId in the constructor is recorded; setSinkId: false leaves the page without the method", () => {
    const p = page({ granted: true });
    const ctx = new p.g.AudioContext({ sinkId: "out-desk" });
    assert.equal(ctx.sinkId, "out-desk");
    assert.deepEqual(p.control.sinks()[0].calls, ["out-desk"]);
    class Bare { setSinkId = undefined; }
    Bare.prototype.setSinkId = async () => {};
    const none = page({ setSinkId: false }, { AudioContext: Bare });
    assert.equal(typeof none.g.AudioContext.prototype.setSinkId, "undefined");
    assert.ok(new none.g.AudioContext() instanceof Bare);
  });
});

describe("state", () => {
  test("a reload finds the devices, the permission and the unplugging as they were left; a different setup starts anew; persist: false never keeps", async () => {
    const first = page();
    first.control.grant();
    first.control.plug({ kind: "input", id: "mic-usb", label: "USB Mic" });
    first.control.unplug("out-desk");
    const again = page({}, { sessionStorage: first.g.sessionStorage });
    assert.equal(again.control.granted(), true);
    assert.deepEqual(again.control.list().map((d) => d.id), ["mic-desk", "mic-headset", "out-headphones", "mic-usb"]);
    const other = page({ inputs: [{ id: "x", label: "X" }], outputs: [] }, { sessionStorage: first.g.sessionStorage });
    assert.deepEqual(other.control.list().map((d) => d.id), ["x"]);
    assert.equal(other.control.granted(), false);
    const loose = page({ persist: false }, { sessionStorage: first.g.sessionStorage });
    assert.equal(loose.control.list().length, 4);
    loose.control.grant();
    assert.equal(page({}, { sessionStorage: first.g.sessionStorage }).control.granted(), false, "the loose page wrote nothing: the last setup was the other one");
  });

  test("counts and records are of the document: a reload starts them at zero", async () => {
    const first = page({ granted: true });
    await first.md.enumerateDevices();
    await first.md.getUserMedia({ audio: true });
    const again = page({}, { sessionStorage: first.g.sessionStorage });
    assert.deepEqual(again.control.calls(), { enumerateDevices: 0, getUserMedia: 0, setSinkId: 0 });
    assert.deepEqual(again.control.opened(), []);
  });

  test("the layer is installed once, logs nothing, and works with no sessionStorage", () => {
    const p = page({}, { sessionStorage: undefined });
    const control = p.control;
    deviceLayer({ inputs: [], outputs: [] }, p.g);
    assert.equal(p.g.__aiwbDevices, control, "a second run (another frame's script, a second addInitScript) changes nothing");
    const seen = [];
    const log = console.log;
    console.log = (...a) => seen.push(a);
    try { page({ granted: true }).control.plug({ kind: "input", id: "mic-usb", label: "USB Mic" }); } finally { console.log = log; }
    assert.deepEqual(seen, []);
  });

  test("a page with no navigator.mediaDevices gets one", async () => {
    const p = page({ granted: true }, { navigator: {} });
    assert.equal((await p.g.navigator.mediaDevices.enumerateDevices()).length, 6);
  });
});

describe("installDevices", () => {
  test("hands the layer and its options to addInitScript of a page or a context, with the stand-in devices as the default", async () => {
    const calls = [];
    const target = { addInitScript: async (fn, arg) => { calls.push([fn, arg]); } };
    await installDevices(target);
    await installDevices(target, { inputs: [{ id: "a", label: "A" }], outputs: [], granted: true, persist: false, setSinkId: false });
    assert.equal(calls[0][0], deviceLayer);
    assert.deepEqual(calls[0][1], { ...STANDIN_DEVICES, granted: false, persist: true, setSinkId: true });
    assert.deepEqual(calls[1][1], { inputs: [{ id: "a", label: "A" }], outputs: [], granted: true, persist: false, setSinkId: false });
  });

  test("the layer survives serialisation: it names nothing outside itself", () => {
    const source = `(${deviceLayer.toString()})`;
    const remade = new Function(`return ${source}`)();
    const g = { navigator: { mediaDevices: new EventTarget() }, EventTarget, Event, DOMException, AudioContext: FakeContext };
    remade({ ...STANDIN_DEVICES, granted: true, persist: false }, g);
    assert.equal(g.__aiwbDevices.list().length, 4);
  });
});
