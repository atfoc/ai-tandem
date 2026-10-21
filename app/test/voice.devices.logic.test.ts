// The pure rules of voice devices (voice-devices architecture VD-4, VD-11, VD-13, VD-15, VD-17) and the stand-in devices that the other tests
// build on (the fake ports' devices, the native module's fake). No audio: the engine's behaviour over these is in voice.devices.engine.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakeAiwbAudio } from "../modules/aiwb-audio/src/fake.ts";
import type { NativeDevice } from "../modules/aiwb-audio/src/AiwbAudio.ts";
import { chimePcm } from "../src/voice/logic/chime.ts";
import {
  PSEUDO_IDS, choicesFor, cutName, fromMediaDevices, matchSaved, noticeText, privacyOfName, shouldPause,
} from "../src/voice/logic/devices.ts";
import type { DeviceChoice, DeviceOption } from "../src/voice/logic/devices.ts";
import { NO_DEVICES, voicePorts } from "../src/voice/ports.ts";
import type { AudioDevice, DeviceAbility, DeviceList, RouteEvent } from "../src/voice/ports.ts";
import { IDLE_SESSION, NOT_READING, noticeStore, resetEngine, updateSettings, settingsStore, waits } from "../src/voice/engine/state.ts";
import * as words from "../src/voice/words.ts";
import { createFakePorts, dev, settle } from "./fixtures/voice/fakeports.ts";

const mic = (id: string, name: string, privacy: AudioDevice["privacy"] = "unknown"): AudioDevice => dev(id, name, "input", privacy);
const out = (id: string, name: string, privacy: AudioDevice["privacy"] = "unknown"): AudioDevice => dev(id, name, "output", privacy);
const PICK: DeviceAbility = { input: "pick", output: "pick", linked: false };

describe("matchSaved (VD-4)", () => {
  const list = [mic("a", "Desk Mic"), mic("b", "Headset Mic"), mic("c", "Desk Mic")];
  it("finds the device with the saved id first, even when another has the saved name", () => {
    assert.equal(matchSaved({ id: "c", name: "Desk Mic" }, list), list[2]);
    assert.equal(matchSaved({ id: "b", name: "Desk Mic" }, list), list[1]);
  });
  it("without the id, finds the first device with the same name (trimmed, case kept)", () => {
    assert.equal(matchSaved({ id: "gone", name: "Desk Mic" }, list), list[0]);
    assert.equal(matchSaved({ id: "gone", name: "  Headset Mic " }, list), list[1]);
    assert.equal(matchSaved({ id: "gone", name: "desk mic" }, list), null, "the case is kept");
  });
  it("is none for a device that is not there, and for an empty list", () => {
    assert.equal(matchSaved({ id: "gone", name: "Other" }, list), null);
    assert.equal(matchSaved({ id: "a", name: "Desk Mic" }, []), null);
  });
  it("does not take a nameless saved device for a nameless listed one", () => {
    assert.equal(matchSaved({ id: "gone", name: "" }, [mic("x", "")]), null);
    assert.equal(matchSaved({ id: "x", name: "" }, [mic("x", "")])?.id, "x");
  });
  it("PSEUDO_IDS are the two the platforms list", () => {
    assert.deepEqual([...PSEUDO_IDS], ["default", "communications"]);
  });
});

describe("privacyOfName (VD-11)", () => {
  it("reads private for headphones, headsets, earbuds, AirPods, hands-free and hearing devices", () => {
    for (const n of ["Bose QC35 Headphones", "USB Headset", "Jabra Evolve2 65 Headset", "Pedja's AirPods Pro", "Galaxy Buds2 Pro", "Earbuds", "EarPods",
      "Hands-Free AG Audio", "Handsfree", "Oticon Hearing Aid", "Stand-in Headphones", "BUDS"]) {
      if (n === "EarPods") continue;   // not a word of the list: unknown
      assert.equal(privacyOfName(n), "private", n);
    }
    assert.equal(privacyOfName("EarPods"), "unknown");
  });
  it("reads public for speakers, displays, HDMI, DisplayPort, TVs and monitors", () => {
    for (const n of ["MacBook Pro Speakers", "Desk Speakers", "Studio Display Speakers", "LG TV", "HDMI Output", "DisplayPort", "Dell Monitor", "Display Audio"]) {
      assert.equal(privacyOfName(n), "public", n);
    }
  });
  it("lets the private words win when both match", () => {
    assert.equal(privacyOfName("Headset Speaker"), "private");
    assert.equal(privacyOfName("Headphones (Speakers)"), "private");
  });
  it("is unknown for anything else, and does not match inside a word", () => {
    for (const n of ["USB Audio Device", "Fake Audio Output 1", "Built-in Output", "", "Scuba Dive Mic", "Subtv"]) assert.equal(privacyOfName(n), "unknown", n);
  });
});

describe("shouldPause (VD-11)", () => {
  const priv = out("p", "Headphones", "private");
  const pub = out("s", "Speakers", "public");
  const unk = out("u", "USB Audio Device", "unknown");
  it("pauses when private or unknown sound would come out of something not known to be private", () => {
    assert.equal(shouldPause(priv, pub), true);
    assert.equal(shouldPause(priv, unk), true);
    assert.equal(shouldPause(priv, null), true);
    assert.equal(shouldPause(unk, pub), true);
    assert.equal(shouldPause(unk, null), true);
  });
  it("treats a lost device that is not known (null) as unknown", () => {
    assert.equal(shouldPause(null, pub), true);
    assert.equal(shouldPause(null, null), true);
  });
  it("does not pause when the sound goes to private listening again", () => {
    assert.equal(shouldPause(priv, out("p2", "Other Headphones", "private")), false);
    assert.equal(shouldPause(unk, priv), false);
    assert.equal(shouldPause(null, priv), false);
  });
  it("does not pause when what went away was a loudspeaker", () => {
    assert.equal(shouldPause(pub, pub), false);
    assert.equal(shouldPause(pub, unk), false);
    assert.equal(shouldPause(pub, null), false);
    assert.equal(shouldPause(pub, priv), false);
  });
});

describe("cutName", () => {
  it("leaves a short name alone and cuts a long one to the limit with an ellipsis", () => {
    assert.equal(cutName("Desk Mic"), "Desk Mic");
    assert.equal(cutName("x".repeat(40)), "x".repeat(40));
    const cut = cutName("x".repeat(41));
    assert.equal(cut, `${"x".repeat(39)}…`);
    assert.equal(Array.from(cut).length, 40);
    assert.equal(cutName("abcdefghij", 5), "abcd…");
  });
  it("does not cut in the middle of a character, nor leave a space before the ellipsis", () => {
    const wide = "\u{1F3A7}".repeat(45);
    assert.equal(Array.from(cutName(wide)).length, 40);
    assert.ok(!cutName(wide).includes("�"));
    assert.equal(cutName(`${"a".repeat(38)} bcdefg`), `${"a".repeat(38)}…`);
  });
});

describe("noticeText (VD-13's table)", () => {
  it("says what was missing at a start, the microphone, the speaker or both", () => {
    assert.equal(noticeText("start-mic", { mic: "Desk Mic" }), "“Desk Mic” isn't connected. Using the system microphone.");
    assert.equal(noticeText("start-speaker", { speaker: "Desk Speakers" }), "“Desk Speakers” isn't connected. Using the system speaker.");
    assert.equal(noticeText("start-both", { mic: "Desk Mic", speaker: "Desk Speakers" }),
      "“Desk Mic” and “Desk Speakers” aren't connected. Using the system's own.");
  });
  it("says what was lost during a session, and the pause", () => {
    assert.equal(noticeText("lost-mic", { device: "Headset" }), "“Headset” was disconnected. Listening with the system microphone.");
    assert.equal(noticeText("lost-speaker", { device: "Headset" }), "“Headset” was disconnected. Speaking through the system speaker.");
    assert.equal(noticeText("paused", { device: "Headset" }), "“Headset” was disconnected. Paused so nothing is played out loud.");
  });
  it("has a sentence for a device whose name is not known (missing, null or blank)", () => {
    for (const device of [undefined, null, "", "   "]) {
      assert.equal(noticeText("lost-mic", { device }), "The microphone was disconnected. Listening with the system microphone.");
      assert.equal(noticeText("lost-speaker", { device }), "The speaker was disconnected. Speaking through the system speaker.");
      assert.equal(noticeText("paused", { device }), "Your headphones were disconnected. Paused so nothing is played out loud.");
    }
    assert.equal(noticeText("start-mic", {}), "The microphone isn't connected. Using the system microphone.");
    assert.equal(noticeText("start-speaker", { speaker: "" }), "The speaker isn't connected. Using the system speaker.");
    assert.equal(noticeText("start-both", { mic: "Desk Mic" }), "The microphone and the speaker aren't connected. Using the system's own.");
  });
  it("cuts a name at 40 characters", () => {
    const long = "H".repeat(60);
    const t = noticeText("lost-mic", { device: long });
    assert.ok(t.startsWith(`“${"H".repeat(39)}…” was disconnected.`), t);
  });
  it("takes every sentence from words.ts", () => {
    assert.equal(noticeText("paused", { device: "X" }), words.NOTICE_PAUSED("X"));
    assert.equal(noticeText("start-mic", { mic: "X" }), words.NOTICE_START_MIC("X"));
  });
});

describe("choicesFor (VD-17)", () => {
  const list = (o: Partial<DeviceList> = {}): DeviceList => ({
    inputs: [mic("a", "Desk Mic"), mic("b", "Stand-in Headset", "private")],
    outputs: [out("s", "Desk Speakers", "public"), out("h", "Stand-in Headphones", "private")],
    hidden: false,
    defaults: { input: null, output: null },
    ...o,
  });
  const none = { mic: null, speaker: null };
  const pick = (c: DeviceChoice) => {
    assert.equal(c.show, "pick");
    return c as Extract<DeviceChoice, { show: "pick" }>;
  };
  const labels = (c: DeviceChoice) => pick(c).options.map((o: DeviceOption) => o.label);

  it("lists System default first, then every device of the kind, with nothing saved selecting System default", () => {
    const c = choicesFor(list(), none, PICK);
    assert.deepEqual(labels(c.mic), ["System default", "Desk Mic", "Stand-in Headset"]);
    assert.deepEqual(labels(c.speaker), ["System default", "Desk Speakers", "Stand-in Headphones"]);
    assert.equal(pick(c.mic).selected, "system");
    assert.deepEqual(pick(c.mic).options.map((o) => o.key), ["system", "d:a", "d:b"]);
    assert.deepEqual(pick(c.mic).options[0], { key: "system", label: "System default", device: null, missing: false });
    assert.deepEqual(pick(c.mic).options[1]!.device, { id: "a", name: "Desk Mic" });
    assert.equal(c.linkedNote, false);
    assert.equal(c.neitherLine, null);
    assert.equal(c.loading, false);
    assert.equal(pick(c.mic).hiddenNote, false);
  });
  it("names the device the system uses now where it is known", () => {
    const c = choicesFor(list({ defaults: { input: mic("a", "Desk Mic"), output: out("s", "Desk Speakers") } }), none, PICK);
    assert.equal(labels(c.mic)[0], "System default (Desk Mic)");
    assert.equal(labels(c.speaker)[0], "System default (Desk Speakers)");
    assert.equal(pick(c.mic).options[0]!.key, "system");
  });
  it("selects the saved device, found by id or by name", () => {
    const byId = choicesFor(list(), { mic: { id: "b", name: "Stand-in Headset" }, speaker: { id: "h", name: "x" } }, PICK);
    assert.equal(pick(byId.mic).selected, "d:b");
    assert.equal(pick(byId.speaker).selected, "d:h");
    const byName = choicesFor(list(), { mic: { id: "old", name: "Stand-in Headset" }, speaker: null }, PICK);
    assert.equal(pick(byName.mic).selected, "d:b", "the listed device's key, not the saved id's");
    assert.equal(pick(byName.mic).options.length, 3, "no extra option");
  });
  it("still shows a saved device that is not listed, last, as not connected and selected, and keeps it as the saved value", () => {
    const saved = { id: "gone", name: "Old Headset" };
    const c = choicesFor(list(), { mic: saved, speaker: null }, PICK);
    const m = pick(c.mic);
    assert.deepEqual(m.options.map((o) => o.label), ["System default", "Desk Mic", "Stand-in Headset", "Old Headset (not connected)"]);
    assert.equal(m.selected, "missing:gone");
    assert.deepEqual(m.options[3], { key: "missing:gone", label: "Old Headset (not connected)", device: saved, missing: true });
    assert.equal(pick(c.speaker).selected, "system");
  });
  it("calls a saved device without a name by a word, not by an empty label", () => {
    const c = choicesFor(list(), { mic: { id: "gone", name: "" }, speaker: null }, PICK);
    assert.equal(pick(c.mic).options.at(-1)!.label, "Saved device (not connected)");
  });
  it("cuts a long name where it is shown (60) and not in the saved value", () => {
    const name = "N".repeat(80);
    const c = choicesFor(list({ inputs: [mic("a", name)] }), { mic: { id: "a", name }, speaker: null }, PICK);
    assert.equal(Array.from(pick(c.mic).options[1]!.label).length, 60);
    assert.equal(pick(c.mic).options[1]!.device!.name, name);
  });
  it("shows System default alone while the list is not read, with loading", () => {
    const c = choicesFor(null, { mic: { id: "a", name: "Desk Mic" }, speaker: null }, PICK);
    assert.equal(c.loading, true);
    assert.deepEqual(labels(c.mic), ["System default"]);
    assert.deepEqual(labels(c.speaker), ["System default"]);
    assert.equal(pick(c.mic).selected, "system");
  });
  it("shows System default alone with the note while the system hides the devices", () => {
    const c = choicesFor(list({ hidden: true, inputs: [], outputs: [] }), none, PICK);
    assert.deepEqual(labels(c.mic), ["System default"]);
    assert.equal(pick(c.mic).hiddenNote, true);
    assert.equal(pick(c.speaker).hiddenNote, true);
    assert.equal(c.loading, false);
  });
  it("gives the line that says the system decides where a kind cannot be picked, and no picker", () => {
    const c = choicesFor(list(), none, { input: "pick", output: "system", linked: false });
    assert.equal(c.speaker.show, "system");
    assert.equal((c.speaker as { line: string }).line, "Follows the system: headphones or a headset when connected, otherwise the speaker.");
    assert.equal(c.mic.show, "pick");
    assert.equal(c.neitherLine, null);
    const m = choicesFor(list(), none, { input: "system", output: "pick", linked: false });
    assert.equal(m.mic.show, "system");
    assert.equal(m.speaker.show, "pick");
  });
  it("gives one line and no picker when neither can be picked, and does not wait for a list", () => {
    const c = choicesFor(null, none, NO_DEVICES.ability);
    assert.equal(c.neitherLine, "Voice uses the system's microphone and speaker. Change them in the system's settings.");
    assert.equal(c.mic.show, "system");
    assert.equal(c.speaker.show, "system");
    assert.equal(c.loading, false);
  });
  it("shows the linked note only where a headset is linked", () => {
    assert.equal(choicesFor(list(), none, { input: "pick", output: "pick", linked: true }).linkedNote, true);
    assert.equal(choicesFor(list(), none, PICK).linkedNote, false);
  });
});

describe("fromMediaDevices", () => {
  const entries = [
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "communications", label: "Communications - Jabra" },
    { kind: "audioinput", deviceId: "i1", label: "MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "i2", label: "Jabra Headset" },
    { kind: "audiooutput", deviceId: "default", label: "Default - MacBook Pro Speakers" },
    { kind: "audiooutput", deviceId: "o1", label: "MacBook Pro Speakers" },
    { kind: "audiooutput", deviceId: "o2", label: "Jabra Headset" },
    { kind: "videoinput", deviceId: "v1", label: "Camera" },
  ];
  it("keeps the devices of one kind in order, without the pseudo-entries and the other kinds", () => {
    assert.deepEqual(fromMediaDevices(entries, "input").map((d) => d.id), ["i1", "i2"]);
    assert.deepEqual(fromMediaDevices(entries, "output").map((d) => d.id), ["o1", "o2"]);
  });
  it("reads privacy from the name and knows nothing is built in", () => {
    assert.deepEqual(fromMediaDevices(entries, "output"), [
      { id: "o1", name: "MacBook Pro Speakers", kind: "output", privacy: "public", builtIn: false },
      { id: "o2", name: "Jabra Headset", kind: "output", privacy: "private", builtIn: false },
    ]);
  });
  it("leaves out the blank entries a browser lists before the microphone is allowed", () => {
    assert.deepEqual(fromMediaDevices([{ kind: "audioinput", deviceId: "", label: "" }, { kind: "audiooutput", deviceId: "", label: "" }], "input"), []);
    assert.deepEqual(fromMediaDevices([], "output"), []);
  });
});

describe("the chime (VD-15)", () => {
  const pcm = chimePcm();
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const dBFS = (n: number) => 20 * Math.log10(n / 32768);
  it("is 0.6 s of 24 kHz mono s16le", () => {
    assert.equal(pcm.byteLength, 24000 * 0.6 * 2);
    assert.equal(samples.length, 14400);
  });
  it("peaks at -12 dBFS and never above", () => {
    const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    assert.ok(Math.abs(dBFS(peak) - -12) < 0.05, `peak ${dBFS(peak)} dBFS`);
  });
  it("has two notes, 660 Hz then 880 Hz, by the zero crossings of each half", () => {
    const crossings = (from: number, to: number) => {
      let n = 0;
      for (let i = from + 1; i < to; i++) if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) n++;
      return n;
    };
    const hz = (from: number, to: number) => (crossings(from, to) / 2) / ((to - from) / 24000);
    assert.ok(Math.abs(hz(1000, 6000) - 660) < 10, String(hz(1000, 6000)));
    assert.ok(Math.abs(hz(8200, 13200) - 880) < 10, String(hz(8200, 13200)));
  });
  it("fades each note in and out in 10 ms, so there is no click", () => {
    assert.equal(samples[0], 0);
    assert.ok(Math.abs(samples[1]!) < 400, "the first samples are quiet");
    assert.ok(Math.abs(samples[7199]!) < 400, "the end of the first note is quiet");
    assert.ok(Math.abs(samples[7200]!) < 400, "the start of the second note is quiet");
    assert.ok(Math.abs(samples[14399]!) < 400, "the end is quiet");
    assert.ok(samples.slice(500, 7000).some((s) => Math.abs(s) > 8000), "the middle of a note is at full level");
  });
  it("is a new array at each call, and the same sound", () => {
    const again = chimePcm();
    assert.notEqual(again, pcm);
    assert.deepEqual(again, pcm);
  });
});

describe("the engine's state for devices", () => {
  it("starts with no pause, no notice and a notice time of 6 s", () => {
    resetEngine();
    assert.equal(IDLE_SESSION.paused, null);
    assert.equal(NOT_READING.paused, false);
    assert.equal(noticeStore.get(), null);
    assert.equal(waits.noticeMs, 6000);
  });
  it("puts the notice and its time back on reset", () => {
    noticeStore.set({ text: "x", where: { kind: "chat", chat: "c" }, at: 1 });
    waits.noticeMs = 10;
    resetEngine();
    assert.equal(noticeStore.get(), null);
    assert.equal(waits.noticeMs, 6000);
  });
  it("tells nobody when a settings patch leaves a saved device as it is, and tells them when it changes", () => {
    resetEngine();
    let told = 0;
    const off = settingsStore.subscribe(() => { told++; });
    updateSettings({ mic: { id: "a", name: "Desk Mic" } });
    assert.equal(told, 1);
    updateSettings({ mic: { id: "a", name: "Desk Mic" } });
    updateSettings({ autoSend: true });
    assert.equal(told, 1, "the same device is no change");
    updateSettings({ mic: null });
    assert.equal(told, 2);
    off();
    resetEngine();
  });
});

describe("the fake ports' devices (VD-19 item 1)", () => {
  const set = () => {
    const f = createFakePorts();
    const d = f.audio.devices;
    d.inputs.push(mic("a", "Desk Mic"), mic("b", "Headset Mic", "private"));
    d.outputs.push(out("s", "Desk Speakers", "public"), out("h", "Headphones", "private"));
    d.defaults = { input: d.inputs[0]!, output: d.outputs[0]! };
    return { f, d, audio: f.audio };
  };
  const start = (audio: ReturnType<typeof set>["audio"], device: { id: string; name: string } | null) =>
    audio.startMic({ chunkMs: 100, echoCancel: true, device, onChunk() {} });

  it("lists what the test set, counts the listings, and tells watchers of a plug and an unplug", async () => {
    const { d } = set();
    let told = 0;
    const off = d.watch(() => { told++; });
    assert.equal((await d.list()).inputs.length, 2);
    assert.equal(d.lists, 1);
    d.plug(mic("c", "Third"));
    assert.equal((await d.list()).inputs.length, 3);
    d.unplug("c");
    assert.equal(told, 2);
    off();
    d.plug(mic("d", "Fourth"));
    assert.equal(told, 2, "unsubscribed");
    assert.equal(d.watching().watch, 0);
  });
  it("answers hidden with nothing listed", async () => {
    const { d } = set();
    d.hidden = true;
    assert.deepEqual(await d.list(), { inputs: [], outputs: [], hidden: true, defaults: { input: null, output: null } });
  });
  it("opens the saved microphone, found by id or by name, and records what was asked", async () => {
    const { d, audio } = set();
    assert.deepEqual((await start(audio, { id: "b", name: "Headset Mic" })).opened, { device: d.inputs[1], missed: false });
    assert.deepEqual((await start(audio, { id: "old", name: "Headset Mic" })).opened, { device: d.inputs[1], missed: false });
    assert.deepEqual((await start(audio, null)).opened, { device: d.defaults.input, missed: false });
    assert.deepEqual(d.opened, [{ id: "b", name: "Headset Mic" }, { id: "old", name: "Headset Mic" }, null]);
    assert.deepEqual(audio.mics[0]!.opened, { device: d.inputs[1], missed: false });
  });
  it("falls back to the default and says missed when the saved device is not there", async () => {
    const { d, audio } = set();
    assert.deepEqual((await start(audio, { id: "gone", name: "Gone" })).opened, { device: d.defaults.input, missed: true });
    assert.deepEqual(await audio.player.useOutput({ id: "gone", name: "Gone" }), { device: d.defaults.output, missed: true });
    assert.deepEqual(await audio.player.useOutput({ id: "h", name: "Headphones" }), { device: d.outputs[1], missed: false });
    assert.deepEqual(await audio.player.useOutput(null), { device: d.defaults.output, missed: false });
    assert.deepEqual(d.used.map((x) => x?.id ?? null), ["gone", "h", null]);
  });
  it("ignores the saved device for a kind the platform cannot pick", async () => {
    const { d, audio } = set();
    d.ability = { input: "system", output: "system", linked: false };
    assert.deepEqual((await start(audio, { id: "gone", name: "Gone" })).opened, { device: d.defaults.input, missed: false });
    assert.deepEqual(await audio.player.useOutput({ id: "gone", name: "Gone" }), { device: d.defaults.output, missed: false });
  });
  it("sends input-lost with the default as the new device when the microphone's device goes, and tells watchers", async () => {
    const { d, audio } = set();
    const seen: RouteEvent[] = [];
    audio.onRoute((e) => seen.push(e));
    await start(audio, { id: "b", name: "Headset Mic" });
    d.unplug("b");
    assert.deepEqual(seen, [{ kind: "input-lost", lost: mic("b", "Headset Mic", "private"), now: d.inputs[0] }]);
    assert.equal(audio.mics[0]!.stopped, false, "capture goes on");
  });
  it("sends input-failed and stops the microphone after failReopen()", async () => {
    const { d, audio } = set();
    const seen: RouteEvent[] = [];
    audio.onRoute((e) => seen.push(e));
    await start(audio, { id: "b", name: "Headset Mic" });
    d.failReopen();
    d.unplug("b");
    assert.deepEqual(seen.map((e) => e.kind), ["input-failed"]);
    assert.equal(audio.mics[0]!.stopped, true);
  });
  it("says nothing about a device that was not in use, or when nothing is in use", async () => {
    const { d, audio } = set();
    const seen: RouteEvent[] = [];
    audio.onRoute((e) => seen.push(e));
    d.unplug("b");
    d.unplug("h");
    await start(audio, null);
    d.unplug("a");   // the default microphone is in use: input-lost
    assert.deepEqual(seen.map((e) => e.kind), ["input-lost"]);
    assert.equal(d.outputDevice, null);
  });
  it("holds a private output that goes to a public one, and not a public one, and not private to private", async () => {
    const { d, audio } = set();
    d.plug(out("h2", "Other Headphones", "private"));
    const seen: RouteEvent[] = [];
    audio.onRoute((e) => seen.push(e));
    await audio.player.useOutput({ id: "h", name: "Headphones" });
    d.unplug("h");
    assert.deepEqual(seen.at(-1), { kind: "output-lost", lost: out("h", "Headphones", "private"), now: d.outputs[0], held: true });
    assert.equal(d.held, true);
    assert.equal(d.holds, 0, "the port's own hold is not the engine's");
    audio.player.stop();
    assert.equal(d.held, false, "stop ends a hold");
    await audio.player.useOutput({ id: "s", name: "Desk Speakers" });
    d.unplug("s", { now: out("x", "Somewhere", "unknown") });
    assert.equal((seen.at(-1) as { held: boolean }).held, false);
    d.defaults.output = d.outputs[0]!;   // the Other Headphones
    await audio.player.useOutput({ id: "h2", name: "Other Headphones" });
    d.plug(out("h3", "Third Headphones", "private"));
    d.unplug("h2", { now: d.outputs.find((o) => o.id === "h3")! });
    assert.equal((seen.at(-1) as { held: boolean }).held, false, "private to private");
  });
  it("lets the test decide held, and send a route event of its own", async () => {
    const { d, audio } = set();
    const seen: RouteEvent[] = [];
    audio.onRoute((e) => seen.push(e));
    await audio.player.useOutput({ id: "s", name: "Desk Speakers" });
    d.unplug("s", { held: true });
    assert.equal((seen[0] as { held: boolean }).held, true);
    d.emit({ kind: "input-failed", lost: null });
    assert.equal(seen.length, 2);
  });
  it("records holds and resumes, keeps writes while held (flagged), and plays nothing until resume()", async () => {
    const { d, audio } = set();
    const events: string[] = [];
    audio.player.on((e) => events.push(e.kind));
    audio.player.hold();
    audio.player.write(new Uint8Array(4));
    audio.player.mark(1);
    await settle();
    assert.deepEqual(audio.writes.map((w) => w.held), [true]);
    assert.deepEqual(events, [], "nothing played, no mark, no drained");
    audio.player.resume();
    await settle();
    assert.deepEqual([d.holds, d.resumes], [1, 1]);
    assert.deepEqual(events, ["mark", "drained"]);
    audio.player.write(new Uint8Array(4));
    assert.equal(audio.writes[1]!.held, false);
  });
  it("is what a port needs: it has an ability and a port of devices", () => {
    const { f } = set();
    assert.deepEqual(f.ports.audio.devices.ability, PICK);
    assert.deepEqual(voicePorts().audio.devices.ability, { input: "system", output: "system", linked: false }, "the ports until a client gives its own: nothing to choose");
  });
});

describe("the native module's fake devices (VD-19 item 2)", () => {
  const native = (id: string, name: string, kind: NativeDevice["kind"], privacy: NativeDevice["privacy"] = "unknown"): NativeDevice =>
    ({ id, name, kind, privacy, builtIn: false });
  const set = () => {
    const f = createFakeAiwbAudio();
    f.permission = "granted";
    f.devices.push(native("i1", "Mic", "input"), native("i2", "Headset", "input", "private"), native("o1", "Speaker", "output", "public"), native("o2", "Headphones", "output", "private"));
    f.defaultInput = "i1";
    f.defaultOutput = "o1";
    const routes: unknown[] = [];
    let devices = 0;
    f.module.addListener("onRoute", (e) => routes.push(e));
    f.module.addListener("onDevices", () => { devices++; });
    return { f, routes, devices: () => devices };
  };
  it("has the ability, lists the devices with the defaults, and leaves the outputs out where the system decides", async () => {
    const { f } = set();
    assert.deepEqual(f.module.deviceAbility(), { input: "pick", output: "pick", linked: false });
    const all = await f.module.listDevices();
    assert.equal(all.devices.length, 4);
    assert.deepEqual([all.defaultInput, all.defaultOutput], ["i1", "o1"]);
    f.ability = { input: "pick", output: "system", linked: false };
    assert.deepEqual((await f.module.listDevices()).devices.map((d) => d.id), ["i1", "i2"]);
  });
  it("opens the input asked for, or the default for null and for one that is gone, and records what was asked", async () => {
    const { f } = set();
    assert.equal((await f.module.startMic(100, true, "i2")).device?.id, "i2");
    assert.equal((await f.module.startMic(100, true, "gone")).device?.id, "i1");
    assert.equal((await f.module.startMic(100, true, null)).device?.id, "i1");
    assert.deepEqual(f.micAsked, ["i2", "gone", null]);
    assert.deepEqual(f.mic, { chunkMs: 100, echoCancel: true, muted: false }, "the microphone's own record is as before");
  });
  it("answers the output it got, and the default for an id that is gone or a platform that decides", async () => {
    const { f } = set();
    assert.equal((await f.module.setOutput("o2")).device?.id, "o2");
    assert.equal((await f.module.setOutput("gone")).device?.id, "o1");
    f.ability = { input: "pick", output: "system", linked: false };
    assert.equal((await f.module.setOutput("o2")).device?.id, "o1");
    f.module.setBuiltInNames({ mic: "Phone microphone", speaker: "Phone speaker" });
    assert.deepEqual(f.builtInNames, { mic: "Phone microphone", speaker: "Phone speaker" });
  });
  it("plug and unplug emit onDevices; the microphone on an unplugged input moves to the default with onRoute", async () => {
    const { f, routes, devices } = set();
    f.plug(native("i3", "Third", "input"));
    assert.equal(devices(), 1);
    await f.module.startMic(100, true, "i2");
    f.unplug("i2");
    assert.equal(devices(), 2);
    assert.deepEqual(routes, [{ kind: "input-lost", lost: native("i2", "Headset", "input", "private"), now: native("i1", "Mic", "input"), held: false }]);
    assert.equal(f.micDevice?.id, "i1");
  });
  it("fails to reopen after failReopen and stops the microphone", async () => {
    const { f, routes } = set();
    await f.module.startMic(100, true, "i2");
    f.failReopen = true;
    f.unplug("i2");
    assert.equal((routes[0] as { kind: string }).kind, "input-failed");
    assert.equal(f.mic, null);
  });
  it("holds a private output that goes away to a public one, and playerResume lets the queue play", async () => {
    const { f, routes } = set();
    await f.module.setOutput("o2");
    f.module.playerWrite(new Uint8Array(4));
    f.unplug("o2");
    assert.deepEqual(routes, [{ kind: "output-lost", lost: native("o2", "Headphones", "output", "private"), now: native("o1", "Speaker", "output", "public"), held: true }]);
    assert.equal(f.held, true);
    const played: string[] = [];
    f.module.addListener("onPlayer", (e) => played.push(e.kind));
    f.play();
    assert.deepEqual(played, [], "held: nothing plays");
    f.module.playerResume();
    f.play();
    assert.deepEqual(played, ["level", "drained"]);
  });
  it("sends a route event of the test's own, and counts the listeners of the device events", () => {
    const { f, routes } = set();
    f.route({ kind: "output-lost", lost: null, now: null, held: false });
    assert.equal(routes.length, 1);
    assert.deepEqual(f.listeningDevices(), { onDevices: 1, onRoute: 1 });
  });
});
