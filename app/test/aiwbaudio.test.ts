// The audio port over the aiwb-audio module (architecture VC-8): the adapter over the module's fake (the module loaded on first use, the
// permission asked once, chunks passed through untouched, mute, stop, the player's events, the clip, an interruption, a build without the
// module), and the contract of src/AiwbAudio.ts against the Swift and the Kotlin sources (every function, every event, the error code).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MIC_BLOCKED, type AiwbAudioModule } from "../modules/aiwb-audio/src/AiwbAudio.ts";
import { createFakeAiwbAudio } from "../modules/aiwb-audio/src/fake.ts";
import { audioOver } from "../src/voice/platform/audio.native.ts";
import { VoiceProblemError, type PlayerEvent } from "../src/voice/ports.ts";

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
  assert.deepEqual(fake.calls, ["micPermission", "micPermission"], "asking for the permission's state does not ask the person");
  port.player.stop();
  assert.deepEqual(fake.calls.at(-1), "playerStop", "once loaded, a stop reaches the module");
  offPlayer();
  offInterrupted();
});

test("startMic asks the person when undetermined, then starts 16 kHz chunks of chunkMs; the base64 reaches the listener untouched", async () => {
  const { fake, port, chunks, onChunk } = setUp({ permission: "undetermined" });
  const mic = await port.startMic({ chunkMs: 100, echoCancel: true, onChunk });
  assert.deepEqual(fake.calls, ["micPermission", "requestMic", "startMic"]);
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
  assert.equal((await yes.port.startMic({ chunkMs: 100, echoCancel: true, onChunk: yes.onChunk })).echoCancel, true);
  const no = setUp({ echo: false });
  assert.equal((await no.port.startMic({ chunkMs: 100, echoCancel: true, onChunk: no.onChunk })).echoCancel, false, "a device without a canceller");
});

test("a refused microphone is mic_blocked: refused now, refused before, or refused by the device", async () => {
  const now = setUp({ permission: "undetermined", answer: "denied" });
  await assert.rejects(now.port.startMic({ chunkMs: 100, echoCancel: true, onChunk: now.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
  assert.deepEqual(now.fake.calls, ["micPermission", "requestMic"], "the microphone is not started");
  const before = setUp({ permission: "denied" });
  await assert.rejects(before.port.startMic({ chunkMs: 100, echoCancel: true, onChunk: before.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
  assert.deepEqual(before.fake.calls, ["micPermission"], "the system is not asked again: the person goes to the settings");
  // The permission was taken back between the check and the start: the module rejects with MIC_BLOCKED.
  const device = setUp();
  device.fake.module.startMic = async () => { throw Object.assign(new Error("x"), { code: MIC_BLOCKED }); };
  await assert.rejects(device.port.startMic({ chunkMs: 100, echoCancel: true, onChunk: device.onChunk }), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
});

test("a device failure of startMic is an error without the device's text, and no chunk reaches the listener after it", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  fake.module.startMic = async () => { throw Object.assign(new Error("AVAudioEngine failed at /private/var/secret"), { code: "ERR_AIWB_MIC" }); };
  await assert.rejects(port.startMic({ chunkMs: 100, echoCancel: true, onChunk }), (e) => {
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
  const mic = await port.startMic({ chunkMs: 100, echoCancel: false, onChunk });
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
  const mic = await port.startMic({ chunkMs: 250, echoCancel: false, onChunk });
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
  const first = await port.startMic({ chunkMs: 100, echoCancel: false, onChunk: (b) => one.push(b) });
  const second = await port.startMic({ chunkMs: 100, echoCancel: false, onChunk: (b) => two.push(b) });
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
  assert.deepEqual(fake.calls, ["playClip", "playClip", "stopClip"]);
  assert.equal(fake.clip, null);
  const before = new AbortController();
  before.abort();
  await port.playClip(bytes, before.signal);
  assert.equal(fake.calls.filter((c) => c === "playClip").length, 2, "an aborted signal plays nothing");
});

test("an interruption ends the microphone and reaches every listener; the handle's stop after it is quiet", async () => {
  const { fake, port, chunks, onChunk } = setUp();
  const mic = await port.startMic({ chunkMs: 100, echoCancel: true, onChunk });
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
  assert.deepEqual(fake.calls, ["openSettings"]);
});

test("a build without the module: every call that needs the device fails plainly, what only stops does nothing", async () => {
  for (const port of [audioOver(null), audioOver(() => null)]) {
    await assert.rejects(port.micPermission(), /no audio module/);
    await assert.rejects(port.startMic({ chunkMs: 100, echoCancel: true, onChunk: () => {} }), /no audio module/);
    await assert.rejects(port.playClip(new Uint8Array(1), new AbortController().signal), /no audio module/);
    await assert.rejects(port.openMicSettings(), /no audio module/);
    assert.throws(() => port.player.write(new Uint8Array(2)), /no audio module/);
    port.player.stop();
    port.player.on(() => {})();
    port.onInterrupted(() => {})();
    assert.equal(port.canOpenMicSettings, false);
  }
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
  assert.equal(fns.length, 11, "the contract's functions were read");
  assert.deepEqual(events, ["onInterrupted", "onMic", "onPlayer"]);
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
