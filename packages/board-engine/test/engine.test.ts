// The requests on given elements, answered by the engine bundle in Node through `createNodeEndpoint`: values the board bridge
// accepts, the refusals, the widths of text in Excalidraw's own fonts, and pictures with images.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateEngineValue } from "@aiwb/board-bridge/validate.ts";
import type { ApplyValue, El, EngineOp, EngineValues, ExportValue, Files, RestoreValue, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { startEngine } from "./support.ts";

let run: Awaited<ReturnType<typeof startEngine>>;
before(async () => { run = await startEngine(); });
after(async () => { await run.close(); });

type Res = Awaited<ReturnType<typeof run.ask>>;
const ok = <Op extends keyof EngineValues>(op: Op, res: Res): EngineValues[Op] => {
  assert.ok(res.ok, JSON.stringify(res));
  const v = validateEngineValue(op, res.value);
  assert.ok(v.ok, `${op}: ${v.ok ? "" : v.error}`);
  return res.value as EngineValues[Op];
};
const refused = (res: Res, code: string): void => {
  assert.ok(!res.ok, JSON.stringify(res).slice(0, 300));
  if (!res.ok) { assert.equal(res.code, code); assert.ok(res.message.length > 0); }
};
const apply = async (elements: El[], params: object): Promise<ApplyValue> =>
  ok("apply", await run.ask({ op: "apply", target: { elements }, params: params as never, rev: 0 } as EngineOp));
const exportOf = (elements: El[], over: object = {}, files: Files = {}) =>
  run.ask({ op: "export", target: { elements, files, appState: { viewBackgroundColor: "#ffffff" } }, ids: [], scale: 1, background: true, ...over } as EngineOp);

// the trial case of the spike's cases.mjs
const TRIAL = { create: [
  { type: "rectangle", key: "a", x: 0, y: 0, width: 160, height: 60, label: { text: "API gateway" } },
  { type: "rectangle", key: "b", x: 320, y: 0, width: 120, height: 60, label: { text: "Database" } },
  { type: "ellipse", key: "c", x: 160, y: 200, width: 200, height: 90, label: { text: "A longer label that must wrap inside" } },
  { type: "text", key: "t", x: 0, y: 340, text: "Free text\nsecond line", fontSize: 24 },
  { type: "arrow", key: "ar", x: 0, y: 0, points: [[0, 0], [100, 0]], start: { key: "a" }, end: { key: "b" }, label: { text: "reads" } },
] };

test("the trial case: apply, update, delete, restore and export answer values the bridge accepts", async () => {
  const first = await apply([], TRIAL);
  assert.deepEqual(Object.keys(first.created).sort(), ["a", "ar", "b", "c", "t"]);
  assert.equal(first.elements!.length, 9, "five elements and the labels of four of them");
  const { a, b, c, t } = first.created;
  const second = ok("apply", await run.ask({
    op: "apply", target: { elements: first.elements! }, rev: 1,
    params: { update: [{ ref: { id: b }, width: 260, height: 90 }, { ref: { id: t }, text: "Changed text that is much wider" }] },
  } as never));
  assert.deepEqual(second.updated.sort(), [b, t].sort());
  assert.equal(second.elements!.length, 10, "the trial's 10 elements: a changed free text is a new element");
  const third = ok("delete", await run.ask({ op: "delete", target: { elements: second.elements! }, refs: [{ id: c }], cascade: true, rev: 2 } as never));
  assert.deepEqual(third.deleted, [c]);
  const labelOfC = third.elements!.find((e) => (e as { containerId?: string }).containerId === c)!;
  assert.equal(labelOfC.isDeleted, true, "the label goes with its shape");
  const restored: RestoreValue = ok("restore", await run.ask({ op: "restore", elements: third.elements! }));
  assert.equal(restored.elements.length, third.elements!.length);
  const picture: ExportValue = ok("export", await exportOf(third.elements!, { ids: [a, b] }));
  assert.equal(picture.count, 2, "two shapes, their labels counted with them");
  assert.ok(Buffer.from(picture.png, "base64").subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a PNG");
  assert.ok(picture.width > 0 && picture.height > 0);
});

test("a request is answered once, and the messages that are not requests are ignored", async () => {
  const before = run.posted.length;
  const others: ToBoard[] = [{ t: "unload" }, { t: "viewMode", on: true }, { t: "select", ids: ["x"] }, { t: "scrollTo", ids: [], animate: false }];
  for (const m of others) run.endpoint.receive(m);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(run.posted.length, before, "nothing is posted for them");
  const res = await run.ask({ op: "restore", elements: [] });
  ok("restore", res);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(run.posted.filter((m) => m.t === "res" && m.id === res.id).length, 1);
});

test("snapshot, and any live target, are NO_BOARD", async () => {
  refused(await run.ask({ op: "snapshot" }), "NO_BOARD");
  refused(await run.ask({ op: "apply", target: "live", params: { create: [] }, rev: 0 } as never), "NO_BOARD");
  refused(await run.ask({ op: "delete", target: "live", refs: [], cascade: false, rev: 0 } as never), "NO_BOARD");
  refused(await run.ask({ op: "export", target: "live", ids: [], scale: 1, background: true } as never), "NO_BOARD");
});

test("a malformed req given to refuse is BAD_MESSAGE; other malformed messages post nothing", async () => {
  const before = run.posted.length;
  run.endpoint.refuse({ t: "req", id: 4242, op: { op: "nonsense" } }, "app → view: op: not an op");
  run.endpoint.refuse({ t: "unload", extra: 1 }, "app → view: unexpected key");
  run.endpoint.refuse("garbage", "not an object");
  run.endpoint.refuse({ t: "req", id: -1 }, "bad id");
  const fresh = run.posted.slice(before);
  assert.deepEqual(fresh, [{ t: "res", id: 4242, ok: false, code: "BAD_MESSAGE", message: "app → view: op: not an op" }]);
});

test("a request the engine cannot carry out is answered: the RpcError's code, or FAILED", async () => {
  refused(await run.ask({ op: "apply", target: { elements: [] }, params: { update: [{ ref: { key: "nobody" }, width: 1 }] }, rev: 0 } as never), "BAD_REF");
  refused(await run.ask({ op: "apply", target: { elements: [] }, params: null, rev: 0 } as never), "FAILED");
  ok("restore", await run.ask({ op: "restore", elements: [] }));
});

test("export: an empty scene is EMPTY, a picture over 8192 px TOO_LARGE, a scale under 1 px BAD_ARGS", async () => {
  refused(await exportOf([]), "EMPTY");
  const wide = (await apply([], { create: [{ type: "rectangle", key: "w", x: 0, y: 0, width: 9000, height: 100 }] })).elements!;
  refused(await exportOf(wide), "TOO_LARGE");
  const small = (await apply([], { create: [{ type: "rectangle", key: "s", x: 0, y: 0, width: 100, height: 100 }] })).elements!;
  refused(await exportOf(small, { scale: 0.001 }), "BAD_ARGS");
  ok("export", await exportOf(small));
});

test("text in Excalidraw's own fonts has the widths the spike measured, on every system", async () => {
  const text = "Hello world, a longer label";
  const els = (await apply([], { create: [
    { type: "text", key: "n", x: 0, y: 0, text, fontFamily: "normal" },
    { type: "text", key: "h", x: 0, y: 100, text, fontFamily: "hand" },
  ] })).elements!;
  const width = (family: number) => (els.find((e) => (e as { fontFamily?: number }).fontFamily === family) as unknown as { width: number }).width;
  assert.equal(width(6).toFixed(2), "241.64", "Nunito");
  assert.equal(width(5).toFixed(2), "242.02", "Excalifont");
});

// ---- images

/** The native canvas the engine runs on (the copy in the assets), so the test makes and reads pictures with the engine's own. */
async function skia(): Promise<typeof import("skia-canvas")> {
  return await import(pathToFileURL(path.join(run.assets, "node_modules", "skia-canvas", "lib", "index.mjs")).href);
}

test("a PNG, a JPEG and an SVG image are drawn: their pixels, not the placeholder's grey", async () => {
  const { Canvas, loadImage } = await skia();
  const solid = async (w: number, h: number, color: string, format: "png" | "jpeg") => {
    const c = new Canvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return `data:image/${format};base64,${(await c.toBuffer(format)).toString("base64")}`;
  };
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#00ff00"/></svg>').toString("base64")}`;
  const files: Files = {
    fpng: { id: "fpng", mimeType: "image/png", dataURL: await solid(160, 100, "#ff0000", "png"), created: 1700000000000 },
    fjpg: { id: "fjpg", mimeType: "image/jpeg", dataURL: await solid(200, 120, "#0000ff", "jpeg"), created: 1700000000000 },
    fsvg: { id: "fsvg", mimeType: "image/svg+xml", dataURL: svg, created: 1700000000000 },
  } as never;
  const image = (id: string, fileId: string, x: number, w: number, h: number) => ({
    id, type: "image", x, y: 0, width: w, height: h, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1,
    versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: id.slice(-1) === "g" ? "a0" : "a1",
    fileId, status: "saved", scale: [1, 1], crop: null,
  }) as unknown as El;
  const elements = [image("i-png", "fpng", 0, 160, 100), image("i-jpg", "fjpg", 200, 200, 120), image("i-svg", "fsvg", 440, 120, 120)];
  const picture: ExportValue = ok("export", await exportOf(elements, {}, files));
  const decoded = await loadImage(Buffer.from(picture.png, "base64"));
  const c = new Canvas(decoded.width, decoded.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const pad = Math.round((picture.width - picture.bounds.width) / 2);
  const at = (x: number, y: number) => Array.from(ctx.getImageData(pad + x, pad + y, 1, 1).data) as number[];
  // (a JPEG is lossy: a few levels off)
  const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) <= 12);
  assert.ok(near(at(80, 50), [255, 0, 0, 255]), `png ${at(80, 50)}`);
  assert.ok(near(at(300, 60), [0, 0, 255, 255]), `jpeg ${at(300, 60)}`);
  assert.ok(near(at(500, 60), [0, 255, 0, 255]), `svg ${at(500, 60)}`);
  const grey = ctx.getImageData(0, 0, decoded.width, decoded.height).data;
  let placeholder = 0;
  for (let i = 0; i < grey.length; i += 4) if (grey[i] === 0xe7 && grey[i + 1] === 0xe7 && grey[i + 2] === 0xe7) placeholder++;
  assert.equal(placeholder, 0, "no pixel of the placeholder's grey #E7E7E7");
});
