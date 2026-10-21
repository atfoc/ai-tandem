// The listening sessions (architecture VC-18 to VC-22, VC-9, §8.1): dictation, speech mode and the board's pill, one at a time. A session
// is the microphone and the STT socket (`listener.ts`), the turn machine (`logic/turn.ts`) with its timer, the sending of a turn through
// the function the screen gave, the reply follower (`reply.ts`) and the speaker; `end`, a problem in any of them, or the system taking
// the audio ends them all together, in this order: no more audio goes up, the timer stops, the reply's sound stops, the session's state
// goes back to idle.
//
// Nothing is sent without the person's act (goal 4.7): a turn goes when the turn machine says so (Auto-send's pause ran out, or Send),
// and dictation's machine never says so. Nothing is heard while it cannot count: from the moment a turn is on its way until its reply is
// over, no chunk goes up, except while the reply is spoken on a platform that ships voice barge-in (VC-9), where what is heard either
// interrupts the reply (two words or more, fewer than half of them in the sentences being spoken: not their echo) or is dropped. A turn
// already handed to the screen's `send` is never taken back; a `send` that fails gives the words back to the person to send again.
//
// The engine imports no screen: speech mode is given the composer's `sendMessage(chat, text)` for its chat, the pill its own `send` and
// `target` (VC-21, VC-29).
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { loadItems } from "@aiwb/core/state/conn.ts";
import { getState, shownBranch, threadAt } from "@aiwb/core/state/store.ts";
import { problemOfException } from "../logic/problems.ts";
import { committedText, deadline, initTurn, step, turnText } from "../logic/turn.ts";
import type { TurnInput, TurnPhase, TurnState } from "../logic/turn.ts";
import { voicePorts } from "../ports.ts";
import type { VoiceProblemKind } from "../ports.ts";
import type { DictationSink, Phase, SessionOwner, SessionState } from "../index.ts";
import { startListener } from "./listener.ts";
import type { Listener } from "./listener.ts";
import { noteSpoken } from "./marks.ts";
import { followReply } from "./reply.ts";
import type { ReplyFollower, ReplyResult } from "./reply.ts";
import { speaker } from "./speaker.ts";
import { dismissProblem, getSettings, IDLE_SESSION, onReset, readingStore, sessionStore, settingsStore, showProblem } from "./state.ts";

/** The timer of the turn (quiet, the countdown's end, the wait for the last segment) and the loading of a list: the tests give their own,
 *  driven by their clock. */
export const sessionDeps = {
  setTimer: (f: () => void, ms: number): unknown => setTimeout(f, ms),
  clearTimer: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
  load: (chat: string): Promise<void> => loadItems(chat),
};
const DEPS_AT_START = { ...sessionDeps };

/** After a reply has played, what is heard for this long and is mostly its words is its echo (where voice barge-in ships). */
export const ECHO_TAIL_MS = 1500;
/** How long the pill's turn waits for its chat's list to load before it is sent all the same. */
export const LOAD_WAIT_MS = 3000;

type How =
  | { kind: "dictation"; sink: DictationSink }
  | { kind: "speech"; chat: string; branch: string; send(text: string): Promise<unknown> }
  | { kind: "pill"; target(): Promise<string | null>; send(chat: string, text: string): Promise<unknown> };

type Session = {
  owner: SessionOwner;
  anchor: string;
  how: How;
  retry: () => void;
  /** Aborted when the session ends: what is still starting stops. */
  ctl: AbortController;
  starting: boolean;
  listener: Listener | null;
  turn: TurnState;
  timer: unknown;
  /** Past the turn machine: the turn is on its way, the agent works, the reply is spoken. null: the turn machine decides. */
  stage: "sending" | "thinking" | "speaking" | null;
  /** The screen's `send` has not answered yet. */
  sending: boolean;
  /** The words of the turn on its way (shown until the reply starts: the speech bar, the captions). */
  said: string;
  reply: ReplyFollower | null;
  muted: boolean;
  /** Speaking may interrupt the reply here (VC-9). */
  bargeIn: boolean;
  /** The sentences being spoken, the last two: what an echo would repeat. */
  recent: string[];
  spoken: string;
  /** `ports.now()` until which what is heard is checked for the echo of the reply that has just played. */
  echoUntil: number;
  level: number;
  target: string | null;
  /** What the dictation sink was last shown. */
  shown: string;
  offs: (() => void)[];
};

let current: Session | null = null;

const TURN_PHASE: Record<TurnPhase, Phase> = {
  listening: "listening", countdown: "countdown", waiting: "waiting", committing: "sending", sent: "sending",
};

const now = (): number => voicePorts().now();

// ---- what is shown

function phaseOf(s: Session): Phase {
  if (s.starting) return "starting";
  return s.stage ?? TURN_PHASE[s.turn.phase];
}

/** Audio may go up: the turn listens, or the reply is spoken where speaking may interrupt it. Where it may not (no echo cancellation), a
 *  message read aloud meanwhile closes the gate too: the microphone would take the speaker's words for the person's. */
function gateOpen(s: Session): boolean {
  if (s.starting) return true;
  if (!s.bargeIn && readingStore.get().key !== null) return false;
  if (s.stage === "speaking") return s.bargeIn;
  if (s.stage) return false;
  return s.turn.phase !== "committing" && s.turn.phase !== "sent";
}

/** The session's state as the screens see it; a value equal in every field to the one shown tells nobody. */
function render(s: Session): void {
  if (current !== s) return;
  const onWay = s.stage === "sending" || s.stage === "thinking";
  const next: SessionState = {
    owner: s.owner,
    phase: phaseOf(s),
    committed: onWay ? s.said : s.stage === "speaking" ? "" : committedText(s.turn),
    partial: s.stage ? "" : s.turn.partial,
    level: s.muted ? 0 : s.level,
    muted: s.muted,
    countdown: s.stage ? null : s.turn.countdown,
    spoken: s.stage === "speaking" ? s.spoken : "",
    target: s.target,
  };
  const was = sessionStore.get();
  if (!(Object.keys(next) as (keyof SessionState)[]).every((k) => Object.is(next[k], was[k]))) sessionStore.set(next);
  s.listener?.gate(gateOpen(s));
  if (s.how.kind === "dictation") {
    const shown = `${committedText(s.turn)}\u0000${s.turn.partial}`;
    if (shown !== s.shown) {
      s.shown = shown;
      s.how.sink.show({ committed: committedText(s.turn), partial: s.turn.partial });
    }
  }
}

// ---- the turn

function schedule(s: Session): void {
  if (s.timer !== null) { sessionDeps.clearTimer(s.timer); s.timer = null; }
  const at = deadline(s.turn);
  if (at === null || current !== s) return;
  s.timer = sessionDeps.setTimer(() => {
    s.timer = null;
    if (current === s) stepTurn(s, { type: "tick" });
  }, Math.max(0, at - now()));
}

function stepTurn(s: Session, input: TurnInput): void {
  if (current !== s || s.starting) return;
  const r = step(s.turn, input, now());
  s.turn = r.state;
  for (const e of r.effects) {
    if (e.kind === "commit") s.listener?.commit();
    else if (e.kind === "send") void sendTurn(s, e.text);
    // A countdown's start and stop are shown from the turn's own `countdown` (render).
  }
  schedule(s);
  render(s);
}

const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/** How many of the words of `text` are in the sentences being spoken, and how many words it has. */
function overlap(text: string, recent: readonly string[]): { words: number; said: number } {
  const words = wordsOf(text);
  const spoken = new Set(recent.flatMap(wordsOf));
  return { words: words.length, said: words.filter((w) => spoken.has(w)).length };
}

/** What is heard while the reply is spoken interrupts it (VC-9): two words or more, fewer than half of them in what is being spoken. */
export function bargesIn(text: string, recent: readonly string[]): boolean {
  const o = overlap(text, recent);
  return o.words >= 2 && o.said * 2 < o.words;
}

/** What is heard just after the reply played is its echo: half of its words or more are the reply's. */
function isEcho(text: string, recent: readonly string[]): boolean {
  const o = overlap(text, recent);
  return o.words > 0 && o.said * 2 >= o.words;
}

function heard(s: Session, kind: "partial" | "committed", text: string): void {
  if (current !== s || s.starting) return;
  if (s.stage === "sending" || s.stage === "thinking") return; // the turn went: what is heard now does not count
  if (s.stage === "speaking") {
    if (!s.bargeIn || !bargesIn(text, s.recent)) return;
    // Voice barge-in: the reply stops, and what was said starts the next turn.
    stopReply(s);
    s.stage = null;
  } else if (s.bargeIn && now() < s.echoUntil && isEcho(text, s.recent)) {
    return;
  }
  stepTurn(s, kind === "partial" ? { type: "partial", text } : { type: "committed", text });
}

// ---- sending and the reply

function stopReply(s: Session): void {
  const r = s.reply;
  s.reply = null;
  r?.stop();
}

/** The words of a turn whose `send` failed are the person's again: the turn waits for Send. */
function giveBack(s: Session, text: string): void {
  s.stage = null;
  s.turn = { ...s.turn, phase: "waiting", committed: [text], partial: "", quietAt: null, countdown: null, commitBy: null };
  schedule(s);
  render(s);
}

async function sendTurn(s: Session, text: string): Promise<void> {
  if (current !== s || s.how.kind === "dictation") return;
  const how = s.how;
  s.stage = "sending";
  s.sending = true;
  s.said = text;
  render(s);

  let chat: string;
  let branch: string;
  if (how.kind === "speech") {
    chat = how.chat;
    branch = how.branch;
  } else {
    let t: string | null = null;
    try { t = await how.target(); } catch { t = null; }
    if (current !== s) return;
    if (!t) { s.sending = false; giveBack(s, text); return; } // no chat could be made: the refusal was reported where it is made
    chat = t;
    s.target = t;
    if (!threadAt(getState(), branchKey(chat, shownBranch(getState(), chat)))) {
      let timer: unknown = null;
      await Promise.race([
        sessionDeps.load(chat).catch(() => {}),
        new Promise<void>((resolve) => { timer = sessionDeps.setTimer(resolve, LOAD_WAIT_MS); }),
      ]);
      sessionDeps.clearTimer(timer);
      if (current !== s) return;
    }
    branch = shownBranch(getState(), chat);
  }

  const before = threadAt(getState(), branchKey(chat, branch))?.items.length ?? 0;
  noteSpoken({ chat, branch, before, text });
  const follower = followReply({
    chat, branch, before, text,
    owner: how.kind,
    anchor: s.anchor,
    retry: s.retry,
    skipCode: getSettings().skipCode,
    onSentence(sentence) {
      if (current !== s || s.reply !== follower) return;
      s.stage = "speaking";
      s.spoken = sentence;
      s.recent = [...s.recent, sentence].slice(-2);
      s.level = 0;
      render(s);
    },
    onLevel(level) {
      if (current !== s || s.reply !== follower || s.stage !== "speaking") return;
      s.level = level;
      render(s);
    },
  });
  s.reply = follower;
  void follower.done.then((r) => afterReply(s, follower, r));

  try {
    await (how.kind === "speech" ? how.send(text) : how.send(chat, text));
  } catch {
    s.sending = false;
    if (s.reply === follower) stopReply(s);
    if (current !== s) return;
    giveBack(s, text); // the screen's send says why, as for a typed message
    return;
  }
  s.sending = false;
  if (current !== s) return;
  s.turn = step(s.turn, { type: "reset" }, now()).state;
  // (The stage may have moved while `send` ran: the reply's first sentence may already be heard.)
  if (s.reply !== follower) s.stage = null; // the reply is already over (or was interrupted)
  else if ((s.stage as Session["stage"]) !== "speaking") s.stage = "thinking";
  schedule(s);
  render(s);
}

function afterReply(s: Session, follower: ReplyFollower, r: ReplyResult): void {
  if (s.reply !== follower) return;
  s.reply = null;
  if (current !== s) return;
  if (typeof r === "object") { endSession(); return; } // the speaker showed the problem
  if (r === "played" && s.bargeIn) s.echoUntil = now() + ECHO_TAIL_MS;
  s.level = 0;
  if (s.sending) { s.stage = "sending"; render(s); return; } // the turn's own send answers after its reply: it decides then
  s.stage = null;
  render(s);
}

// ---- starting and ending

function fail(s: Session, kind: VoiceProblemKind): void {
  if (current !== s) return;
  showProblem({ kind, anchor: s.anchor, retry: s.retry });
  endSession();
}

/** Ends the session running, quietly: the microphone and the socket, the timer, the reply's sound; dictation gives its final words. */
export function endSession(): void {
  const s = current;
  if (!s) return;
  current = null;
  s.ctl.abort();
  s.listener?.stop();
  s.listener = null;
  if (s.timer !== null) { sessionDeps.clearTimer(s.timer); s.timer = null; }
  for (const off of s.offs.splice(0)) off();
  stopReply(s);
  if (s.how.kind === "dictation") s.how.sink.done(turnText(s.turn));
  sessionStore.set(IDLE_SESSION);
}

async function start(owner: SessionOwner, anchor: string, how: How, retry: () => void): Promise<void> {
  endSession(); // one session at a time (VC-18)
  const settings = getSettings();
  const s: Session = {
    owner, anchor, how, retry, ctl: new AbortController(), starting: true, listener: null,
    turn: initTurn({ sends: how.kind !== "dictation", autoSend: settings.autoSend, pauseMs: settings.pauseMs }),
    timer: null, stage: null, sending: false, said: "", reply: null, muted: false, bargeIn: false, recent: [], spoken: "",
    echoUntil: 0, level: 0, target: null, shown: `\u0000`, offs: [],
  };
  current = s;
  sessionStore.set({ ...IDLE_SESSION, owner, phase: "starting" });

  // The key first: with none, the popover shows and nothing else happens (no microphone, no socket).
  const has = await voicePorts().keystore.has().catch(() => false);
  if (current !== s) return;
  if (!has) { fail(s, "no_key"); return; }
  dismissProblem();
  s.offs.push(voicePorts().audio.onInterrupted(() => { if (current === s) endSession(); }));

  let listener: Listener | null;
  try {
    listener = await startListener({
      settings,
      echoCancel: how.kind !== "dictation",
      signal: s.ctl.signal,
      on: {
        partial: (text) => heard(s, "partial", text),
        committed: (text) => heard(s, "committed", text),
        level(level) {
          if (current !== s || s.stage) return;
          s.level = level;
          render(s);
        },
        problem: (kind) => fail(s, kind),
      },
    });
  } catch (e) {
    fail(s, problemOfException(e));
    return;
  }
  if (!listener || current !== s) { listener?.stop(); return; }
  s.listener = listener;
  s.bargeIn = how.kind !== "dictation" && voicePorts().audio.voiceBargeIn && listener.echoCancel;
  if (s.muted) listener.mute(true);
  s.starting = false;
  s.offs.push(readingStore.subscribe(() => render(s)));
  s.offs.push(settingsStore.subscribe(() => {
    const st = getSettings();
    if (st.autoSend !== s.turn.config.autoSend || st.pauseMs !== s.turn.config.pauseMs) {
      stepTurn(s, { type: "settings", autoSend: st.autoSend, pauseMs: st.pauseMs });
    }
  }));
  render(s);
}

// ---- the controller's methods

export function startDictation(o: { chat: string; branch: string; anchor: string; sink: DictationSink }): Promise<void> {
  return start({ kind: "dictation", chat: o.chat, branch: o.branch }, o.anchor, { kind: "dictation", sink: o.sink },
    () => { void startDictation(o); });
}

export function startSpeech(o: { chat: string; branch: string; anchor: string; send(text: string): Promise<unknown> }): Promise<void> {
  return start({ kind: "speech", chat: o.chat, branch: o.branch }, o.anchor, { kind: "speech", chat: o.chat, branch: o.branch, send: o.send },
    () => { void startSpeech(o); });
}

export function startPill(o: {
  board: string; anchor: string; target(): Promise<string | null>; send(chat: string, text: string): Promise<unknown>;
}): Promise<void> {
  return start({ kind: "pill", board: o.board }, o.anchor, { kind: "pill", target: o.target, send: o.send },
    () => { void startPill(o); });
}

/** Mute: no audio goes up; the socket stays. */
export function mute(on: boolean): void {
  const s = current;
  if (!s || s.muted === on) return;
  s.muted = on;
  s.listener?.mute(on);
  render(s);
}

/** Send, or the ↑ badge: the turn goes (after its last words are committed). */
export function send(): void {
  const s = current;
  if (!s || s.stage || s.how.kind === "dictation") return;
  stepTurn(s, { type: "send" });
}

/** Cancel: the countdown stops and the words stay. */
export function cancelCountdown(): void {
  const s = current;
  if (!s || s.stage) return;
  stepTurn(s, { type: "cancel" });
}

/** A tap barge-in: whatever plays stops (the reply, or a message read aloud), and a session whose reply was coming or being spoken listens
 *  again. The agent's turn goes on (goal §5: barge-in stops speech, not the turn). */
export function interrupt(): void {
  const s = current;
  if (s && s.reply) {
    stopReply(s);
    s.level = 0;
    s.stage = s.sending ? "sending" : null;
    render(s);
  }
  speaker.stopAll();
}

onReset(() => {
  endSession();
  Object.assign(sessionDeps, DEPS_AT_START);
});
