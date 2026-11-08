// The shared schema (src/model/schema.ts) loads in plain Node with no DOM and without tldraw's editor or React, and a store
// built from it takes our records and refuses bad ones. The board host builds its rooms from this module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Anything that is not DOM-free must not be reached from schema.ts.
const refused: string[] = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/^(tldraw|@tldraw\/(editor|assets|sync|sync-core)|react|react-dom)(\/|$)/.test(specifier)) refused.push(specifier);
    return next(specifier, context);
  },
});

const { tlSchema, aiwbGeoShapeProps } = await import("../src/model/schema.ts");
const { Store } = await import("@tldraw/store");
const { createShapeId, toRichText, PageRecordType, GeoShapeGeoStyle } = await import("@tldraw/tlschema");
const { stickyShapeProps } = await import("../src/model/shapes/sticky-props.ts");

const PAGE = PageRecordType.create({ id: PageRecordType.createId("page"), name: "Page 1", index: "a1" as never });

function store() {
  return new Store({ schema: tlSchema as never, props: {} as never, initialData: {} });
}

const base = { typeName: "shape", x: 0, y: 0, rotation: 0, index: "a1", parentId: PAGE.id, isLocked: false, opacity: 1, meta: {} } as const;

const stickyRecord = (props: Record<string, unknown> = {}) => ({
  ...base,
  id: createShapeId("s1"),
  type: "aiwb-sticky",
  props: {
    w: 200, h: 200, color: "dark-blue", font: "sans", align: "middle", verticalAlign: "middle", richText: toRichText("Idea"),
    fontSize: 0, fitted: 48, ...props,
  },
});

const geoRecord = (props: Record<string, unknown> = {}) => ({
  ...base,
  id: createShapeId("g1"),
  type: "geo",
  props: {
    geo: "rounded-rectangle", dash: "solid", url: "", w: 200, h: 100, growY: 0, scale: 1, flipX: false, flipY: false,
    labelColor: "black", color: "blue", fill: "fill", size: "xl", font: "sans", align: "middle", verticalAlign: "middle",
    richText: toRichText("API"), fillColor: "light-red", labelSize: "s", ...props,
  },
});

test("schema.ts loads in Node with no DOM and without tldraw, its editor or React", () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  assert.deepEqual(refused, []);
  assert.ok(GeoShapeGeoStyle.values.includes("rounded-rectangle" as never), "the rounded rectangle is a geo value");
  assert.equal(aiwbGeoShapeProps.fillColor.id, "aiwb:fill-color");
  assert.equal(aiwbGeoShapeProps.labelSize.id, "aiwb:label-size");
  assert.equal((stickyShapeProps.color as unknown as { id: string }).id, "aiwb:sticky-color");
});

test("a store from the schema takes a sticky and a geo with our props", () => {
  const s = store();
  s.put([PAGE as never, stickyRecord() as never, geoRecord() as never]);
  const g = s.get(createShapeId("g1") as never) as unknown as { props: Record<string, unknown> };
  assert.deepEqual([g.props.geo, g.props.fillColor, g.props.labelSize, g.props.color, g.props.size], ["rounded-rectangle", "light-red", "s", "blue", "xl"]);
  const st = s.get(createShapeId("s1") as never) as unknown as { props: Record<string, unknown> };
  assert.equal(st.props.color, "dark-blue");
});

test("a store from the schema refuses bad records", () => {
  const s = store();
  s.put([PAGE as never]);
  assert.throws(() => s.put([stickyRecord({ color: "white" }) as never]), /color/);
  assert.throws(() => s.put([stickyRecord({ fitted: "big" }) as never]), /fitted/);
  assert.throws(() => s.put([geoRecord({ fillColor: "teal" }) as never]), /fillColor/);
  assert.throws(() => s.put([geoRecord({ labelSize: "xxl" }) as never]), /labelSize/);
  const { fillColor: _drop, ...noFill } = geoRecord().props;
  assert.throws(() => s.put([{ ...geoRecord(), props: noFill } as never]), /fillColor/);
});

test("the schema serializes with our shape and its migrations", () => {
  const ser = tlSchema.serialize() as { sequences: Record<string, number> };
  assert.equal(ser.sequences["com.tldraw.shape.aiwb-sticky"], 0);
  assert.ok(ser.sequences["com.tldraw.shape.geo"] > 0);
});
