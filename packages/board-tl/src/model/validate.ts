// The checks of an `apply` before anything is applied (design 7.4 step 2). Pure: the ops and a lookup of the board's
// elements in, the first error out. Types, required fields, allowed fields (a field that does not apply to an element is an
// error, not ignored), value ranges, and refs, where the refs of earlier ops of the same call count.

import type { TlElement } from "./terms.ts";
import { INK_NAMES, SIZES, STICKY_NAMES } from "./palette.ts";
import { elementTypeOf, keyOf, type AnyRecord, type ShapeRecord } from "./read.ts";

export type ErrorCode =
  | "BAD_ARGS"
  | "INVALID_OP"
  | "UNKNOWN_REF"
  | "REF_EXISTS"
  | "NOT_SUPPORTED"
  | "APPLY_FAILED"
  | "SAVE_FAILED"
  | "HOST_STOPPED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export type ValidationResult =
  | { ok: true }
  /** `error` is the whole answer, "CODE: text"; `index` the 0-based op at fault, when one is. */
  | { ok: false; code: ErrorCode; index?: number; error: string };

export type ElementType = TlElement["type"];
export type KnownElement = { id: string; type: ElementType };

/** The board's elements as the checks see them: by tldraw id, and by key (`meta.key`). */
export type Lookup = {
  byId(id: string): KnownElement | undefined;
  byKey(key: string): KnownElement | undefined;
};

/** A lookup over records (the room's current records, design 7.4 step 1). */
export function lookupFromRecords(records: Iterable<AnyRecord>): Lookup {
  const ids = new Map<string, KnownElement>();
  const keys = new Map<string, KnownElement>();
  for (const r of records) {
    if (r.typeName !== "shape") continue;
    const s = r as ShapeRecord;
    const el = { id: s.id, type: elementTypeOf(s) };
    ids.set(s.id, el);
    const k = keyOf(s);
    if (k !== undefined) keys.set(k, el);
  }
  return { byId: (id) => ids.get(id), byKey: (k) => keys.get(k) };
}

// ---- The vocabulary ----

const STICKY_COLORS: readonly string[] = STICKY_NAMES;
const COLORS: readonly string[] = INK_NAMES;
const FILLS: readonly string[] = [...INK_NAMES, "none"];
const SIZE_VALUES: readonly string[] = SIZES;
const FONT_SIZES: readonly string[] = ["auto", ...SIZES];
const ALIGNS: readonly string[] = ["start", "middle", "end"];
const DASHES: readonly string[] = ["solid", "dashed", "dotted"];
const SHAPES: readonly string[] = ["rectangle", "rounded", "ellipse", "triangle", "diamond"];
const LINES: readonly string[] = ["straight", "curved", "elbow"];
const ARROWHEADS: readonly string[] = ["none", "arrow", "triangle", "dot", "diamond", "bar"];

type Check =
  | { kind: "number" }
  | { kind: "positive" }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "end" } // a connector's end: a ref or a point
  | { kind: "frameRef" } // a frame, or null for the page
  | { kind: "refs" }; // a list of refs (a frame's contents)

const N: Check = { kind: "number" };
const POS: Check = { kind: "positive" };
const STR: Check = { kind: "string" };
const BOOL: Check = { kind: "boolean" };
const en = (values: readonly string[]): Check => ({ kind: "enum", values });
const END: Check = { kind: "end" };
const PARENT: Check = { kind: "frameRef" };
const REFS: Check = { kind: "refs" };

type Fields = Record<string, Check>;

/** The fields of each element, as an agent writes them (create and update share them, design 7.2). */
const FIELDS: Record<"sticky" | "shape" | "text" | "connector" | "frame", Fields> = {
  sticky: { x: N, y: N, w: POS, text: STR, color: en(STICKY_COLORS), fontSize: en(FONT_SIZES), align: en(ALIGNS), parent: PARENT },
  shape: {
    shape: en(SHAPES), x: N, y: N, w: POS, h: POS, text: STR, fill: en(FILLS), border: en(COLORS), borderWidth: en(SIZE_VALUES),
    borderStyle: en(DASHES), align: en(ALIGNS), size: en(SIZE_VALUES), parent: PARENT,
  },
  text: { x: N, y: N, w: POS, text: STR, size: en(SIZE_VALUES), color: en(COLORS), align: en(ALIGNS), bold: BOOL, parent: PARENT },
  connector: {
    from: END, to: END, line: en(LINES), start: en(ARROWHEADS), end: en(ARROWHEADS), text: STR, color: en(COLORS),
    width: en(SIZE_VALUES), dash: en(DASHES),
  },
  frame: { name: STR, x: N, y: N, w: POS, h: POS, contains: REFS, color: en(COLORS) },
};

const REQUIRED: Record<keyof typeof FIELDS, string[]> = {
  sticky: ["x", "y"],
  shape: ["x", "y"],
  text: ["x", "y", "text"],
  connector: ["from", "to"],
  frame: [],
};

/** A hint for a field an agent may well try where it does not apply. */
const HINTS: Record<string, string> = {
  "shape.color": "; a shape has fill and border",
  "sticky.h": "; a sticky is square, give w",
  "text.h": "; a text's height follows its text",
};

const article = (t: string) => (/^[aeiou]/.test(t) ? "an" : "a");

// ---- The checks ----

class Fail {
  readonly code: ErrorCode;
  readonly text: string;
  constructor(code: ErrorCode, text: string) {
    this.code = code;
    this.text = text;
  }
}

type Known = { id: string; type: ElementType };

/**
 * The checks of one `apply`'s arguments: `{ ops: [...] }` (plus `board`). Old-board properties (`create`, `update`) on a new
 * board are refused.
 */
export function validateApplyArgs(args: unknown, lookup: Lookup): ValidationResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) return badArgs("the arguments are not an object");
  const a = args as Record<string, unknown>;
  if ("create" in a || "update" in a) return badArgs("this is a new board; use ops (see the tool description)");
  return validateOps(a.ops, lookup);
}

/** The checks of an `apply`'s `ops`: ok, or the first error. */
export function validateOps(ops: unknown, lookup: Lookup): ValidationResult {
  if (ops === undefined) return badArgs("ops is missing");
  if (!Array.isArray(ops)) return badArgs("ops is not an array");
  if (ops.length === 0) return badArgs("ops is empty");

  const refs = new Map<string, Known>(); // refs made by earlier creates of this call
  const deleted = new Set<string>(); // ids deleted by earlier ops of this call

  const resolve = (ref: string): Known | undefined => {
    const own = refs.get(ref);
    if (own) return deleted.has(own.id) ? undefined : own;
    const found = ref.startsWith("shape:") ? lookup.byId(ref) : lookup.byKey(ref);
    return found && !deleted.has(found.id) ? found : undefined;
  };
  const mustResolve = (ref: string): Known => {
    const k = resolve(ref);
    if (!k) throw new Fail("UNKNOWN_REF", `${JSON.stringify(ref)} names no element of this board or of this call`);
    return k;
  };

  const checkValue = (field: string, check: Check, v: unknown) => {
    const bad = (what: string) => {
      throw new Fail("INVALID_OP", `${field} ${what}`);
    };
    switch (check.kind) {
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) bad("is not a number");
        return;
      case "positive":
        if (typeof v !== "number" || !Number.isFinite(v)) bad("is not a number");
        if ((v as number) <= 0) bad("is not more than 0");
        return;
      case "string":
        if (typeof v !== "string") bad("is not a string");
        return;
      case "boolean":
        if (typeof v !== "boolean") bad("is not true or false");
        return;
      case "enum":
        if (typeof v !== "string" || !check.values.includes(v)) bad(`is not one of ${check.values.join(", ")}`);
        return;
      case "end": {
        if (typeof v === "string") {
          const k = mustResolve(v);
          if (k.type === "connector") bad(`names a connector; a connector attaches to an element that is not a connector`);
          return;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const p = v as Record<string, unknown>;
          const keys = Object.keys(p);
          const isNum = (n: unknown) => typeof n === "number" && Number.isFinite(n);
          if (keys.length === 2 && isNum(p.x) && isNum(p.y)) return;
        }
        bad("is neither a ref nor a point {x, y}");
        return;
      }
      case "frameRef": {
        if (v === null) return;
        if (typeof v !== "string") bad("is neither a ref nor null");
        const k = mustResolve(v as string);
        if (k.type !== "frame") bad(`names ${article(k.type)} ${k.type}, not a frame`);
        return;
      }
      case "refs": {
        if (!Array.isArray(v)) bad("is not a list of refs");
        for (const r of v as unknown[]) {
          if (typeof r !== "string") bad("is not a list of refs");
          mustResolve(r as string);
        }
        return;
      }
    }
  };

  const checkFields = (type: keyof typeof FIELDS, op: Record<string, unknown>, skip: string[]) => {
    const allowed = FIELDS[type];
    for (const [field, v] of Object.entries(op)) {
      if (skip.includes(field)) continue;
      const check = allowed[field];
      if (!check) throw new Fail("INVALID_OP", `${field} does not apply to ${article(type)} ${type}${HINTS[`${type}.${field}`] ?? ""}`);
      checkValue(field, check, v);
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i];
    let label = `op ${i}`;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Fail("INVALID_OP", "is not an object");
      const op = raw as Record<string, unknown>;
      const kind = op.op;
      if (kind === "create") {
        const type = op.type;
        label = `op ${i} (create${typeof type === "string" ? ` ${type}` : ""})`;
        if (type === "pen" || type === "image") throw new Fail("NOT_SUPPORTED", `an agent cannot create ${article(type)} ${type}`);
        if (typeof type !== "string" || !(type in FIELDS))
          throw new Fail("INVALID_OP", `type is not one of ${Object.keys(FIELDS).join(", ")}`);
        const t = type as keyof typeof FIELDS;
        for (const f of REQUIRED[t]) if (op[f] === undefined) throw new Fail("INVALID_OP", `${f} is missing`);
        if (t === "frame") {
          const hasX = op.x !== undefined;
          const hasY = op.y !== undefined;
          if (hasX !== hasY) throw new Fail("INVALID_OP", "x and y go together");
          const contains = op.contains;
          if (!hasX && !(Array.isArray(contains) && contains.length > 0))
            throw new Fail("INVALID_OP", "a frame needs x and y, or contains to be fitted around");
        }
        if (op.ref !== undefined) {
          const ref = op.ref;
          if (typeof ref !== "string" || ref === "") throw new Fail("INVALID_OP", "ref is not a non-empty string");
          if (ref.startsWith("shape:")) throw new Fail("INVALID_OP", `ref ${JSON.stringify(ref)} looks like an id; pick a name`);
          if (refs.has(ref)) throw new Fail("REF_EXISTS", `ref ${JSON.stringify(ref)} is used by an earlier op of this call`);
          if (lookup.byKey(ref)) throw new Fail("REF_EXISTS", `ref ${JSON.stringify(ref)} is already the key of an element of this board`);
        }
        checkFields(t, op, ["op", "type", "ref"]);
        if (typeof op.ref === "string") refs.set(op.ref, { id: `ref:${i}`, type: t });
      } else if (kind === "update" || kind === "delete") {
        const id = op.id;
        label = `op ${i} (${kind}${typeof id === "string" ? ` ${id}` : ""})`;
        if (typeof id !== "string" || id === "") throw new Fail("INVALID_OP", "id is missing");
        const el = mustResolve(id);
        if (kind === "delete") {
          for (const f of Object.keys(op)) if (f !== "op" && f !== "id") throw new Fail("INVALID_OP", `${f} does not apply to a delete`);
          deleted.add(el.id);
          continue;
        }
        if (!(el.type in FIELDS))
          throw new Fail("NOT_SUPPORTED", `${el.type === "other" ? "this kind of element" : `${article(el.type)} ${el.type}`} cannot be changed by an agent (it can be deleted)`);
        const fields = Object.keys(op).filter((f) => f !== "op" && f !== "id");
        if (fields.length === 0) throw new Fail("INVALID_OP", "names nothing to change");
        if (op.ref !== undefined) throw new Fail("INVALID_OP", "ref does not apply to an update");
        checkFields(el.type as keyof typeof FIELDS, op, ["op", "id"]);
        if (el.type === "frame" && Array.isArray(op.contains)) {
          for (const r of op.contains as string[]) if (resolve(r)?.id === el.id) throw new Fail("INVALID_OP", "a frame cannot contain itself");
        }
        if (typeof op.parent === "string" && resolve(op.parent)?.id === el.id) throw new Fail("INVALID_OP", "an element cannot be its own parent");
      } else {
        throw new Fail("INVALID_OP", "op is not one of create, update, delete");
      }
    } catch (e) {
      if (e instanceof Fail) return { ok: false, code: e.code, index: i, error: `${e.code}: ${label}: ${e.text}` };
      throw e;
    }
  }
  return { ok: true };
}

function badArgs(text: string): ValidationResult {
  return { ok: false, code: "BAD_ARGS", error: `BAD_ARGS: ${text}` };
}
