// The words of a reference's chip and of the pin on the board (B2), read from the reference's own detail lines (core logic/refs.ts:
// format.ts formatElement with runs of spaces collapsed, `rectangle key=api id=a1 "Checkout service" (10,20 160×70)`). No React and no
// DOM here, so Node loads it: test/board.refbox.test.ts.
import { pointLabel, type Ref } from "@aiwb/core/logic/refs.ts";

/** One element's label in a detail: after `id=<id>` comes the label as a JSON string, when the element has one. Labels are
 *  consumed whole, so what a label holds ("; ", "id=") never reads as the next element. */
const ELEMENT = /\bid=\S+(?:\s+("(?:[^"\\]|\\.)*"))?/g;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function labelOf(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json);
    return typeof s === "string" ? flat(s) || null : null;
  } catch {
    return null;
  }
}

/** The labels of the elements in a detail, in order, those that have one. */
const labelsOf = (detail: string): string[] =>
  [...detail.matchAll(ELEMENT)].map((m) => labelOf(m[1])).filter((l): l is string => !!l);

const withArticle = (type: string) => (/^[aeiou]/i.test(type) ? "an " : "a ") + type;

/** What a point is near: the label of the first element of its `near:` detail (`Checkout service`), else that element's type
 *  (`a rectangle`), else null. */
export function nearName(ref: Ref): string | null {
  if (ref.kind !== "point") return null;
  const m = /^near:\s*(\S+)\s+(?:key=\S+\s+)?id=\S+(?:\s+("(?:[^"\\]|\\.)*"))?/.exec(ref.detail);
  if (!m) return null;
  return labelOf(m[2]) ?? withArticle(m[1]);
}

const spot = (ref: Extract<Ref, { kind: "point" }>) => pointLabel(ref.x, ref.y);

/** The point chip: `Point near Checkout service` | `Point near a rectangle` | `Point at (412, 230)`. */
export function pointChipText(ref: Ref): string {
  if (ref.kind !== "point") return "";
  const near = nearName(ref);
  return near ? `Point near ${near}` : `Point at ${spot(ref)}`;
}

/** The pin's label on the board: `x 412, y 230 · near Checkout service` | `x 412, y 230`. */
export function pinText(ref: Ref): string {
  if (ref.kind !== "point") return "";
  const xy = `x ${Math.round(ref.x)}, y ${Math.round(ref.y)}`;
  const near = nearName(ref);
  return near ? `${xy} · near ${near}` : xy;
}

/** The selection chip: `2 shapes · Payments, Inventory` | `1 shape · Payments` | `3 shapes`. The count is the ids; the names are
 *  those of the elements that have a label. */
export function selectionChipText(ref: Ref): string {
  if (ref.kind !== "selection") return "";
  const n = ref.ids.length;
  const names = labelsOf(ref.detail);
  return `${n} shape${n === 1 ? "" : "s"}${names.length ? " · " + names.join(", ") : ""}`;
}
