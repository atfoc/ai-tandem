// The turn machine (architecture VC-20): the words of one spoken turn, when the person has gone quiet, the countdown, and when the turn is
// sent. Pure and clocked from outside: `step(state, input, now)` gives the next state and the effects the engine carries out, and
// `deadline(state)` says when the engine must call `step` with a `tick` if nothing else comes first.
//
// The words are the finished segments (`committed`) and the live guess (`partial`). The person is quiet when the turn has words and
// either a segment was committed with no guess after it, or the guess has not changed for QUIET_MS. With Auto-send on, quiet starts a
// countdown of `pauseMs`; its end sends the turn. With Auto-send off, quiet waits for Send. Cancel keeps the words and waits; talking on
// (a new guess) ends a countdown or a wait and goes on listening. Send with a guess that is not committed asks the service to commit it
// and waits up to COMMIT_WAIT_MS for the segment; the text sent is the segments, and the guess if no segment came. Dictation is the same
// machine with `sends: false`: it keeps the words and never emits `send`.

/** No change of the guess for this long is quiet, when no segment was committed. */
export const QUIET_MS = 400;
/** How long Send waits for the segment it asked the service to commit. */
export const COMMIT_WAIT_MS = 1000;

export type TurnPhase =
  | "listening"   // words may come; no countdown
  | "countdown"   // Auto-send: quiet, the turn goes when `countdown` ends
  | "waiting"     // quiet and not sending by itself: Send, or Cancel kept the words
  | "committing"  // Send asked for the last segment and waits for it
  | "sent";       // the turn went; nothing changes until `reset`

export type TurnConfig = {
  /** false for dictation: nothing is ever sent. */
  sends: boolean;
  autoSend: boolean;
  pauseMs: number;
};

export type TurnState = {
  phase: TurnPhase;
  config: TurnConfig;
  /** Finished segments, trimmed, empty ones left out. */
  committed: readonly string[];
  partial: string;
  /** When the person counts as quiet; null when not waiting for it. */
  quietAt: number | null;
  countdown: { startedAt: number; ms: number } | null;
  /** When Send stops waiting for the segment. */
  commitBy: number | null;
};

export type TurnInput =
  | { type: "partial"; text: string }
  | { type: "committed"; text: string }
  | { type: "tick" }
  | { type: "send" }
  | { type: "cancel" }
  /** Auto-send or the pause changed (the speech bar's toggle, Settings). */
  | { type: "settings"; autoSend: boolean; pauseMs: number }
  /** A new turn, after the old one went. */
  | { type: "reset" };

export type TurnEffect =
  /** Put the turn into a chat. The words are the whole turn. */
  | { kind: "send"; text: string }
  /** Send the STT socket a frame with `commit: true` and an empty chunk. */
  | { kind: "commit" }
  /** Show (or stop showing) the countdown bar. `start` while one runs restarts it. */
  | { kind: "countdown"; action: "start"; startedAt: number; ms: number }
  | { kind: "countdown"; action: "stop" };

export type TurnStep = { state: TurnState; effects: TurnEffect[] };

export function initTurn(config: TurnConfig): TurnState {
  return { phase: "listening", config, committed: [], partial: "", quietAt: null, countdown: null, commitBy: null };
}

const clean = (s: string): string => s.trim();

/** The finished words of the turn. */
export const committedText = (s: TurnState): string => s.committed.join(" ");

/** All the words of the turn, as sent: the segments and then the guess, if there is one. */
export function turnText(s: TurnState): string {
  return [...s.committed, clean(s.partial)].filter(Boolean).join(" ");
}

export const hasWords = (s: TurnState): boolean => turnText(s) !== "";

/** When `step` must next be called with a `tick`; null when nothing is waiting for time. */
export function deadline(s: TurnState): number | null {
  switch (s.phase) {
    case "listening": return s.quietAt;
    case "countdown": return s.countdown ? s.countdown.startedAt + s.countdown.ms : null;
    case "committing": return s.commitBy;
    default: return null;
  }
}

/** Ends a countdown that runs: the state without it and the effect that stops its bar. */
function stopCountdown(s: TurnState, phase: TurnPhase): TurnStep {
  const effects: TurnEffect[] = s.countdown ? [{ kind: "countdown", action: "stop" }] : [];
  return { state: { ...s, phase, countdown: null }, effects };
}

/** The turn goes now: the text of the turn, after the countdown stops. */
function sendNow(s: TurnState): TurnStep {
  const text = turnText(s);
  const stopped = stopCountdown(s, "sent");
  const state = { ...stopped.state, quietAt: null, commitBy: null };
  if (text === "") return { state: { ...state, phase: "listening" }, effects: stopped.effects };
  return { state, effects: [...stopped.effects, { kind: "send", text }] };
}

/** Send, or the end of a countdown: the guess is committed first, so that the text sent is the service's own. */
function startSend(s: TurnState, now: number): TurnStep {
  if (!s.config.sends || s.phase === "sent" || s.phase === "committing" || !hasWords(s)) return { state: s, effects: [] };
  if (clean(s.partial) === "") return sendNow(s);
  const stopped = stopCountdown(s, "committing");
  return { state: { ...stopped.state, quietAt: null, commitBy: now + COMMIT_WAIT_MS }, effects: [...stopped.effects, { kind: "commit" }] };
}

/** Quiet: the countdown starts, or the turn waits. Dictation has no quiet. */
function quiet(s: TurnState, now: number): TurnStep {
  if (!s.config.sends) return { state: { ...s, quietAt: null }, effects: [] };
  if (!s.config.autoSend) return { state: { ...s, phase: "waiting", quietAt: null }, effects: [] };
  const countdown = { startedAt: now, ms: s.config.pauseMs };
  return {
    state: { ...s, phase: "countdown", quietAt: null, countdown },
    effects: [{ kind: "countdown", action: "start", ...countdown }],
  };
}

/** The person talks on: a countdown or a wait ends, and the turn listens again. */
function talkOn(s: TurnState): TurnStep {
  if (s.phase === "countdown") return stopCountdown(s, "listening");
  if (s.phase === "waiting") return { state: { ...s, phase: "listening" }, effects: [] };
  return { state: s, effects: [] };
}

/** After an input: quiet is entered when its time has come. */
function settle(r: TurnStep, now: number): TurnStep {
  const s = r.state;
  if (s.phase !== "listening" || s.quietAt === null || now < s.quietAt || !hasWords(s)) return r;
  const q = quiet(s, now);
  return { state: q.state, effects: [...r.effects, ...q.effects] };
}

/** When quiet is reached if nothing changes from `at` on. Dictation has no quiet. */
const quietFrom = (s: TurnState, at: number): number | null => (s.config.sends && hasWords(s) ? at : null);

function onPartial(s: TurnState, text: string, now: number): TurnStep {
  const partial = clean(text);
  if (s.phase === "sent" || partial === s.partial) return { state: s, effects: [] };
  if (s.phase === "committing") return { state: { ...s, partial }, effects: [] };
  const moved = partial !== "" ? talkOn(s) : { state: s, effects: [] as TurnEffect[] };
  const state = { ...moved.state, partial };
  // A guess that went empty with words left counts as a change too: quiet is a pause after the last change.
  return { state: state.phase === "listening" ? { ...state, quietAt: quietFrom(state, now + QUIET_MS) } : state, effects: moved.effects };
}

function onCommitted(s: TurnState, text: string, now: number): TurnStep {
  if (s.phase === "sent") return { state: s, effects: [] };
  const segment = clean(text);
  const fromGuess = clean(s.partial) !== "";
  const committed = segment ? [...s.committed, segment] : s.committed;
  const next = { ...s, committed, partial: "" };
  if (s.phase === "committing") return sendNow(next);
  // Words that no guess announced are new speech: a countdown that runs starts again; a wait goes back to listening.
  const moved = segment && !fromGuess && s.phase !== "countdown" ? talkOn(next) : { state: next, effects: [] as TurnEffect[] };
  let state = moved.state;
  let effects = moved.effects;
  if (state.phase === "countdown" && segment && !fromGuess) {
    const countdown = { startedAt: now, ms: state.config.pauseMs };
    state = { ...state, countdown };
    effects = [...effects, { kind: "countdown", action: "start", ...countdown }];
  }
  if (state.phase === "listening") state = { ...state, quietAt: quietFrom(state, now) };
  return { state, effects };
}

function onTick(s: TurnState, now: number): TurnStep {
  if (s.phase === "countdown" && s.countdown && now >= s.countdown.startedAt + s.countdown.ms) return startSend(s, now);
  if (s.phase === "committing" && s.commitBy !== null && now >= s.commitBy) return sendNow(s);
  return { state: s, effects: [] };
}

function onSettings(s: TurnState, autoSend: boolean, pauseMs: number): TurnStep {
  const next = { ...s, config: { ...s.config, autoSend, pauseMs } };
  if (s.phase === "countdown" && !autoSend) return stopCountdown(next, "waiting");
  return { state: next, effects: [] };
}

export function step(s: TurnState, input: TurnInput, now: number): TurnStep {
  switch (input.type) {
    case "partial": return settle(onPartial(s, input.text, now), now);
    case "committed": return settle(onCommitted(s, input.text, now), now);
    case "tick": return settle(onTick(s, now), now);
    case "send": return startSend(s, now);
    case "cancel": return s.phase === "countdown" ? stopCountdown(s, "waiting") : { state: s, effects: [] };
    case "settings": return onSettings(s, input.autoSend, input.pauseMs);
    case "reset": return { state: initTurn(s.config), effects: s.countdown ? [{ kind: "countdown", action: "stop" }] : [] };
  }
}
