// The web audio port's devices (voice-devices D3, architecture VD-1, VD-2, VD-6, VD-9 to VD-11), over a fake `navigator.mediaDevices` and a fake
// `AudioContext` in Node: listing, the saved microphone and speaker, a saved device that is missing, a microphone that goes away, a speaker that
// goes away (public and private), the hold and the resume. No audio is made and no real device is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { audioWeb } from "../src/voice/platform/audio.web.ts";
import { VoiceProblemError, type AudioPort, type RouteEvent } from "../src/voice/ports.ts";

type Dev = { kind: "audioinput" | "audiooutput"; deviceId: string; label: string; groupId: string };
const input = (id: string, label: string, groupId = `g-${id}`): Dev => ({ kind: "audioinput", deviceId: id, label, groupId });
const output = (id: string, label: string, groupId = `g-${id}`): Dev => ({ kind: "audiooutput", deviceId: id, label, groupId });

const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

class FakeTrack extends EventTarget {
  stopped = false;
  readonly label: string;
  readonly deviceId: string;
  constructor(label: string, deviceId: string) { super(); this.label = label; this.deviceId = deviceId; }
  getSettings(): { deviceId: string; echoCancellation: boolean } { return { deviceId: this.deviceId, echoCancellation: true }; }
  stop(): void { this.stopped = true; }
  end(): void { this.dispatchEvent(new Event("ended")); }
}
class FakeStream {
  readonly track: FakeTrack;
  constructor(track: FakeTrack) { this.track = track; }
  getTracks(): FakeTrack[] { return [this.track]; }
  getAudioTracks(): FakeTrack[] { return [this.track]; }
}

type World = {
  devices: Dev[];
  md: EventTarget & Record<string, unknown>;
  gum: { constraints: unknown[]; fail: ((c: unknown) => Error | null) | null };
  enumerated: number;
  streams: FakeStream[];
  contexts: FakeContext[];
  plug(d: Dev): void;
  unplug(id: string): void;
};

let world: World;

class FakeNode {
  connected: unknown[] = [];
  onaudioprocess: ((e: unknown) => void) | null = null;
  fftSize = 0;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(to: unknown): void { this.connected.push(to); }
  disconnect(): void { this.connected = []; }
  getFloatTimeDomainData(): void {}
  copyToChannel(): void {}
  start(): void {}
  stop(): void {}
}

class FakeContext extends EventTarget {
  static withSink = true;
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  sinkId = "";
  destination = new FakeNode();
  sinkCalls: string[] = [];
  log: string[] = [];
  processors: FakeNode[] = [];
  constructor() { super(); world.contexts.push(this); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createBuffer(_c: number, n: number, rate: number): FakeNode & { duration: number } { return Object.assign(new FakeNode(), { duration: n / rate }); }
  createBufferSource(): FakeNode { return new FakeNode(); }
  createMediaStreamSource(stream: FakeStream): FakeNode & { stream: FakeStream } { return Object.assign(new FakeNode(), { stream }); }
  createScriptProcessor(): FakeNode { const p = new FakeNode(); this.processors.push(p); return p; }
  async suspend(): Promise<void> { this.log.push("suspend"); this.state = "suspended"; }
  async resume(): Promise<void> { this.log.push("resume"); this.state = "running"; }
  async close(): Promise<void> { this.state = "closed"; }
  async decodeAudioData(): Promise<FakeNode> { return new FakeNode(); }
  async setSinkId(id: string): Promise<void> {
    this.sinkCalls.push(id);
    this.log.push(`sink:${id}`);
    if (id !== "" && !world.devices.some((d) => d.kind === "audiooutput" && d.deviceId === id)) throw Object.assign(new Error("x"), { name: "NotFoundError" });
    this.sinkId = id;
  }
}

const REAL_SINK = FakeContext.prototype.setSinkId;

function install(devices: Dev[], opts: { granted?: boolean; sink?: boolean } = {}): void {
  const granted = opts.granted ?? true;
  const md = new EventTarget() as World["md"];
  world = {
    devices: [...devices], md, enumerated: 0, streams: [], contexts: [],
    gum: { constraints: [], fail: null },
    plug(d) { world.devices.push(d); md.dispatchEvent(new Event("devicechange")); },
    unplug(id) {
      world.devices = world.devices.filter((d) => d.deviceId !== id);
      for (const s of world.streams) {
        const t = s.track as FakeTrack & { origin?: string };
        if ((t.deviceId === id || t.origin === id) && !t.stopped) t.end();
      }
      md.dispatchEvent(new Event("devicechange"));
    },
  };
  md.enumerateDevices = async () => {
    world.enumerated += 1;
    if (!granted) return [{ kind: "audioinput", deviceId: "", label: "", groupId: "" }, { kind: "audiooutput", deviceId: "", label: "", groupId: "" }];
    return world.devices.map((d) => ({ ...d }));
  };
  md.getUserMedia = async (c: { audio: { deviceId?: { exact: string } } }) => {
    world.gum.constraints.push(c.audio);
    const err = world.gum.fail?.(c.audio);
    if (err) throw err;
    const ins = world.devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default");
    const exact = c.audio.deviceId?.exact;
    let dev: Dev | undefined;
    if (exact !== undefined) {
      dev = ins.find((d) => d.deviceId === exact);
      if (!dev) throw Object.assign(new Error("x"), { name: "OverconstrainedError" });
    } else dev = ins[0];
    if (!dev) throw Object.assign(new Error("x"), { name: "NotFoundError" });
    const stream = new FakeStream(new FakeTrack(exact === undefined ? `Default - ${dev.label}` : dev.label, exact === undefined ? "default" : dev.deviceId));
    // a track on the default is ended when its real device goes: the fake ties it to the device it was made from
    (stream.track as FakeTrack & { origin?: string }).origin = dev.deviceId;
    world.streams.push(stream);
    return stream;
  };
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: md }, configurable: true, writable: true });
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
  const proto = FakeContext.prototype as unknown as { setSinkId?: unknown };
  if (opts.sink === false) delete proto.setSinkId;
  else proto.setSinkId = REAL_SINK;
}

const DESK = input("in-desk", "Desk Mic");
const HEAD = input("in-head", "Stand-in Headset");
const SPK = output("out-spk", "Desk Speakers");
const PHONES = output("out-hp", "Stand-in Headphones");
const defaultIn = (of: Dev) => input("default", `Default - ${of.label}`, of.groupId);
const defaultOut = (of: Dev) => output("default", `Default - ${of.label}`, of.groupId);
const FULL = (): Dev[] => [defaultIn(DESK), DESK, HEAD, defaultOut(SPK), SPK, PHONES];

const PCM = new Uint8Array(480);

/** Console output of a run, to prove that no device name reaches it. */
function spyConsole(): { seen: string[]; restore(): void } {
  const seen: string[] = [];
  const saved: Record<string, unknown> = {};
  for (const k of ["log", "info", "warn", "error", "debug"] as const) {
    saved[k] = console[k];
    console[k] = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  }
  return { seen, restore() { for (const k of Object.keys(saved)) (console as unknown as Record<string, unknown>)[k] = saved[k]; } };
}

const startMic = (port: AudioPort, device: { id: string; name: string } | null, chunks: string[] = []) =>
  port.startMic({ chunkMs: 10, echoCancel: true, device, onChunk: (b) => { chunks.push(b); } });

/** One block of sound into the context's script processor, as the browser would. */
const feed = (ctx: FakeContext, nth = 0): void => {
  ctx.processors[nth]!.onaudioprocess!({ inputBuffer: { getChannelData: () => Float32Array.from({ length: 4096 }, (_, i) => 0.4 * Math.sin(i / 7)) } });
};

// ---- ability and listing

test("the web port can pick both kinds, the speaker only where AudioContext has setSinkId", () => {
  install(FULL());
  assert.deepEqual(audioWeb().devices.ability, { input: "pick", output: "pick", linked: false });
  install(FULL(), { sink: false });
  assert.deepEqual(audioWeb().devices.ability, { input: "pick", output: "system", linked: false });
  install(FULL());
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  assert.deepEqual(audioWeb().devices.ability, { input: "system", output: "system", linked: false });
});

test("listing drops the pseudo-entries and reads the default from the 'Default - …' entry", async () => {
  install([...FULL(), input("communications", "Communications - Desk Mic", DESK.groupId)]);
  const port = audioWeb();
  const list = await port.devices.list();
  assert.deepEqual(list.inputs.map((d) => d.name), ["Desk Mic", "Stand-in Headset"]);
  assert.deepEqual(list.outputs.map((d) => [d.name, d.privacy]), [["Desk Speakers", "public"], ["Stand-in Headphones", "private"]]);
  assert.equal(list.hidden, false);
  assert.equal(list.defaults.input?.id, "in-desk");
  assert.equal(list.defaults.output?.id, "out-spk");
});

test("before the permission the list is hidden: no devices, and no getUserMedia to find out", async () => {
  install(FULL(), { granted: false });
  const list = await audioWeb().devices.list();
  assert.deepEqual([list.hidden, list.inputs.length, list.outputs.length], [true, 0, 0]);
  assert.equal(world.gum.constraints.length, 0);
});

test("a default entry whose label names no listed device gives a device made from the label", async () => {
  install([output("default", "Default - Studio Monitors", "gx"), SPK]);
  const list = await audioWeb().devices.list();
  assert.equal(list.defaults.output?.name, "Studio Monitors");
  assert.equal(list.defaults.output?.privacy, "public");
});

test("watch listens for devicechange only while someone watches, and lists nothing by itself", async () => {
  install(FULL());
  const port = audioWeb();
  const add = (world.md as unknown as { addEventListener: EventTarget["addEventListener"] }).addEventListener;
  let attached = 0;
  let removed = 0;
  world.md.addEventListener = ((t: string, f: never, o: never) => { attached++; return add.call(world.md, t, f, o); }) as never;
  const rm = world.md.removeEventListener;
  world.md.removeEventListener = ((t: string, f: never, o: never) => { removed++; return rm.call(world.md, t, f, o); }) as never;
  assert.equal(attached, 0);
  let told = 0;
  const stop = port.devices.watch(() => { told++; });
  assert.equal(attached, 1);
  world.plug(output("out-new", "Another Speaker"));
  assert.equal(told, 1);
  assert.equal(world.enumerated, 0);
  stop();
  assert.equal(removed, 1);
  world.plug(output("out-newer", "Yet Another"));
  assert.equal(told, 1);
});

// ---- the microphone: choosing

test("no saved microphone: the default is opened, nothing is listed", async () => {
  install(FULL());
  const mic = await startMic(audioWeb(), null);
  assert.deepEqual(mic.opened, { device: null, missed: false });
  assert.equal(world.enumerated, 0);
  assert.equal((world.gum.constraints[0] as { deviceId?: unknown }).deviceId, undefined);
  await mic.stop();
});

test("the saved microphone is opened by its id, and chunks come from it", async () => {
  install(FULL());
  const chunks: string[] = [];
  const mic = await startMic(audioWeb(), { id: "in-head", name: "Stand-in Headset" }, chunks);
  assert.deepEqual(world.gum.constraints.map((c) => (c as { deviceId?: unknown }).deviceId), [{ exact: "in-head" }]);
  assert.equal(mic.opened.device?.name, "Stand-in Headset");
  assert.equal(mic.opened.missed, false);
  feed(world.contexts[0]!);
  assert.ok(chunks.length > 0);
  await mic.stop();
});

test("a saved microphone is found again by its name when its id changed", async () => {
  install(FULL());
  const mic = await startMic(audioWeb(), { id: "old-id", name: "Stand-in Headset" });
  assert.deepEqual((world.gum.constraints[0] as { deviceId: unknown }).deviceId, { exact: "in-head" });
  assert.equal(mic.opened.missed, false);
  await mic.stop();
});

test("a saved microphone that is not there gives the default and missed; nothing is asked of a missing id", async () => {
  install(FULL());
  const mic = await startMic(audioWeb(), { id: "gone", name: "Gone Mic" });
  assert.deepEqual(mic.opened, { device: null, missed: true });
  assert.equal(world.gum.constraints.length, 1);
  assert.equal((world.gum.constraints[0] as { deviceId?: unknown }).deviceId, undefined);
  await mic.stop();
});

test("an OverconstrainedError on the exact id (it went between the list and the open) gives the default and missed", async () => {
  install(FULL());
  world.gum.fail = (c) => ((c as { deviceId?: unknown }).deviceId ? Object.assign(new Error("x"), { name: "OverconstrainedError" }) : null);
  const mic = await startMic(audioWeb(), { id: "in-head", name: "Stand-in Headset" });
  assert.deepEqual(mic.opened, { device: null, missed: true });
  assert.equal(world.gum.constraints.length, 2);
  await mic.stop();
});

test("a refusal is mic_blocked, with or without a saved microphone", async () => {
  install(FULL());
  world.gum.fail = () => Object.assign(new Error("x"), { name: "NotAllowedError" });
  for (const device of [null, { id: "in-head", name: "Stand-in Headset" }]) {
    await assert.rejects(startMic(audioWeb(), device), (e) => e instanceof VoiceProblemError && e.kind === "mic_blocked");
  }
});

test("before the permission a saved microphone is found after the default is opened: the permission is asked once, the list read again", async () => {
  install(FULL(), { granted: false });
  const granted = world.md.enumerateDevices as () => Promise<unknown>;
  let opens = 0;
  const gum = world.md.getUserMedia as (c: unknown) => Promise<unknown>;
  world.md.getUserMedia = async (c: unknown) => {
    opens++;
    const s = await gum(c);
    // the permission is given by the first open: from now on the list is real
    world.md.enumerateDevices = async () => { world.enumerated++; return world.devices.map((d) => ({ ...d })); };
    return s;
  };
  void granted;
  const mic = await startMic(audioWeb(), { id: "in-head", name: "Stand-in Headset" });
  assert.equal(opens, 2);
  assert.equal(mic.opened.device?.id, "in-head");
  assert.equal(world.streams[0]!.track.stopped, true);     // the default that asked the permission was let go
  await mic.stop();
});

// ---- the microphone: lost

test("the microphone's track ends: capture goes on from the default into the same onChunk, and input-lost is told", async () => {
  install(FULL());
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  const chunks: string[] = [];
  const mic = await startMic(port, { id: "in-head", name: "Stand-in Headset" }, chunks);
  const ctx = world.contexts[0]!;
  feed(ctx);
  const before = chunks.length;
  world.unplug("in-head");
  await settle();
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.kind, "input-lost");
  if (e.kind === "input-lost") {
    assert.equal(e.lost?.name, "Stand-in Headset");
    assert.equal(e.now?.name, "Desk Mic");
  }
  assert.equal(world.contexts.length, 1, "the same context and chunker go on");
  assert.equal(world.gum.constraints.length, 2);
  assert.equal((world.gum.constraints[1] as { deviceId?: unknown }).deviceId, undefined);
  feed(ctx);
  assert.ok(chunks.length > before);
  assert.equal(world.streams[0]!.track.stopped, true);
  await mic.stop();
  assert.equal(world.streams[1]!.track.stopped, true);
});

test("a default microphone that goes away is named by its track's label, without 'Default - '", async () => {
  install(FULL());
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  const mic = await startMic(port, null);
  world.streams[0]!.track.end();
  await settle();
  const e = events[0]!;
  assert.equal(e.kind, "input-lost");
  if (e.kind === "input-lost") assert.equal(e.lost?.name, "Desk Mic");
  await mic.stop();
});

test("capture that cannot be reopened is input-failed and the microphone is stopped; the second end changes nothing", async () => {
  install(FULL());
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  const mic = await startMic(port, { id: "in-head", name: "Stand-in Headset" });
  world.gum.fail = () => Object.assign(new Error("x"), { name: "NotFoundError" });
  world.unplug("in-head");
  await settle();
  assert.deepEqual(events.map((e) => e.kind), ["input-failed"]);
  assert.equal(world.contexts[0]!.state, "closed");
  await mic.stop();
});

test("with nobody told of routes, a microphone that cannot be reopened ends as a taken microphone always did", async () => {
  install(FULL());
  const port = audioWeb();
  let taken = 0;
  port.onInterrupted(() => { taken++; });
  const mic = await startMic(port, null);
  world.gum.fail = () => Object.assign(new Error("x"), { name: "NotFoundError" });
  world.streams[0]!.track.end();
  await settle();
  assert.equal(taken, 1);
  await mic.stop();
});

test("a microphone stopped by the engine does not reopen when its track ends", async () => {
  install(FULL());
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  const mic = await startMic(port, null);
  await mic.stop();
  world.streams[0]!.track.end();
  await settle();
  assert.equal(world.gum.constraints.length, 1);
  assert.equal(events.length, 0);
});

// ---- the speaker: choosing

test("useOutput(null) with nothing running makes no context, lists nothing and sets no sink", async () => {
  install(FULL());
  const player = audioWeb().player;
  assert.deepEqual(await player.useOutput(null), { device: null, missed: false });
  assert.equal(world.contexts.length, 0);
  assert.equal(world.enumerated, 0);
});

test("the saved speaker is set with setSinkId on the player's context, after it is made (never in the constructor)", async () => {
  install(FULL());
  const player = audioWeb().player;
  const got = await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" });
  assert.equal(got.missed, false);
  assert.equal(got.device?.name, "Stand-in Headphones");
  assert.deepEqual(world.contexts.map((c) => c.sinkCalls), [["out-hp"]]);
  player.write(PCM);
  assert.equal(world.contexts.length, 1);
  player.stop();
});

test("a saved speaker that is not listed gives the default and missed", async () => {
  install(FULL());
  const player = audioWeb().player;
  assert.deepEqual(await player.useOutput({ id: "gone", name: "Gone Speaker" }), { device: null, missed: true });
  assert.ok(world.contexts.every((c) => c.sinkCalls.every((id) => id === "")));
});

test("a setSinkId that rejects gives the default and missed", async () => {
  install(FULL());
  const player = audioWeb().player;
  await player.useOutput(null);
  const real = FakeContext.prototype.setSinkId;
  FakeContext.prototype.setSinkId = async function (this: FakeContext, id: string) {
    this.sinkCalls.push(id);
    if (id !== "") throw Object.assign(new Error("x"), { name: "NotFoundError" });
    this.sinkId = id;
  };
  try {
    const got = await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" });
    assert.deepEqual(got, { device: null, missed: true });
    assert.deepEqual(world.contexts[0]!.sinkCalls, ["out-hp", ""]);
  } finally { FakeContext.prototype.setSinkId = real; }
});

test("before the permission a saved speaker cannot be found: the default and missed", async () => {
  install(FULL(), { granted: false });
  const player = audioWeb().player;
  assert.deepEqual(await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" }), { device: null, missed: true });
});

test("a saved speaker back to System default sets the sink to the default", async () => {
  install(FULL());
  const player = audioWeb().player;
  await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" });
  assert.deepEqual(await player.useOutput(null), { device: null, missed: false });
  assert.deepEqual(world.contexts[0]!.sinkCalls, ["out-hp", ""]);
});

test("where the context cannot choose a sink, useOutput does nothing and says so", async () => {
  install(FULL(), { sink: false });
  const player = audioWeb().player;
  assert.deepEqual(await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" }), { device: null, missed: false });
  assert.equal(world.contexts.length, 0);
  assert.equal(world.enumerated, 0);
});

// ---- the speaker: lost

async function speaking(saved: { id: string; name: string } | null = { id: "out-hp", name: "Stand-in Headphones" }) {
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  await port.player.useOutput(saved);
  port.player.write(PCM);
  await settle();
  return { port, events, ctx: world.contexts[0]!, player: port.player };
}

test("a chosen public speaker unplugged: the sound moves to the default and goes on, held false", async () => {
  install(FULL());
  const { events, ctx, player } = await speaking({ id: "out-spk", name: "Desk Speakers" });
  world.unplug("out-spk");
  await settle();
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.kind, "output-lost");
  if (e.kind === "output-lost") {
    assert.equal(e.lost?.name, "Desk Speakers");
    assert.equal(e.held, false);
  }
  assert.equal(ctx.sinkId, "");
  assert.equal(ctx.state, "running");
  player.stop();
});

test("a chosen private speaker unplugged: the context is suspended before the sink moves, and stays so until resume()", async () => {
  install(FULL());
  const { events, ctx, player } = await speaking();
  ctx.log.length = 0;
  world.unplug("out-hp");
  await settle();
  const e = events[0]!;
  assert.equal(e.kind, "output-lost");
  if (e.kind === "output-lost") {
    assert.equal(e.lost?.name, "Stand-in Headphones");
    assert.equal(e.now?.name, "Desk Speakers");
    assert.equal(e.held, true);
  }
  assert.ok(ctx.log.indexOf("suspend") >= 0 && ctx.log.indexOf("suspend") < ctx.log.indexOf("sink:"));
  assert.equal(ctx.sinkId, "");
  assert.equal(ctx.state, "suspended");
  player.write(PCM);                                    // queued, not played
  assert.equal(ctx.state, "suspended");
  player.resume();
  await settle();
  assert.equal(ctx.state, "running");
  player.stop();
});

test("a held player that is stopped is free again for the next sound", async () => {
  install(FULL());
  const { ctx, player } = await speaking();
  world.unplug("out-hp");
  await settle();
  assert.equal(ctx.state, "suspended");
  player.stop();
  await settle();
  assert.equal(ctx.state, "running");
  player.write(PCM);
  assert.equal(ctx.state, "running");
  player.stop();
});

test("the engine's hold keeps the context suspended through a write; resume plays on", async () => {
  install(FULL());
  const player = audioWeb().player;
  player.write(PCM);
  player.hold();
  await settle();
  const ctx = world.contexts[0]!;
  assert.equal(ctx.state, "suspended");
  player.write(PCM);
  assert.equal(ctx.state, "suspended");
  player.resume();
  await settle();
  assert.equal(ctx.state, "running");
  player.stop();
});

test("a speaker lost with nothing chosen: the default's device went away, so the sound moved; private → public holds", async () => {
  install(FULL());
  // the default output is the headphones now
  world.devices = world.devices.map((d) => (d.deviceId === "default" && d.kind === "audiooutput" ? defaultOut(PHONES) : d));
  const { events, ctx, player } = await speaking(null);
  world.unplug("out-hp");
  world.devices = world.devices.map((d) => (d.deviceId === "default" && d.kind === "audiooutput" ? defaultOut(SPK) : d));
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  const lost = events.filter((e) => e.kind === "output-lost");
  assert.ok(lost.length >= 1);
  const e = lost[0]!;
  if (e.kind === "output-lost") {
    assert.equal(e.lost?.name, "Stand-in Headphones");
    assert.equal(e.held, true);
  }
  assert.equal(ctx.state, "suspended");
  assert.equal(ctx.sinkCalls.length, 0, "no sink was chosen, so none is moved");
  player.stop();
});

test("private → private: the sound moves to other headphones and does not hold", async () => {
  const other = output("out-hp2", "Second Headphones");
  install([...FULL(), other]);
  const { events, ctx, player } = await speaking();
  // the default is the second headphones; the chosen ones go away
  world.devices = world.devices.map((d) => (d.deviceId === "default" && d.kind === "audiooutput" ? defaultOut(other) : d));
  world.unplug("out-hp");
  await settle();
  const e = events[0]!;
  assert.equal(e.kind, "output-lost");
  if (e.kind === "output-lost") assert.equal(e.held, false);
  assert.equal(ctx.state, "running");
  player.stop();
});

test("an output that is not in use going away is no loss, and the sound is not held", async () => {
  install(FULL());
  const { events, ctx, player } = await speaking({ id: "out-spk", name: "Desk Speakers" });
  world.unplug("out-hp");
  await settle();
  assert.equal(events.length, 0);
  assert.equal(ctx.state, "running");
  player.stop();
});

test("a device plugged in during the session does not move the sound", async () => {
  install(FULL());
  const { events, ctx, player } = await speaking({ id: "out-spk", name: "Desk Speakers" });
  world.plug(output("out-new", "Brand New Speaker"));
  await settle();
  assert.equal(events.length, 0);
  assert.equal(ctx.sinkId, "out-spk");
  assert.equal(ctx.state, "running");
  player.stop();
});

test("a devicechange with nobody listening for routes is not looked at: no listing, no hold", async () => {
  install(FULL());
  const player = audioWeb().player;
  await player.useOutput({ id: "out-hp", name: "Stand-in Headphones" });
  player.write(PCM);
  const before = world.enumerated;
  world.unplug("out-hp");
  await settle();
  assert.equal(world.enumerated, before);
  assert.notEqual(world.contexts[0]!.state, "suspended");
  player.stop();
});

test("a route listener that leaves takes the devicechange listener with it", async () => {
  install(FULL());
  const port = audioWeb();
  let removed = 0;
  const rm = world.md.removeEventListener;
  world.md.removeEventListener = ((t: string, f: never, o: never) => { removed++; return rm.call(world.md, t, f, o); }) as never;
  const stop = port.onRoute(() => {});
  stop();
  assert.equal(removed, 1);
});

// ---- the speaker: lost, with no speaker ever chosen (D3F: the baseline is learnt when the first route listener subscribes)

const setDefaultOut = (of: Dev): void => {
  world.devices = world.devices.map((d) => (d.deviceId === "default" && d.kind === "audiooutput" ? defaultOut(of) : d));
};

test("no useOutput ever: headphones → loudspeakers as the default holds the context and tells output-lost with held true", async () => {
  install(FULL());
  setDefaultOut(PHONES);
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  await settle();
  port.player.write(PCM);
  await settle();
  const ctx = world.contexts[0]!;
  assert.equal(ctx.state, "running");
  world.unplug("out-hp");
  setDefaultOut(SPK);
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  const lost = events.filter((e) => e.kind === "output-lost");
  assert.equal(lost.length, 1);
  const e = lost[0]!;
  if (e.kind === "output-lost") {
    assert.equal(e.lost?.name, "Stand-in Headphones");
    assert.equal(e.now?.name, "Desk Speakers");
    assert.equal(e.held, true);
  }
  assert.equal(ctx.state, "suspended");
  assert.equal(ctx.sinkCalls.length, 0, "no sink was chosen, so none is moved");
  port.player.resume();
  await settle();
  assert.equal(ctx.state, "running");
  port.player.stop();
});

test("no useOutput ever, the default moves while the headphones stay plugged in: still a loss, still held", async () => {
  install(FULL());
  setDefaultOut(PHONES);
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  await settle();
  setDefaultOut(SPK);
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  const e = events.find((x) => x.kind === "output-lost");
  assert.ok(e && e.kind === "output-lost" && e.held === true && e.lost?.name === "Stand-in Headphones");
});

test("no useOutput ever: one pair of headphones → another is a loss without a hold", async () => {
  const other = output("out-hp2", "Second Headphones");
  install([...FULL(), other]);
  setDefaultOut(PHONES);
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  await settle();
  port.player.write(PCM);
  await settle();
  const ctx = world.contexts[0]!;
  world.unplug("out-hp");
  setDefaultOut(other);
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  const lost = events.filter((e) => e.kind === "output-lost");
  assert.equal(lost.length, 1);
  if (lost[0]!.kind === "output-lost") assert.equal(lost[0]!.held, false);
  assert.equal(ctx.state, "running");
  port.player.stop();
});

test("a loss seen before any context exists still tells held, and a context made later does not play", async () => {
  install(FULL());
  setDefaultOut(PHONES);
  const port = audioWeb();
  const events: RouteEvent[] = [];
  port.onRoute((e) => events.push(e));
  await settle();
  assert.equal(world.contexts.length, 0);
  world.unplug("out-hp");
  setDefaultOut(SPK);
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  const e = events.find((x) => x.kind === "output-lost");
  assert.ok(e && e.kind === "output-lost" && e.held === true);
  assert.equal(world.contexts.length, 0, "the loss made no context");
  port.player.write(PCM);
  await settle();
  assert.equal(world.contexts[0]!.state, "suspended");
  port.player.resume();
  await settle();
  assert.equal(world.contexts[0]!.state, "running");
  port.player.stop();
});

test("the first route listener lists the outputs once, a second one does not, and with none nothing is listed", async () => {
  install(FULL());
  const port = audioWeb();
  port.player.write(PCM);
  await port.player.useOutput(null);
  await settle();
  assert.equal(world.enumerated, 0, "no listener: nothing is listed");
  const off1 = port.onRoute(() => {});
  await settle();
  assert.equal(world.enumerated, 1);
  const off2 = port.onRoute(() => {});
  await settle();
  assert.equal(world.enumerated, 1);
  off1();
  off2();
  world.md.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.equal(world.enumerated, 1, "the last listener left: the devicechange is not looked at");
  port.player.stop();
});

test("a listener on a port that cannot choose a sink lists nothing", async () => {
  install(FULL(), { sink: false });
  const port = audioWeb();
  port.onRoute(() => {});
  await settle();
  assert.equal(world.enumerated, 0);
});

test("the engine's hold before the context exists sticks: the context made by the first write is suspended", async () => {
  install(FULL());
  const player = audioWeb().player;
  player.hold();
  assert.equal(world.contexts.length, 0);
  player.write(PCM);
  await settle();
  const ctx = world.contexts[0]!;
  assert.equal(ctx.state, "suspended");
  player.resume();
  await settle();
  assert.equal(ctx.state, "running");
  player.stop();
});

// ---- no device name in the console

test("no device name is written to the console through a whole lost-device run", async () => {
  install([input("in-x", "CANARY-MIC-77"), output("out-x", "CANARY-OUT-77 Headphones"), SPK, HEAD]);
  const spy = spyConsole();
  try {
    const { port, ctx, player } = await speaking({ id: "out-x", name: "CANARY-OUT-77 Headphones" });
    const mic = await startMic(port, { id: "in-x", name: "CANARY-MIC-77" });
    world.unplug("in-x");
    world.unplug("out-x");
    await settle();
    await mic.stop();
    assert.equal(ctx.sinkId, "");
    player.stop();
    await port.devices.list();
    await startMic(port, { id: "missing", name: "CANARY-MIC-77" }).then((m) => m.stop());
  } finally { spy.restore(); }
  assert.deepEqual(spy.seen.filter((l) => l.includes("CANARY")), []);
});
