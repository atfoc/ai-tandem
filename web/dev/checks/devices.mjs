// The stand-in audio devices of the voice-devices checks (plans/voice-devices/architecture.md VD-19 item 3; no dash in the name, the runner does not
// take it for a check). `installDevices(page | context, { inputs, outputs, granted })` puts them into every page, before the app loads
// (`addInitScript`): a stand-in `navigator.mediaDevices` and a wrapped `AudioContext.prototype.setSinkId`, so that a check can add and remove
// microphones and speakers, which the browser's fake devices (shot.mjs BROWSER_ARGS) cannot. It takes the place of mic.mjs's synthetic microphone in
// the device check; the other VC checks keep mic.mjs. No real device and no real sound is touched.
//
//   inputs   [{ id, label, hz?, groupId? }]   microphones. Each answers a stream of an oscillator at its own `hz` (440 when none), so that the
//                                              stand-in voice service (voicestandin.mjs, `toneHz` of an STT session) tells which one was heard
//   outputs  [{ id, label, groupId? }]        speakers
//   granted  false                            the microphone permission. Until it is given (`grant()`, or a successful getUserMedia, as a browser does)
//                                              enumerateDevices answers one blank entry per kind (platforms.md §2) and setSinkId rejects a listed id
//   persist  true                             the devices, and whether they are granted, are kept in the tab's sessionStorage, so that a reload of the
//                                              page (the app "restarted") finds the stand-in as it was left; a different `inputs`/`outputs`/`granted`
//                                              starts anew. false: every load starts from the options
//   setSinkId true                            false: the page has no `AudioContext.prototype.setSinkId`, as Firefox and Safari (the Speaker choice is not offered)
//
// What the page sees:
//   enumerateDevices()   granted: for each kind that has a device, the "default" entry first (label "Default - <first device>", as Chromium's), then
//                        each device (deviceId, label, groupId, kind "audioinput" | "audiooutput"); not granted: the blank pair
//   getUserMedia({audio})  honours deviceId as a string, { exact } or { ideal } (a list too), also the pseudo ids "default" and "communications";
//                        an exact id nobody has: OverconstrainedError; no microphone at all: NotFoundError. The stream is an oscillator at the device's
//                        frequency; its track has the device's label and getSettings().deviceId (the id asked for, "default" included); a track
//                        ends (readyState "ended", an `ended` event) when its device is unplugged, and track.stop() stops the sound. Success grants
//   setSinkId(id)        "" / "default" / { type: "none" } resolve, the id of a listed output (granted) resolves, anything else rejects NotFoundError.
//                        The context's `sinkId` reads back what was set. An unplugged output leaves the context's sink as it was ("gone" in the record)
//   devicechange         fired (a task later) on navigator.mediaDevices by plug() and unplug(); not by grant() (Chromium fires none on a permission)
//
// What the check sees, `window.__aiwbDevices` (every value is plain data, so page.evaluate returns it):
//   list()      the devices as they are, granted or not: [{ kind: "input" | "output", id, label, groupId, hz? }] (no "default" entry)
//   plug(d)     adds a device { kind: "input" | "output" (or "audioinput" | "audiooutput"), id, label, hz?, groupId? }; devicechange
//   unplug(id)  removes the device with that id (true when there was one); its live tracks end; devicechange
//   grant()     the permission is given; granted() tells
//   opened()    every getUserMedia that succeeded, in order: [{ requested: id asked for | null, deviceId: the device that answered, label, hz, live }]
//   sinks()     every AudioContext of the page (not the stand-in's own), in the order made: [{ index, state, sinkId, default, gone, calls }]
//               sinkId: the id set ("" until one is), or "none"; default: it plays on the system's default; gone: its sink was unplugged;
//               calls: every id setSinkId was asked for, in order
//   calls()     { enumerateDevices, getUserMedia, setSinkId }: how many times each was called in this page (for "no listing before Settings")
// The layer logs nothing to the console and keeps no name anywhere but in the page's memory and, with persist, sessionStorage.

/** Two microphones and two speakers, the ones of architecture §12.2 (the second of each is the private one). */
export const STANDIN_DEVICES = {
  inputs: [
    { id: "mic-desk", label: "Desk Mic", hz: 300 },
    { id: "mic-headset", label: "Stand-in Headset", hz: 700 },
  ],
  outputs: [
    { id: "out-desk", label: "Desk Speakers" },
    { id: "out-headphones", label: "Stand-in Headphones" },
  ],
};

/** Installs the stand-in devices in a page or a browser context; call it before the page goes to the app. */
export async function installDevices(target, { inputs = STANDIN_DEVICES.inputs, outputs = STANDIN_DEVICES.outputs, granted = false, persist = true, setSinkId = true } = {}) {
  await target.addInitScript(deviceLayer, { inputs, outputs, granted, persist, setSinkId });
}

/** The page's side. It is serialised and run in the page (and in a fake global by devices.test.mjs), so it names nothing outside itself. */
export function deviceLayer(config, g = globalThis) {
  if (g.__aiwbDevices) return;
  const nav = g.navigator;
  if (!nav) return;
  const KIND = { input: "audioinput", output: "audiooutput", audioinput: "audioinput", audiooutput: "audiooutput" };
  const PSEUDO = ["default", "communications"];
  const KEY = "aiwb.devices.standin";
  const signature = JSON.stringify([config.inputs, config.outputs, !!config.granted]);

  const norm = (d, kind) => {
    const k = KIND[kind ?? d.kind];
    if (!k || typeof d.id !== "string" || !d.id || typeof d.label !== "string") throw new TypeError("a stand-in device needs a kind, an id and a label");
    return { kind: k, id: d.id, label: d.label, groupId: d.groupId ?? "group-" + d.id, hz: k === "audioinput" ? (d.hz ?? 440) : undefined };
  };
  const pub = (d) => ({ kind: d.kind === "audioinput" ? "input" : "output", id: d.id, label: d.label, groupId: d.groupId, ...(d.hz === undefined ? {} : { hz: d.hz }) });

  let devices = [...(config.inputs ?? []).map((d) => norm(d, "input")), ...(config.outputs ?? []).map((d) => norm(d, "output"))];
  let granted = !!config.granted;
  const store = (() => { try { return config.persist === false ? null : g.sessionStorage ?? null; } catch { return null; } })();
  if (store) {
    try {
      const was = JSON.parse(store.getItem(KEY) ?? "null");
      if (was && was.signature === signature) { devices = was.devices; granted = was.granted; }
    } catch { /* (nothing readable is kept: start from the options) */ }
  }
  const save = () => { try { store?.setItem(KEY, JSON.stringify({ signature, devices, granted })); } catch { /* (the tab keeps nothing) */ } };
  save();

  const count = { enumerateDevices: 0, getUserMedia: 0, setSinkId: 0 };
  let md = nav.mediaDevices;
  if (!md) { md = new g.EventTarget(); Object.defineProperty(nav, "mediaDevices", { value: md, configurable: true }); }
  const change = () => { void Promise.resolve().then(() => setTimeout(() => md.dispatchEvent(new g.Event("devicechange")), 0)); };
  const ofKind = (kind) => devices.filter((d) => d.kind === kind);
  const pseudo = (id) => PSEUDO.includes(id);

  // ---- listing

  const info = (kind, deviceId, label, groupId) => ({ deviceId, kind, label, groupId, toJSON() { return { deviceId, kind, label, groupId }; } });
  const visible = () => {
    if (!granted) return [info("audioinput", "", "", ""), info("audiooutput", "", "", "")];
    const out = [];
    for (const kind of ["audioinput", "audiooutput"]) {
      const some = ofKind(kind);
      if (!some.length) continue;
      out.push(info(kind, "default", "Default - " + some[0].label, some[0].groupId));
      for (const d of some) out.push(info(kind, d.id, d.label, d.groupId));
    }
    return out;
  };
  md.enumerateDevices = async () => { count.enumerateDevices++; return visible(); };

  // ---- capture

  const Base = g.AudioContext;
  const live = [];
  const opened = [];
  const ids = (v) => (v == null ? [] : typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const resolve = (id) => (pseudo(id) ? ofKind("audioinput")[0] : devices.find((d) => d.kind === "audioinput" && d.id === id));
  const gone = (message, name) => new g.DOMException(message, name);
  const overconstrained = () => {
    const e = typeof g.OverconstrainedError === "function" ? new g.OverconstrainedError("deviceId", "The deviceId constraint could not be satisfied.") : new Error("The deviceId constraint could not be satisfied.");
    if (e.name !== "OverconstrainedError") Object.defineProperty(e, "name", { value: "OverconstrainedError" });
    return e;
  };

  md.getUserMedia = async (constraints) => {
    count.getUserMedia++;
    if (!constraints || (!constraints.audio && !constraints.video)) throw new TypeError("At least one of audio and video must be requested");
    if (constraints.video || !Base) throw gone("Requested device not found", "NotFoundError");
    const asked = constraints.audio === true ? undefined : constraints.audio?.deviceId;
    const exact = asked && typeof asked === "object" && !Array.isArray(asked) ? ids(asked.exact) : [];
    const ideal = asked && typeof asked === "object" && !Array.isArray(asked) ? ids(asked.ideal) : ids(asked);
    let id = null, dev;
    if (exact.length) {
      id = exact.find((x) => resolve(x)) ?? null;
      if (id === null) throw overconstrained();
      dev = resolve(id);
    } else {
      id = ideal.find((x) => resolve(x)) ?? null;
      dev = id === null ? ofKind("audioinput")[0] : resolve(id);
    }
    if (!dev) throw gone("Requested device not found", "NotFoundError");

    const ctx = new Base();
    const osc = ctx.createOscillator(), out = ctx.createMediaStreamDestination();
    osc.frequency.value = dev.hz;
    osc.connect(out);
    osc.start();
    if (ctx.state !== "running") await Promise.resolve(ctx.resume()).catch(() => {});
    const stream = out.stream, track = stream.getAudioTracks()[0];
    const rec = { requested: id, device: dev, stopped: false };
    const real = track.stop.bind(track);
    const end = (event) => {
      if (rec.stopped) return;
      rec.stopped = true;
      real();
      try { osc.stop(); } catch { /* (stopped already) */ }
      try { void Promise.resolve(ctx.close()).catch(() => {}); } catch { /* (closed already) */ }
      if (event) track.dispatchEvent(new g.Event("ended"));
    };
    track.stop = () => end(false);
    Object.defineProperty(track, "label", { get: () => (id !== null && pseudo(id) ? "Default - " + dev.label : dev.label), configurable: true });
    const settings = track.getSettings?.bind(track);
    track.getSettings = () => ({ ...(settings ? settings() : {}), deviceId: id ?? "default", groupId: dev.groupId });
    live.push({ rec, end });
    opened.push(rec);
    if (!granted) { granted = true; save(); }
    return stream;
  };

  // ---- playback

  const contexts = [];
  if (Base) {
    const proto = Base.prototype;
    const known = new WeakMap();
    const register = (ctx, sinkId) => {
      let r = known.get(ctx);
      if (r) return r;
      r = { ctx, sinkId: typeof sinkId === "string" ? sinkId : "", calls: typeof sinkId === "string" ? [sinkId] : [] };
      known.set(ctx, r);
      contexts.push(r);
      Object.defineProperty(ctx, "sinkId", { get: () => (r.sinkId === "none" ? { type: "none" } : r.sinkId), configurable: true });
      return r;
    };
    if (config.setSinkId === false) delete proto.setSinkId;
    else {
      proto.setSinkId = async function setSinkId(id) {
        count.setSinkId++;
        const r = register(this);
        const key = typeof id === "string" ? id : id && id.type === "none" ? "none" : null;
        r.calls.push(key ?? "(not an id)");
        if (key === null) throw new TypeError("setSinkId takes an id or { type: \"none\" }");
        if (key !== "" && key !== "default" && key !== "none" && !(granted && ofKind("audiooutput").some((d) => d.id === key))) throw gone("The device could not be found.", "NotFoundError");
        r.sinkId = key;
      };
    }
    class AudioContext extends Base {
      constructor(...args) { super(...args); register(this, args[0]?.sinkId); }
    }
    g.AudioContext = AudioContext;
  }
  const sinkRecord = (r, index) => {
    const sink = r.sinkId;
    const isDefault = sink === "" || sink === "default";
    return {
      index, state: r.ctx.state, sinkId: sink, default: isDefault, calls: [...r.calls],
      gone: !isDefault && sink !== "none" && !ofKind("audiooutput").some((d) => d.id === sink),
    };
  };

  // ---- the control

  g.__aiwbDevices = {
    list: () => devices.map(pub),
    plug(d) {
      const dev = norm(d);
      if (devices.some((x) => x.id === dev.id)) throw new Error("a device with that id is plugged in already");
      devices.push(dev);
      save();
      change();
    },
    unplug(id) {
      const at = devices.findIndex((d) => d.id === id);
      if (at < 0) return false;
      const [dev] = devices.splice(at, 1);
      save();
      for (const l of [...live]) if (l.rec.device.id === dev.id) l.end(true);
      change();
      return true;
    },
    grant() { granted = true; save(); },
    granted: () => granted,
    opened: () => opened.map((r) => ({ requested: r.requested, deviceId: r.device.id, label: r.device.label, hz: r.device.hz, live: !r.stopped })),
    sinks: () => contexts.map(sinkRecord),
    calls: () => ({ ...count }),
  };
}
