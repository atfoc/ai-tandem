// Sentences to sound (architecture VC-11, VC-12): the one speaker of the app. An utterance (a message being read, the reply of a speech
// turn) is opened with `begin`, gets its sentences with `say`, and is closed with `end`. Each sentence is one streamed TTS request; at
// most two are in flight (one streams into the player while the next is fetched), each with its own abort. The chunks go to the player
// as they arrive, with a `mark` before the first chunk of a sentence, so a sentence plays before the service has finished it; the
// sentences are written in their order whatever order their requests finish in. `stopAll` is the barge-in: it stops the sound, clears
// what was queued and aborts every request still open.
//
// A second utterance never overlaps the first: `begin` stops it. A problem in any request stops the utterance, shows the popover
// (`state.ts` `showProblem`) and ends `done` with the problem; what was already played is not taken back.
import { createSplitter } from "../logic/sentences.ts";
import { problemOfException, problemOfStatus } from "../logic/problems.ts";
import { firstVoiceQuery, parseVoices, ttsBody, ttsPath, ttsQuery, VOICES_PATH } from "../logic/protocol.ts";
import { VoiceNetError, VoiceProblemError, voicePorts } from "../ports.ts";
import type { NetRequest } from "../ports.ts";
import type { VoiceSettings } from "../logic/settings.ts";
import type { VoiceProblem } from "../index.ts";
import { player } from "./player.ts";
import { dismissProblem, getSettings, onReset, readingStore, showProblem, updateSettings, waits } from "./state.ts";

export type Utterance = {
  key: string;
  owner: "read" | "speech" | "pill";
  /** Where the popover of a problem hangs: the control that was tapped. */
  anchor: string;
  /** What "Try again" does after a "can't reach". */
  retry?: () => void;
  /** The sentence whose sound has just begun (the speech bar and the captions show it). */
  onSentence?(sentence: string): void;
  /** The player's level, 0..1. */
  onLevel?(level: number): void;
};

export interface SpeakHandle {
  /** Queued; its request starts when fewer than two run. Ignored after `end` or once the utterance is over. */
  say(sentence: string): void;
  /** No more sentences. */
  end(): void;
  readonly done: Promise<"played" | "stopped" | VoiceProblem>;
}

export interface Speaker {
  /** Stops whatever plays (it is a barge-in) and starts `u`. */
  begin(u: Utterance): SpeakHandle;
  /** Stops the sound, clears the queue and aborts every request still open (and a preview clip). */
  stopAll(): void;
  current(): Utterance | null;
}

/** At most this many sentences are fetched and not yet written to the player: the free plan's concurrency (VC-12). */
export const MAX_IN_FLIGHT = 2;

type Sentence = {
  /** The mark id: unique for the whole run of the app. */
  id: number;
  text: string;
  ctl: AbortController;
  started: boolean;
  /** The answer's body is read to its end. */
  fetched: boolean;
  chunks: Uint8Array[];
  markWritten: boolean;
  /** An odd last byte of a chunk, joined to the next one: the player takes whole samples. */
  carry: Uint8Array | null;
};

type Run = {
  u: Utterance;
  ctl: AbortController;
  /** The sentences not yet written out, in order. */
  queue: Sentence[];
  ended: boolean;
  finished: boolean;
  settings: VoiceSettings;
  voice: Promise<string> | null;
  texts: Map<number, string>;
  off: () => void;
  settle(r: "played" | "stopped" | VoiceProblem): void;
};

let nextId = 1;
let run: Run | null = null;
let clip: AbortController | null = null;

/** `parent` aborted, or `ms` passed: the signal to give a call and the way to know which it was. `settled` stops the timer once the call
 *  has answered (the signal stays linked to `parent`, so an abort still cuts the body); `release` lets the link go. */
export function bounded(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut(): boolean; settled(): void; release(): void } {
  const ctl = new AbortController();
  let out = false;
  const timer = setTimeout(() => { out = true; ctl.abort(); }, ms);
  const onParent = () => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener("abort", onParent);
  return {
    signal: ctl.signal,
    timedOut: () => out,
    settled: () => clearTimeout(timer),
    release() { clearTimeout(timer); parent?.removeEventListener("abort", onParent); },
  };
}

/** A call of the voice service with a JSON answer. A status of 400 or more throws the problem it is; a call that is cut, that times out
 *  or that the port cannot make throws what the port threw (callers read it with `problemOfException`), a timeout a `VoiceNetError`. */
export async function requestJson(r: NetRequest, signal?: AbortSignal): Promise<unknown> {
  const b = bounded(signal, waits.callMs);
  try {
    const answer = await voicePorts().net.request(r, b.signal);
    const text = await answer.text();
    const problem = problemOfStatus(answer.status, text);
    if (problem) throw new VoiceProblemError(problem);
    try { return JSON.parse(text); } catch { throw new VoiceProblemError("service"); }
  } catch (e) {
    if (b.timedOut()) throw new VoiceNetError();
    throw e;
  } finally {
    b.release();
  }
}

/** The first chunk to be heard of `body`, and so on to its end; stops (and returns false) when `signal` aborts, even if the port ignores it. */
async function eachChunk(body: AsyncIterable<Uint8Array>, signal: AbortSignal, f: (chunk: Uint8Array) => void): Promise<boolean> {
  const it = body[Symbol.asyncIterator]();
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  try {
    for (;;) {
      const step = await Promise.race([it.next(), aborted]);
      if (step === "aborted") return false;
      if (step.done) return true;
      f(step.value);
    }
  } finally {
    // A body that is cut loose is told so; it may already be closed, which is no error here.
    Promise.resolve(it.return?.()).catch(() => {});
  }
}

/** The voice of an utterance: the chosen one, else the first of the service, which is then the chosen one (VC-12). */
function voiceOf(r: Run): Promise<string> {
  return (r.voice ??= (async () => {
    if (r.settings.voiceId) return r.settings.voiceId;
    const json = await requestJson({ method: "GET", path: VOICES_PATH, query: firstVoiceQuery() }, r.ctl.signal);
    const first = parseVoices(json).voices[0];
    if (!first) throw new VoiceProblemError("service");
    if (!getSettings().voiceId) updateSettings({ voiceId: first.id, voiceName: first.name });
    return getSettings().voiceId ?? first.id;
  })());
}

function finish(r: Run, result: "played" | "stopped" | VoiceProblem): void {
  if (r.finished) return;
  r.finished = true;
  r.ctl.abort();
  for (const s of r.queue) s.ctl.abort();
  r.off();
  if (run === r) run = null;
  r.settle(result);
}

/** The run ends with sound cut: stopped, or a problem. */
function cut(r: Run, result: "stopped" | VoiceProblem): void {
  if (r.finished) return;
  finish(r, result);
  player.stop();
}

function fail(r: Run, kind: VoiceProblem["kind"]): void {
  if (r.finished) return;
  const problem: VoiceProblem = { kind, anchor: r.u.anchor, retry: r.u.retry };
  showProblem(problem);
  cut(r, problem);
}

/** Whole samples only: joins the odd byte kept from the last chunk, and keeps the odd byte of this one. */
function whole(s: Sentence, chunk: Uint8Array): Uint8Array {
  let data = chunk;
  if (s.carry) {
    data = new Uint8Array(s.carry.length + chunk.length);
    data.set(s.carry, 0);
    data.set(chunk, s.carry.length);
    s.carry = null;
  }
  if (data.length % 2 === 1) {
    s.carry = data.slice(data.length - 1);
    data = data.subarray(0, data.length - 1);
  }
  return data;
}

/** Writes to the player what can be written, in the order of the sentences: the head sentence's chunks as they come, and when it is
 *  read to its end the next one's, which may have been fetched meanwhile. */
function drain(r: Run): void {
  while (!r.finished && r.queue.length) {
    const head = r.queue[0];
    for (const chunk of head.chunks.splice(0)) {
      const data = whole(head, chunk);
      if (data.length === 0) continue;
      if (!head.markWritten) {
        head.markWritten = true;
        r.texts.set(head.id, head.text);
        player.mark(head.id);
      }
      player.write(data);
    }
    if (!head.fetched) break;
    r.queue.shift();
  }
  pump(r);
  settleIfOver(r);
}

/** The utterance is over when it is closed, every sentence is written out, and the player has played it. */
function settleIfOver(r: Run): void {
  if (r.finished || !r.ended || r.queue.length) return;
  if (!player.busy()) finish(r, "played");
}

/** Starts the requests that may start: the sentences in order, while fewer than two are fetched and not yet written out. */
function pump(r: Run): void {
  if (r.finished) return;
  let active = r.queue.filter((s) => s.started).length;
  for (const s of r.queue) {
    if (active >= MAX_IN_FLIGHT) return;
    if (s.started) continue;
    s.started = true;
    active++;
    void fetchSentence(r, s);
  }
}

async function fetchSentence(r: Run, s: Sentence): Promise<void> {
  let wait: ReturnType<typeof bounded> | null = null;
  let answered = false;
  try {
    const voice = await voiceOf(r);
    if (r.finished) return;
    wait = bounded(s.ctl.signal, waits.answerMs);
    const answer = await voicePorts().net.request(
      { method: "POST", path: ttsPath(voice), query: ttsQuery(), json: ttsBody(s.text, r.settings) },
      wait.signal,
    );
    answered = true;
    wait.settled();
    if (r.finished) return;
    if (answer.status >= 400) {
      const text = await answer.text().catch(() => "");
      fail(r, problemOfStatus(answer.status, text) ?? "service");
      return;
    }
    const toEnd = await eachChunk(answer.body, s.ctl.signal, (chunk) => {
      if (r.finished) return;
      s.chunks.push(chunk);
      drain(r);
    });
    if (!toEnd || r.finished) return;
    s.fetched = true;
    drain(r);
  } catch (e) {
    if (r.finished) return;
    fail(r, wait?.timedOut() && !answered ? "offline" : problemOfException(e));
  } finally {
    wait?.release();
  }
}

function begin(u: Utterance): SpeakHandle {
  stopAll();
  let settle!: (r: "played" | "stopped" | VoiceProblem) => void;
  const done = new Promise<"played" | "stopped" | VoiceProblem>((resolve) => { settle = resolve; });
  const r: Run = {
    u, ctl: new AbortController(), queue: [], ended: false, finished: false, settings: getSettings(), voice: null,
    texts: new Map(), off: () => {}, settle,
  };
  run = r;
  r.off = player.on((e) => {
    if (r.finished) return;
    if (e.kind === "mark") {
      const text = r.texts.get(e.id);
      if (text !== undefined) { r.texts.delete(e.id); u.onSentence?.(text); }
    } else if (e.kind === "level") {
      u.onLevel?.(e.level);
    } else {
      settleIfOver(r);
    }
  });
  return {
    say(sentence) {
      const text = sentence.trim();
      if (r.finished || r.ended || !text) return;
      r.queue.push({ id: nextId++, text, ctl: new AbortController(), started: false, fetched: false, chunks: [], markWritten: false, carry: null });
      pump(r);
    },
    end() {
      if (r.finished || r.ended) return;
      r.ended = true;
      settleIfOver(r);
    },
    done,
  };
}

function stopAll(): void {
  clip?.abort();
  clip = null;
  if (run) cut(run, "stopped");
  else player.stop();
}

export const speaker: Speaker = { begin, stopAll, current: () => run?.u ?? null };

/** Plays a clip through the same output as the speech, after stopping everything else (a preview, VC-11). `load` fetches its bytes with
 *  a signal that `stopAll` aborts. Resolves "stopped" when something else took the output, "played" when the clip ended. */
export async function playClipOnce(load: (signal: AbortSignal) => Promise<Uint8Array>): Promise<"played" | "stopped"> {
  stopAll();
  const ctl = new AbortController();
  clip = ctl;
  try {
    const bytes = await load(ctl.signal);
    if (ctl.signal.aborted) return "stopped";
    await voicePorts().audio.playClip(bytes, ctl.signal);
    return ctl.signal.aborted ? "stopped" : "played";
  } catch (e) {
    if (ctl.signal.aborted) return "stopped";
    throw e;
  } finally {
    if (clip === ctl) clip = null;
  }
}

// ---- Read aloud (goal 3.3, VC-24)

export const readKey = (chat: string, branch: string, index: number): string => `read:${chat}:${branch}:${index}`;

let readSeq = 0;

/** Reads one message aloud, as one utterance: a second call stops the first. The key is looked at first: with none, the popover shows
 *  and nothing else happens (no request, no sound). Resolves when the reading has ended, been stopped or failed (a failure is the
 *  popover, not a rejection). */
export async function readAloud(o: { chat: string; branch: string; index: number; text: string; anchor: string }): Promise<void> {
  const mine = ++readSeq;
  stopAll();
  const key = readKey(o.chat, o.branch, o.index);
  readingStore.set({ key });
  const hasKey = await voicePorts().keystore.has().catch(() => false);
  if (mine !== readSeq) return;
  if (!hasKey) {
    readingStore.set({ key: null });
    showProblem({ kind: "no_key", anchor: o.anchor });
    return;
  }
  dismissProblem();
  const retry = () => { void readAloud(o); };
  const handle = speaker.begin({ key, owner: "read", anchor: o.anchor, retry });
  const splitter = createSplitter({ skipCode: getSettings().skipCode, onSentence: handle.say });
  splitter.push(o.text);
  splitter.flush();
  handle.end();
  await handle.done;
  if (readingStore.get().key === key) readingStore.set({ key: null });
}

/** Stops the message being read, if one is. */
export function stopReading(): void {
  readSeq++;
  if (readingStore.get().key === null) return;
  readingStore.set({ key: null });
  stopAll();
}

onReset(() => {
  run?.ctl.abort();
  for (const s of run?.queue ?? []) s.ctl.abort();
  run?.off();
  if (run) run.finished = true;
  run = null;
  clip?.abort();
  clip = null;
  readSeq = 0;
});
