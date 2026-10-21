// The listening sessions (architecture VC-18 to VC-22, §8.1): dictation, speech mode and the board's pill, one at a time. A session
// is the microphone and the STT socket (`listener.ts`), the turn machine (`logic/turn.ts`) with its timer, the sending of a turn through
// the function the screen gave, the reply follower (`reply.ts`) and the speaker; `end`, a problem in any of them, or the system taking
// the audio ends them all together, in this order: no more audio goes up, the timer stops, the reply's sound stops, the session's state
// goes back to idle.
//
// Nothing is sent without the person's act (goal 4.7): a turn goes when the turn machine says so (Auto-send's pause ran out, or Send),
// and dictation's machine never says so. Nothing is heard while it cannot count: from the moment a turn is on its way until its reply is
// over, on every platform, no chunk goes up and what is heard is dropped, so the speaker's words are never taken for the person's. The
// reply is over when it has played (and then `REPLY_TAIL_MS` more, for the last of its sound in the room), was stopped, failed, or the
// person tapped to interrupt it (no tail: listening is at once); a message read aloud closes the gate the same way while it plays. Speaking
// does not interrupt the reply; a tap does. A turn already handed to the screen's `send` is never taken back; a `send` that fails gives
// the words back to the person to send again.
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
import type { Opened, VoiceProblemKind } from "../ports.ts";
import type { DictationSink, Phase, SessionOwner, SessionState } from "../index.ts";
import { announceStart, applyOutput, enterRoute, outputWanted, stopMicTest } from "./devices.ts";
import type { NoticeWhere, RouteHandle } from "./devices.ts";
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

/** After a reply has played to its end, the gate stays closed this long more: the last of the speaker's sound and its echo in the room. */
export const REPLY_TAIL_MS = 500;
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
  /** Past the turn machine: the turn is on its way, the agent works, the reply is spoken (or its tail runs). null: the turn machine
   *  decides. */
  stage: "sending" | "thinking" | "speaking" | null;
  /** The screen's `send` has not answered yet. */
  sending: boolean;
  /** The words of the turn on its way (shown until the reply starts: the speech bar, the captions). */
  said: string;
  reply: ReplyFollower | null;
  muted: boolean;
  spoken: string;
  /** The timer of the tail after a reply played (`REPLY_TAIL_MS`); null when none runs. */
  tail: unknown;
  level: number;
  target: string | null;
  /** What the dictation sink was last shown. */
  shown: string;
  offs: (() => void)[];
  /** Paused because the private output went away (VD-12): nothing is sent, no timer of the turn runs, the player stays held. */
  paused: { device: string } | null;
  /** The session's use of audio, for the devices that go away (`devices.ts`). */
  route: RouteHandle | null;
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

/** Audio may go up: the turn listens. A turn on its way, its reply and the reply's tail, and a message read aloud close the gate: the
 *  microphone would take the speaker's words for the person's. */
function gateOpen(s: Session): boolean {
  if (s.paused) return false;
  if (s.starting) return true;
  if (readingStore.get().key !== null) return false;
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
    paused: s.paused,
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
  if (s.paused && s.turn.phase !== "committing") return; // the turn's time stands still while paused; a Send already asked for goes on
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
  // Words heard while paused are kept, but no countdown runs: it would send the turn while the person cannot hear the reply (VD-12).
  if (s.paused && s.turn.phase === "countdown") s.turn = step(s.turn, { type: "cancel" }, now()).state;
  schedule(s);
  render(s);
}

function heard(s: Session, kind: "partial" | "committed", text: string): void {
  if (current !== s || s.starting) return;
  if (s.stage) return; // the turn went and its reply is not over: what is heard now does not count
  stepTurn(s, kind === "partial" ? { type: "partial", text } : { type: "committed", text });
}

// ---- sending and the reply

function stopReply(s: Session): void {
  const r = s.reply;
  s.reply = null;
  r?.stop();
}

function clearTail(s: Session): void {
  if (s.tail === null) return;
  sessionDeps.clearTimer(s.tail);
  s.tail = null;
}

/** The words of a turn whose `send` failed are the person's again: the turn waits for Send. */
function giveBack(s: Session, text: string): void {
  clearTail(s);
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
  // (The stage may have moved while `send` ran: the reply's first sentence may already be heard, or the reply has played and its tail
  // runs: the tail ends it.)
  if (s.reply !== follower) { if (s.tail === null) s.stage = null; } // the reply is already over (or was interrupted)
  else if ((s.stage as Session["stage"]) !== "speaking") s.stage = "thinking";
  schedule(s);
  render(s);
}

function afterReply(s: Session, follower: ReplyFollower, r: ReplyResult): void {
  if (s.reply !== follower) return;
  s.reply = null;
  if (current !== s) return;
  if (typeof r === "object") { endSession(); return; } // the speaker showed the problem
  s.level = 0;
  if (r === "played" && s.stage === "speaking") {
    // Its sound has ended: the speaking phase stays, and the gate closed, for the tail.
    s.tail = sessionDeps.setTimer(() => {
      s.tail = null;
      if (current !== s) return;
      s.stage = s.sending ? "sending" : null; // the turn's own send answers after its reply: it decides then
      render(s);
    }, REPLY_TAIL_MS);
    render(s);
    return;
  }
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
  clearTail(s);
  for (const off of s.offs.splice(0)) off();
  stopReply(s);
  s.route?.leave();
  s.route = null;
  if (s.how.kind === "dictation") s.how.sink.done(turnText(s.turn));
  sessionStore.set(IDLE_SESSION);
}

async function start(owner: SessionOwner, anchor: string, how: How, retry: () => void): Promise<void> {
  endSession(); // one session at a time (VC-18)
  stopMicTest(); // and not together with the microphone test of Settings (VD-16)
  const settings = getSettings();
  const s: Session = {
    owner, anchor, how, retry, ctl: new AbortController(), starting: true, listener: null,
    turn: initTurn({ sends: how.kind !== "dictation", autoSend: settings.autoSend, pauseMs: settings.pauseMs }),
    timer: null, stage: null, sending: false, said: "", reply: null, muted: false, spoken: "", tail: null,
    level: 0, target: null, shown: `\u0000`, offs: [], paused: null, route: null,
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
  if (s.muted) listener.mute(true);
  // The devices (VD-8): a speaking session gives the player its speaker once, now; a saved device that was not there is one notice.
  const speaks = how.kind !== "dictation";
  const where: NoticeWhere = owner.kind === "pill" ? { kind: "board", board: owner.board } : { kind: "chat", chat: owner.chat };
  const route = enterRoute({
    where, listens: true, speaks,
    onPause: speaks ? (device) => pauseSession(s, device) : undefined,
    onResume: () => resumeSession(s),
    onMicFailed: () => fail(s, "mic_blocked"),
  });
  s.route = route;
  let out: Opened | null = null;
  if (speaks && outputWanted(settings.speaker)) {
    out = await applyOutput(settings.speaker);
    if (current !== s) return;
  }
  announceStart(route, settings, listener.opened, out);
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

/** The private output went away and the next sound would be out loud (VD-12): the gate closes, a countdown is cancelled with its words kept,
 *  the player stays held. The reply follower and the speaker go on into the held queue. */
function pauseSession(s: Session, device: string): void {
  if (current !== s || s.paused) return;
  s.paused = { device };
  if (s.starting) return; // the start finishes into the pause: the gate is closed from its first render
  if (s.turn.phase === "countdown") stepTurn(s, { type: "cancel" });
  else { schedule(s); render(s); }
}

/** Continue: the gate and the turn's time are back as the phase says. (The player was resumed by `devices.resume`.) */
function resumeSession(s: Session): void {
  if (current !== s || !s.paused) return;
  s.paused = null;
  if (s.starting) return;
  stepTurn(s, { type: "tick" }); // quiet that came while paused starts its countdown now
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
  if (!s || s.stage || s.paused || s.how.kind === "dictation") return;
  stepTurn(s, { type: "send" });
}

/** Cancel: the countdown stops and the words stay. */
export function cancelCountdown(): void {
  const s = current;
  if (!s || s.stage) return;
  stepTurn(s, { type: "cancel" });
}

/** A tap barge-in: whatever plays stops (the reply, or a message read aloud), and a session whose reply was coming or being spoken listens
 *  again at once (no tail). The agent's turn goes on (goal §5: barge-in stops speech, not the turn). */
export function interrupt(): void {
  const s = current;
  if (s && (s.reply || s.tail !== null)) {
    stopReply(s);
    clearTail(s);
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
