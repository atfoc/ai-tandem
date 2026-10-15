// The board in the web view: Excalidraw and the bridge to the app (bridge/protocol.ts). It does what the page's
// Canvas.tsx and board.ts do for a board, with no server: it shows the scene the app gives it, applies an agent's
// change with the page's own engine (web/src/apply.ts, used unchanged), tells the app about changes and the
// selection, draws a PNG on request, and sends the pending change before the app goes away.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, FONT_FAMILY, restoreElements, getSceneVersion, exportToBlob, THEME } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./page.css";
import { applyChanges, RpcError } from "../../../../web/src/apply.ts";
import { CanvasFilters } from "../../../../web/src/CanvasFilters.tsx";
import { FLAVOURS, type Flavour } from "../../../../packages/core/src/logic/theme.ts";
import {
  PROTOCOL_VERSION, parseRequest, encode, ok, fail,
  type Request, type Event, type Reply, type SceneData, type ThemeName, type SelectedEl, type El, type Requests,
} from "../../bridge/protocol.ts";

declare const __EXCALIDRAW_VERSION__: string;
declare global { interface Window { ReactNativeWebView?: { postMessage(s: string): void }; __aiwb?: any } }

const SAVE_DEBOUNCE = 500; // the page's (web/src/board.ts SAVE_DEBOUNCE)

// ---- to the app

// in a plain browser (a test) there is no web view: what the page says is kept in window.__aiwb.out, and what it is told is
// handed to window.__aiwb.receive; the web view has neither use for them
const aiwb: { out: string[]; receive?: (raw: unknown) => void } = (window.__aiwb = { out: [] });
const toApp = (m: Event | Reply) => {
  const s = encode(m);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
  else aiwb.out.push(s); // in a plain browser: kept for a test to read
};
const log = (level: "info" | "warn" | "error", text: string) => toApp({ v: 1, kind: "event", type: "log", level, text: text.slice(0, 2000) });

// What the page is not allowed to reach (CSP in the page's head): every violation is counted and told.
let violations = 0;
document.addEventListener("securitypolicyviolation", (e) => {
  violations++;
  if (violations <= 20) log("warn", `blocked ${e.violatedDirective}: ${e.blockedURI}`);
});
// what touches the board: the first pointer of each kind (touch, pen, mouse) is told, to show what kind of input reached the page
const pointers = new Set<string>();
document.addEventListener("pointerdown", (e) => {
  if (pointers.has(e.pointerType)) return;
  pointers.add(e.pointerType);
  log("info", `first pointerdown: ${e.pointerType} pressure=${e.pressure} at ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
}, true);
window.addEventListener("error", (e) => log("error", `${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => log("error", `unhandled rejection: ${(e.reason as any)?.message ?? String(e.reason)}`));

// ---- the board

type Shown = { gen: number; scene: SceneData; readOnly: boolean };
let api: any = null;
let setShown: (s: Shown) => void = () => {};
let setThemeState: (t: ThemeName) => void = () => {};
let theme: ThemeName = "light";
let gen = 0;
let waitingForGen: { gen: number; done: () => void } | null = null;

// scene changes: the version last told, the one waiting for the debounce
let toldVersion = 0, seenVersion = 0, rev = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let sendNow = false; // set by an applied change: it is saved at once (the page's saveNow)
let latest: { elements: readonly any[]; appState: any; files: any } | null = null;
let selectionKey = "";

function sceneOf(l: NonNullable<typeof latest>): SceneData {
  const a = l.appState ?? {};
  return {
    elements: l.elements as unknown as El[],
    appState: { viewBackgroundColor: a.viewBackgroundColor, scrollX: a.scrollX, scrollY: a.scrollY, zoom: a.zoom },
    files: l.files ?? {},
  };
}

function sendScene(flushed: boolean) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!latest) return;
  const v = getSceneVersion(latest.elements as any);
  if (v === toldVersion) return;
  toldVersion = v;
  toApp({ v: 1, kind: "event", type: "sceneChanged", version: v, flushed, elements: latest.elements.length, scene: sceneOf(latest) });
}

function onBoardChange(g: number, elements: readonly any[], appState: any, files: any) {
  if (g !== gen) return;
  if (waitingForGen?.gen === g) { waitingForGen.done(); waitingForGen = null; }
  latest = { elements, appState, files };
  const v = getSceneVersion(elements as any);
  if (v !== seenVersion) {
    seenVersion = v;
    if (sendNow) { sendNow = false; sendScene(false); }
    else { if (timer) clearTimeout(timer); timer = setTimeout(() => sendScene(false), SAVE_DEBOUNCE); }
  }
  const ids = Object.keys(appState.selectedElementIds ?? {}).sort();
  const key = ids.join(",");
  if (key !== selectionKey) {
    selectionKey = key;
    const chosen = new Set(ids);
    const text = new Map<string, string>(elements.filter((e) => e.type === "text").map((e) => [e.id, e.text]));
    const els: SelectedEl[] = elements.filter((e) => chosen.has(e.id) && !e.isDeleted && !(e.type === "text" && e.containerId)).slice(0, 30).map((e) => ({
      id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height,
      label: e.type === "text" ? e.text : text.get(e.boundElements?.find((b: any) => b.type === "text")?.id),
    }));
    toApp({ v: 1, kind: "event", type: "selection", ids, elements: els });
  }
}

const CLEAN = { currentItemRoughness: 0, currentItemRoundness: "sharp", currentItemArrowType: "sharp", currentItemFontFamily: FONT_FAMILY.Nunito };

function Board() {
  const [shown, setShownState] = useState<Shown | null>(null);
  const [t, setT] = useState<ThemeName>("light");
  const [, bump] = useState(0);
  useEffect(() => {
    setShown = setShownState; setThemeState = (x) => { setT(x); bump((n) => n + 1); };
    // ready only now: a request sent on `ready` must find the setters bound (it did not, when ready went out right after render())
    toApp({ v: 1, kind: "event", type: "ready", protocol: PROTOCOL_VERSION, excalidraw: __EXCALIDRAW_VERSION__, loadMs: Math.round(performance.now()) }); // since the navigation started
  }, []);
  const flavour = (FLAVOURS as readonly string[]).includes(t) ? (t as Flavour) : null;
  const excal = t === "light" || t === "latte" ? THEME.LIGHT : THEME.DARK;
  useEffect(() => {
    const d = document.documentElement.dataset;
    d.theme = excal;
    if (flavour) d.flavour = flavour; else delete d.flavour;
  }, [excal, flavour]);
  const ref = useRef(shown); ref.current = shown;
  return (
    <>
      <CanvasFilters />
      {shown && (
        <Excalidraw
          key={shown.gen}
          theme={excal}
          viewModeEnabled={shown.readOnly}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: false } } }}
          initialData={{
            elements: restoreElements(shown.scene.elements as any, null) as any,
            files: (shown.scene.files ?? {}) as any,
            appState: {
              viewBackgroundColor: shown.scene.appState?.viewBackgroundColor ?? "#ffffff",
              scrollX: shown.scene.appState?.scrollX ?? 0, scrollY: shown.scene.appState?.scrollY ?? 0,
              zoom: shown.scene.appState?.zoom ?? { value: 1 }, ...CLEAN,
            } as any,
          }}
          excalidrawAPI={(a) => { if (ref.current && ref.current.gen === gen) api = a; }}
          onChange={(els, appState, files) => onBoardChange(shown.gen, els, appState, files)}
        />
      )}
    </>
  );
}

// ---- the requests

type Handlers = { [T in keyof Requests]: (m: Extract<Request, { type: T }>) => Promise<Requests[T]["result"]> | Requests[T]["result"] };
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const live = (els: readonly any[]) => els.filter((e) => !e.isDeleted);

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

const handlers: Handlers = {
  async loadScene(m) {
    const t0 = performance.now();
    if (timer) { clearTimeout(timer); timer = null; }
    gen++; api = null; latest = null; selectionKey = ""; sendNow = false;
    const restored = restoreElements(m.scene.elements as any, null);
    toldVersion = seenVersion = getSceneVersion(restored);
    const first = new Promise<void>((done) => { waitingForGen = { gen, done }; setTimeout(done, 20000); });
    setShown({ gen, scene: m.scene, readOnly: !!m.readOnly });
    await first;
    try { await document.fonts.ready; } catch { /* no font API: the first draw is not waited for */ }
    await nextFrame();
    return { elements: m.scene.elements.length, ms: Math.round(performance.now() - t0) };
  },

  applyChange(m) {
    if (!api) throw new RpcError("NO_BOARD", "no scene is loaded");
    return applyChanges(api, m.change as any, {
      pushUndo: () => {}, onChange: () => {}, saveNow: () => { sendNow = true; }, rev: () => ++rev,
    }) as any;
  },

  getScene() {
    if (!api) throw new RpcError("NO_BOARD", "no scene is loaded");
    const els = api.getSceneElementsIncludingDeleted();
    return { scene: sceneOf({ elements: els, appState: api.getAppState(), files: api.getFiles() }), version: getSceneVersion(els) };
  },

  select(m) {
    if (!api) throw new RpcError("NO_BOARD", "no scene is loaded");
    const els = live(api.getSceneElementsIncludingDeleted()).filter((e: any) => m.ids.includes(e.id));
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(els.map((e: any) => [e.id, true])) } });
    if (m.scroll && els.length) api.scrollToContent(els, { animate: false, fitToViewport: false });
    return { selected: els.length };
  },

  async exportPng(m) {
    if (!api) throw new RpcError("NO_BOARD", "no scene is loaded");
    const t0 = performance.now();
    const scale = m.scale ?? 1, background = m.background ?? true;
    const all = live(api.getSceneElementsIncludingDeleted());
    const picked = m.selectedOnly ? all.filter((e: any) => api.getAppState().selectedElementIds?.[e.id]) : all;
    if (!picked.length) throw new RpcError("EMPTY", "there is nothing to draw");
    const app = api.getAppState();
    try { await document.fonts.ready; } catch { /* as above */ }
    let size = { width: 0, height: 0 };
    const blob = await exportToBlob({
      elements: picked, files: api.getFiles(), mimeType: "image/png", exportPadding: 10,
      appState: { exportBackground: background, viewBackgroundColor: app.viewBackgroundColor ?? "#ffffff", exportWithDarkMode: false },
      getDimensions: (w: number, h: number) => {
        size = { width: Math.round(w * scale), height: Math.round(h * scale) };
        if (size.width > 8192 || size.height > 8192) throw new RpcError("TOO_BIG", `the picture would be ${size.width} x ${size.height}`);
        return { width: size.width, height: size.height, scale };
      },
    });
    const base64 = await blobBase64(blob);
    return { base64, width: size.width, height: size.height, bytes: blob.size, ms: Math.round(performance.now() - t0) };
  },

  flush() {
    const pending = !!timer || (!!latest && getSceneVersion(latest.elements as any) !== toldVersion);
    sendScene(true); // the event goes before the reply
    return { pending, version: toldVersion };
  },

  async setTheme(m) {
    theme = m.theme;
    setThemeState(m.theme);
    await nextFrame(); await nextFrame();
    return { theme };
  },

  setTool(m) {
    if (!api) throw new RpcError("NO_BOARD", "no scene is loaded");
    api.setActiveTool({ type: m.tool });
    return { tool: m.tool };
  },

  async probeNetwork(m) {
    const before = violations;
    const attempts: { url: string; how: string; outcome: string }[] = [];
    const tries: Promise<void>[] = [];
    const rec0 = (how: string, p: Promise<string>) => tries.push(p.then((o) => { attempts.push({ url: m.urls[0] ?? "", how, outcome: o }); }));
    for (const url of m.urls) {
      const rec = (how: string, p: Promise<string>) => tries.push(p.then((o) => { attempts.push({ url, how, outcome: o }); }));
      rec("fetch", fetch(url, { mode: "no-cors" }).then(() => "reached", (e) => `refused: ${e?.name}`));
      rec("xhr", new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("reached"); x.onerror = () => res("refused"); try { x.open("GET", url); x.send(); } catch (e: any) { res(`refused: ${e?.name}`); } }));
      rec("img", new Promise((res) => { const i = new Image(); i.onload = () => res("reached"); i.onerror = () => res("refused"); i.src = url; }));
      rec("websocket", new Promise((res) => { try { const w = new WebSocket(url.replace(/^http/, "ws")); w.onopen = () => res("reached"); w.onerror = () => res("refused"); w.onclose = () => res("refused"); } catch (e: any) { res(`refused: ${e?.name}`); } }));
      rec("beacon", Promise.resolve((() => { try { return navigator.sendBeacon(url, "x") ? "queued (see violations)" : "refused"; } catch (e: any) { return `refused: ${e?.name}`; } })()));
      rec("iframe", new Promise((res) => { const f = document.createElement("iframe"); f.onload = () => res("load event (a blocked frame fires one too)"); f.onerror = () => res("refused"); f.src = url; f.style.display = "none"; document.body.appendChild(f); setTimeout(() => { f.remove(); res("no load in 1.5 s"); }, 1500); }));
    }
    // leaving the page: the app refuses every navigation but its own file (onShouldStartLoadWithRequest), and no window opens
    const leave = m.urls[0];
    if (leave) {
      rec0("window.open", Promise.resolve((() => { try { return window.open(leave) ? "a window opened" : "no window"; } catch (e: any) { return `refused: ${e?.name}`; } })()));
      rec0("location.assign", new Promise((res) => { try { window.location.assign(leave); } catch (e: any) { res(`refused: ${e?.name}`); } setTimeout(() => res("still here after 800 ms"), 800); }));
    }
    await Promise.race([Promise.all(tries), new Promise((r) => setTimeout(r, 4000))]);
    await new Promise((r) => setTimeout(r, 300)); // violation events are queued tasks
    return { attempts, violations: violations - before };
  },
};

function receive(raw: unknown) {
  const p = parseRequest(raw);
  if (!p.ok) {
    log("warn", `refused a message: ${p.reason}`);
    if (p.id) toApp(fail(p.id, "BAD_REQUEST", p.reason));
    return;
  }
  const m = p.value;
  Promise.resolve()
    .then(() => (handlers[m.type] as (m: Request) => unknown)(m))
    .then((result) => toApp(ok(m.id, result)))
    .catch((e) => toApp(fail(m.id, e instanceof RpcError ? e.code : "FAILED", e?.message ?? String(e))));
}

// Only the app's own messages: the ones its `postMessage` dispatches, which have no source window. A frame cannot be
// embedded (CSP frame-src), and a message from one would have a source.
window.addEventListener("message", (e) => { if (e.source === null) receive(e.data); });
aiwb.receive = receive;

createRoot(document.getElementById("root")!).render(<Board />);
