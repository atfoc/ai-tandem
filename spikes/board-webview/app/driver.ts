// The checks, run inside the app through the real bridge, and their results written to Documents/results.json for
// run.sh to read (the simulator's container is a folder of the Mac). Scenarios are chosen by a launch argument
// (`xcrun simctl launch <udid> <bundle> -AIWBScenario auto`, read as a user default):
//   auto   the bridge exercised end to end, a blank page, an empty board and a 2,000 element board held for memory readings
//   touch  an empty board with the freedraw tool, waits for a stroke made from outside (Maestro) and checks it through the bridge
import { File, Paths } from "expo-file-system";
import type { BoardBridge } from "../bridge/client.ts";
import type { Event, SceneData } from "../bridge/protocol.ts";
import { smallScene, largeScene, emptyScene } from "./scenes.ts";
import type { PageStats } from "./BoardView.tsx";

export const T_MODULE = Date.now();

type Step = { name: string; ok: boolean; ms: number; info?: unknown; error?: string };
type Report = { scenario: string; phase: string; done: boolean; at: Record<string, number>; steps: Step[]; extra: Record<string, unknown> };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bytesOf = (s: unknown) => JSON.stringify(s).length;

export class Driver {
  report: Report;
  private file = new File(Paths.document, "results.json");
  private ready: Promise<Extract<Event, { type: "ready" }>>;
  events: Event[] = [];

  constructor(private bridge: BoardBridge, private stats: PageStats, scenario: string) {
    this.report = { scenario, phase: "start", done: false, at: { appModule: T_MODULE }, steps: [], extra: {} };
    this.ready = bridge.waitFor((e): e is Extract<Event, { type: "ready" }> => e.type === "ready", 120000);
    bridge.on((e) => { this.events.push(e); });
    this.save();
  }

  save() {
    this.report.extra.bridgeStats = this.bridge.stats;
    this.report.extra.page = { ...this.stats };
    this.report.at.loadStart = this.stats.loadStartAt; this.report.at.loadEnd = this.stats.loadEndAt;
    this.file.create({ overwrite: true });
    this.file.write(JSON.stringify(this.report, null, 1));
  }

  async phase(name: string, holdMs = 0) { this.report.phase = name; this.report.at[name] = Date.now(); this.save(); if (holdMs) await sleep(holdMs); }

  async step<T>(name: string, fn: () => Promise<T>, summarize?: (r: T) => unknown): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.report.steps.push({ name, ok: true, ms: Date.now() - t0, info: summarize ? summarize(r) : undefined });
      this.save();
      return r;
    } catch (e: any) {
      this.report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) });
      this.save();
      return undefined;
    }
  }

  check(name: string, cond: boolean, info?: unknown) {
    this.report.steps.push({ name, ok: !!cond, ms: 0, info, error: cond ? undefined : "check failed" });
    this.save();
  }

  /** The events of a type after `from` (an index into this.events). */
  since<T extends Event["type"]>(from: number, type: T) { return this.events.slice(from).filter((e): e is Extract<Event, { type: T }> => e.type === type); }

  async waitEvent<T extends Event["type"]>(type: T, pred: (e: Extract<Event, { type: T }>) => boolean, from: number, timeoutMs: number) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.since(from, type).find(pred);
      if (hit) return { event: hit, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(25);
    }
  }

  async savePng(name: string, base64: string) {
    const f = new File(Paths.document, name);
    f.create({ overwrite: true });
    f.write(base64, { encoding: "base64" });
  }

  async run() {
    try {
      const ready = await this.ready;
      this.report.at.pageReady = Date.now();
      this.report.extra.ready = ready;
      if (this.report.scenario === "touch") await this.touch(); else await this.auto();
    } catch (e: any) {
      this.report.extra.fatal = String(e?.message ?? e);
    }
    this.report.done = true;
    this.report.phase = "done";
    this.report.at.done = Date.now();
    this.save();
  }

  // ---- auto

  async auto() {
    const b = this.bridge;
    await this.phase("mem-blank", 4000); // the page is up, no board loaded

    await this.step("loadScene empty", () => b.call("loadScene", { scene: emptyScene() }), (r) => r);
    await this.phase("mem-empty", 4000);

    // ---- a small board, an agent's change, the selection, the picture
    const small = smallScene();
    await this.step("loadScene small", () => b.call("loadScene", { scene: small }), (r) => r);
    const from = this.events.length;
    const t0 = Date.now();
    const result = await this.step("applyChange create+update+delete", () => b.call("applyChange", { change: {
      create: [{ type: "rectangle", key: "c", x: 100, y: 300, width: 160, height: 80, label: { text: "Added" } }, { type: "arrow", start: { key: "a" }, end: { key: "c" } }],
      update: [{ ref: { key: "b" }, backgroundColor: "#a5d8ff" }],
      delete: [{ ref: { key: "a" } }],
      select: [{ key: "c" }],
    } }), (r) => r);
    this.check("apply: created 2, updated 1, deleted 1", !!result && Object.keys(result.created).length === 2 && result.updated.length === 1 && result.deleted.length === 1 && result.conflicts.length === 0, result);
    const sc = await this.waitEvent("sceneChanged", () => true, from, 5000);
    this.check("sceneChanged arrives after the change", !!sc, { latencyMs: sc ? sc.event.version && Date.now() - t0 : null, elements: sc?.event.elements });
    if (sc) {
      const live = sc.event.scene.elements.filter((e) => !e.isDeleted);
      this.check("the scene it carries has the change", live.some((e) => e.id === (result as any).created.c) && live.every((e) => e.id !== "rect-a") && (live.find((e) => e.id === "rect-b") as any)?.backgroundColor === "#a5d8ff", { live: live.length });
    }
    const sel = await this.waitEvent("selection", (e) => e.ids.length === 1, from, 3000);
    this.check("selection event names the selected element and its label", !!sel && sel.event.elements[0]?.label === "Added", sel?.event);
    const sel2 = await this.step("select ids + scroll", () => b.call("select", { ids: ["rect-b"], scroll: true }), (r) => r);
    const sel2e = await this.waitEvent("selection", (e) => e.ids.includes("rect-b"), from, 3000);
    this.check("select request raises a selection event", !!sel2e && sel2?.selected === 1, sel2e?.event.ids);
    const png = await this.step("exportPng small", () => b.call("exportPng", { scale: 2 }), (r) => ({ width: r.width, height: r.height, bytes: r.bytes, pageMs: r.ms, base64Chars: r.base64.length }));
    if (png) { this.check("png has the PNG signature", png.base64.startsWith("iVBORw0KGgo"), png.base64.slice(0, 12)); await this.savePng("export-small.png", png.base64); }
    await this.step("flush (nothing pending)", () => b.call("flush", {}), (r) => r);
    // a request that is not on the list is refused by the page, with an answer
    const bad = await b.call("setTheme", { theme: "nope" as any }, 5000).then(() => "accepted", (e) => String(e.message));
    this.check("a bad request is refused by the page", /BAD_REQUEST|theme/.test(bad), bad);
    const getScene = await this.step("getScene", () => b.call("getScene", {}), (r) => ({ elements: r.scene.elements.length, version: r.version }));
    this.check("getScene agrees with the event", !!getScene && !!sc && getScene.version === sc.event.version, { scene: getScene?.version, event: sc?.event.version });

    // ---- themes (the board is a view: only how it looks changes)
    await this.step("setTheme light", () => b.call("setTheme", { theme: "light" }));
    await this.phase("shot-light", 2500);
    await this.step("setTheme mocha", () => b.call("setTheme", { theme: "mocha" }));
    await this.phase("shot-mocha", 2500);
    await this.step("setTheme latte", () => b.call("setTheme", { theme: "latte" }));
    await this.phase("shot-latte", 2500);
    await this.step("setTheme light", () => b.call("setTheme", { theme: "light" }));
    const png2 = await this.step("exportPng after themes", () => b.call("exportPng", {}), (r) => ({ width: r.width, height: r.height, bytes: r.bytes }));
    if (png2) this.check("export ignores the theme (same size as before at scale 1)", png2.width === (png ? png.width / 2 : -1), { a: png2.width, b: png?.width });

    // ---- the network: the page tries, and cannot
    const probe = await this.step("probeNetwork", () => b.call("probeNetwork", { urls: ["http://127.0.0.1:47931/probe", "https://example.com/probe"] }, 20000), (r) => r);
    const subresources = probe?.attempts.filter((a) => !["window.open", "location.assign"].includes(a.how)) ?? [];
    this.check("the page reached nothing: no attempt succeeded, and the policy blocked every one", !!probe && subresources.every((a) => !/^reached/.test(a.outcome)) && probe.violations === subresources.length, { attempts: subresources.length, violations: probe?.violations });
    this.check("a navigation away from the page was refused by the app, and no window opened", this.stats.blockedNavigations.length >= 1 && !!probe && probe.attempts.filter((a) => a.how === "window.open").every((a) => a.outcome !== "a window opened"), { blocked: this.stats.blockedNavigations });

    // ---- a large board
    const bigScene = largeScene(2000);
    this.report.extra.largeSceneBytes = bytesOf(bigScene);
    const tl = Date.now();
    const big = await this.step("loadScene 2000", () => b.call("loadScene", { scene: bigScene }, 120000), (r) => r);
    this.report.extra.loadLarge = { roundTripMs: Date.now() - tl, pageMs: big?.ms, bytes: bytesOf(bigScene) };
    await this.phase("mem-large", 5000);
    // an agent's change on the large board, and how long the debounced scene takes to come back
    const f2 = this.events.length;
    const t2 = Date.now();
    await this.step("applyChange on 2000", () => b.call("applyChange", { change: { create: [{ type: "ellipse", key: "n", x: 0, y: -400, width: 100, height: 100 }], update: [{ ref: { id: "r0" }, backgroundColor: "#ffc9c9" }] } }), (r) => ({ ...r, ms: Date.now() - t2 }));
    const sc2 = await this.waitEvent("sceneChanged", () => true, f2, 15000);
    this.report.extra.sceneChangedLarge = sc2 ? { latencyMs: Date.now() - t2, elements: sc2.event.elements, jsonChars: bytesOf(sc2.event) } : null;
    this.check("sceneChanged carries the 2000 element board", !!sc2 && sc2.event.elements === 2001, sc2?.event.elements);
    const png3 = await this.step("exportPng 2000 (scale 0.5)", () => b.call("exportPng", { scale: 0.5 }, 120000), (r) => ({ width: r.width, height: r.height, bytes: r.bytes, pageMs: r.ms }));
    if (png3) await this.savePng("export-large.png", png3.base64);
    await this.step("flush on 2000", () => b.call("flush", {}), (r) => r);
    await this.phase("mem-large-after", 4000);
    // the page is told to load the empty board again: what memory does it give back
    await this.step("loadScene empty again", () => b.call("loadScene", { scene: emptyScene() }));
    await this.phase("mem-empty-again", 4000);
    await this.step("loadScene small", () => b.call("loadScene", { scene: smallScene() }));
    await this.phase("final", 500);
  }

  // ---- touch

  async touch() {
    const b = this.bridge;
    await this.step("loadScene empty", () => b.call("loadScene", { scene: emptyScene() }));
    await this.step("setTool freedraw", () => b.call("setTool", { tool: "freedraw" }));
    const from = this.events.length;
    await this.phase("touch-ready"); // run.sh starts the swipes now
    const hit = await this.waitEvent("sceneChanged", (e) => e.scene.elements.some((x) => x.type === "freedraw" && !x.isDeleted), from, 120000);
    this.check("a freedraw element arrived through the bridge (sceneChanged, debounced)", !!hit);
    if (hit) {
      const strokes = hit.event.scene.elements.filter((x) => x.type === "freedraw" && !x.isDeleted);
      this.report.extra.strokes = strokes.map((s) => ({ id: s.id, points: (s.points as unknown[]).length, width: s.width, height: s.height }));
    }
    // the swipes are made from outside and take a while: wait for the third stroke to arrive (or 60 s)
    await this.waitEvent("sceneChanged", (e) => e.scene.elements.filter((x) => x.type === "freedraw" && !x.isDeleted).length >= 3, from, 60000);
    await sleep(700);
    await this.step("flush", () => b.call("flush", {}), (r) => r);
    const gsr = await this.step("getScene", () => b.call("getScene", {}), (r) => ({ elements: r.scene.elements.length }));
    const gs = gsr?.scene.elements.filter((x) => !x.isDeleted).map((x) => ({ type: x.type, points: Array.isArray(x.points) ? x.points.length : undefined }));
    this.report.extra.finalElements = gs;
    this.check("at least 3 strokes drawn (3 swipes)", !!gs && gs.filter((x) => x.type === "freedraw").length >= 3, gs);
    const png = await this.step("exportPng of the drawing", () => b.call("exportPng", { scale: 1 }), (r) => ({ width: r.width, height: r.height, bytes: r.bytes }));
    if (png) await this.savePng("touch.png", png.base64);
    this.report.extra.pointerLogs = this.events.filter((e) => e.type === "log").map((e: any) => e.text);
  }
}

export const sceneOf = (e: Extract<Event, { type: "sceneChanged" }>): SceneData => e.scene;
