// A validator for every message of the bridge (AD-50). The app runs `validateFromBoard` on what the board view sends,
// the view runs `validateToBoard` on what the app sends; a message that fails is logged and dropped, never acted on.
//
// What a valid message is:
// - an object of exactly the keys its type has: an unknown key is rejected (the bridge has no room for a call, an
//   address or a secret to ride along), a missing one too;
// - JSON-safe all the way down: null, booleans, finite numbers, strings, arrays, plain objects. A function, a Blob, a
//   Map, a class instance, NaN or Infinity is rejected, and so is a nesting deeper than MAX_DEPTH. A property whose
//   value is `undefined` counts as absent, which is what JSON does with it (the in-page view hands over objects, not text);
// - elements and files are loose: an element has a string `id` and a number `version`, a file is an object, and what
//   else they hold is the engine's business.
// The validators return the message they were given (not a copy), typed.
import { CHROME_COLOUR, CHROME_VARS, isChromeVar } from "./chrome.ts";
import type { EngineValues, FromBoard, ToBoard } from "./messages.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The deepest nesting a payload may have; an Excalidraw element is under ten. */
export const MAX_DEPTH = 64;

// ---- checks: a check returns null when the value is fine, else what is wrong with it (path first)

type Check = (v: unknown, path: string) => string | null;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const has = (o: Obj, k: string) => Object.hasOwn(o, k) && o[k] !== undefined;
const fail = (path: string, what: string) => `${path}: ${what}`;

const str: Check = (v, p) => (typeof v === "string" ? null : fail(p, "not a string"));
const name: Check = (v, p) => (typeof v === "string" && v !== "" ? null : fail(p, "not a non-empty string"));
const bool: Check = (v, p) => (typeof v === "boolean" ? null : fail(p, "not a boolean"));
const num: Check = (v, p) => (typeof v === "number" && Number.isFinite(v) ? null : fail(p, "not a finite number"));
const positive: Check = (v, p) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? null : fail(p, "not a number above 0"));
const atLeast0: Check = (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : fail(p, "not a number of 0 or more"));
const count: Check = (v, p) => (Number.isSafeInteger(v) && (v as number) >= 0 ? null : fail(p, "not a whole number of 0 or more"));
const lit = (want: unknown): Check => (v, p) => (v === want ? null : fail(p, `not ${JSON.stringify(want)}`));
const oneOf = (...want: string[]): Check => (v, p) => (typeof v === "string" && want.includes(v) ? null : fail(p, `not one of ${want.join(", ")}`));

/** Every item of an array passes `item`; `length` fixes the length. */
const list = (item: Check, length?: number): Check => (v, p) => {
  if (!Array.isArray(v)) return fail(p, "not an array");
  if (length !== undefined && v.length !== length) return fail(p, `not ${length} items`);
  for (let i = 0; i < v.length; i++) { const e = item(v[i], `${p}[${i}]`); if (e) return e; }
  return null;
};

/** A JSON-safe value (see the top of the file). */
function json(v: unknown, p: string, depth = 0): string | null {
  if (depth > MAX_DEPTH) return fail(p, "nested too deep");
  if (v === null || typeof v === "boolean" || typeof v === "string") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : fail(p, "not a finite number");
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const e = json(v[i], `${p}[${i}]`, depth + 1); if (e) return e; }
    return null;
  }
  if (isObj(v)) {
    for (const k of Object.keys(v)) { if (v[k] === undefined) continue; const e = json(v[k], `${p}.${k}`, depth + 1); if (e) return e; }
    return null;
  }
  return fail(p, `not JSON-safe (${typeof v === "object" ? "a " + (Object.getPrototypeOf(v)?.constructor?.name ?? "foreign object") : typeof v})`);
}
const jsonCheck: Check = (v, p) => json(v, p);
const plainJson: Check = (v, p) => (isObj(v) ? json(v, p) : fail(p, "not an object"));

/** An object with exactly these keys: `req` must be there, `opt` may be (absent or undefined). Nothing else is. */
const shape = (req: Record<string, Check>, opt: Record<string, Check> = {}): Check => (v, p) => {
  if (!isObj(v)) return fail(p, "not an object");
  for (const k of Object.keys(v)) if (!Object.hasOwn(req, k) && !Object.hasOwn(opt, k)) return fail(`${p}.${k}`, "unknown key");
  for (const k of Object.keys(req)) {
    if (!has(v, k)) return fail(`${p}.${k}`, "missing");
    const e = req[k](v[k], `${p}.${k}`); if (e) return e;
  }
  for (const k of Object.keys(opt)) if (has(v, k)) { const e = opt[k](v[k], `${p}.${k}`); if (e) return e; }
  return null;
};
const nullable = (c: Check): Check => (v, p) => (v === null ? null : c(v, p));
const either = (a: Check, b: Check, what: string): Check => (v, p) => (a(v, p) === null || b(v, p) === null ? null : fail(p, what));

// ---- the loose types of the engine

const element: Check = (v, p) => {
  if (!isObj(v)) return fail(p, "not an object");
  if (typeof v.id !== "string" || v.id === "") return fail(`${p}.id`, "not a non-empty string");
  if (typeof v.version !== "number" || !Number.isFinite(v.version)) return fail(`${p}.version`, "not a finite number");
  return json(v, p);
};
const elements: Check = list(element);
const files: Check = (v, p) => {
  if (!isObj(v)) return fail(p, "not an object");
  for (const k of Object.keys(v)) if (!isObj(v[k])) return fail(`${p}.${k}`, "a file is not an object");
  return json(v, p);
};
const appState: Check = shape({}, { scrollX: num, scrollY: num, zoom: shape({ value: positive }), viewBackgroundColor: str });
const style: Check = (v, p) => {
  if (!isObj(v)) return fail(p, "not an object");
  for (const k of Object.keys(v)) {
    if (!k.startsWith("currentItem")) return fail(`${p}.${k}`, "not a currentItem key");
    const x = v[k];
    if (!(x === null || typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x)))) return fail(`${p}.${k}`, "not a string, number, boolean or null");
  }
  return null;
};
const scene = shape({ elements, files, appState });

const filterId: Check = (v, p) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : fail(p, "not an id of letters, digits, _ and -"));
const unit: Check = (v, p) => (typeof v === "number" && v >= 0 && v <= 1 ? null : fail(p, "not a number from 0 to 1"));
const filter = shape({ id: filterId, matrix: list(num, 20), tables: shape({ r: list(unit, 256), g: list(unit, 256), b: list(unit, 256) }) });
/** The chrome map: only the custom properties of `chrome.ts`, each a `#rrggbb` colour. */
const chrome: Check = (v, p) => {
  if (!isObj(v)) return fail(p, "not an object");
  const names = Object.keys(v);
  if (names.length > CHROME_VARS.length) return fail(p, `more than ${CHROME_VARS.length} properties`);
  for (const k of names) {
    if (!isChromeVar(k)) return fail(`${p}.${k}`, "not a custom property of the chrome");
    if (typeof v[k] !== "string" || !CHROME_COLOUR.test(v[k])) return fail(`${p}.${k}`, "not a colour of the form #rrggbb");
  }
  return null;
};
const theme = shape({ mode: oneOf("light", "dark"), filter: nullable(filter) }, { chrome: nullable(chrome) });

const ref: Check = (v, p) => {
  if (!isObj(v)) return fail(p, "a ref is {\"id\": \"...\"} or {\"key\": \"...\"}");
  const keys = Object.keys(v);
  if (keys.length !== 1 || (keys[0] !== "id" && keys[0] !== "key")) return fail(p, "a ref is {\"id\": \"...\"} or {\"key\": \"...\"}");
  return name(v[keys[0]], `${p}.${keys[0]}`);
};
const params = shape({}, { create: list(plainJson), update: list(plainJson), delete: list(plainJson), select: list(ref), focus: bool });
const target = either(lit("live"), shape({ elements }), "not \"live\" or {elements}");

// ---- the requests

const ops: Record<string, Check> = {
  apply: shape({ op: lit("apply"), target, params, rev: count }),
  delete: shape({ op: lit("delete"), target, refs: list(ref), cascade: bool, rev: count }),
  restore: shape({ op: lit("restore"), elements: list(jsonCheck) }),
  export: shape({
    op: lit("export"),
    target: either(lit("live"), shape({ elements, files, appState }), "not \"live\" or {elements, files, appState}"),
    ids: list(str), scale: positive, background: bool,
  }),
  snapshot: shape({ op: lit("snapshot") }),
};
const op: Check = (v, p) => {
  if (!isObj(v) || typeof v.op !== "string") return fail(p, "not a request");
  if (!Object.hasOwn(ops, v.op)) return fail(`${p}.op`, `unknown request "${v.op}"`);
  return ops[v.op](v, p);
};

// ---- the messages

const toBoard: Record<string, Check> = {
  load: shape({ t: lit("load"), board: name, scene, viewMode: bool, theme, style }),
  unload: shape({ t: lit("unload") }),
  viewMode: shape({ t: lit("viewMode"), on: bool }),
  theme: shape({ t: lit("theme"), theme }),
  select: shape({ t: lit("select"), ids: list(str) }),
  scrollTo: shape({ t: lit("scrollTo"), ids: list(str), animate: bool }),
  req: shape({ t: lit("req"), id: count, op }),
};

const resOk = shape({ t: lit("res"), id: count, ok: lit(true) }, { value: jsonCheck });
const resFailed = shape({ t: lit("res"), id: count, ok: lit(false), code: str, message: str });
const fromBoard: Record<string, Check> = {
  ready: shape({ t: lit("ready"), version: str }),
  loaded: shape({ t: lit("loaded"), board: name }),
  changed: shape({ t: lit("changed"), board: name, elements, appState, style }, { files, order: list(name) }),
  view: shape({ t: lit("view"), board: name, scrollX: num, scrollY: num, zoom: positive, width: atLeast0, height: atLeast0 }),
  selection: shape({ t: lit("selection"), board: name, ids: list(str) }),
  res: (v, p) => (isObj(v) && v.ok === false ? resFailed(v, p) : resOk(v, p)),
  error: shape({ t: lit("error"), message: str }),
};

// ---- the values of the replies, by request (what `res.value` holds; the app checks it against the op it sent)

const applyShape: Record<string, Check> = {
  created: (v: unknown, p: string) => {
    if (!isObj(v)) return fail(p, "not an object");
    for (const k of Object.keys(v)) { const e = name(v[k], `${p}.${k}`); if (e) return e; }
    return null;
  },
  updated: list(str),
  deleted: list(str),
  conflicts: list(shape({ ref, expectedVersion: num }, { actualVersion: num })),
  rev: count,
};
const apply = shape(applyShape, { elements });

const values: { [Op in keyof EngineValues]: Check } = {
  apply,
  delete: apply,
  restore: shape({ elements }),
  export: shape({
    png: name, width: positive, height: positive,
    bounds: shape({ x: num, y: num, width: atLeast0, height: atLeast0 }),
    count,
  }),
  snapshot: shape({ board: name, elements, files, appState, style }),
};

/** Checks the `value` of a `res` against the request it answers (`op` is the request's `op`). */
export function validateEngineValue<Op extends keyof EngineValues>(op: Op, value: unknown): Result<EngineValues[Op]> {
  if (!Object.hasOwn(values, op)) return { ok: false, error: `value: unknown request "${String(op)}"` };
  const error = values[op](value, "value");
  return error ? { ok: false, error } : { ok: true, value: value as EngineValues[Op] };
}
export const validateApplyValue = (v: unknown) => validateEngineValue("apply", v);
export const validateDeleteValue = (v: unknown) => validateEngineValue("delete", v);
export const validateRestoreValue = (v: unknown) => validateEngineValue("restore", v);
export const validateExportValue = (v: unknown) => validateEngineValue("export", v);
export const validateSnapshotValue = (v: unknown) => validateEngineValue("snapshot", v);

function run<T>(table: Record<string, Check>, direction: string, m: unknown): Result<T> {
  if (!isObj(m) || typeof m.t !== "string") return { ok: false, error: "message: not an object with a type `t`" };
  if (!Object.hasOwn(table, m.t)) return { ok: false, error: `message.t: unknown ${direction} message "${m.t}"` };
  const error = table[m.t](m, "message");
  return error ? { ok: false, error } : { ok: true, value: m as T };
}

/** Checks a message from the app to the board view. */
export const validateToBoard = (m: unknown): Result<ToBoard> => run<ToBoard>(toBoard, "app → view", m);
/** Checks a message from the board view to the app. */
export const validateFromBoard = (m: unknown): Result<FromBoard> => run<FromBoard>(fromBoard, "view → app", m);

function parse<T>(text: unknown, check: (m: unknown) => Result<T>): Result<T> {
  if (typeof text !== "string") return { ok: false, error: "message: not a string" };
  let m: unknown;
  try { m = JSON.parse(text); } catch (e) { return { ok: false, error: `message: not JSON (${(e as Error).message})` }; }
  return check(m);
}
/** The text a web view hands over (`postMessage`, `aiwbBoardReceive`), parsed and checked. */
export const parseToBoard = (text: unknown): Result<ToBoard> => parse(text, validateToBoard);
export const parseFromBoard = (text: unknown): Result<FromBoard> => parse(text, validateFromBoard);
