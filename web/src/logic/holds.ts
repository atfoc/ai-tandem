// Counted holds that linger: something is kept while at least one holder has it, and for a while
// after the last one let go, so that a holder who comes right back finds it. DOM-free; conn.ts
// keeps a run agent's view and thread this way (holdAgent).

type Timers<T> = { set: (f: () => void, ms: number) => T; clear: (t: T) => void };

export class Holds<T = ReturnType<typeof setTimeout>> {
  private counts = new Map<string, number>();
  private lingers = new Map<string, T>();
  private lingerMs: number;
  private onDrop: (id: string) => void;
  private timers: Timers<T>;

  /** onDrop runs once the linger after the last release has passed with no new hold. */
  constructor(lingerMs: number, onDrop: (id: string) => void, timers?: Timers<T>) {
    this.lingerMs = lingerMs;
    this.onDrop = onDrop;
    this.timers = timers ?? { set: (f, ms) => setTimeout(f, ms) as T, clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  }

  /** Takes a hold, which ends a linger. fresh: the id was neither held nor lingering, so there is
   *  nothing kept for it yet. release lets go, once; calling it again does nothing. */
  hold(id: string): { fresh: boolean; release: () => void } {
    const fresh = !this.has(id);
    this.stopLinger(id);
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.counts.get(id) ?? 1) - 1;
      if (n > 0) { this.counts.set(id, n); return; }
      this.counts.delete(id);
      this.lingers.set(id, this.timers.set(() => { this.lingers.delete(id); this.onDrop(id); }, this.lingerMs));
    };
    return { fresh, release };
  }

  /** Held, or let go so lately that it is still kept. */
  has(id: string): boolean { return this.counts.has(id) || this.lingers.has(id); }

  /** Every id that is kept: held or lingering. */
  ids(): string[] { return [...new Set([...this.counts.keys(), ...this.lingers.keys()])]; }

  private stopLinger(id: string) {
    const t = this.lingers.get(id);
    if (t === undefined) return;
    this.timers.clear(t);
    this.lingers.delete(id);
  }
}
