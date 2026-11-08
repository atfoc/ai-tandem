// The shape utils (src/model/shapes/) import in plain Node (no DOM needed at import time), use the very props objects of the
// schema, and our geo's display values separate fill colour from border colour and label size from border width.
import "./tsx-hook.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DEFAULT_THEME, defaultShapeUtils } from "tldraw";
import { aiwbGeoShapeMigrations, aiwbGeoShapeProps, tlSchema } from "../src/model/schema.ts";
import { stickyShapeMigrations, stickyShapeProps } from "../src/model/shapes/sticky-props.ts";
import { FONT_FACES } from "../src/model/fonts.ts";
import { fontFiles } from "../src/model/fonts-node.ts";

// (dynamic: the .tsx hook above must be registered before index.ts reaches sticky.tsx)
const { AiwbFrameShapeUtil, AiwbGeoShapeUtil, CUSTOM_SHAPE_UTILS, SHAPE_UTILS, StickyShapeUtil, StickyTool } = await import("../src/model/shapes/index.ts");

// Importing tldraw leaves React's scheduler MessagePort open, which keeps the test process alive.
after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));

test("the utils use the schema's props and migrations, and the type names", () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  assert.equal(StickyShapeUtil.type, "aiwb-sticky");
  assert.equal(StickyShapeUtil.props, stickyShapeProps);
  assert.equal(StickyShapeUtil.migrations, stickyShapeMigrations);
  assert.equal(AiwbGeoShapeUtil.type, "geo");
  assert.equal(AiwbGeoShapeUtil.props, aiwbGeoShapeProps);
  assert.equal(AiwbGeoShapeUtil.migrations, aiwbGeoShapeMigrations);
  assert.equal(AiwbFrameShapeUtil.type, "frame");
  assert.equal(StickyTool.id, "sticky");
  assert.deepEqual(CUSTOM_SHAPE_UTILS.map((u) => u.type), ["aiwb-sticky", "geo", "frame"]);
  // the complete list: tldraw's defaults, geo and frame replaced, plus the sticky
  assert.equal(SHAPE_UTILS.length, defaultShapeUtils.length + 1);
  assert.equal(SHAPE_UTILS.find((u) => u.type === "geo"), AiwbGeoShapeUtil);
  assert.equal(SHAPE_UTILS.find((u) => u.type === "frame"), AiwbFrameShapeUtil);
  // every util's type is a shape type of the schema
  const known = Object.keys((tlSchema.serialize() as { sequences: Record<string, number> }).sequences)
    .filter((k) => k.startsWith("com.tldraw.shape.")).map((k) => k.slice("com.tldraw.shape.".length));
  for (const u of SHAPE_UTILS) assert.ok(known.includes(u.type), u.type);
});

test("the geo's display values: fillColor fills, color borders, labelSize sizes the label, size stays the border", () => {
  const util = new AiwbGeoShapeUtil({} as never);
  const shape = (props: Record<string, unknown>) =>
    ({ type: "geo", props: { ...util.getDefaultProps(), ...props } }) as never;
  const dv = (props: Record<string, unknown>) => ({
    ...util.options.getDefaultDisplayValues({} as never, shape(props), DEFAULT_THEME, "light"),
    ...util.options.getCustomDisplayValues({} as never, shape(props), DEFAULT_THEME, "light"),
  });
  const c = DEFAULT_THEME.colors.light;
  const a = dv({ fill: "fill", fillColor: "light-red", color: "blue", size: "xl", labelSize: "s" });
  assert.equal(a.fillColor, c["light-red"].fill);
  assert.equal(a.strokeColor, c.blue.solid);
  assert.equal(a.labelFontSize, DEFAULT_THEME.fontSize * 1.125);
  const b = dv({ fill: "fill", fillColor: "light-red", color: "blue", size: "s", labelSize: "xl" });
  assert.equal(b.labelFontSize, DEFAULT_THEME.fontSize * 2);
  assert.ok(b.strokeWidth < a.strokeWidth, "size is the border width");
  assert.equal(dv({ fill: "solid", fillColor: "green" }).fillColor, c.green.semi);
  assert.equal(dv({ fill: "none", fillColor: "green" }).fillColor, "transparent");
  assert.deepEqual([util.getDefaultProps().fillColor, util.getDefaultProps().labelSize], ["white", "m"]);
});

test("the rounded rectangle's path is filled unless fill is none (drawn and hit inside, as tldraw's own geos)", () => {
  const util = new AiwbGeoShapeUtil({} as never);
  const def = (util.options as unknown as { customGeoTypes: Record<string, { getPath(w: number, h: number, s: unknown): { toD(o: object): string } }> }).customGeoTypes["rounded-rectangle"];
  const at = (fill: string) => def.getPath(200, 100, { props: { ...util.getDefaultProps(), fill } }).toD({ onlyFilled: true });
  assert.match(at("fill"), /^M 16 0 L 184 0 C/);
  assert.equal(at("none"), "");
});

test("the fonts list names tldraw's 16 files, each with the key of tldraw's own asset list", () => {
  assert.equal(FONT_FACES.length, 16);
  const files = fontFiles();
  for (const f of files) assert.ok(existsSync(f.path), f.path);
  const require = createRequire(import.meta.url);
  const selfHosted = readFileSync(require.resolve("@tldraw/assets/selfHosted.js"), "utf8");
  const pairs = new Map([...selfHosted.matchAll(/(\w+): formatAssetUrl\(\s*'\.\/fonts\/([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.equal(pairs.size, 16);
  for (const f of FONT_FACES) assert.equal(pairs.get(f.key), f.file, f.key);
  assert.equal(new Set(FONT_FACES.map((f) => f.key)).size, 16);
});
