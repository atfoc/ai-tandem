import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createClient, type Client } from "@aiwb/conn";
import type { Envelope } from "@aiwb/core/transport/types.ts";

import { createFakeAiwbNet } from "../modules/aiwb-net/src/fake.ts";
import { pickImagesWith, takePhotoWith, type CameraPort, type ImagePickerPort } from "../src/platform/imagepickcore.ts";
import { nativeConnector } from "../src/platform/net/nativeConnector.ts";
import { createNativeTransport, type AppStatePort } from "../src/platform/nativetransport.ts";
import { PICTURES_FOLDER, createPictureCache, type FsModule } from "../src/platform/picturecache.ts";
import { askPicture } from "../src/platform/pictureask.ts";
import { PictureError } from "../src/platform/picturefile.ts";
import { isFileUri } from "../src/platform/pictureuri.ts";

// The scripted server, the stores and the waits are CommonJS without types (packages/conn/test).
const require = createRequire(import.meta.url);
const { ScriptedServer } = require("../../packages/conn/test/fakes/scripted-server.js");
const { memoryStore } = require("../../packages/conn/test/fakes/memory-store.js");
const { FAST, until, sleep, seededRandom } = require("../../packages/conn/test/fakes/support.js");

// ---- fakes of what the phone gives: the app state, and expo-file-system in memory

function fakeAppState() {
  const listeners = new Set<(s: string) => void>();
  const port: AppStatePort = {
    addEventListener: (_t, f) => { listeners.add(f); return { remove: () => { listeners.delete(f); } }; },
  };
  return { port, emit: (s: string) => { for (const f of [...listeners]) f(s); }, count: () => listeners.size };
}

// A tree of files by `file://` address. `fail` makes the next write throw.
function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const log = { writes: 0, moves: 0 };
  const state = { failWrite: false };
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === "string" ? p : (p as { uri: string }).uri)).join("/").replace(/(?<![:/])\/{2,}/g, "/");
  class Dir { uri: string; constructor(...p: unknown[]) { this.uri = join(p); } create() {} }
  class File {
    uri: string;
    constructor(...p: unknown[]) { this.uri = join(p); }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length ?? 0; }
    create() { if (!files.has(this.uri)) files.set(this.uri, new Uint8Array(0)); }
    write(c: Uint8Array) { if (state.failWrite) throw new Error("disk full"); log.writes++; files.set(this.uri, c); }
    delete() { files.delete(this.uri); }
    async bytes() { const b = files.get(this.uri); if (!b) throw new Error("no such file"); return b; }
    async move(d: unknown) { const to = (d as File).uri; files.set(to, files.get(this.uri)!); files.delete(this.uri); log.moves++; this.uri = to; }
  }
  const fs: FsModule = { File: File as never, Directory: Dir as never, Paths: { cache: new Dir("file:///cache") } };
  return { fs, files, log, state };
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const id = (n: number) => n.toString(16).padStart(64, "0");

function rig(server: Record<string, unknown> = {}, timing: Record<string, unknown> = {}) {
  const s = new ScriptedServer(server);
  const net = createFakeAiwbNet(s);
  const client: Client = createClient({
    connector: nativeConnector(net), store: memoryStore(), local: null,
    timing: { ...FAST, ...timing }, random: seededRandom(),
  });
  const app = fakeAppState();
  const disk = fakeFs();
  const picks: unknown[] = [];
  const t = createNativeTransport(client, { appState: app.port, cache: createPictureCache(disk.fs), pickImages: async () => (picks.shift() as never) });
  const envelopes: Envelope[] = [];
  const states: string[] = [];
  const stateOf = (sid: string) => {
    let st: string | null = null;
    for (const e of envelopes) if ("app" in e && e.app.type === "server_state" && e.app.server.id === sid) st = e.app.server.state;
    return st;
  };
  // adds the server as an entry, subscribes, and waits for it to be connected
  async function connected() {
    const sub = t.stream((e) => envelopes.push(e), (st) => states.push(st));
    const a = await t.app("servers.add", { force: true, form: { name: "Remote", address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint } });
    const sid = JSON.parse(a.text).server.id as string;
    await until(() => stateOf(sid) === "connected", "connected");
    return { sub, sid };
  }
  return { s, net, client, t, app, disk, picks, envelopes, states, stateOf, connected, close: () => client.close() };
}

// ---- the transport

test("native transport: its way, the pieces it has, and a call answered as the Client answers it", async () => {
  const r = rig();
  try {
    assert.equal(r.t.way, "native");
    assert.equal(r.t.pictureURL, undefined);
    assert.equal(typeof r.t.pickImages, "function");
    const { sub, sid } = await r.connected();
    r.s.routes.set("GET /api/dirs", () => ({ json: { dirs: ["/a"] }, headers: { "x-aiwb-scene-rev": "7" } }));
    r.s.routes.set("POST /api/chats/c1/open", (req: any) => ({ json: { body: new TextDecoder().decode(req.body), type: req.headers["content-type"] } }));
    assert.deepEqual(await r.t.call({ server: sid, method: "GET", path: "/api/dirs" }), { status: 200, text: '{"dirs":["/a"]}', sceneRev: 7 });
    const json = await r.t.call({ server: sid, method: "POST", path: "/api/chats/c1/open", body: { json: '{"é":1}' } });
    assert.deepEqual(JSON.parse(json.text), { body: '{"é":1}', type: "application/json" });
    // bytes, and a Blob (turned into bytes first)
    r.s.routes.set("POST /api/chats/c1/images", (req: any) => ({ json: { n: req.body.length, type: req.headers["content-type"] } }));
    const bytes = await r.t.call({ server: sid, method: "POST", path: "/api/chats/c1/images", body: { bytes: PNG, type: "image/png" } });
    assert.deepEqual(JSON.parse(bytes.text), { n: PNG.length, type: "image/png" });
    const blob = await r.t.call({ server: sid, method: "POST", path: "/api/chats/c1/images", body: { bytes: new Blob([PNG as BlobPart]), type: "image/png" } });
    assert.deepEqual(JSON.parse(blob.text), { n: PNG.length, type: "image/png" });
    assert.equal((await r.t.call({ server: "nobody", method: "GET", path: "/api/dirs" })).status, 404);
    // the secret is the Client's: it was sent, and it is in no answer
    assert.ok(r.s.requests.every((q: any) => q.path === "/api/hello" || q.headers["x-aiwb-secret"] === r.s.secret));
    assert.ok(!JSON.stringify([json, bytes, blob]).includes(r.s.secret));
    sub.close();
  } finally { await r.close(); }
});

test("native transport: a call is aborted with an AbortError, before it is sent or while it waits", async () => {
  const r = rig({}, { call: 5000 });
  try {
    const { sid } = await r.connected();
    r.s.routes.set("POST /api/chats/c1/messages", () => new Promise(() => {}));
    const ac = new AbortController();
    const pending = r.t.call({ server: sid, method: "POST", path: "/api/chats/c1/messages", body: { json: "{}" }, signal: ac.signal });
    await sleep(20);
    ac.abort();
    await assert.rejects(pending, (e: any) => e.name === "AbortError");
    await assert.rejects(r.t.call({ server: sid, method: "GET", path: "/api/dirs", signal: ac.signal }), (e: any) => e.name === "AbortError");
  } finally { await r.close(); }
});

test("native transport: the stream's envelopes come in order, open at once, and closing it ends them", async () => {
  const r = rig();
  try {
    const { sub, sid } = await r.connected();
    assert.deepEqual(r.states, ["open"]);
    for (let i = 1; i <= 3; i++) r.s.emit({ type: "tick", n: i });
    await until(() => r.envelopes.filter((e) => "server" in e && e.event.type === "tick").length === 3, "three ticks");
    const mine = r.envelopes.map((e) => ("server" in e ? `${e.event.type}${e.event.n ?? ""}` : `${e.app.type}:${e.app.type === "server_state" ? e.app.server.state : ""}`));
    assert.deepEqual(mine.slice(-6), ["hello", "snapshot", "server_state:connected", "tick1", "tick2", "tick3"]);
    assert.equal(mine[0], "servers:");
    assert.equal(r.app.count(), 1);
    sub.close();
    sub.close();
    assert.equal(r.app.count(), 0, "the app-state listener is removed");
    const before = r.envelopes.length;
    r.s.emit({ type: "tick", n: 4 });
    await sleep(60);
    assert.equal(r.envelopes.length, before, "nothing after close");
    assert.deepEqual(r.states, ["open"], "closing is not the transport ending the stream");
    assert.ok(sid);
  } finally { await r.close(); }
});

test("native transport: wake on `active` makes an entry in its back-off try now and ends nothing; `background` does nothing", async () => {
  const r = rig({ eventsAnswer: () => ({ status: 500, text: "{}" }) }, { backoff: [60000] });
  try {
    const sub = r.t.stream((e) => r.envelopes.push(e), (st) => r.states.push(st));
    const a = await r.t.app("servers.add", { force: true, form: { name: "Remote", address: r.s.address, secret: r.s.secret, selfSigned: true, pin: r.s.fingerprint } });
    const sid = JSON.parse(a.text).server.id as string;
    const events = () => r.s.requests.filter((q: any) => q.path.startsWith("/api/events")).length;
    await until(() => r.stateOf(sid) === "unreachable", "unreachable");
    await sleep(120);
    const asked = events();
    r.s.eventsAnswer = null;
    r.app.emit("background");
    r.app.emit("inactive");
    await sleep(120);
    assert.equal(events(), asked, "going away asks nothing");
    r.app.emit("active");
    await until(() => r.stateOf(sid) === "connected", "connected after the wake");
    // a wake on a connected entry ends nothing
    const seen = r.envelopes.length;
    r.app.emit("active");
    r.s.emit({ type: "tick", n: 1 });
    await until(() => r.envelopes.length > seen, "the next event");
    assert.equal(r.stateOf(sid), "connected");
    assert.deepEqual(r.states, ["open"], "the stream was not reported closed");
    sub.close();
  } finally { await r.close(); }
});

test("native transport: `app` ops are answered as text", async () => {
  const r = rig();
  try {
    const list = await r.t.app("servers.list");
    assert.equal(list.status, 200);
    assert.equal(typeof list.text, "string");
    assert.deepEqual(JSON.parse(list.text), (await r.client.app("servers.list")).body);
    const owner = await r.t.app("owner.status");
    assert.equal(owner.status, 404);
    assert.equal(JSON.parse(owner.text).code, "no_owner", "a phone has no server of its own");
  } finally { await r.close(); }
});

// ---- pictures

test("native transport: picture() writes once, then answers the cached file without a fetch", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.routes.set(`GET /api/chats/c1/images/${id(1)}`, () => ({ bytes: PNG, type: "text/html" }));
    const fetches = () => r.s.requests.filter((q: any) => q.path.includes("/images/")).length;
    const uri = await r.t.picture(sid, "c1", id(1));
    assert.equal(uri, `file:///cache/${PICTURES_FOLDER}/${sid}/${id(1)}`);
    assert.ok(isFileUri(uri));
    assert.deepEqual(r.disk.files.get(uri), PNG);
    assert.equal(fetches(), 1);
    assert.equal(await r.t.picture(sid, "c1", id(1)), uri);
    assert.equal(fetches(), 1, "the second time asks no one");
    assert.equal(r.disk.log.writes, 1);
    assert.equal([...r.disk.files.keys()].filter((k) => k.endsWith(".tmp")).length, 0, "no temporary file is left");
    // not connected: the cached one is still answered
    r.s.down("refused");
    assert.equal(await r.t.picture(sid, "c1", id(1)), uri);
  } finally { await r.close(); }
});

test("native transport: picture() rejects with the answer's status, for bytes that are no image, a bad id or an abort; nothing is written", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.routes.set(`GET /api/chats/c1/images/${id(2)}`, () => ({ bytes: new TextEncoder().encode("<svg onload=alert(1)>"), type: "image/png" }));
    r.s.routes.set(`GET /api/chats/c1/images/${id(3)}`, () => ({ status: 404, json: { error: "no such image", code: "not_found" } }));
    await assert.rejects(r.t.picture(sid, "c1", id(2)), (e: any) => e instanceof PictureError && e.status === 502);
    await assert.rejects(r.t.picture(sid, "c1", id(3)), (e: any) => e instanceof PictureError && e.status === 404);
    await assert.rejects(r.t.picture(sid, "c1", "../../x"), (e: any) => e instanceof PictureError && e.status === 400);
    await assert.rejects(r.t.picture("../x", "c1", id(1)), (e: any) => e instanceof PictureError && e.status === 400);
    await assert.rejects(r.t.picture("nobody", "c1", id(1)), (e: any) => e instanceof PictureError && e.status === 404);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(r.t.picture(sid, "c1", id(1), ac.signal), (e: any) => e.name === "AbortError");
    assert.equal(r.disk.files.size, 0);
  } finally { await r.close(); }
});

// ---- cancelling a picture (D-PC-08): a <Picture> that goes before its bytes came stops the fetch

const imagePath = (n: number) => `/api/chats/c1/images/${id(n)}`;
const asked = (r: ReturnType<typeof rig>, n: number) => r.s.requests.filter((q: any) => q.path === imagePath(n)).length;
const cancelsOf = (r: ReturnType<typeof rig>) => r.net.calls.filter((c) => c.fn === "cancel").length;

test("native transport: a picture whose signal aborts before the bytes came is cancelled on the session and writes nothing", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.hangPaths.add(imagePath(1));
    const cancels = cancelsOf(r);
    const ac = new AbortController();
    const p = r.t.picture(sid, "c1", id(1), ac.signal);
    await until(() => asked(r, 1) === 1, "asked");
    ac.abort();
    await assert.rejects(p, (e: any) => e.name === "AbortError");
    await until(() => cancelsOf(r) === cancels + 1, "the request was cancelled on the session");
    assert.equal(r.disk.files.size, 0);
    assert.equal(r.disk.log.writes, 0);
    // a later call asks afresh and is not held by the cancelled one
    r.s.hangPaths.delete(imagePath(1));
    r.s.routes.set(`GET ${imagePath(1)}`, () => ({ bytes: PNG, type: "image/png" }));
    assert.ok((await r.t.picture(sid, "c1", id(1))).endsWith(id(1)));
    assert.equal(asked(r, 1), 2);
  } finally { await r.close(); }
});

test("native transport: a picture waiting for one of the eight places leaves the queue when its signal aborts, and is never asked", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.s.routes.set("GET /api/chats/c1/images/*", async () => { await gate; return { bytes: PNG, type: "image/png" }; });
    const first = Array.from({ length: 8 }, (_, i) => r.t.picture(sid, "c1", id(10 + i)));
    await until(() => r.s.requests.filter((q: any) => q.path.includes("/images/")).length === 8, "eight asked");
    const ac = new AbortController();
    const waiting = r.t.picture(sid, "c1", id(30), ac.signal);
    await sleep(50);
    ac.abort();
    await assert.rejects(waiting, (e: any) => e.name === "AbortError");
    release();
    await Promise.all(first);
    assert.equal(asked(r, 30), 0);
    assert.equal(r.disk.files.size, 8, "only the eight that were wanted");
  } finally { await r.close(); }
});

test("native transport: two callers of one picture share one fetch, which is aborted only when neither wants it", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.hangPaths.add(imagePath(1));
    const cancels = cancelsOf(r);
    const a = new AbortController();
    const b = new AbortController();
    const pa = r.t.picture(sid, "c1", id(1), a.signal);
    const pb = r.t.picture(sid, "c1", id(1), b.signal);
    await until(() => asked(r, 1) >= 1, "asked");
    await sleep(50);
    assert.equal(asked(r, 1), 1, "one fetch for both");
    a.abort();
    await assert.rejects(pa, (e: any) => e.name === "AbortError");
    await sleep(50);
    assert.equal(cancelsOf(r), cancels, "one still wants it: the fetch goes on");
    b.abort();
    await assert.rejects(pb, (e: any) => e.name === "AbortError");
    await until(() => cancelsOf(r) === cancels + 1, "neither wants it: cancelled on the session");
    assert.equal(r.disk.files.size, 0);
  } finally { await r.close(); }
});

test("native transport: the caller that stays gets the picture when the other one leaves, and the fetch is not repeated", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.s.routes.set(`GET ${imagePath(1)}`, async () => { await gate; return { bytes: PNG, type: "image/png" }; });
    const cancels = cancelsOf(r);
    const a = new AbortController();
    const pa = r.t.picture(sid, "c1", id(1), a.signal);
    const pb = r.t.picture(sid, "c1", id(1)); // a caller with no signal wants it for good
    await until(() => asked(r, 1) >= 1, "asked");
    a.abort();
    await assert.rejects(pa, (e: any) => e.name === "AbortError");
    release();
    const uri = await pb;
    assert.deepEqual(r.disk.files.get(uri), PNG);
    assert.equal(asked(r, 1), 1);
    assert.equal(cancelsOf(r), cancels);
    assert.equal(r.disk.log.writes, 1);
  } finally { await r.close(); }
});

test("native transport: a picture that has finished is not aborted by a signal that aborts afterwards, and stays in the cache", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.routes.set(`GET ${imagePath(1)}`, () => ({ bytes: PNG, type: "image/png" }));
    const cancels = cancelsOf(r);
    const ac = new AbortController();
    const uri = await r.t.picture(sid, "c1", id(1), ac.signal);
    ac.abort();
    await sleep(20);
    assert.equal(cancelsOf(r), cancels);
    assert.deepEqual(r.disk.files.get(uri), PNG);
    assert.equal(await r.t.picture(sid, "c1", id(1)), uri);
    assert.equal(asked(r, 1), 1);
  } finally { await r.close(); }
});

test("<Picture>'s ask: stopping before the answer aborts the signal and says nothing afterwards; a finished ask is not aborted", async () => {
  const seen: AbortSignal[] = [];
  const said: string[] = [];
  let answer!: (a: string) => void;
  let refuse!: (e: unknown) => void;
  const ask = (_s: string, _c: string, _i: string, signal?: AbortSignal) => {
    seen.push(signal!);
    return new Promise<string>((res, rej) => { answer = res; refuse = rej; });
  };
  const on = { address: (a: string) => said.push(`address ${a}`), failed: () => said.push("failed") };

  const stop = askPicture(ask, "s", "c", "i", on);
  await sleep(0);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal && !seen[0].aborted);
  stop();
  assert.equal(seen[0].aborted, true, "the signal reaches the seam when the picture goes");
  refuse(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await sleep(0);
  answer("file:///late");
  await sleep(0);
  assert.deepEqual(said, [], "no state is set after the stop, whether the request failed or answered");

  const done = askPicture(ask, "s", "c", "i", on);
  await sleep(0);
  answer("file:///x");
  await sleep(0);
  done();
  assert.deepEqual(said, ["address file:///x"]);
  assert.equal(seen[1].aborted, true, "stopping after the answer aborts a signal nobody listens to any more");

  const bad = askPicture(ask, "s", "c", "i", on);
  await sleep(0);
  refuse(new Error("404"));
  await sleep(0);
  assert.deepEqual(said, ["address file:///x", "failed"]);
  bad();
});

test("native transport: a write that fails rejects and leaves no half file for the next call to answer", async () => {
  const r = rig();
  try {
    const { sid } = await r.connected();
    r.s.routes.set(`GET /api/chats/c1/images/${id(1)}`, () => ({ bytes: PNG, type: "image/png" }));
    r.disk.state.failWrite = true;
    await assert.rejects(r.t.picture(sid, "c1", id(1)), /disk full/);
    assert.equal(r.disk.files.size, 0);
    r.disk.state.failWrite = false;
    assert.ok((await r.t.picture(sid, "c1", id(1))).endsWith(id(1)));
  } finally { await r.close(); }
});

test("<Picture> draws only file:// addresses (AD-36 point 3): any other scheme is the broken tile", () => {
  assert.ok(isFileUri("file:///var/mobile/Containers/Data/Application/X/Library/Caches/aiwb-pictures/s_1/abc"));
  assert.ok(isFileUri("FILE:///cache/x"));
  for (const bad of ["http://127.0.0.1/x", "https://example.test/x.png", "data:image/png;base64,AAAA", "content://media/1", "blob:abc", "aiwb-picture://p/s/c/i", "/host/picture/x", "x.png", "", " file:///x", "javascript:file://"]) {
    assert.equal(isFileUri(bad), false, bad);
  }
});

// ---- picking

const asset = (name: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => ({ uri: `file:///picked/${name}`, fileName: name, bytes, ...extra });

function picker(assets: ReturnType<typeof asset>[], canceled = false) {
  const disk = fakeFs();
  for (const a of assets) disk.files.set(a.uri, a.bytes);
  const asked: unknown[] = [];
  const port: ImagePickerPort = {
    launchImageLibraryAsync: async (o) => { asked.push(o); return canceled ? { canceled: true } : { canceled: false, assets: assets.map((a) => ({ uri: a.uri, fileName: a.fileName, ...("fileSize" in a ? { fileSize: a.fileSize as number } : {}) })) }; },
  };
  return { port, disk, asked };
}

test("pickImages: asks the library for several images; a PNG is answered with its type taken from the bytes", async () => {
  const p = picker([asset("a.heic", PNG), asset("noext", Uint8Array.from([0xff, 0xd8, 0xff, 1]))]);
  const r = await pickImagesWith(p.port, p.disk.fs as never);
  // (`compatible`: iOS hands a HEIC of the library over as a JPEG; found by the device test of package V4, where `automatic` handed it over as a HEIC)
  assert.deepEqual(p.asked, [{ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 1, preferredAssetRepresentationMode: "compatible" }]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.files.map((f) => [f.name, f.type, f.data.length]), [["a.heic", "image/png", PNG.length], ["noext", "image/jpeg", 4]]);
});

test("pickImages: refuses a 6 MB file (without reading it) and a PDF, and says why", async () => {
  const big = new Uint8Array(6 * 1024 * 1024); big.set(PNG);
  const pdf = new TextEncoder().encode("%PDF-1.7\n...");
  const p = picker([asset("big.png", big), asset("doc.pdf", pdf), asset("ok.png", PNG), asset("sized.png", PNG, { fileSize: 6 * 1024 * 1024 })]);
  let reads = 0;
  const File = p.disk.fs.File;
  p.disk.fs.File = class extends (File as never as new (...a: unknown[]) => { bytes(): Promise<Uint8Array>; uri: string }) {
    async bytes() { reads++; return super.bytes(); }
  } as never;
  const r = await pickImagesWith(p.port, p.disk.fs as never);
  assert.deepEqual(r.skipped, [{ name: "big.png", reason: "size" }, { name: "doc.pdf", reason: "type" }, { name: "sized.png", reason: "size" }]);
  assert.deepEqual(r.files.map((f) => f.name), ["ok.png"]);
  assert.equal(reads, 2, "the 6 MB files whose size was known were not read");
});

test("pickImages: a cancelled picker, a file that cannot be read and more than a message takes", async () => {
  assert.deepEqual(await pickImagesWith(picker([], true).port, fakeFs().fs as never), { files: [], skipped: [] });
  const many = Array.from({ length: 12 }, (_, i) => asset(`p${i}.png`, PNG));
  const p = picker([...many, asset("gone.png", PNG)]);
  p.disk.files.delete("file:///picked/gone.png");
  const r = await pickImagesWith(p.port, p.disk.fs as never);
  assert.equal(r.files.length, 10);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["count", "count", "count"]);
  const q = picker([asset("gone.png", PNG)]);
  q.disk.files.clear();
  assert.deepEqual((await pickImagesWith(q.port, q.disk.fs as never)).skipped, [{ name: "gone.png", reason: "read" }]);
});

// ---- the camera (Take photo)

function camera(assets: ReturnType<typeof asset>[], o: { granted?: boolean; canceled?: boolean } = {}) {
  const disk = fakeFs();
  for (const a of assets) disk.files.set(a.uri, a.bytes);
  const calls: unknown[] = [];
  const port: CameraPort = {
    requestCameraPermissionsAsync: async () => { calls.push("permission"); return { granted: o.granted ?? true }; },
    launchCameraAsync: async (opts) => { calls.push(opts); return o.canceled ? { canceled: true } : { canceled: false, assets: assets.map((a) => ({ uri: a.uri, fileName: a.fileName, ...("fileSize" in a ? { fileSize: a.fileSize as number } : {}) })) }; },
  };
  return { port, disk, calls };
}

test("takePhoto: asks for the camera first, opens it for one image, and answers a JPEG with its type taken from the bytes", async () => {
  const p = camera([asset("IMG_1.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2]))]);
  const r = await takePhotoWith(p.port, p.disk.fs as never);
  assert.deepEqual(p.calls, ["permission", { mediaTypes: ["images"], allowsEditing: false, quality: 1, preferredAssetRepresentationMode: "compatible" }]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.files.map((f) => [f.name, f.type, f.data.length, f.uri]), [["IMG_1.jpg", "image/jpeg", 5, "file:///picked/IMG_1.jpg"]]);
});

test("takePhoto: a cancelled camera adds nothing", async () => {
  const p = camera([], { canceled: true });
  assert.deepEqual(await takePhotoWith(p.port, p.disk.fs as never), { files: [], skipped: [] });
});

test("takePhoto: a refused permission is an Error that says how to allow the camera, and the camera is not opened", async () => {
  const p = camera([asset("IMG_1.jpg", Uint8Array.from([0xff, 0xd8, 0xff]))], { granted: false });
  await assert.rejects(takePhotoWith(p.port, p.disk.fs as never), /Allow it in Settings/);
  assert.deepEqual(p.calls, ["permission"]);
});

test("takePhoto: a HEIC is refused by its type, a file over 5 MB by its size", async () => {
  const heic = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  const a = camera([asset("IMG_2.heic", heic)]);
  assert.deepEqual(await takePhotoWith(a.port, a.disk.fs as never), { files: [], skipped: [{ name: "IMG_2.heic", reason: "type" }] });
  const b = camera([asset("big.jpg", Uint8Array.from([0xff, 0xd8, 0xff]), { fileSize: 6 * 1024 * 1024 })]);
  assert.deepEqual(await takePhotoWith(b.port, b.disk.fs as never), { files: [], skipped: [{ name: "big.jpg", reason: "size" }] });
});

test("native transport: pickImages is the one the device gives", async () => {
  const r = rig();
  try {
    r.picks.push({ files: [], skipped: [{ name: "x", reason: "type" }] });
    assert.deepEqual(await r.t.pickImages!(), { files: [], skipped: [{ name: "x", reason: "type" }] });
  } finally { await r.close(); }
});
