// Where the board side's work on a board that is not on screen goes (AD-52: one web view first). While a board view is mounted
// that is the visible view. Only when none is, a hidden engine view is made (a box nobody sees, at the root of the app), and it
// ends 60 s after its last request, so the memory it took comes back. When a visible view appears while an engine view is
// there, the engine view ends as soon as its requests are answered.
// No React and no react-native here, so Node loads it; `EngineHost.tsx` draws the hidden view this decides on.
import type { BoardChannel } from "@aiwb/core/board/channel.ts";

import type { HostChannel } from "../../platform/board.types.ts";

/** How long a hidden engine view lives after its last request (ms). */
export const ENGINE_IDLE = 60_000;

/** The hidden view: whether it is wanted, and which one (a new one has a new `gen`, so the host draws it anew). */
export type EngineState = { on: boolean; gen: number };

export type Engine = {
  /** The channel for work on a board that is not on screen: the visible view's, else the hidden engine's (made now). */
  channel(): Promise<BoardChannel>;
  /** The visible view is attached (its channel) or gone (null). */
  setVisible(ch: HostChannel | null): void;
  /** The hidden host made its channel, or went away (null). */
  hostChannel(ch: HostChannel | null): void;
  subscribe(f: () => void): () => void;
  state(): EngineState;
};

export function createEngine(idleMs = ENGINE_IDLE): Engine {
  let visible: HostChannel | null = null;
  let current: HostChannel | null = null; // the hidden view's channel, once its host made it
  let waiters: ((ch: HostChannel) => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: EngineState = { on: false, gen: 0 };
  const subs = new Set<() => void>();
  const set = (next: EngineState) => { state = next; for (const f of [...subs]) f(); };

  /** The hidden view goes: its host unmounts (the host lets requests in flight be answered first). */
  function end() {
    clearTimeout(timer);
    timer = undefined;
    current = null;
    if (state.on) set({ on: false, gen: state.gen });
  }

  /** The hidden view ends when it has been quiet for the idle time: `touch` is called at each request and its answer. */
  function touch() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (current && current.inflight() > 0) { touch(); return; } // (a long request: the time starts again when it is answered)
      end();
    }, idleMs);
  }

  /** The hidden view's channel, counting its requests as use. */
  function used(ch: HostChannel): HostChannel {
    return {
      ...ch,
      request(op) {
        touch();
        const p = ch.request(op);
        p.then(touch, touch);
        return p;
      },
    };
  }
  let wrapped: { for: HostChannel; as: HostChannel } | null = null;
  const hiddenChannel = (ch: HostChannel) => (wrapped?.for === ch ? wrapped.as : (wrapped = { for: ch, as: used(ch) }).as);

  return {
    channel() {
      if (visible) return Promise.resolve(visible);
      touch();
      if (current) return Promise.resolve(hiddenChannel(current));
      if (!state.on) set({ on: true, gen: state.gen + 1 });
      return new Promise((r) => waiters.push(r));
    },
    setVisible(ch) {
      visible = ch;
      if (!ch) return;
      // what waited for an engine view is answered by the visible one
      const queue = waiters;
      waiters = [];
      for (const w of queue) w(ch);
      if (!state.on) return;
      // the visible view answers from now on; the engine view ends once what it was asked is answered
      const gen = state.gen;
      const gone = () => { if (visible && state.on && state.gen === gen) end(); };
      if (current) void current.idle().then(gone); else gone();
    },
    hostChannel(ch) {
      if (!ch) { current = null; return; }
      current = ch;
      const queue = waiters;
      waiters = [];
      for (const w of queue) w(hiddenChannel(ch));
    },
    subscribe(f) { subs.add(f); return () => { subs.delete(f); }; },
    state: () => state,
  };
}

/** The app's engine. */
export const engine = createEngine();
