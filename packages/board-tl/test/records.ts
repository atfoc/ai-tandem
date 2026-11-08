// Hand-written tldraw records for the tests: the smallest records of each type that read.ts looks at, with tldraw's
// defaults for the rest.

import { b64Vecs, toRichText } from "@tldraw/tlschema";
import type { BindingRecord, ShapeRecord } from "../src/model/read.ts";

export const PAGE = { typeName: "page", id: "page:page", name: "Page 1", index: "a1", meta: {} };

let n = 0;
const nextIndex = () => `a${(++n).toString(36).padStart(2, "0")}`;

type Base = Partial<Omit<ShapeRecord, "props">> & { props?: Record<string, unknown>; key?: string };

function shape(type: string, id: string, defaults: Record<string, unknown>, o: Base): ShapeRecord {
  const { props, key, ...rest } = o;
  return {
    id,
    typeName: "shape",
    type,
    x: 0,
    y: 0,
    rotation: 0,
    index: nextIndex(),
    parentId: PAGE.id,
    isLocked: false,
    ...rest,
    props: { ...defaults, ...props },
    meta: key ? { key } : {},
  };
}

export const rich = (s: string) => toRichText(s);

export const note = (id: string, o: Base = {}) =>
  shape("note", id, {
    color: "yellow", labelColor: "black", size: "m", font: "sans", fontSizeAdjustment: 1, align: "middle",
    verticalAlign: "middle", growY: 0, url: "", richText: rich(""), scale: 1, textLastEditedBy: null,
  }, o);

export const sticky = (id: string, o: Base = {}) =>
  shape("aiwb-sticky", id, {
    w: 200, h: 200, color: "light-yellow", font: "sans", align: "middle", verticalAlign: "middle", richText: rich(""), fontSize: 0, fitted: 48,
  }, o);

export const geo = (id: string, o: Base = {}) =>
  shape("geo", id, {
    geo: "rectangle", dash: "draw", url: "", w: 100, h: 100, growY: 0, scale: 1, flipX: false, flipY: false,
    labelColor: "black", color: "black", fill: "none", size: "m", font: "sans", align: "middle", verticalAlign: "middle",
    richText: rich(""), fillColor: "white", labelSize: "m",
  }, o);

export const text = (id: string, o: Base = {}) =>
  shape("text", id, { color: "black", size: "m", font: "sans", textAlign: "start", w: 8, richText: rich(""), scale: 1, autoSize: true }, o);

export const arrow = (id: string, o: Base = {}) =>
  shape("arrow", id, {
    kind: "arc", labelColor: "black", color: "black", fill: "none", dash: "draw", size: "m", arrowheadStart: "none",
    arrowheadEnd: "arrow", font: "sans", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0, richText: rich(""),
    labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5,
  }, o);

export const frame = (id: string, o: Base = {}) => shape("frame", id, { w: 160, h: 90, name: "", color: "black" }, o);

export const draw = (id: string, points: { x: number; y: number }[], o: Base = {}) =>
  shape("draw", id, {
    color: "black", fill: "none", dash: "draw", size: "m",
    segments: [{ type: "free", path: b64Vecs.encodePoints(points.map((p) => ({ ...p, z: 0.5 }))) }],
    isComplete: true, isClosed: false, isPen: false, scale: 1, scaleX: 1, scaleY: 1,
  }, o);

export const image = (id: string, o: Base = {}) =>
  shape("image", id, { w: 300, h: 200, playing: true, url: "", assetId: null, crop: null, flipX: false, flipY: false, altText: "" }, o);

export function bind(arrowId: string, toId: string, terminal: "start" | "end", anchor?: { x: number; y: number }): BindingRecord {
  return {
    id: `binding:${arrowId.slice(6)}-${terminal}`,
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId,
    props: {
      terminal,
      normalizedAnchor: anchor ?? { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: anchor !== undefined,
      snap: "none",
    },
  };
}
