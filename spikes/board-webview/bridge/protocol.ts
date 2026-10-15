// The bridge between the app and the board in a web view: every message that crosses, typed once.
// This one module is imported by the app side (Metro) and by the web-view side (esbuild). It has no
// imports and no DOM or React Native types, so both can take it, and node can test it.
//
// Three kinds of message, all JSON text with a version:
//   request  app -> web view   {v, kind:"request", id, type, ...params}     answered by exactly one reply
//   reply    web view -> app   {v, kind:"reply", id, ok:true, result} | {v, kind:"reply", id, ok:false, error}
//   event    web view -> app   {v, kind:"event", type, ...}                  nothing answers it
// Both sides parse what they receive with `parseRequest` / `parseFromBoard` below and drop what does not fit:
// an unknown type, a missing field, a field of another type, a message over MAX_MESSAGE. The web view can
// ask for nothing but what REQUEST_TYPES lists, and the app takes from it nothing but the replies and events.

export const PROTOCOL_VERSION = 1;
/** The size over which a message is dropped unread (a 2,000 element board is about 1.5 MB). */
export const MAX_MESSAGE = 64 * 1024 * 1024;
export const MAX_ELEMENTS = 100_000;

// ---- shapes

/** An Excalidraw element. The bridge checks the few fields every element has and passes the rest through:
 *  Excalidraw's own `restoreElements` repairs the rest. */
export type El = { id: string; type: string; x: number; y: number; isDeleted?: boolean; [k: string]: unknown };
export type SceneData = {
  elements: El[];
  appState?: { viewBackgroundColor?: string; scrollX?: number; scrollY?: number; zoom?: { value: number } };
  files?: Record<string, unknown>;
};
export type Ref = { id: string } | { key: string };
/** The change an agent makes (the `apply` tool: web/src/apply.ts ApplyParams). */
export type ApplyChange = { create?: Obj[]; update?: Obj[]; delete?: Obj[]; select?: Ref[]; focus?: boolean };
export type ApplyResult = {
  created: Record<string, string>; updated: string[]; deleted: string[];
  conflicts: { ref: Ref; expectedVersion: number; actualVersion: number | undefined }[]; rev: number;
};
export type Obj = { [k: string]: unknown };
export const THEMES = ["light", "dark", "latte", "frappe", "macchiato", "mocha"] as const;
export type ThemeName = typeof THEMES[number];
export const TOOLS = ["selection", "freedraw", "rectangle", "ellipse", "diamond", "arrow", "line", "text", "hand", "eraser"] as const;
export type ToolName = typeof TOOLS[number];
/** What a chat needs to refer to a selected element. */
export type SelectedEl = { id: string; type: string; x: number; y: number; width: number; height: number; label?: string };

// ---- requests (app -> web view): params and result of each

export type Requests = {
  /** Replace the board shown by a scene. `readOnly`: the window does not hold the board, it only shows it. */
  loadScene: { params: { scene: SceneData; readOnly?: boolean }; result: { elements: number; ms: number } };
  /** Apply an agent's change: create, update and delete elements. */
  applyChange: { params: { change: ApplyChange }; result: ApplyResult };
  /** The scene as it is now (all elements, deleted too). */
  getScene: { params: Record<string, never>; result: { scene: SceneData; version: number } };
  /** Select elements and scroll them into view (a reference of a chat shown). */
  select: { params: { ids: string[]; scroll?: boolean }; result: { selected: number } };
  /** The board as a PNG, base64 without a data: prefix. */
  exportPng: {
    params: { scale?: number; background?: boolean; selectedOnly?: boolean };
    result: { base64: string; width: number; height: number; bytes: number; ms: number };
  };
  /** Send the pending change now (the app goes away): the `sceneChanged` event is sent before this is answered. */
  flush: { params: Record<string, never>; result: { pending: boolean; version: number } };
  setTheme: { params: { theme: ThemeName }; result: { theme: ThemeName } };
  /** The drawing tool (the app's own toolbar, or a pencil mode). */
  setTool: { params: { tool: ToolName }; result: { tool: ToolName } };
  /** Spike only: try to reach these addresses from the page, to show the page cannot. */
  probeNetwork: { params: { urls: string[] }; result: { attempts: { url: string; how: string; outcome: string }[]; violations: number } };
};
export type RequestType = keyof Requests;
export const REQUEST_TYPES = ["loadScene", "applyChange", "getScene", "select", "exportPng", "flush", "setTheme", "setTool", "probeNetwork"] as const satisfies readonly RequestType[];

export type Request = { [T in RequestType]: { v: 1; kind: "request"; id: string; type: T } & Requests[T]["params"] }[RequestType];
export type ErrorBody = { code: string; message: string };
export type Reply = { v: 1; kind: "reply"; id: string } & ({ ok: true; result: unknown } | { ok: false; error: ErrorBody });

// ---- events (web view -> app)

export type Event =
  /** The page is up: its protocol and Excalidraw versions, and how long the load took in the page. */
  | { v: 1; kind: "event"; type: "ready"; protocol: number; excalidraw: string; loadMs: number }
  /** The scene changed, debounced (or at once for `flush`). `scene` is the whole scene. */
  | { v: 1; kind: "event"; type: "sceneChanged"; version: number; flushed: boolean; elements: number; scene: SceneData }
  /** The selection changed (not debounced: it is small). */
  | { v: 1; kind: "event"; type: "selection"; ids: string[]; elements: SelectedEl[] }
  /** Something the page wants the app's log to hold: an error, a blocked address. */
  | { v: 1; kind: "event"; type: "log"; level: "info" | "warn" | "error"; text: string };
export type EventType = Event["type"];
export type FromBoard = Reply | Event;

// ---- building

export const request = <T extends RequestType>(id: string, type: T, params: Requests[T]["params"]): Request =>
  ({ v: 1, kind: "request", id, type, ...params }) as Request;
export const ok = (id: string, result: unknown): Reply => ({ v: 1, kind: "reply", id, ok: true, result });
export const fail = (id: string, code: string, message: string): Reply => ({ v: 1, kind: "reply", id, ok: false, error: { code, message } });
export const encode = (m: Request | Reply | Event): string => JSON.stringify(m);

// ---- validating

export type Parsed<T> = { ok: true; value: T } | { ok: false; id?: string; reason: string };
const bad = (reason: string, id?: string): { ok: false; id?: string; reason: string } => ({ ok: false, id, reason });

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const optNum = (x: unknown) => x === undefined || isNum(x);
const optBool = (x: unknown) => x === undefined || typeof x === "boolean";
const isStrList = (x: unknown, max = MAX_ELEMENTS): x is string[] => Array.isArray(x) && x.length <= max && x.every(isStr);
const isRef = (x: unknown): x is Ref => isObj(x) && (isStr(x.id) || isStr(x.key));
const objList = (x: unknown, what: string): string | null =>
  x === undefined ? null : !Array.isArray(x) || x.length > MAX_ELEMENTS ? `${what} is not a list of at most ${MAX_ELEMENTS}` : x.every(isObj) ? null : `${what} holds a non-object`;

/** Null when `e` has what every element has. Excalidraw's restoreElements repairs the rest. */
function elementProblem(e: unknown): string | null {
  if (!isObj(e)) return "an element is not an object";
  if (!isStr(e.id) || !e.id) return "an element has no id";
  if (!isStr(e.type) || !e.type) return `element ${e.id} has no type`;
  if (!isNum(e.x) || !isNum(e.y)) return `element ${e.id} has no position`;
  return null;
}

/** Null when `s` is a scene. */
export function sceneProblem(s: unknown): string | null {
  if (!isObj(s)) return "scene is not an object";
  if (!Array.isArray(s.elements)) return "scene.elements is not a list";
  if (s.elements.length > MAX_ELEMENTS) return `scene has more than ${MAX_ELEMENTS} elements`;
  for (const e of s.elements) { const p = elementProblem(e); if (p) return p; }
  if (s.appState !== undefined) {
    if (!isObj(s.appState)) return "scene.appState is not an object";
    const a = s.appState;
    if (a.viewBackgroundColor !== undefined && !isStr(a.viewBackgroundColor)) return "appState.viewBackgroundColor is not a string";
    if (!optNum(a.scrollX) || !optNum(a.scrollY)) return "appState.scroll is not a number";
    if (a.zoom !== undefined && !(isObj(a.zoom) && isNum(a.zoom.value))) return "appState.zoom is not {value}";
  }
  if (s.files !== undefined && !isObj(s.files)) return "scene.files is not an object";
  return null;
}

function changeProblem(c: unknown): string | null {
  if (!isObj(c)) return "change is not an object";
  for (const k of ["create", "update", "delete"] as const) { const p = objList(c[k], `change.${k}`); if (p) return p; }
  if (c.select !== undefined && !(Array.isArray(c.select) && c.select.every(isRef))) return "change.select holds a non-ref";
  if (!optBool(c.focus)) return "change.focus is not a boolean";
  return null;
}

const NO_PARAMS = (m: Obj) => Object.keys(m).every((k) => ["v", "kind", "id", "type"].includes(k)) ? null : "this request takes no parameters";

/** Per request type: null when its params are right, else what is wrong. */
const PARAMS: { [T in RequestType]: (m: Obj) => string | null } = {
  loadScene: (m) => sceneProblem(m.scene) ?? (optBool(m.readOnly) ? null : "readOnly is not a boolean"),
  applyChange: (m) => changeProblem(m.change),
  getScene: NO_PARAMS,
  select: (m) => !isStrList(m.ids) ? "ids is not a list of strings" : optBool(m.scroll) ? null : "scroll is not a boolean",
  exportPng: (m) => !optNum(m.scale) || (m.scale !== undefined && ((m.scale as number) < 0.1 || (m.scale as number) > 4)) ? "scale is not a number from 0.1 to 4"
    : !optBool(m.background) || !optBool(m.selectedOnly) ? "background and selectedOnly are booleans" : null,
  flush: NO_PARAMS,
  setTheme: (m) => (THEMES as readonly unknown[]).includes(m.theme) ? null : `theme is not one of ${THEMES.join(", ")}`,
  setTool: (m) => (TOOLS as readonly unknown[]).includes(m.tool) ? null : `tool is not one of ${TOOLS.join(", ")}`,
  probeNetwork: (m) => isStrList(m.urls, 20) ? null : "urls is not a list of at most 20 strings",
};

function parseJson(raw: unknown): Parsed<Obj> {
  if (!isStr(raw)) return bad("the message is not text");
  if (raw.length > MAX_MESSAGE) return bad(`the message is over ${MAX_MESSAGE} characters`);
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return bad("the message is not JSON"); }
  if (!isObj(m)) return bad("the message is not an object");
  if (m.v !== PROTOCOL_VERSION) return bad(`protocol version ${String(m.v)}, expected ${PROTOCOL_VERSION}`);
  return { ok: true, value: m };
}

/** The web view's side: what the app sent. Anything but a known request with the right params is refused. */
export function parseRequest(raw: unknown): Parsed<Request> {
  const j = parseJson(raw);
  if (!j.ok) return j;
  const m = j.value;
  const id = isStr(m.id) && m.id.length <= 100 ? m.id : undefined;
  if (m.kind !== "request") return bad("not a request", id);
  if (!id) return bad("a request has an id of at most 100 characters");
  if (!isStr(m.type) || !(REQUEST_TYPES as readonly string[]).includes(m.type)) return bad(`unknown request type ${JSON.stringify(m.type)}`, id);
  const p = PARAMS[m.type as RequestType](m);
  return p ? bad(p, id) : { ok: true, value: m as unknown as Request };
}

/** The app's side: what the web view sent. A reply or one of the known events; nothing else is taken. */
export function parseFromBoard(raw: unknown): Parsed<FromBoard> {
  const j = parseJson(raw);
  if (!j.ok) return j;
  const m = j.value;
  if (m.kind === "reply") {
    if (!isStr(m.id)) return bad("a reply has no id");
    if (m.ok === true) return "result" in m ? { ok: true, value: m as unknown as Reply } : bad("a reply has no result", m.id);
    if (m.ok === false && isObj(m.error) && isStr(m.error.code) && isStr(m.error.message)) return { ok: true, value: m as unknown as Reply };
    return bad("a reply is neither ok nor an error", m.id);
  }
  if (m.kind !== "event") return bad("neither a reply nor an event");
  switch (m.type) {
    case "ready":
      return isNum(m.protocol) && isStr(m.excalidraw) && isNum(m.loadMs) ? { ok: true, value: m as unknown as Event } : bad("a bad ready event");
    case "sceneChanged": {
      const p = sceneProblem(m.scene);
      return p ? bad(p) : isNum(m.version) && typeof m.flushed === "boolean" && isNum(m.elements) ? { ok: true, value: m as unknown as Event } : bad("a bad sceneChanged event");
    }
    case "selection":
      return isStrList(m.ids) && Array.isArray(m.elements) && m.elements.length <= 100 && m.elements.every((e) => isObj(e) && isStr(e.id) && isStr(e.type))
        ? { ok: true, value: m as unknown as Event } : bad("a bad selection event");
    case "log":
      return (m.level === "info" || m.level === "warn" || m.level === "error") && isStr(m.text) ? { ok: true, value: m as unknown as Event } : bad("a bad log event");
    default:
      return bad(`unknown event type ${JSON.stringify(m.type)}`);
  }
}
