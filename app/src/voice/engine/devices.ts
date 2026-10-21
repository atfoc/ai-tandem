// Devices in the engine (voice-devices architecture VD-6, VD-8 to VD-13, VD-16): what a start got (a notice for a saved device that was not
// there), what a device lost during a session does (a notice, a pause, an end), the microphone test, and the data of the Settings pickers.
// It knows no platform: it asks the ports and reads their answers (goal 4.11). Nothing here is written to a log, a request or a problem:
// device names reach the notice's text and nothing else.
//
// A *route* is one use of audio that a lost device concerns: a listening session, a message read aloud, a preview or Test speaker, the
// microphone test. The port tells `onRoute` only while something uses it; the engine listens while a route is entered, and tells each
// route what happened to it. Sessions and Read aloud pause (the player stays held, VD-12); a preview or Test speaker just stops.
import { noticeText, shouldPause } from "../logic/devices.ts";
import type { VoiceNotice } from "../logic/devices.ts";
import { VoiceProblemError, voicePorts } from "../ports.ts";
import type { DeviceList, MicHandle, Opened, RouteEvent, SavedDevice } from "../ports.ts";
import { player } from "./player.ts";
import {
  createStore, endNotice, flags, getSettings, onReset, sessionStore, settingsOpenStore, settingsStore, showNotice, showProblem,
} from "./state.ts";

export type NoticeWhere = VoiceNotice["where"];

/** What a route wants to hear about. */
export type Route = {
  /** Who shows its notices; null: nobody (the microphone test, a preview). */
  where: NoticeWhere | null;
  /** Capture is in use: a lost or failed microphone concerns it. */
  listens: boolean;
  /** Sound is in use or will be: a lost output concerns it. */
  speaks: boolean;
  /** A private output went and the next sound would be out loud: the route pauses itself (session, Read aloud). The player stays held. */
  onPause?(device: string): void;
  /** The person went on (`resume`): the route goes on. */
  onResume?(): void;
  /** Where a pause is not wanted but a stop is (a preview, Test speaker). */
  onStop?(): void;
  /** The microphone could not go on (`input-failed`). */
  onMicFailed?(): void;
};

export interface RouteHandle {
  readonly paused: boolean;
  /** A notice of this route, in the place it shows its notices. Fades after `waits.noticeMs` unless `sticky` (the pause's own sentence). */
  notice(text: string, o?: { sticky?: boolean }): void;
  /** Takes its notice away now. */
  clearNotice(): void;
  /** The route is over: its notice goes, the hold it kept is let go when nobody else keeps one. Safe to call twice. */
  leave(): void;
}

type Entry = Route & { paused: boolean };
const routes = new Set<Entry>();
let offRoute: (() => void) | null = null;

const sameDevice = (a: SavedDevice | null, b: SavedDevice | null): boolean => a === b || (a !== null && b !== null && a.id === b.id && a.name === b.name);

/** The name of a device for a notice (empty when the port did not know it). */
const nameOf = (d: { name: string } | null | undefined): string => d?.name ?? "";

function onRoute(e: RouteEvent): void {
  switch (e.kind) {
    case "input-lost": {
      const r = [...routes].find((x) => x.listens && x.where);
      if (r?.where) showNotice(noticeText("lost-mic", { device: nameOf(e.lost) }), r.where, r);
      return;
    }
    case "input-failed":
      for (const r of [...routes]) if (r.listens) r.onMicFailed?.();
      return;
    case "output-lost": {
      if (e.held) player.noteHeld();
      const pause = shouldPause(e.lost, e.now);
      let kept = false;
      let told = false;
      for (const r of [...routes]) {
        if (!r.speaks || !routes.has(r)) continue;
        if (pause && r.onPause) {
          kept = true;
          if (!r.paused) { r.paused = true; r.onPause(nameOf(e.lost)); }
        } else if (pause && r.onStop) {
          r.onStop();
        } else if (!pause && !told && r.where) {
          told = true;
          showNotice(noticeText("lost-speaker", { device: nameOf(e.lost) }), r.where, r);
        }
      }
      // The rule says pause, and the port did not hold: hold now. The port held and nobody keeps it (the rule says no, or no route
      // speaks): let it go at once, the sound moves to the system default.
      if (kept && !player.held()) player.hold();
      else if (!kept && player.held() && ![...routes].some((x) => x.paused)) player.resume();
      return;
    }
  }
}

/** A use of audio begins: the engine listens to the port's `onRoute` while any route is entered. */
export function enterRoute(r: Route): RouteHandle {
  const entry: Entry = { ...r, paused: false };
  routes.add(entry);
  if (!offRoute) offRoute = voicePorts().audio.onRoute(onRoute);
  return {
    get paused() { return entry.paused; },
    notice(text, o) { if (entry.where && routes.has(entry)) showNotice(text, entry.where, entry, o); },
    clearNotice() { endNotice(entry); },
    leave() {
      if (!routes.delete(entry)) return;
      endNotice(entry);
      const wasPaused = entry.paused;
      entry.paused = false;
      if (routes.size === 0) { offRoute?.(); offRoute = null; }
      // The hold this route kept belongs to nobody now: stop it (the queue behind it was this route's).
      if (wasPaused && ![...routes].some((x) => x.paused)) player.stop();
    },
  };
}

/** Continue: every paused route goes on, on the system's output, out loud, because the person chose it (goal 3.3). */
export function resume(): void {
  const paused = [...routes].filter((x) => x.paused);
  if (!paused.length) return;
  player.resume();
  for (const r of paused) {
    r.paused = false;
    r.onResume?.();
  }
}

// ---- starts (VD-8)

/** Whether the port must be told where the next sound goes: a saved speaker, or the default after one was asked for. A person who never
 *  chose a speaker makes no `useOutput` call at all: nothing changes for them (goal 3.1). */
let asked = false;
export const outputWanted = (saved: SavedDevice | null): boolean => saved !== null || asked;

/** Tells the player the person's speaker (VD-8). Never rejects: a port that cannot is read as "the default" (goal 3.3). */
export async function applyOutput(saved: SavedDevice | null): Promise<Opened> {
  if (saved !== null) asked = true;
  try {
    return await player.useOutput(saved);
  } catch {
    return { device: null, missed: false };
  }
}

/** The one notice of a start (VD-13): the saved microphone and/or speaker that were not there. Both missing make one notice. */
export function announceStart(route: RouteHandle, saved: { mic: SavedDevice | null; speaker: SavedDevice | null }, mic: Opened | null, speaker: Opened | null): void {
  const micGone = mic?.missed && saved.mic ? saved.mic.name : null;
  const speakerGone = speaker?.missed && saved.speaker ? saved.speaker.name : null;
  if (saved.mic && micGone !== null && saved.speaker && speakerGone !== null) {
    route.notice(noticeText("start-both", { mic: micGone, speaker: speakerGone }));
  } else if (saved.mic && mic?.missed) {
    route.notice(noticeText("start-mic", { mic: saved.mic.name }));
  } else if (saved.speaker && speaker?.missed) {
    route.notice(noticeText("start-speaker", { speaker: saved.speaker.name }));
  }
}

/** Settings > Voice's own notice (goal 4.5: a fallback is announced where it happens): a preview, Test speaker or Test microphone that went to the
 *  system default because the saved device was not there. It is the start sentence, in the devices card (`where.kind === "settings"`). It outlives the
 *  short route that made it, goes on the usual timer, and goes when Settings closes. */
const SETTINGS_NOTICE_OWNER = {};
function announceInSettings(text: string): void { showNotice(text, { kind: "settings" }, SETTINGS_NOTICE_OWNER); }
settingsOpenStore.subscribe(() => { if (!settingsOpenStore.get()) endNotice(SETTINGS_NOTICE_OWNER); });

/** A preview or Test speaker has opened the output for the saved speaker: when it was not there, the sentence of a start names it. */
export function announceSpeakerInSettings(saved: SavedDevice | null, opened: Opened): void {
  if (saved && opened.missed) announceInSettings(noticeText("start-speaker", { speaker: saved.name }));
}

// ---- the microphone test (VD-16)

export type MicTestState = { on: boolean; level: number; /** a voice session listens: the control is off */ busy: boolean };

const busyNow = (): boolean => sessionStore.get().owner !== null;
export const micTestStore = createStore<MicTestState>(() => ({ on: false, level: 0, busy: busyNow() }));
// The test and a session never listen together: the control is off while a session runs, and a session ends the test when it starts.
sessionStore.subscribe(() => {
  const cur = micTestStore.get();
  if (cur.busy !== busyNow()) micTestStore.set({ ...cur, busy: busyNow() });
});

type TestRun = { mic: SavedDevice | null; handle: MicHandle | null; route: RouteHandle | null; offs: (() => void)[] };
let testSeq = 0;
let testRun: TestRun | null = null;

/** Stops the microphone test, if one runs or is starting. Safe at any time. */
export function stopMicTest(): void {
  testSeq++;
  const run = testRun;
  testRun = null;
  if (!run) return;
  for (const off of run.offs.splice(0)) off();
  run.route?.leave();
  void run.handle?.stop().catch(() => {});
  micTestStore.set({ on: false, level: 0, busy: busyNow() });
}

/** Starts the microphone test on the saved microphone: only the level is kept, no chunk goes anywhere, no socket opens, no key is needed. The
 *  first tap asks the microphone permission as Dictate does; a refusal is the `mic_blocked` popover on `anchor`. A running test is restarted. */
export async function startMicTest(anchor: string): Promise<void> {
  if (busyNow()) return;
  stopMicTest();
  const seq = testSeq;
  const alive = () => seq === testSeq;
  const mic = getSettings().mic;
  const refuse = () => showProblem({ kind: "mic_blocked", anchor, retry: () => { void startMicTest(anchor); } });
  let handle: MicHandle;
  try {
    if (flags.denyMic) throw new VoiceProblemError("mic_blocked");
    handle = await voicePorts().audio.startMic({
      chunkMs: 100, echoCancel: false, device: mic,
      onChunk(_b64, level) { if (alive()) micTestStore.set({ on: true, level, busy: busyNow() }); },
    });
  } catch {
    if (alive()) refuse();
    return;
  }
  if (!alive()) { void handle.stop().catch(() => {}); return; }
  if (mic && handle.opened.missed) announceInSettings(noticeText("start-mic", { mic: mic.name }));
  const run: TestRun = { mic, handle, route: null, offs: [] };
  testRun = run;
  run.route = enterRoute({
    where: null, listens: true, speaks: false,
    onMicFailed() { if (alive()) { stopMicTest(); refuse(); } },
  });
  // A different microphone picked meanwhile: the test goes on with the new one. Settings closed: the test ends with it.
  run.offs.push(settingsStore.subscribe(() => {
    if (alive() && !sameDevice(getSettings().mic, mic)) void startMicTest(anchor);
  }));
  const wasOpen = settingsOpenStore.get();
  run.offs.push(settingsOpenStore.subscribe(() => {
    if (alive() && wasOpen && !settingsOpenStore.get()) stopMicTest();
  }));
  micTestStore.set({ on: true, level: 0, busy: false });
  refreshDevices(); // the permission may have just been given: the names are there now
}

// ---- the lists of Settings (VD-6 a, VD-17)

export const deviceListStore = createStore<DeviceList | null>(() => null);
let watchers = 0;
let offWatch: (() => void) | null = null;
let listSeq = 0;

/** Lists the devices again, while Settings shows them. An answer that comes after a newer request is dropped; a list that fails keeps the last. */
export function refreshDevices(): void {
  if (watchers === 0) return;
  const seq = ++listSeq;
  voicePorts().audio.devices.list().then((l) => { if (seq === listSeq && watchers > 0) deviceListStore.set(l); }, () => {});
}

/** Settings > Voice shows the pickers: list now, and again each time the port says the list may have changed. Returns the way to stop. */
export function watchDevices(): () => void {
  watchers++;
  if (watchers === 1) offWatch = voicePorts().audio.devices.watch(refreshDevices);
  refreshDevices();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--watchers > 0) return;
    offWatch?.();
    offWatch = null;
    listSeq++;
  };
}

onReset(() => {
  stopMicTest();
  for (const r of [...routes]) routes.delete(r);
  offRoute?.();
  offRoute = null;
  asked = false;
  offWatch?.();
  offWatch = null;
  watchers = 0;
  listSeq++;
  deviceListStore.set(null);
  micTestStore.set({ on: false, level: 0, busy: false });
});
