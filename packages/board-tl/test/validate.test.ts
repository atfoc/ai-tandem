import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupFromRecords, validateApplyArgs, validateOps, type ValidationResult } from "../src/model/validate.ts";
import { PAGE, arrow, draw, frame, geo, note, sticky, text } from "./records.ts";

// A board: a frame f1 holding a sticky n1, a shape s1, a text, a connector, a pen.
const board = lookupFromRecords([
  PAGE,
  frame("shape:f", { key: "f1" }),
  note("shape:n", { key: "n1", parentId: "shape:f" }),
  geo("shape:s", { key: "s1" }),
  text("shape:t"),
  arrow("shape:c", { key: "c1" }),
  draw("shape:p", [{ x: 0, y: 0 }]),
  { ...geo("shape:o"), type: "embed", props: {} },
  sticky("shape:k"),
] as never);

const run = (ops: unknown) => validateOps(ops, board);
const fails = (r: ValidationResult, code: string, index: number | undefined, error: string) => {
  assert.deepEqual(r, index === undefined ? { ok: false, code, error } : { ok: false, code, index, error });
};

test("the design's example is valid", () => {
  const r = run([
    { op: "create", ref: "n2", type: "sticky", x: 0, y: 0, text: "Idea", color: "yellow" },
    { op: "create", ref: "s2", type: "shape", shape: "rectangle", x: 300, y: 0, w: 200, h: 100, text: "API" },
    { op: "create", type: "connector", from: "n2", to: "s2", end: "arrow", text: "calls" },
    { op: "create", ref: "f2", type: "frame", name: "Sprint", contains: ["n2", "s2"] },
    { op: "update", id: "shape:n", color: "green", text: "Done" },
    { op: "delete", id: "shape:s" },
  ]);
  assert.deepEqual(r, { ok: true });
});

test("every element type and field in its valid form", () => {
  assert.deepEqual(
    run([
      { op: "create", type: "sticky", x: 1, y: 2, w: 300, text: "", color: "light-yellow", fontSize: "auto", align: "start", parent: "f1" },
      { op: "create", type: "sticky", x: 1, y: 2, fontSize: "xl", parent: null },
      {
        op: "create", type: "shape", shape: "rounded", x: 0, y: 0, w: 10, h: 10, text: "t", fill: "none", border: "pink",
        borderWidth: "l", borderStyle: "dotted", align: "end", size: "s", parent: "shape:f",
      },
      { op: "create", type: "text", x: 0, y: 0, text: "hi", w: 120, size: "xl", color: "black", align: "middle", bold: true },
      { op: "create", type: "connector", from: { x: 0, y: 0 }, to: "shape:t", line: "elbow", start: "dot", end: "bar", color: "blue", width: "xl", dash: "dashed" },
      { op: "create", type: "frame", x: 0, y: 0, w: 100, h: 100, color: "light-blue" },
      { op: "update", id: "s1", fill: "red", shape: "diamond", parent: null },
      { op: "update", id: "c1", from: "s1", to: { x: 5, y: 5 }, line: "curved" },
      { op: "update", id: "f1", name: "N", contains: ["s1", "shape:t"] },
      { op: "update", id: "shape:t", w: 50, bold: false, color: "grey" },
      { op: "update", id: "shape:k", color: "dark-green", fontSize: "auto" },
      { op: "update", id: "shape:k", color: "black" },
      { op: "delete", id: "shape:p" },
    ]),
    { ok: true },
  );
});

test("BAD_ARGS: ops missing, not an array, empty, or the old properties", () => {
  fails(validateApplyArgs({}, board), "BAD_ARGS", undefined, "BAD_ARGS: ops is missing");
  fails(validateApplyArgs({ ops: {} }, board), "BAD_ARGS", undefined, "BAD_ARGS: ops is not an array");
  fails(validateApplyArgs({ ops: [] }, board), "BAD_ARGS", undefined, "BAD_ARGS: ops is empty");
  fails(validateApplyArgs(null, board), "BAD_ARGS", undefined, "BAD_ARGS: the arguments are not an object");
  fails(
    validateApplyArgs({ create: [], ops: [] }, board),
    "BAD_ARGS",
    undefined,
    "BAD_ARGS: this is a new board; use ops (see the tool description)",
  );
  fails(validateApplyArgs({ update: [] }, board), "BAD_ARGS", undefined, "BAD_ARGS: this is a new board; use ops (see the tool description)");
  assert.deepEqual(validateApplyArgs({ board: "b_1", ops: [{ op: "delete", id: "s1" }] }, board), { ok: true });
});

test("INVALID_OP: the op, the type, required fields", () => {
  fails(run(["x"]), "INVALID_OP", 0, "INVALID_OP: op 0: is not an object");
  fails(run([{ op: "move" }]), "INVALID_OP", 0, "INVALID_OP: op 0: op is not one of create, update, delete");
  fails(run([{ op: "create", type: "circle" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create circle): type is not one of sticky, shape, text, connector, frame");
  fails(run([{ op: "create", type: "sticky", x: 0 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): y is missing");
  fails(run([{ op: "create", type: "text", x: 0, y: 0 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create text): text is missing");
  fails(run([{ op: "create", type: "connector", from: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create connector): to is missing");
  fails(run([{ op: "create", type: "frame" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create frame): a frame needs x and y, or contains to be fitted around");
  fails(run([{ op: "create", type: "frame", x: 0, contains: ["s1"] }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create frame): x and y go together");
  fails(run([{ op: "update" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update): id is missing");
  fails(run([{ op: "update", id: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update s1): names nothing to change");
  fails(run([{ op: "delete", id: "s1", text: "x" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (delete s1): text does not apply to a delete");
});

test("INVALID_OP: a field that does not apply is an error, not ignored", () => {
  fails(
    run([{ op: "create", type: "shape", x: 0, y: 0, color: "red" }]),
    "INVALID_OP",
    0,
    "INVALID_OP: op 0 (create shape): color does not apply to a shape; a shape has fill and border",
  );
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, h: 10 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): h does not apply to a sticky; a sticky is square, give w");
  fails(run([{ op: "create", type: "connector", from: "s1", to: "n1", parent: "f1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create connector): parent does not apply to a connector");
  fails(run([{ op: "update", id: "shape:t", fill: "red" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update shape:t): fill does not apply to a text");
  fails(run([{ op: "update", id: "f1", parent: null }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update f1): parent does not apply to a frame");
  fails(run([{ op: "update", id: "s1", ref: "x" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update s1): ref does not apply to an update");
});

test("INVALID_OP: values and ranges", () => {
  fails(
    run([{ op: "delete", id: "n1" }, { op: "update", id: "shape:s", fill: "purple" }]),
    "INVALID_OP",
    1,
    "INVALID_OP: op 1 (update shape:s): fill is not one of black, grey, white, red, orange, yellow, green, light-green, blue, light-blue, violet, pink, none",
  );
  // A sticky colour that is no ink, on a text; an ink that is no sticky colour, on a sticky.
  fails(run([{ op: "update", id: "shape:t", color: "light-yellow" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update shape:t): color is not one of black, grey, white, red, orange, yellow, green, light-green, blue, light-blue, violet, pink");
  fails(run([{ op: "update", id: "n1", color: "white" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update n1): color is not one of light-yellow, yellow, orange, light-green, green, dark-green, cyan, light-pink, pink, violet, red, light-blue, blue, dark-blue, grey, black");
  fails(run([{ op: "create", type: "sticky", x: "0", y: 0 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): x is not a number");
  fails(run([{ op: "create", type: "sticky", x: Infinity, y: 0 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): x is not a number");
  fails(run([{ op: "create", type: "shape", x: 0, y: 0, w: 0 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create shape): w is not more than 0");
  fails(run([{ op: "create", type: "text", x: 0, y: 0, text: 5 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create text): text is not a string");
  fails(run([{ op: "create", type: "text", x: 0, y: 0, text: "", bold: "yes" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create text): bold is not true or false");
  fails(run([{ op: "create", type: "connector", from: { x: 0 }, to: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create connector): from is neither a ref nor a point {x, y}");
  fails(run([{ op: "create", type: "connector", from: "c1", to: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create connector): from names a connector; a connector attaches to an element that is not a connector");
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, parent: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): parent names a shape, not a frame");
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, parent: 3 }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): parent is neither a ref nor null");
  fails(run([{ op: "update", id: "f1", contains: "s1" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update f1): contains is not a list of refs");
  fails(run([{ op: "update", id: "f1", contains: ["f1"] }]), "INVALID_OP", 0, "INVALID_OP: op 0 (update f1): a frame cannot contain itself");
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, ref: "" }]), "INVALID_OP", 0, "INVALID_OP: op 0 (create sticky): ref is not a non-empty string");
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, ref: "shape:x" }]), "INVALID_OP", 0, 'INVALID_OP: op 0 (create sticky): ref "shape:x" looks like an id; pick a name');
});

test("UNKNOWN_REF: a name that is no ref, id or key; refs of earlier ops count, deleted ones do not", () => {
  fails(
    run([{ op: "create", ref: "a", type: "sticky", x: 0, y: 0 }, { op: "create", type: "connector", from: "a", to: "n9" }]),
    "UNKNOWN_REF",
    1,
    'UNKNOWN_REF: op 1 (create connector): "n9" names no element of this board or of this call',
  );
  fails(run([{ op: "update", id: "shape:zz", x: 1 }]), "UNKNOWN_REF", 0, 'UNKNOWN_REF: op 0 (update shape:zz): "shape:zz" names no element of this board or of this call');
  fails(run([{ op: "delete", id: "s1" }, { op: "update", id: "shape:s", x: 1 }]), "UNKNOWN_REF", 1, 'UNKNOWN_REF: op 1 (update shape:s): "shape:s" names no element of this board or of this call');
  fails(
    run([{ op: "create", ref: "a", type: "sticky", x: 0, y: 0 }, { op: "delete", id: "a" }, { op: "delete", id: "a" }]),
    "UNKNOWN_REF",
    2,
    'UNKNOWN_REF: op 2 (delete a): "a" names no element of this board or of this call',
  );
  fails(run([{ op: "create", type: "frame", contains: ["s1", "nope"] }]), "UNKNOWN_REF", 0, 'UNKNOWN_REF: op 0 (create frame): "nope" names no element of this board or of this call');
  fails(run([{ op: "create", type: "sticky", x: 0, y: 0, parent: "fx" }]), "UNKNOWN_REF", 0, 'UNKNOWN_REF: op 0 (create sticky): "fx" names no element of this board or of this call');
  // A ref of a later op does not count.
  fails(
    run([{ op: "create", type: "connector", from: "s1", to: "later" }, { op: "create", ref: "later", type: "sticky", x: 0, y: 0 }]),
    "UNKNOWN_REF",
    0,
    'UNKNOWN_REF: op 0 (create connector): "later" names no element of this board or of this call',
  );
  // A frame made in this call can be a parent at once.
  assert.deepEqual(run([{ op: "create", ref: "fr", type: "frame", x: 0, y: 0 }, { op: "create", type: "sticky", x: 0, y: 0, parent: "fr" }]), { ok: true });
});

test("REF_EXISTS: a ref that is a key of the board, or a ref used twice in one call", () => {
  fails(run([{ op: "create", ref: "n1", type: "sticky", x: 0, y: 0 }]), "REF_EXISTS", 0, 'REF_EXISTS: op 0 (create sticky): ref "n1" is already the key of an element of this board');
  fails(
    run([{ op: "create", ref: "a", type: "sticky", x: 0, y: 0 }, { op: "create", ref: "a", type: "text", x: 0, y: 0, text: "" }]),
    "REF_EXISTS",
    1,
    'REF_EXISTS: op 1 (create text): ref "a" is used by an earlier op of this call',
  );
});

test("NOT_SUPPORTED: creating a pen or an image, changing what agents only read", () => {
  fails(run([{ op: "create", type: "pen" }]), "NOT_SUPPORTED", 0, "NOT_SUPPORTED: op 0 (create pen): an agent cannot create a pen");
  fails(run([{ op: "create", type: "image", x: 0, y: 0 }]), "NOT_SUPPORTED", 0, "NOT_SUPPORTED: op 0 (create image): an agent cannot create an image");
  fails(run([{ op: "update", id: "shape:p", x: 1 }]), "NOT_SUPPORTED", 0, "NOT_SUPPORTED: op 0 (update shape:p): a pen cannot be changed by an agent (it can be deleted)");
  fails(run([{ op: "update", id: "shape:o", x: 1 }]), "NOT_SUPPORTED", 0, "NOT_SUPPORTED: op 0 (update shape:o): this kind of element cannot be changed by an agent (it can be deleted)");
  assert.deepEqual(run([{ op: "delete", id: "shape:p" }, { op: "delete", id: "shape:o" }]), { ok: true });
});

test("the first error wins", () => {
  const r = run([{ op: "create", type: "sticky", x: 0, y: 0 }, { op: "create", type: "pen" }, { op: "update", id: "nope", x: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "NOT_SUPPORTED");
  assert.equal(!r.ok && r.index, 1);
});
