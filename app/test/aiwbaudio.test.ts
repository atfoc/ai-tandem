// The audio port over the aiwb-audio module (architecture VC-8): the adapter over the module's fake (the module loaded on first use, the
// permission asked once, chunks passed through untouched, mute, stop, the player's events, the clip, an interruption, a build without the
// module), and the contract of src/AiwbAudio.ts against the Swift and the Kotlin sources (every function, every event, the error code).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MIC_BLOCKED, type AiwbAudioModule, type NativeDevice } from "../modules/aiwb-audio/src/AiwbAudio.ts";
import { createFakeAiwbAudio } from "../modules/aiwb-audio/src/fake.ts";
import { audioOver } from "../src/voice/platform/audio.native.ts";
import { VoiceProblemError, type PlayerEvent, type RouteEvent } from "../src/voice/ports.ts";
import { BUILTIN_MIC_NAME, BUILTIN_SPEAKER_NAME } from "../src/voice/words.ts";

const read = (file: string) => fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

/** A port over a fresh fake, and what the mic gave it. */
function setUp(o: { permission?: "granted" | "denied" | "undetermined"; answer?: "granted" | "denied"; echo?: boolean } = {}) {
  const fake = createFakeAiwbAudio();
  fake.permission = o.permission ?? "granted";
  fake.answer = o.answer ?? "granted";
  fake.echoAvailable = o.echo ?? true;
  const port = audioOver(fake.module);
  const chunks: [string, number][] = [];
  const onChunk = (b64: string, level: number) => { chunks.push([b64, level]); };
  return { fake, port, chunks, onChunk };
}

test("the module is loaded on the first call that needs it, once, and not when the port is made, listened to or stopped", async () => {
  const fake = createFakeAiwbAudio();
  let loads = 0;
  const port = audioOver(() => { loads++; return fake.module; });
  const offPlayer = port.player.on(() => {});
  const offInterrupted = port.onInterrupted(() => {});
  port.player.stop(); // nothing can be playing yet
  assert.equal(loads, 0);
  assert.deepEqual(fake.listening(), { onMic: 0, onPlayer: 0, onInterrupted: 0 });
  assert.equal(await port.micPermission(), "undetermined");
  await port.micPermission();
  assert.equal(loads, 1);
  assert.deepEqual(fake.listening(), { onMic: 1, onPlayer: 1, onInterrupted: 1 }, "one listener of each event, however many handlers");
  assert.deepEqual(fake.calls, ["setBuiltInNames", "micPermission", "micPermission"], "asking for the permission's state does not ask the person");
  port.player.stop();
  assert.deepEqual(fake.calls.at(-1), "playerStop", "once loaded, a stop reaches the module");
  offPlayer();
  offInterrupted();
});

test("startMic asks the person when undetermined, then starts 16 kHz chunks of chunkMs; the base64 reaches the listener untouched", async () => {
  const { fake, port, chunks, onChunk } = setUp({ permission: "undetermined" });
  const mic = await port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk });
  assert.deepEqual(fake.calls, ["setBuiltInNames", "micPermission", "requestMic", "startMic"]);
  assert.deepEqual(fake.mic, { chunkMs: 100, echoCancel: true, muted: false });
  assert.equal(mic.echoCancel, true);
  const pcm = Buffer.alloc(3200, 7).toString("base64"); // 100 ms at 16 kHz s16
  fake.hear(pcm, 0.25);
  fake.hear("AAEC", 0);
  assert.deepEqual(chunks, [[pcm, 0.25], ["AAEC", 0]]);
  assert.equal(chunks[0][0], pcm, "the same string, not decoded and encoded again");
});

test("the microphone's echoCancel is what startMic answered: the device's echo cancellation", async () => {
  const yes = setUp({ echo: true });
  assert.equal((await yes.port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: yes.onChunk })).echoCancel, true);
  const no = setUp({ echo: false });
  assert.equal((await no.port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: no.onChunk })).echoCancel, false, "a device without a canceller");
});

test("a refused microphone is mic_blocked: refused now, refused before, or refused by the device", async () => {
  const now = setUp({ permission: "undetermined", answer: "denied" });
  await assert.rejects(now.port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: now.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
  assert.deepEqual(now.fake.calls, ["setBuiltInNames", "micPermission", "requestMic"], "the microphone is not started");
  const before = setUp({ permission: "denied" });
  await assert.rejects(before.port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: before.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
  assert.deepEqual(before.fake.calls, ["setBuiltInNames", "micPermission"], "the system is not asked again: the person goes to the settings");
  // The permission was taken back between the check and the start: the module rejects with MIC_BLOCKED.
  const device = setUp();
  device.fake.module.startMic = async () => { throw Object.assign(new Error("x"), { code: MIC_BLOCKED }); };
  await assert.rejects(device.port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: device.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
});

test("a device failure of startMic is an error without the device's text, and no chunk reaches the listener after it", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  fake.module.startMic = async () => { throw Object.assign(new Error("AVAudioEngine failed at /private/var/secret"), { code: "ERR_AIWB_MIC" }); };
  await assert.rejects(port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk }), (e) => {
    assert.ok(!(e instanceof VoiceProblemError));
    assert.doesNotMatch((e as Error).message, /secret|AVAudioEngine/);
    return true;
  });
  fake.mic = { chunkMs: 100, echoCancel: false, muted: false }; // a chunk the native side would send anyway
  fake.hear("AAAA", 0.1);
  assert.deepEqual(chunks, []);
});

test("mute: no chunk while muted, even one the native side sent before the mute reached it; chunks again after", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: null, onChunk });
  fake.hear("AQ==", 0.1);
  mic.mute(true);
  assert.equal(fake.mic?.muted, true);
  fake.hear("Ag==", 0.2);
  fake.mic!.muted = false; // the native side's chunk in flight
  fake.hear("Aw==", 0.3);
  fake.mic!.muted = true;
  mic.mute(false);
  fake.hear("BA==", 0.4);
  assert.deepEqual(chunks.map((c) => c[0]), ["AQ==", "BA=="]);
  assert.ok(fake.calls.includes("setMicMuted:true") && fake.calls.includes("setMicMuted:false"));
});

test("stop: stopMic once, no chunk after it, a mute after it does nothing", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  const mic = await port.startMic({ chunkMs: 250, echoCancel: false, device: null, onChunk });
  await mic.stop();
  await mic.stop();
  assert.equal(fake.calls.filter((c) => c === "stopMic").length, 1);
  assert.equal(fake.mic, null);
  fake.mic = { chunkMs: 250, echoCancel: false, muted: false }; // a late chunk of the native side
  fake.hear("AAAA", 0.5);
  mic.mute(true);
  assert.deepEqual(chunks, []);
  assert.ok(!fake.calls.includes("setMicMuted:true"));
});

test("a second startMic replaces the first: the first's chunks end, and the first's stop does not stop the second", async () => {
  const { fake, port } = setUp();
  const one: string[] = [], two: string[] = [];
  const first = await port.startMic({ chunkMs: 100, echoCancel: false, device: null, onChunk: (b) => one.push(b) });
  const second = await port.startMic({ chunkMs: 100, echoCancel: false, device: null, onChunk: (b) => two.push(b) });
  assert.deepEqual(fake.calls.filter((c) => c === "stopMic").length, 1, "the first was stopped before the second started");
  fake.hear("AQ==", 0.1);
  await first.stop();
  first.mute(true);
  fake.hear("Ag==", 0.1);
  assert.deepEqual([one, two], [[], ["AQ==", "Ag=="]]);
  assert.equal(fake.calls.filter((c) => c === "stopMic").length, 1);
  assert.ok(!fake.calls.includes("setMicMuted:true"));
  await second.stop();
  assert.equal(fake.mic, null);
});

test("the player: bytes passed as they came, marks in the queue, events in order to every listener, stop empties the queue", () => {
  const { fake, port } = setUp();
  const seen: PlayerEvent[] = [], also: string[] = [];
  const off = port.player.on((e) => seen.push(e));
  port.player.on((e) => also.push(e.kind));
  const first = new Uint8Array([1, 0, 2, 0, 3]);
  port.player.mark(1);
  port.player.write(first);
  port.player.write(new Uint8Array([0, 4, 0]));
  port.player.mark(2);
  port.player.write(new Uint8Array([5, 0]));
  assert.equal((fake.queued[1] as { bytes: Uint8Array }).bytes, first, "the same bytes, not a copy");
  assert.deepEqual(fake.written, [1, 0, 2, 0, 3, 0, 4, 0, 5, 0], "an odd trailing byte waits for the next write (the module's rule)");
  fake.play();
  assert.deepEqual(seen, [
    { kind: "mark", id: 1 }, { kind: "level", level: 0.5 }, { kind: "level", level: 0.5 }, { kind: "mark", id: 2 }, { kind: "level", level: 0.5 }, { kind: "drained" },
  ]);
  assert.equal(also.length, seen.length);
  port.player.write(new Uint8Array([9, 9]));
  port.player.mark(3);
  port.player.stop();
  assert.deepEqual(fake.queued, [], "stop clears the queue");
  fake.play();
  off();
  port.player.write(new Uint8Array([1, 1]));
  fake.play();
  assert.equal(seen.length, 6, "nothing after stop, nothing after off");
  assert.equal(also.length, 8, "the other listener still hears the last write");
});

test("a player listener that throws does not keep the next one from the event", () => {
  const { fake, port } = setUp();
  const seen: string[] = [];
  const log = console.error;
  console.error = () => {};
  try {
    port.player.on(() => { throw new Error("boom"); });
    port.player.on((e) => seen.push(e.kind));
    port.player.write(new Uint8Array([1, 0]));
    fake.play();
  } finally { console.error = log; }
  assert.deepEqual(seen, ["level", "drained"]);
});

test("playClip resolves when the clip ends, and the signal stops it", async () => {
  const { fake, port } = setUp();
  const bytes = new Uint8Array([0x49, 0x44, 0x33]);
  const played = port.playClip(bytes, new AbortController().signal);
  await Promise.resolve();
  assert.equal(fake.clip, bytes);
  fake.endClip();
  await played;
  const ab = new AbortController();
  const stopped = port.playClip(bytes, ab.signal);
  await Promise.resolve();
  ab.abort();
  await stopped;
  assert.deepEqual(fake.calls, ["setBuiltInNames", "playClip", "playClip", "stopClip"]);
  assert.equal(fake.clip, null);
  const before = new AbortController();
  before.abort();
  await port.playClip(bytes, before.signal);
  assert.equal(fake.calls.filter((c) => c === "playClip").length, 2, "an aborted signal plays nothing");
});

test("an interruption ends the microphone and reaches every listener; the handle's stop after it is quiet", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk });
  const told: number[] = [];
  const off = port.onInterrupted(() => told.push(1));
  port.onInterrupted(() => told.push(2));
  fake.interrupt("call");
  assert.deepEqual(told, [1, 2]);
  fake.mic = { chunkMs: 100, echoCancel: true, muted: false };
  fake.hear("AAAA", 0.1);
  assert.deepEqual(chunks, [], "the mic of before the interruption gives nothing");
  await mic.stop();
  assert.ok(!fake.calls.includes("stopMic"), "the module stopped it already");
  off();
  fake.interrupt("route");
  assert.deepEqual(told, [1, 2, 2]);
});

test("openMicSettings opens the app's page; canOpenMicSettings is whether the module is there", async () => {
  const { fake, port } = setUp();
  assert.equal(port.canOpenMicSettings, true);
  await port.openMicSettings();
  assert.deepEqual(fake.calls, ["setBuiltInNames", "openSettings"]);
});

test("a build without the module: every call that needs the device fails plainly, what only stops does nothing", async () => {
  for (const port of [audioOver(null), audioOver(() => null)]) {
    await assert.rejects(port.micPermission(), /no audio module/);
    await assert.rejects(port.startMic({ chunkMs: 100, echoCancel: true, device: null, onChunk: () => {} }), /no audio module/);
    await assert.rejects(port.playClip(new Uint8Array(1), new AbortController().signal), /no audio module/);
    await assert.rejects(port.openMicSettings(), /no audio module/);
    assert.throws(() => port.player.write(new Uint8Array(2)), /no audio module/);
    port.player.stop();
    port.player.on(() => {})();
    port.onInterrupted(() => {})();
    assert.equal(port.canOpenMicSettings, false);
  }
});

// ---- devices (voice-devices VD-2, VD-18)

const nd = (id: string, kind: "input" | "output", name: string, o: Partial<NativeDevice> = {}): NativeDevice =>
  ({ id, kind, name, privacy: "unknown", builtIn: false, ...o });
const BUILTIN_MIC = nd("builtin:mic", "input", "Phone microphone", { builtIn: true });
const HEADSET_MIC = nd("bt:aa", "input", "Pixel Buds", { privacy: "private" });
const BUILTIN_SPK = nd("builtin:spk", "output", "Phone speaker", { builtIn: true, privacy: "public" });
const HEADSET_SPK = nd("bt:aa", "output", "Pixel Buds", { privacy: "private" });
const USB_SPK = nd("usb:1", "output", "USB Speaker", { privacy: "public" });

/** A port over a fake that lists a built-in pair and a headset (the default is the built-in pair). */
function withDevices(o: { ability?: { input: "pick" | "system"; output: "pick" | "system"; linked: boolean } } = {}) {
  const s = setUp();
  s.fake.devices = [BUILTIN_MIC, HEADSET_MIC, BUILTIN_SPK, HEADSET_SPK, USB_SPK].map((d) => ({ ...d }));
  s.fake.defaultInput = BUILTIN_MIC.id;
  s.fake.defaultOutput = BUILTIN_SPK.id;
  if (o.ability) s.fake.ability = o.ability;
  return s;
}
const names = (fake: ReturnType<typeof createFakeAiwbAudio>, call: string) => fake.calls.filter((c) => c === call).length;

test("devices: the ability is the module's, asked once; the built-in names are given once, at load; a build without the module chooses nothing", async () => {
  const { fake, port } = withDevices({ ability: { input: "pick", output: "system", linked: false } });
  assert.deepEqual(fake.calls, [], "making the port loads nothing");
  assert.deepEqual(port.devices.ability, { input: "pick", output: "system", linked: false });
  assert.deepEqual(port.devices.ability, { input: "pick", output: "system", linked: false });
  assert.equal(names(fake, "deviceAbility"), 1);
  assert.deepEqual(fake.builtInNames, { mic: BUILTIN_MIC_NAME, speaker: BUILTIN_SPEAKER_NAME });
  await port.micPermission();
  assert.equal(names(fake, "setBuiltInNames"), 1, "once, however many calls follow");
  for (const none of [audioOver(null), audioOver(() => null)]) {
    assert.deepEqual(none.devices.ability, { input: "system", output: "system", linked: false });
    assert.deepEqual(await none.devices.list(), { inputs: [], outputs: [], hidden: false, defaults: { input: null, output: null } });
    assert.deepEqual(await none.player.useOutput({ id: "x", name: "X" }), { device: null, missed: false });
    none.devices.watch(() => {})();
    none.onRoute(() => {})();
    none.player.hold();
    none.player.resume();
  }
});

test("devices: list maps the module's list, drops pseudo-entries, finds the system defaults, and asks for no permission", async () => {
  const { fake, port } = withDevices();
  fake.devices.unshift(nd("default", "input", "Default"), nd("communications", "output", "Communications"));
  const l = await port.devices.list();
  assert.deepEqual(l.inputs.map((d) => d.id), ["builtin:mic", "bt:aa"]);
  assert.deepEqual(l.outputs.map((d) => d.id), ["builtin:spk", "bt:aa", "usb:1"]);
  assert.deepEqual(l.inputs[1], { id: "bt:aa", name: "Pixel Buds", kind: "input", privacy: "private", builtIn: false });
  assert.equal(l.hidden, false);
  assert.deepEqual([l.defaults.input?.id, l.defaults.output?.id], ["builtin:mic", "builtin:spk"]);
  assert.ok(!fake.calls.includes("micPermission") && !fake.calls.includes("requestMic") && !fake.calls.includes("startMic"), "listing never asks, never opens");
  fake.defaultInput = null;
  assert.equal((await port.devices.list()).defaults.input, null, "no default known");
});

test("devices: where the platform picks no input and no output, nothing is listed and the module is not asked", async () => {
  const { fake, port } = withDevices({ ability: { input: "system", output: "system", linked: false } });
  assert.deepEqual((await port.devices.list()).inputs, []);
  assert.ok(!fake.calls.includes("listDevices"));
  const out = withDevices({ ability: { input: "pick", output: "system", linked: false } });
  const l = await out.port.devices.list();
  assert.equal(l.inputs.length, 2);
  assert.deepEqual(l.outputs, [], "the module leaves outputs out where it cannot pick them");
});

test("devices: watch is told when the list may have changed; off stops it; a watcher that throws does not keep the next from it", () => {
  const { fake, port } = withDevices();
  let a = 0, b = 0;
  const offA = port.devices.watch(() => { a++; });
  port.devices.watch(() => { b++; });
  assert.deepEqual(fake.listeningDevices(), { onDevices: 1, onRoute: 1 }, "one listener of each, however many watchers");
  fake.plug(nd("usb:2", "input", "USB Mic"));
  fake.unplug("usb:2");
  assert.deepEqual([a, b], [2, 2]);
  offA();
  fake.plug(nd("usb:3", "input", "USB Mic 2"));
  assert.deepEqual([a, b], [2, 3]);
  const log = console.error;
  console.error = () => {};
  try {
    port.devices.watch(() => { throw new Error("boom"); });
    port.devices.watch(() => { b++; });
    fake.plug(nd("usb:4", "input", "USB Mic 3"));
  } finally { console.error = log; }
  assert.equal(b, 5);
});

test("startMic with no saved microphone lists nothing and asks for the default; opened is what the module opened", async () => {
  const { fake, port, onChunk } = withDevices();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: null, onChunk });
  assert.deepEqual(fake.micAsked, [null]);
  assert.ok(!fake.calls.includes("listDevices"), "a person who never chose lists no devices (VD-6)");
  assert.deepEqual(mic.opened, { device: BUILTIN_MIC, missed: false });
});

test("startMic with a saved microphone: found by id, else by name; the module is given the id", async () => {
  const { fake, port, onChunk } = withDevices();
  const byId = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
  assert.deepEqual(fake.micAsked, ["bt:aa"]);
  assert.deepEqual(byId.opened, { device: HEADSET_MIC, missed: false });
  // The id changed since it was saved (the person's data was cleared, a reconnect): the name finds it.
  const byName = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:old", name: "Pixel Buds" }, onChunk });
  assert.deepEqual(fake.micAsked, ["bt:aa", "bt:aa"]);
  assert.deepEqual(byName.opened, { device: HEADSET_MIC, missed: false });
  assert.deepEqual(fake.micDevice, HEADSET_MIC);
  // The output with the same id is not mistaken for it.
  assert.equal(fake.calls.filter((c) => c === "listDevices").length, 2);
});

test("startMic with a saved microphone that is not there: the default, and missed; nothing else changes", async () => {
  const { fake, port, chunks, onChunk } = withDevices();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "usb:gone", name: "Studio Mic" }, onChunk });
  assert.deepEqual(fake.micAsked, [null], "the default is asked for, not the missing id");
  assert.deepEqual(mic.opened, { device: BUILTIN_MIC, missed: true });
  fake.hear("AQ==", 0.1);
  assert.deepEqual(chunks, [["AQ==", 0.1]], "listening goes on from the default");
  // A speaker of the same id is no microphone: the kind is matched.
  const outputOnly = withDevices();
  outputOnly.fake.devices = outputOnly.fake.devices.filter((d) => d.kind === "output");
  const m2 = await outputOnly.port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk: outputOnly.onChunk });
  assert.equal(m2.opened.missed, true);
});

test("startMic: the device went away between the listing and the start gives missed, from the module's answer", async () => {
  const { fake, port, onChunk } = withDevices();
  const real = fake.module.startMic;
  fake.module.startMic = async (...a) => { fake.unplug("bt:aa"); return real(...a); }; // gone after it was listed
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
  assert.deepEqual(mic.opened, { device: BUILTIN_MIC, missed: true });
});

test("startMic: a listing that fails is not a missing device; the saved id is asked for and the answer says", async () => {
  const { fake, port, onChunk } = withDevices();
  fake.module.listDevices = async () => { throw new Error("no list"); };
  const there = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
  assert.deepEqual(fake.micAsked, ["bt:aa"]);
  assert.deepEqual(there.opened, { device: HEADSET_MIC, missed: false });
  const gone = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "usb:gone", name: "Studio Mic" }, onChunk });
  assert.deepEqual(gone.opened, { device: BUILTIN_MIC, missed: true });
});

test("startMic where the platform picks no input: the saved microphone is ignored, nothing is listed, nothing is missed", async () => {
  const { fake, port, onChunk } = withDevices({ ability: { input: "system", output: "system", linked: false } });
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "usb:gone", name: "Studio Mic" }, onChunk });
  assert.deepEqual(fake.micAsked, [null]);
  assert.ok(!fake.calls.includes("listDevices"));
  assert.equal(mic.opened.missed, false);
});

test("useOutput: a saved speaker is found by id or name and given to the module; one that is gone gives the default and missed", async () => {
  const { fake, port } = withDevices();
  assert.deepEqual(await port.player.useOutput({ id: "usb:1", name: "USB Speaker" }), { device: USB_SPK, missed: false });
  assert.deepEqual(await port.player.useOutput({ id: "old", name: "Pixel Buds" }), { device: HEADSET_SPK, missed: false }, "by name");
  assert.deepEqual(await port.player.useOutput({ id: "x", name: "Gone Speaker" }), { device: BUILTIN_SPK, missed: true });
  assert.deepEqual(fake.outputAsked, ["usb:1", "bt:aa", null]);
  assert.deepEqual(await port.player.useOutput(null), { device: BUILTIN_SPK, missed: false }, "back to the default");
  assert.deepEqual(fake.outputAsked, ["usb:1", "bt:aa", null, null]);
  // An input of the same id is no speaker: the kind is matched.
  fake.devices = fake.devices.filter((d) => d.kind === "input");
  assert.equal((await port.player.useOutput({ id: "bt:aa", name: "Pixel Buds" })).missed, true);
});

test("useOutput with nothing chosen ever makes no call; where the platform picks no output it asks nothing of it", async () => {
  const { fake, port } = withDevices();
  assert.deepEqual(await port.player.useOutput(null), { device: null, missed: false });
  assert.deepEqual(fake.calls.filter((c) => c === "setOutput" || c === "listDevices"), []);
  const sys = withDevices({ ability: { input: "pick", output: "system", linked: false } });
  assert.deepEqual(await sys.port.player.useOutput({ id: "usb:1", name: "USB Speaker" }), { device: null, missed: false });
  assert.deepEqual(sys.fake.calls.filter((c) => c === "setOutput" || c === "listDevices"), []);
});

test("useOutput: a listing that fails asks for the saved id; a setOutput that fails is an error without the device's text", async () => {
  const { fake, port } = withDevices();
  const list = fake.module.listDevices;
  fake.module.listDevices = async () => { throw new Error("no list"); };
  assert.deepEqual(await port.player.useOutput({ id: "usb:1", name: "USB Speaker" }), { device: USB_SPK, missed: false });
  fake.module.listDevices = list;
  fake.module.setOutput = async () => { throw new Error("AudioTrack failed for Secret Headset"); };
  await assert.rejects(port.player.useOutput({ id: "usb:1", name: "USB Speaker" }), (e) => {
    assert.doesNotMatch((e as Error).message, /Secret|AudioTrack/);
    return true;
  });
});

test("hold and resume reach the module once loaded, and do nothing before", async () => {
  const { fake, port } = setUp();
  port.player.hold();
  port.player.resume();
  assert.deepEqual(fake.calls, [], "never loaded: nothing can be playing");
  port.player.write(new Uint8Array([1, 0]));
  port.player.hold();
  assert.equal(fake.held, true);
  fake.play();
  assert.equal(fake.queued.length, 1, "a held player plays nothing");
  port.player.resume();
  assert.equal(fake.held, false);
  assert.deepEqual(fake.calls.slice(-3), ["playerWrite", "playerHold", "playerResume"]);
});

test("onRoute: a lost microphone and a lost speaker reach every listener as the port's events; off stops one", async () => {
  const { fake, port, onChunk } = withDevices();
  const hpIn = nd("hp:in", "input", "Wired Headset", { privacy: "private" }), hpOut = nd("hp:out", "output", "Wired Headset", { privacy: "private" });
  fake.devices.push(hpIn, hpOut);
  const one: RouteEvent[] = [], two: RouteEvent[] = [];
  const off = port.onRoute((e) => one.push(e));
  port.onRoute((e) => two.push(e));
  assert.deepEqual(fake.listeningDevices(), { onDevices: 0, onRoute: 0 }, "nothing is loaded by listening for a route");
  await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "hp:in", name: "Wired Headset" }, onChunk });
  await port.player.useOutput({ id: "hp:out", name: "Wired Headset" });
  assert.deepEqual(fake.listeningDevices(), { onDevices: 1, onRoute: 1 });
  fake.unplug("hp:in");
  fake.unplug("hp:out");
  assert.deepEqual(one, [
    { kind: "input-lost", lost: hpIn, now: BUILTIN_MIC },
    { kind: "output-lost", lost: hpOut, now: BUILTIN_SPK, held: true },
  ], "private headphones lost to a loudspeaker: held");
  assert.deepEqual(two, one);
  assert.equal(fake.held, true);
  off();
  fake.route({ kind: "output-lost", lost: USB_SPK, now: BUILTIN_SPK, held: false });
  assert.equal(one.length, 2);
  assert.deepEqual(two.at(-1), { kind: "output-lost", lost: USB_SPK, now: BUILTIN_SPK, held: false });
});

test("onRoute: unknown devices stay null; the event carries only the fields of the port's types", () => {
  const { fake, port } = withDevices();
  const seen: RouteEvent[] = [];
  port.onRoute((e) => seen.push(e));
  port.devices.watch(() => {});
  fake.route({ kind: "input-lost", lost: null, now: null, held: false });
  fake.route({ kind: "input-failed", lost: { ...HEADSET_MIC }, now: null, held: false });
  assert.deepEqual(seen, [{ kind: "input-lost", lost: null, now: null }, { kind: "input-failed", lost: HEADSET_MIC }]);
  assert.ok(!("held" in seen[0]) && !("now" in seen[1]));
});

test("a microphone that cannot be reopened (input-failed): the microphone is over, its late chunks and its stop do nothing", async () => {
  const { fake, port, chunks, onChunk } = withDevices();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
  const seen: RouteEvent[] = [];
  port.onRoute((e) => seen.push(e));
  fake.failReopen = true;
  fake.unplug("bt:aa");
  assert.deepEqual(seen, [{ kind: "input-failed", lost: HEADSET_MIC }]);
  fake.mic = { chunkMs: 100, echoCancel: false, muted: false }; // a chunk of the native side in flight
  fake.hear("AAAA", 0.1);
  assert.deepEqual(chunks, []);
  await mic.stop();
  assert.ok(!fake.calls.includes("stopMic"), "the module stopped it already");
  // The next start works as any other.
  fake.mic = null;
  const again = await port.startMic({ chunkMs: 100, echoCancel: false, device: null, onChunk });
  fake.hear("AQ==", 0.2);
  assert.deepEqual(chunks, [["AQ==", 0.2]]);
  await again.stop();
});

test("a microphone that moved to the default (input-lost) goes on into the same listener", async () => {
  const { fake, port, chunks, onChunk } = withDevices();
  await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
  fake.hear("AQ==", 0.1);
  fake.unplug("bt:aa");
  fake.hear("Ag==", 0.2);
  assert.deepEqual(chunks.map((c) => c[0]), ["AQ==", "Ag=="]);
});

test("a route listener that throws does not keep the next one from the event", () => {
  const { fake, port } = withDevices();
  const seen: string[] = [];
  const log = console.error;
  console.error = () => {};
  try {
    port.devices.watch(() => {});
    port.onRoute(() => { throw new Error("boom"); });
    port.onRoute((e) => seen.push(e.kind));
    fake.route({ kind: "output-lost", lost: null, now: null, held: false });
  } finally { console.error = log; }
  assert.deepEqual(seen, ["output-lost"]);
});

test("no device name reaches the console through a start, a miss, a change of output or a loss", async () => {
  const { fake, port, onChunk } = withDevices();
  const said: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    port.onRoute(() => {});
    await port.devices.list();
    await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "x", name: "Secret Studio Mic" }, onChunk });
    await port.startMic({ chunkMs: 100, echoCancel: false, device: { id: "bt:aa", name: "Pixel Buds" }, onChunk });
    await port.player.useOutput({ id: "bt:aa", name: "Pixel Buds" });
    fake.unplug("bt:aa");
  } finally { Object.assign(console, saved); }
  assert.deepEqual(said, []);
});

// ---- the contract against the native sources

const contract = read("../modules/aiwb-audio/src/AiwbAudio.ts");
const swift = read("../modules/aiwb-audio/ios/AiwbAudioModule.swift");
const kotlin = read("../modules/aiwb-audio/android/src/main/java/expo/modules/aiwbaudio/AiwbAudioModule.kt");

/** The members of an interface or a type literal of the contract, by name. */
function members(name: string): string[] {
  const at = contract.indexOf(name);
  assert.ok(at >= 0, name);
  const open = contract.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < contract.length; i++) {
    if (contract[i] === "{") depth++;
    else if (contract[i] === "}" && --depth === 0) { end = i; break; }
  }
  const body = contract.slice(open + 1, end).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/^\s{2}(\w+)\s*[(:]/gm)].map((m) => m[1]).sort();
}

/** `Function("x")` and `AsyncFunction("x")` of a native module definition. */
const functionsOf = (text: string) => [...text.matchAll(/\b(?:Async)?Function\("(\w+)"\)/g)].map((m) => m[1]).sort();
/** The names of `Events(...)`. */
const eventsOf = (text: string) => [...(/\bEvents\(([^)]*)\)/.exec(text)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();

test("the Swift and the Kotlin module define every function and every event of the contract, and nothing else", () => {
  const fns = members("interface AiwbAudioNative");
  const events = members("type AiwbAudioEvents");
  assert.equal(fns.length, 17, "the contract's functions were read");
  assert.deepEqual(events, ["onDevices", "onInterrupted", "onMic", "onPlayer", "onRoute"]);
  for (const [name, text] of [["Swift", swift], ["Kotlin", kotlin]] as const) {
    assert.deepEqual(functionsOf(text), fns, `${name}: the functions`);
    assert.deepEqual(eventsOf(text), events, `${name}: the events`);
    assert.match(text, /Name\("AiwbAudio"\)/, `${name}: the module's name, as AiwbAudioModule.ts requires it`);
  }
});

test("both sides reject a refused microphone with MIC_BLOCKED and emit the payloads of the contract", () => {
  const native = [swift, read("../modules/aiwb-audio/ios/VoiceAudio.swift")].join("\n");
  const android = [kotlin, ...["VoiceAudio.kt", "MicCapture.kt", "PcmPlayer.kt"].map((f) => read(`../modules/aiwb-audio/android/src/main/java/expo/modules/aiwbaudio/${f}`))].join("\n");
  for (const [name, text] of [["iOS", native], ["Android", android]] as const) {
    assert.ok(text.includes(`"${MIC_BLOCKED}"`), `${name}: the code ${MIC_BLOCKED}`);
    for (const key of ['"pcm"', '"level"', '"kind"', '"mark"', '"id"', '"drained"', '"reason"', '"echoCancel"', '"call"', '"route"', '"other"']) {
      assert.ok(text.includes(key), `${name}: ${key}`);
    }
    for (const permission of ['"granted"', '"denied"', '"undetermined"']) assert.ok(text.includes(permission), `${name}: ${permission}`);
  }
});

test("expo-module.config.json names the classes the sources define", () => {
  const cfg = JSON.parse(read("../modules/aiwb-audio/expo-module.config.json")) as { apple: { modules: string[] }; android: { modules: string[] } };
  assert.deepEqual(cfg.apple.modules, ["AiwbAudioModule"]);
  assert.match(swift, /public class AiwbAudioModule: Module/);
  assert.deepEqual(cfg.android.modules, ["expo.modules.aiwbaudio.AiwbAudioModule"]);
  assert.match(kotlin, /^package expo\.modules\.aiwbaudio$/m);
  assert.match(kotlin, /class AiwbAudioModule : Module\(\)/);
  assert.match(read("../modules/aiwb-audio/ios/AiwbAudio.podspec"), /s\.name\s+= 'AiwbAudio'/);
});

test("the module's web face is null: the web build has its own audio", async () => {
  const web = (await import("../modules/aiwb-audio/src/AiwbAudioModule.web.ts")).default as AiwbAudioModule | null;
  assert.equal(web, null);
});
