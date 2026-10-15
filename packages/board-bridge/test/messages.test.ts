import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_OPS, FROM_BOARD_TYPES, TO_BOARD_TYPES } from "../src/messages.ts";
import { CHROME_VARS } from "../src/chrome.ts";
import type { CanvasFilterMsg, CurrentItemStyle, El, EngineOp, FromBoard, SavedAppState, ThemeMsg, ToBoard } from "../src/messages.ts";
import { MAX_DEPTH, parseFromBoard, parseToBoard, validateFromBoard, validateToBoard } from "../src/validate.ts";

// ---- one valid message of every kind (typed, so the validators and the types are held to each other)

const rect: El = { id: "r1", type: "rectangle", version: 3, x: 0, y: 0, width: 100, height: 50, isDeleted: false, boundElements: [{ id: "t1", type: "text" }], customData: { key: "api" }, frameId: null };
const text: El = { id: "t1", type: "text", version: 2, x: 4, y: 4, text: "API", containerId: "r1" };
const appState: SavedAppState = { scrollX: -20, scrollY: 12.5, zoom: { value: 1.5 }, viewBackgroundColor: "#ffffff" };
const style: CurrentItemStyle = { currentItemStrokeColor: "#1e1e1e", currentItemRoughness: 0, currentItemFontFamily: 6, currentItemStartArrowhead: null, currentItemRoundness: "sharp" };
const files = { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 } };
const filter: CanvasFilterMsg = {
  id: "aiwb-canvas-mocha",
  matrix: [...Array(20).keys()].map((i) => (i % 6 === 0 ? 1 : 0)),
  tables: { r: Array.from({ length: 256 }, (_, i) => i / 255), g: Array.from({ length: 256 }, (_, i) => i / 255), b: Array.from({ length: 256 }, (_, i) => i / 255) },
};
const theme: ThemeMsg = { mode: "dark", filter };
const scene = { elements: [rect, text], files, appState };

const toBoard = {
  load: { t: "load", board: "b1", scene, viewMode: false, theme, style },
  unload: { t: "unload" },
  viewMode: { t: "viewMode", on: true },
  theme: { t: "theme", theme: { mode: "light", filter: null } },
  select: { t: "select", ids: ["r1", "t1"] },
  scrollTo: { t: "scrollTo", ids: ["r1"], animate: true },
  req: { t: "req", id: 7, op: { op: "snapshot" } },
} satisfies Record<(typeof TO_BOARD_TYPES)[number], ToBoard>;

const fromBoard = {
  ready: { t: "ready", version: "0.18.1" },
  loaded: { t: "loaded", board: "b1" },
  changed: { t: "changed", board: "b1", elements: [rect, text], order: ["r1", "t1"], files, appState, style },
  view: { t: "view", board: "b1", scrollX: 10, scrollY: -4, zoom: 0.75, width: 800, height: 600 },
  selection: { t: "selection", board: "b1", ids: ["r1"] },
  res: { t: "res", id: 7, ok: true, value: { png: "iVBOR", bounds: { x: 0, y: 0, width: 10, height: 10 } } },
  error: { t: "error", message: "boom" },
} satisfies Record<(typeof FROM_BOARD_TYPES)[number], FromBoard>;

const ops = {
  apply: { op: "apply", target: "live", params: { create: [{ type: "rectangle", key: "a", x: 0, y: 0 }], update: [{ ref: { key: "a" }, x: 5 }], delete: [{ ref: { id: "r1" }, cascade: true }], select: [{ key: "a" }], focus: true }, rev: 4 },
  delete: { op: "delete", target: { elements: [rect, text] }, refs: [{ id: "r1" }, { key: "api" }], cascade: false, rev: 0 },
  restore: { op: "restore", elements: [{ id: "x", version: 1 }, { garbage: true }] },
  export: { op: "export", target: { elements: [rect], files, appState }, ids: ["r1"], scale: 2, background: true },
  snapshot: { op: "snapshot" },
} satisfies Record<(typeof ENGINE_OPS)[number], EngineOp>;

const ok = (r: { ok: boolean }, what: string) => assert.equal(r.ok, true, `${what}: ${(r as { error?: string }).error}`);
const bad = (r: { ok: boolean }, what: string) => assert.equal(r.ok, false, `${what} was accepted`);
const copy = <T>(v: T): T => structuredClone(v);
const set = (v: unknown, path: (string | number)[], value: unknown) => {
  let o = v as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[path.at(-1)!] = value;
  return v;
};

// ---- every message: round trip, and what a valid one must have

test("every message has a sample, and the samples cover every name", () => {
  assert.deepEqual(Object.keys(toBoard).sort(), [...TO_BOARD_TYPES].sort());
  assert.deepEqual(Object.keys(fromBoard).sort(), [...FROM_BOARD_TYPES].sort());
  assert.deepEqual(Object.keys(ops).sort(), [...ENGINE_OPS].sort());
});

for (const [t, m] of Object.entries(toBoard)) {
  test(`app → view "${t}": round trip through JSON, valid accepted`, () => {
    ok(validateToBoard(m), "the sample");
    const text = JSON.stringify(m);
    const back = parseToBoard(text);
    ok(back, "after JSON");
    assert.deepEqual(back.ok && back.value, m);
    assert.equal(JSON.stringify(back.ok && back.value), text);
  });
}

for (const [t, m] of Object.entries(fromBoard)) {
  test(`view → app "${t}": round trip through JSON, valid accepted`, () => {
    ok(validateFromBoard(m), "the sample");
    const text = JSON.stringify(m);
    const back = parseFromBoard(text);
    ok(back, "after JSON");
    assert.deepEqual(back.ok && back.value, m);
    assert.equal(JSON.stringify(back.ok && back.value), text);
  });
}

for (const [o, op] of Object.entries(ops)) {
  test(`request "${o}": round trip through JSON, valid accepted`, () => {
    const m: ToBoard = { t: "req", id: 1, op };
    ok(validateToBoard(m), "the request");
    const back = parseToBoard(JSON.stringify(m));
    ok(back, "after JSON");
    assert.deepEqual(back.ok && back.value, m);
  });
}

test("a message with a key missing, an unknown key, or a key of the wrong kind is rejected (every message)", () => {
  const all: [string, unknown, (m: unknown) => { ok: boolean }][] = [
    ...Object.entries(toBoard).map(([t, m]) => [`to ${t}`, m, validateToBoard] as [string, unknown, (m: unknown) => { ok: boolean }]),
    ...Object.entries(fromBoard).map(([t, m]) => [`from ${t}`, m, validateFromBoard] as [string, unknown, (m: unknown) => { ok: boolean }]),
    ...Object.entries(ops).map(([o, op]) => [`req ${o}`, { t: "req", id: 1, op }, validateToBoard] as [string, unknown, (m: unknown) => { ok: boolean }]),
  ];
  const optional = new Set(["from changed files", "from changed order", "from res value"]);
  for (const [what, m, validate] of all) {
    const target = (what.startsWith("req ") ? (m as { op: Record<string, unknown> }).op : (m as Record<string, unknown>));
    for (const k of Object.keys(target)) {
      if (optional.has(`${what} ${k}`)) continue;
      const without = copy(m) as typeof m;
      delete (what.startsWith("req ") ? (without as { op: Record<string, unknown> }).op : (without as Record<string, unknown>))[k];
      bad(validate(without), `${what} without ${k}`);
      if (k !== "t" && k !== "op") {
        const swapped = copy(m) as typeof m;
        (what.startsWith("req ") ? (swapped as { op: Record<string, unknown> }).op : (swapped as Record<string, unknown>))[k] = Symbol.for("not json");
        bad(validate(swapped), `${what} with ${k} a symbol`);
      }
    }
    const extra = copy(m) as typeof m;
    (what.startsWith("req ") ? (extra as { op: Record<string, unknown> }).op : (extra as Record<string, unknown>)).url = "https://example.com";
    bad(validate(extra), `${what} with an extra key`);
  }
});

test("a message of the other direction, an unknown type, and things that are no message are rejected", () => {
  for (const m of Object.values(toBoard)) if (m.t !== "theme" && m.t !== "select") bad(validateFromBoard(m), `to ${m.t} as from`);
  for (const m of Object.values(fromBoard)) bad(validateToBoard(m), `from ${m.t} as to`);
  for (const m of [{ t: "call", url: "http://x" }, { t: "fetch" }, { t: "" }, { t: 1 }, {}, [], null, undefined, "load", 7, { t: "__proto__" }, { t: "constructor" }, { t: "toString" }]) {
    bad(validateToBoard(m), `${JSON.stringify(m)} as to`);
    bad(validateFromBoard(m), `${JSON.stringify(m)} as from`);
  }
  const unknownOp = { t: "req", id: 1, op: { op: "fetch", url: "http://x" } };
  bad(validateToBoard(unknownOp), "an unknown request");
  bad(validateToBoard({ t: "req", id: 1, op: { op: "constructor" } }), "a request named like an Object member");
  bad(validateToBoard({ t: "req", id: 1, op: "snapshot" }), "a request that is a string");
});

test("parse: text that is not JSON or not a string is rejected, with a reason", () => {
  for (const text of ["", "{", "undefined", "{\"t\":", 5, null, {}]) {
    const a = parseToBoard(text), b = parseFromBoard(text);
    bad(a, `${String(text)} to`); bad(b, `${String(text)} from`);
    assert.match(!a.ok ? a.error : "", /^message: /);
  }
  const m = parseFromBoard(JSON.stringify({ t: "view", board: "b", scrollX: 0, scrollY: 0, zoom: 0, width: 1, height: 1 }));
  assert.equal(m.ok, false);
  assert.match(!m.ok ? m.error : "", /message\.zoom: not a number above 0/);
});

// ---- the parts

test("elements: an id and a version, nothing else is demanded, nothing that is not JSON", () => {
  const load = (elements: unknown[]) => ({ t: "load", board: "b", scene: { elements, files: {}, appState: {} }, viewMode: false, theme: { mode: "light", filter: null }, style: {} });
  ok(validateToBoard(load([])), "no elements");
  ok(validateToBoard(load([{ id: "a", version: 0, anything: { goes: [1, "two", null] } }])), "a loose element");
  for (const e of [{ version: 1 }, { id: "", version: 1 }, { id: 1, version: 1 }, { id: "a" }, { id: "a", version: "1" }, { id: "a", version: NaN }, "a", null, [], { id: "a", version: 1, f: () => 1 }, { id: "a", version: 1, d: new Date() }, { id: "a", version: 1, m: new Map() }, { id: "a", version: 1, n: Infinity }, { id: "a", version: 1, b: 1n }])
    bad(validateToBoard(load([e])), typeof e === "object" ? JSON.stringify(e, (_, v) => (typeof v === "bigint" ? `${v}n` : v)) : String(e));
  const r = validateToBoard(load([rect, { id: "z" }]));
  assert.equal(!r.ok && r.error, "message.scene.elements[1].version: not a finite number");
});

test("JSON safety: functions, Blobs, class instances, cycles and deep nesting are rejected; undefined properties are absent", () => {
  const changed = (extra: Record<string, unknown>) => ({ t: "changed", board: "b", elements: [{ id: "a", version: 1, ...extra }], appState: {}, style: {} });
  ok(validateFromBoard(changed({ link: undefined })), "an undefined property");
  ok(validateFromBoard(changed({ link: null })), "a null");
  bad(validateFromBoard(changed({ blob: new Blob(["x"]) })), "a Blob");
  bad(validateFromBoard(changed({ f() {} })), "a function");
  bad(validateFromBoard(changed({ s: Symbol("x") })), "a symbol");
  bad(validateFromBoard(changed({ u: [undefined] })), "undefined in an array");
  bad(validateFromBoard(changed({ u8: new Uint8Array(2) })), "a typed array");
  class Point { x = 1; }
  bad(validateFromBoard(changed({ p: new Point() })), "a class instance");
  const cycle: Record<string, unknown> = {}; cycle.me = cycle;
  bad(validateFromBoard(changed({ cycle })), "a cycle");
  let deep: unknown = 1;
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = [deep];
  bad(validateFromBoard(changed({ deep })), "nesting too deep");
  bad(validateFromBoard({ t: "res", id: 1, ok: true, value: { blob: new Blob(["x"]) } }), "a Blob in a result");
  bad(validateFromBoard({ t: "res", id: 1, ok: true, value: () => 1 }), "a function as a result");
  ok(validateFromBoard({ t: "res", id: 1, ok: true, value: undefined }), "no value");
  ok(validateFromBoard({ t: "res", id: 1, ok: true, value: null }), "a null value");
});

test("files are objects by id, and the files of a changed message are optional", () => {
  const { files: _omitted, ...withoutFiles } = fromBoard.changed;
  ok(validateFromBoard(withoutFiles), "no files");
  ok(validateFromBoard({ ...fromBoard.changed, files: {} }), "an empty set of files");
  ok(validateFromBoard({ ...fromBoard.changed, files: undefined }), "undefined files");
  bad(validateFromBoard({ ...fromBoard.changed, files: { f1: "data:..." } }), "a file that is a string");
  bad(validateFromBoard({ ...fromBoard.changed, files: [] }), "files as an array");
});

test("`order` of a changed message is optional and a list of ids", () => {
  const { order: _omitted, ...withoutOrder } = fromBoard.changed;
  ok(validateFromBoard(withoutOrder), "no order");
  ok(validateFromBoard({ ...fromBoard.changed, order: [] }), "an empty order (every element is gone)");
  ok(validateFromBoard({ ...fromBoard.changed, order: undefined }), "undefined order");
  for (const o of ["r1", [1], [""], [null], { 0: "r1" }]) bad(validateFromBoard({ ...fromBoard.changed, order: o }), `order ${JSON.stringify(o)}`);
});

test("saved app state: four optional keys of their kinds, no others", () => {
  const withState = (state: unknown) => ({ ...fromBoard.changed, appState: state });
  ok(validateFromBoard(withState({})), "a board nobody drew on");
  ok(validateFromBoard(withState({ viewBackgroundColor: "#ffffff" })), "only the colour");
  for (const s of [{ scrollX: "0" }, { scrollY: null }, { scrollX: NaN }, { zoom: 1 }, { zoom: {} }, { zoom: { value: 0 } }, { zoom: { value: -1 } }, { zoom: { value: 1, extra: 1 } }, { viewBackgroundColor: 255 }, { width: 100 }, { selectedElementIds: {} }])
    bad(validateFromBoard(withState(s)), JSON.stringify(s));
});

test("current item style: currentItem* keys with plain values", () => {
  const withStyle = (st: unknown) => ({ ...fromBoard.changed, style: st });
  ok(validateFromBoard(withStyle({})), "empty");
  ok(validateFromBoard(withStyle(style)), "the sample");
  for (const s of [{ strokeColor: "#000" }, { currentItemFoo: {} }, { currentItemFoo: [] }, { currentItemFoo: NaN }, { currentItemFoo: undefined, other: 1 }, []])
    bad(validateFromBoard(withStyle(s)), JSON.stringify(s));
});

test("theme: light or dark, with a filter of an id, 20 matrix values and three tables of 256 values in 0 to 1, or none", () => {
  const msg = (t: unknown) => ({ t: "theme", theme: t });
  ok(validateToBoard(msg({ mode: "light", filter: null })), "light");
  ok(validateToBoard(msg({ mode: "dark", filter })), "dark with a filter");
  for (const t of [{ mode: "sepia", filter: null }, { mode: "dark" }, { filter: null }, { mode: "dark", filter: undefined }, "dark", { mode: "dark", filter: null, flavour: "mocha" },
    { mode: "dark", filter: { ...filter, id: "" } }, { mode: "dark", filter: { ...filter, id: "a b" } }, { mode: "dark", filter: { ...filter, id: "x\" onload=\"1" } }, { mode: "dark", filter: { ...filter, id: "a".repeat(65) } },
    { mode: "dark", filter: { ...filter, matrix: filter.matrix.slice(1) } }, { mode: "dark", filter: { ...filter, matrix: [...filter.matrix.slice(1), "0"] } },
    { mode: "dark", filter: { ...filter, tables: { ...filter.tables, r: filter.tables.r.slice(1) } } },
    { mode: "dark", filter: { ...filter, tables: { ...filter.tables, g: filter.tables.g.map((v, i) => (i === 3 ? 1.5 : v)) } } },
    { mode: "dark", filter: { ...filter, tables: { r: filter.tables.r, g: filter.tables.g } } },
    { mode: "dark", filter: { ...filter, tables: { ...filter.tables, a: [] } } }])
    bad(validateToBoard(msg(t)), JSON.stringify(t).slice(0, 80));
  assert.deepEqual(validateToBoard(msg({ mode: "dark", filter: { ...filter, id: "bad id" } })), { ok: false, error: "message.theme.filter.id: not an id of letters, digits, _ and -" });
});

test("theme: the chrome is a map of allowed custom properties to #rrggbb colours, or absent, or null", () => {
  const msg = (chrome: unknown) => ({ t: "theme", theme: { mode: "dark", filter: null, chrome } });
  const all = Object.fromEntries(CHROME_VARS.map((n, i) => [n, "#" + ((i * 4099) % 0xffffff).toString(16).padStart(6, "0")]));
  ok(validateToBoard(msg(all)), "every property");
  ok(validateToBoard(msg({})), "none");
  ok(validateToBoard(msg(null)), "null");
  ok(validateToBoard(msg({ "--island-bg-color": "#1E1E2E" })), "capitals");
  ok(validateToBoard({ t: "theme", theme: { mode: "dark", filter: null } }), "absent");
  ok(validateToBoard({ ...toBoard.load, theme: { ...theme, chrome: all } }), "in a load");
  const path = (m: unknown) => { const r = validateToBoard(m); return r.ok ? "ok" : r.error; };
  assert.equal(path(msg({ "--island-bg-color": "red" })), "message.theme.chrome.--island-bg-color: not a colour of the form #rrggbb");
  assert.equal(path(msg({ "--background": "#000000" })), "message.theme.chrome.--background: not a custom property of the chrome");
  assert.equal(path(msg([])), "message.theme.chrome: not an object");
  for (const [what, c] of Object.entries({
    "a short colour": { "--island-bg-color": "#fff" }, "an alpha colour": { "--island-bg-color": "#11223344" }, "no #": { "--island-bg-color": "112233" },
    "a function": { "--island-bg-color": "rgb(0,0,0)" }, "a variable": { "--island-bg-color": "var(--bg)" }, "a url": { "--island-bg-color": "url(https://x/y)" },
    "a declaration riding along": { "--island-bg-color": "#112233; background: url(https://x/y)" }, "a rule riding along": { "--island-bg-color": "#112233}\n.excalidraw{display:none" },
    "a number": { "--island-bg-color": 0x112233 }, "null": { "--island-bg-color": null }, "undefined": { "--island-bg-color": undefined, "--nope": "#000000" },
    "a property of the page": { "--bg": "#000000" }, "a property of the theme filter": { "--theme-filter": "#000000" }, "a CSS property": { "color": "#000000" },
    "a name with a quote": { "--a\"b": "#000000" }, "a prototype key": JSON.parse('{"__proto__": {"x": 1}}'), "a string": "#000000",
  })) bad(validateToBoard(msg(c)), what);
  assert.ok(CHROME_VARS.length < 100 && new Set(CHROME_VARS).size === CHROME_VARS.length && CHROME_VARS.every((n) => /^--[a-z0-9-]+$/.test(n)), "the list is small, without repeats, of plain names");
  assert.deepEqual(CHROME_VARS.filter((n) => n.startsWith("--aiwb")), ["--aiwb-line", "--aiwb-faint"], "(two of the board view's own)");
  // a map of more names than the list has is refused before the names are looked at one by one
  const many = Object.fromEntries(Array.from({ length: CHROME_VARS.length + 1 }, (_, i) => [`--x${i}`, "#000000"]));
  assert.match(path(msg(many)), /more than \d+ properties/);
  // the map crosses a web view's text as it is
  assert.deepEqual(JSON.parse(JSON.stringify(msg(all))), msg(all));
});

test("load carries the theme and the style too, and all of them are checked", () => {
  const load = toBoard.load;
  bad(validateToBoard({ ...load, theme: { mode: "x", filter: null } }), "a bad theme");
  bad(validateToBoard({ ...load, style: { stroke: 1 } }), "a bad style");
  bad(validateToBoard({ ...load, scene: { ...scene, appState: { zoom: 2 } } }), "a bad appState");
  bad(validateToBoard({ ...load, scene: { elements: [], files: {} } }), "no appState");
  bad(validateToBoard({ ...load, board: "" }), "no board");
  bad(validateToBoard({ ...load, viewMode: "yes" }), "a viewMode that is not a boolean");
  const { theme: _t, ...noTheme } = load;
  bad(validateToBoard(noTheme), "no theme");
});

test("ids: select and scrollTo take strings", () => {
  ok(validateToBoard({ t: "select", ids: [] }), "an empty selection");
  bad(validateToBoard({ t: "select", ids: "r1" }), "ids a string");
  bad(validateToBoard({ t: "select", ids: [1] }), "ids numbers");
  bad(validateToBoard({ t: "scrollTo", ids: ["a"] }), "no animate");
  bad(validateToBoard({ t: "scrollTo", ids: ["a"], animate: 1 }), "animate a number");
  bad(validateFromBoard({ t: "selection", board: "b", ids: [null] }), "a null id");
});

test("view: numbers, a zoom above 0, a size of 0 or more", () => {
  const v = fromBoard.view;
  ok(validateFromBoard({ ...v, width: 0, height: 0 }), "a size of 0");
  for (const bad1 of [{ zoom: 0 }, { zoom: -1 }, { zoom: "1" }, { zoom: { value: 1 } }, { width: -1 }, { height: NaN }, { scrollX: Infinity }, { scrollY: null }, { board: "" }])
    bad(validateFromBoard({ ...v, ...bad1 }), JSON.stringify(bad1));
});

test("requests: ids and revisions are whole numbers, targets are \"live\" or elements", () => {
  const req = (op: unknown, id: unknown = 1) => ({ t: "req", id, op });
  for (const id of [-1, 1.5, "1", NaN, null, 2 ** 60]) bad(validateToBoard(req({ op: "snapshot" }, id)), `id ${String(id)}`);
  ok(validateToBoard(req({ op: "snapshot" }, 0)), "id 0");
  for (const rev of [-1, 0.5, "1", null]) bad(validateToBoard(req({ ...ops.apply, rev })), `rev ${String(rev)}`);
  for (const target of ["elsewhere", null, {}, { elements: "x" }, { elements: [{ id: "a" }] }, { elements: [], files: {} }]) bad(validateToBoard(req({ ...ops.apply, target })), `target ${JSON.stringify(target)}`);
  ok(validateToBoard(req({ ...ops.apply, target: { elements: [] } })), "no elements as the target");
  for (const target of ["live", { elements: [rect], files: {} }, { elements: [rect], appState }, { elements: [rect] }]) {
    const r = validateToBoard(req({ ...ops.export, target }));
    assert.equal(r.ok, target === "live", JSON.stringify(target).slice(0, 60));
  }
  for (const bad1 of [{ scale: 0 }, { scale: -1 }, { scale: "2" }, { background: 1 }, { ids: "r1" }, { ids: [1] }]) bad(validateToBoard(req({ ...ops.export, ...bad1 })), JSON.stringify(bad1));
  for (const bad1 of [{ cascade: 1 }, { refs: [{}] }, { refs: [{ id: "a", key: "b" }] }, { refs: [{ id: 1 }] }, { refs: ["server"] }, { refs: [{ id: "" }] }, { refs: [{ kind: "point", x: 0, y: 0 }] }, { refs: [{ id: "a", extra: 1 }] }, { refs: "a" }])
    bad(validateToBoard(req({ ...ops.delete, ...bad1 })), JSON.stringify(bad1));
  const r = validateToBoard(req({ ...ops.delete, refs: ["server"] }));
  assert.match(!r.ok ? r.error : "", /a ref is \{"id": "\.\.\."\} or \{"key": "\.\.\."\}/);
});

test("apply params: lists of objects, refs to select, a boolean to focus, nothing else", () => {
  const apply = (params: unknown) => ({ t: "req", id: 1, op: { op: "apply", target: "live", params, rev: 0 } });
  ok(validateToBoard(apply({})), "empty params");
  for (const p of [{ create: {} }, { create: ["a"] }, { create: [null] }, { update: [[]] }, { delete: "x" }, { select: [{ both: 1 }] }, { select: ["a"] }, { focus: "yes" }, { board: "other" }, { create: [{ f: () => 1 }] }, { create: [{ n: NaN }] }, []])
    bad(validateToBoard(apply(p)), JSON.stringify(p));
  assert.equal(validateToBoard(apply({ create: [{ type: "rectangle" }, 3] })).ok, false);
});

test("res: ok with a value, or failed with a code and a message", () => {
  ok(validateFromBoard({ t: "res", id: 3, ok: false, code: "BAD_REF", message: "no live element for {\"id\":\"x\"}" }), "a failure");
  for (const m of [{ t: "res", id: 3, ok: false, code: "BAD_REF" }, { t: "res", id: 3, ok: false, message: "x" }, { t: "res", id: 3, ok: false, code: 1, message: "x" },
    { t: "res", id: 3, ok: false, code: "A", message: "x", value: 1 }, { t: "res", id: 3, value: 1 }, { t: "res", id: 3, ok: "yes", value: 1 }, { t: "res", id: -1, ok: true, value: 1 }, { t: "res", ok: true, value: 1 },
    { t: "res", id: 3, ok: true, value: 1, code: "A" }])
    bad(validateFromBoard(m), JSON.stringify(m));
});

test("the bridge has no place for an address, a secret or a call: such keys are rejected wherever they go", () => {
  for (const k of ["url", "address", "secret", "token", "server", "fetch", "call", "headers"]) {
    for (const m of [...Object.values(toBoard)]) bad(validateToBoard({ ...m, [k]: "x" }), `${k} on to ${m.t}`);
    for (const m of [...Object.values(fromBoard)]) bad(validateFromBoard({ ...m, [k]: "x" }), `${k} on from ${m.t}`);
    bad(validateToBoard({ ...toBoard.load, theme: { ...theme, [k]: "x" } }), `${k} in a theme`);
    bad(validateToBoard({ ...toBoard.load, scene: { ...scene, [k]: "x" } }), `${k} in a scene`);
    bad(validateToBoard({ ...toBoard.load, scene: { ...scene, appState: { [k]: "x" } } }), `${k} in an appState`);
    bad(validateToBoard({ t: "req", id: 1, op: { ...ops.snapshot, [k]: "x" } }), `${k} in a request`);
  }
});

test("a message from JSON.parse with a __proto__ key is rejected like any unknown key", () => {
  bad(parseToBoard("{\"t\":\"unload\",\"__proto__\":{\"polluted\":true}}"), "__proto__");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  ok(parseToBoard("{\"t\":\"unload\"}"), "unload");
});
