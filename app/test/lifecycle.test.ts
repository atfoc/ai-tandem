// What the app does when its page or its screen goes away (AD-76): on the web build (platform/lifecycle.web.ts) the boards are
// written when the page is hidden and when it unloads, the window of the desktop app asks window.aiwbFlush before it closes, and
// the page asks the user before it unloads with a drawing that waits (D-SV-08, D-SV-09, D-SV-10, D-DW-02); on the phone
// (platform/backgroundflush.ts) the same when the app goes to the background (D-SV-11). The page and the app state are fakes:
// the real event of a browser is dispatched by checks/SEC.9, the real one of the system is device-only.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installBackgroundFlush } from "../src/platform/backgroundflush.ts";
import { installLifecycle, markReady } from "../src/platform/lifecycle.web.ts";
import type { AppStatePort } from "../src/platform/nativetransport.ts";

const g = globalThis as unknown as { window?: unknown; document?: unknown };
const had = { window: g.window, document: g.document };
beforeEach(() => {
  g.window = new EventTarget();
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
});
afterEach(() => { g.window = had.window; g.document = had.document; });

/** A board side that has `pending` writes waiting; a flush writes them. */
function fakeBoards(pending: number, stuck = false) {
  const log: string[] = [];
  let waiting = pending;
  return {
    log,
    flushAll: async () => { log.push("flushAll"); if (!stuck) waiting = 0; },
    hasPendingSaves: () => waiting > 0,
    endSent: () => { log.push("endSent"); },
  };
}
const win = () => g.window as EventTarget & { aiwbFlush?: () => Promise<boolean>; aiwbReady?: boolean };
const doc = () => g.document as EventTarget & { visibilityState: string };

test("window.aiwbFlush writes every board and answers true once nothing is pending, false while a write is stuck (D-SV-10, D-DW-02)", async () => {
  const boards = fakeBoards(2);
  const off = installLifecycle(boards);
  assert.equal(typeof win().aiwbFlush, "function");
  assert.equal(await win().aiwbFlush!(), true);
  assert.deepEqual(boards.log, ["flushAll"]);
  off();
  const stuck = fakeBoards(1, true);
  installLifecycle(stuck);
  assert.equal(await win().aiwbFlush!(), false, "a write that did not go through: the window is not to close");
});

test("window.aiwbFlush answers true at once when nothing waits: what the window's close, quit and reload are immediate on (D-DW-07)", async () => {
  const boards = fakeBoards(0);
  installLifecycle(boards);
  assert.equal(await win().aiwbFlush!(), true);
  assert.equal(boards.log.length, 1, "it asks the boards once and answers");
});

test("the boards are written when the page goes hidden, and not when it is shown (D-SV-08)", async () => {
  const boards = fakeBoards(1);
  installLifecycle(boards);
  doc().visibilityState = "visible";
  doc().dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(boards.log, [], "shown: nothing");
  doc().visibilityState = "hidden";
  doc().dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(boards.log, ["flushAll"]);
});

test("pagehide ends the sends still waiting for their chat's view, then writes the boards (D-SV-08)", () => {
  const boards = fakeBoards(1);
  installLifecycle(boards);
  win().dispatchEvent(new Event("pagehide"));
  assert.deepEqual(boards.log, ["endSent", "flushAll"]);
});

test("the page asks before it unloads only while a drawing waits, and writes it then; with nothing waiting it never asks (D-SV-09)", () => {
  const waiting = fakeBoards(1);
  installLifecycle(waiting);
  const asked = new Event("beforeunload", { cancelable: true });
  win().dispatchEvent(asked);
  assert.equal(asked.defaultPrevented, true, "a drawing waits: the browser is asked to confirm the unload");
  assert.deepEqual(waiting.log, ["flushAll"], "and the write is started");

  g.window = new EventTarget();
  const idle = fakeBoards(0);
  installLifecycle(idle);
  const free = new Event("beforeunload", { cancelable: true });
  win().dispatchEvent(free);
  assert.equal(free.defaultPrevented, false, "nothing waits: the page goes");
  assert.deepEqual(idle.log, []);
});

test("the function that installs removes what it installed", () => {
  const boards = fakeBoards(1);
  const off = installLifecycle(boards);
  const window = win();
  off();
  assert.equal(window.aiwbFlush, undefined);
  window.dispatchEvent(new Event("pagehide"));
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  doc().visibilityState = "hidden";
  doc().dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(boards.log, []);
  assert.equal(e.defaultPrevented, false);
});

test("markReady tells the window the page drew (window.aiwbReady)", () => {
  assert.equal(win().aiwbReady, undefined);
  markReady();
  assert.equal(win().aiwbReady, true);
});

// ---- the phone

function fakeAppState() {
  const listeners = new Set<(s: string) => void>();
  const port: AppStatePort = { addEventListener: (_t, f) => { listeners.add(f); return { remove: () => { listeners.delete(f); } }; } };
  return { port, emit: (s: string) => { for (const f of [...listeners]) f(s); }, count: () => listeners.size };
}

test("the app going to the background ends the waiting sends and writes the boards; coming back or being inactive does not (D-SV-11)", () => {
  const boards = fakeBoards(1);
  const app = fakeAppState();
  const off = installBackgroundFlush(boards, app.port);
  for (const s of ["active", "inactive"]) app.emit(s);
  assert.deepEqual(boards.log, [], "the app is still in front");
  app.emit("background");
  assert.deepEqual(boards.log, ["endSent", "flushAll"]);
  app.emit("active");
  assert.deepEqual(boards.log, ["endSent", "flushAll"]);
  off();
  assert.equal(app.count(), 0);
  app.emit("background");
  assert.equal(boards.log.length, 2);
});
