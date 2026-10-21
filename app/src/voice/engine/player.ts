// The one audio queue of the app (architecture VC-11), over the audio port's PCM player. Everything that is heard as speech goes
// through here: it keeps the port's one event subscription (made at the first use, never before), tells what is queued and not yet
// played, and counts what it did for the checks (`window.__aiwbVoice.player()`, VC-32). It decides nothing about sentences: `speaker.ts`
// does, and calls this.
import { voicePorts } from "../ports.ts";
import type { Opened, PcmPlayer, PlayerEvent, SavedDevice } from "../ports.ts";
import { onReset } from "./state.ts";

export type PlayerStats = {
  /** Calls of `write`, and the bytes written. */
  writes: number;
  bytes: number;
  /** Calls of `mark`. */
  marks: number;
  /** Calls of `stop` that reached the port. */
  stops: number;
  /** `ports.now()` at the first write since the stats were reset; null before it. */
  firstWriteAt: number | null;
};

const fresh = (): PlayerStats => ({ writes: 0, bytes: 0, marks: 0, stops: 0, firstWriteAt: null });
let stats = fresh();
/** Audio was written and the port has not said it is drained: there is sound to stop. */
let busy = false;
/** The port's player is held (by `hold`, or by a loss it held itself): it plays nothing and keeps its queue. `stop` ends it too. */
let held = false;
const listeners = new Set<(e: PlayerEvent) => void>();
let subscribed: { port: PcmPlayer; off: () => void } | null = null;

function dispatch(e: PlayerEvent): void {
  if (e.kind === "drained") busy = false;
  for (const f of [...listeners]) f(e);
}

/** The port's player, subscribed to once. A new set of ports (the tests give one per test) is subscribed to in its turn. */
function port(): PcmPlayer {
  const p = voicePorts().audio.player;
  if (subscribed?.port !== p) {
    subscribed?.off();
    subscribed = { port: p, off: p.on(dispatch) };
  }
  return p;
}

export const player = {
  /** PCM s16le mono at 24 kHz, after what is queued. An odd length is the caller's to avoid (`speaker.ts` carries the odd byte). */
  write(pcm: Uint8Array): void {
    const p = port();
    if (stats.firstWriteAt === null) stats.firstWriteAt = voicePorts().now();
    stats.writes++;
    stats.bytes += pcm.length;
    busy = true;
    p.write(pcm);
  },
  /** The start of a sentence: `mark` events come back when playback reaches it. */
  mark(id: number): void {
    stats.marks++;
    port().mark(id);
  },
  /** Stops at once and clears the queue. Nothing reaches the port when nothing was written and nothing is held (a fresh engine makes no
   *  audio call). A held player is let go too, once its queue is gone: the next utterance must not be written into a hold nobody owns. */
  stop(): void {
    if (!busy && !held) return;
    const wasHeld = held;
    busy = false;
    held = false;
    stats.stops++;
    const p = port();
    p.stop();
    if (wasHeld) p.resume();
  },
  /** Where the next sound goes: the saved speaker, or null for the system default (VD-1). Never rejects for a missing device. */
  useOutput(d: SavedDevice | null): Promise<Opened> { return port().useOutput(d); },
  /** Pauses the sound where it is; what is written meanwhile is kept (VD-12). */
  hold(): void {
    held = true;
    port().hold();
  },
  /** Plays on from where the hold stopped. */
  resume(): void {
    held = false;
    port().resume();
  },
  /** The port held the sound itself (an `output-lost` with `held`): the engine now owns the hold. */
  noteHeld(): void { held = true; },
  held: (): boolean => held,
  /** Audio is queued and not played out yet. */
  busy: (): boolean => busy,
  /** Playback events (marks, levels, drained) of the one player. Returns the way to stop listening. */
  on(f: (e: PlayerEvent) => void): () => void {
    port();
    listeners.add(f);
    return () => { listeners.delete(f); };
  },
  stats: (): PlayerStats => ({ ...stats }),
};

onReset(() => {
  subscribed?.off();
  subscribed = null;
  listeners.clear();
  busy = false;
  held = false;
  stats = fresh();
});
