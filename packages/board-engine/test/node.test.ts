// `createNodeEndpoint` and `copyEngineAssets`: the assets folder, the start-up and what it says when it cannot start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_EXTERNALS, copyEngineAssets, createNodeEndpoint } from "../src/node.ts";
import { buildEngine, outFile, packageRoot } from "../build.mjs";
import { SKIA_VERSION, fetchSkiaBinary, skiaPackage } from "../src/skia-binary.ts";
import type { FromBoard } from "@aiwb/board-bridge/messages.ts";
import { rmTemp, startEngine, target, tempDir } from "./support.ts";

let run: Awaited<ReturnType<typeof startEngine>>;
before(async () => { run = await startEngine(); });
after(async () => { await run.close(); });

test("the engine leaves the native canvas out of the bundles", () => {
  assert.deepEqual(ENGINE_EXTERNALS, ["skia-canvas"]);
});

test("copyEngineAssets writes engine.mjs, the fonts without Xiaolai, and skia-canvas with the binary", () => {
  const a = run.assets;
  assert.ok(fs.statSync(path.join(a, "engine.mjs")).size > 1_000_000);
  for (const family of ["Nunito", "Excalifont", "Virgil", "Liberation"]) assert.ok(fs.readdirSync(path.join(a, "fonts", family)).length > 0, family);
  assert.ok(!fs.existsSync(path.join(a, "fonts", "Xiaolai")));
  const skia = path.join(a, "node_modules", "skia-canvas");
  assert.equal(JSON.parse(fs.readFileSync(path.join(skia, "package.json"), "utf8")).version, "4.0.0");
  assert.ok(fs.existsSync(path.join(skia, "lib", "index.mjs")) && fs.existsSync(path.join(skia, "lib", "classes", "neon.js")));
  assert.ok(fs.statSync(path.join(skia, "lib", "skia.node")).size > 10_000_000);
});

test("copyEngineAssets is repeatable, and does not rebuild a bundle that is newer than its sources", async () => {
  const before = fs.statSync(outFile).mtimeMs;
  await buildEngine({ ifStale: true });
  assert.equal(fs.statSync(outFile).mtimeMs, before);
  const dir = path.join(run.root, "again");
  await copyEngineAssets(dir, target);
  await copyEngineAssets(dir, target);
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "skia-canvas", "lib", "skia.node")));
  assert.equal(fs.statSync(outFile).mtimeMs, before);
});

test("copyEngineAssets for another target fails naming the package when the registry is not reached, and writes nothing", async () => {
  const other = target.os === "darwin" ? { os: "linux" as const, arch: target.arch } : { os: "darwin" as const, arch: target.arch };
  const cache = tempDir("nocache");
  try {
    await assert.rejects(
      fetchSkiaBinary(other, { cache, pack: async () => { throw Object.assign(new Error("failed"), { stderr: "npm error code ENOTFOUND\nnpm error network" }); } }),
      (e: Error) => {
        assert.match(e.message, new RegExp(skiaPackage(other).replace("/", "\\/") + "@4\\.0\\.0"));
        assert.match(e.message, /registry was not reached/);
        assert.match(e.message, /ENOTFOUND/);
        return true;
      });
    assert.deepEqual(fs.readdirSync(cache), [], "no half-fetched file is left");
  } finally { rmTemp(cache); }
});

test("the installed skia-canvas is the version the binary packages are fetched at", () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot("skia-canvas"), "package.json"), "utf8")).version, SKIA_VERSION);
});

test("ready is posted once, before the promise resolves, and tells the versions (or the given one)", async () => {
  const seen: FromBoard[] = [];
  const ep = await createNodeEndpoint((m) => seen.push(m), { assets: run.assets, warn: () => {} });
  assert.deepEqual(seen, [{ t: "ready", version: "excalidraw 0.18.1; skia-canvas 4.0.0" }]);
  await ep.close();
  const given: FromBoard[] = [];
  await (await createNodeEndpoint((m) => given.push(m), { assets: run.assets, version: "headless 1", warn: () => {} })).close();
  assert.deepEqual(given, [{ t: "ready", version: "headless 1" }]);
  assert.equal(run.posted.filter((m) => m.t === "ready").length, 1, "the endpoint of the run was told ready once");
});

test("after close nothing is posted", async () => {
  const seen: FromBoard[] = [];
  const ep = await createNodeEndpoint((m) => seen.push(m), { assets: run.assets, warn: () => {} });
  await ep.close();
  ep.receive({ t: "req", id: 1, op: { op: "restore", elements: [] } });
  ep.refuse({ t: "req", id: 2 }, "bad");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen.map((m) => m.t), ["ready"]);
});

// ---- what it says when it cannot start: nothing is posted, and the reason names what is missing

async function cannotStart(assets: string, expected: RegExp): Promise<void> {
  const seen: FromBoard[] = [];
  await assert.rejects(createNodeEndpoint((m) => seen.push(m), { assets, warn: () => {} }), (e: Error) => {
    assert.match(e.message, expected);
    return true;
  });
  assert.deepEqual(seen, []);
}

test("assets with no folder, or without engine.mjs, reject naming engine.mjs", async () => {
  const dir = tempDir("none");
  try {
    await cannotStart(path.join(dir, "nowhere"), /does not exist/);
    await cannotStart(dir, /engine\.mjs is missing/);
    fs.cpSync(run.assets, path.join(dir, "a"), { recursive: true, filter: (p) => path.basename(p) !== "engine.mjs" });
    await cannotStart(path.join(dir, "a"), /engine\.mjs is missing/);
  } finally { rmTemp(dir); }
});

test("assets with the binary removed reject naming the binary", async () => {
  const dir = tempDir("nobin");
  try {
    fs.cpSync(run.assets, dir, { recursive: true, filter: (p) => path.basename(p) !== "skia.node" });
    await cannotStart(dir, /native canvas .*skia\.node is missing/);
  } finally { rmTemp(dir); }
});

test("assets with a font folder removed reject naming the font", async () => {
  const dir = tempDir("nofont");
  try {
    fs.cpSync(run.assets, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}fonts${path.sep}Nunito`) });
    await cannotStart(dir, /fonts\/Nunito is missing/);
  } finally { rmTemp(dir); }
});

test("a binary that does not load rejects with the loader's reason", async () => {
  const dir = tempDir("badbin");
  try {
    fs.cpSync(run.assets, dir, { recursive: true, filter: (p) => path.basename(p) !== "skia.node" });
    fs.writeFileSync(path.join(dir, "node_modules", "skia-canvas", "lib", "skia.node"), "not a binary");
    await cannotStart(dir, /./);
  } finally { rmTemp(dir); }
});
