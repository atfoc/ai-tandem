// `aiwb-indent` in JS, for the tests of the hanging indent's controller (app/src/platform/chipinput/hang.ts) and nothing else.
// `mount(tag)` / `unmount(tag)` are the platform's text view coming and going: `setIndent` resolves true for a mounted tag (and
// records the width; 0 removes it), false for any other, and it resolves a tick later, as the real one answers from the UI
// thread, so the controller's call in flight is exercised. `settle()` waits until every call made so far has answered. `emit` is
// what the native side does when it has drawn the box. `calls()` is every `setIndent` in order, `indents()` what is drawn now,
// `listening()` the number of listeners of onDrawnHeight.
import type { AiwbIndentEvents, AiwbIndentModule, DrawnHeightEvent } from "./AiwbIndent.ts";

export type FakeAiwbIndent = {
  module: AiwbIndentModule;
  mount(tag: number): void;
  unmount(tag: number): void;
  emit(e: DrawnHeightEvent): void;
  calls(): [number, number][];
  indents(): Map<number, number>;
  listening(): number;
  settle(): Promise<void>;
};

export function createFakeAiwbIndent(): FakeAiwbIndent {
  const listeners = new Set<AiwbIndentEvents["onDrawnHeight"]>();
  const mounted = new Set<number>();
  const drawn = new Map<number, number>();
  const log: [number, number][] = [];
  let pending: Promise<unknown> = Promise.resolve();
  return {
    module: {
      setIndent: (tag, tabWidth) => {
        log.push([tag, tabWidth]);
        const answer = new Promise<boolean>((resolve) => setTimeout(() => {
          if (!mounted.has(tag)) return resolve(false);
          if (tabWidth > 0) drawn.set(tag, tabWidth);
          else drawn.delete(tag);
          resolve(true);
        }, 0));
        pending = Promise.all([pending, answer]);
        return answer;
      },
      addListener: (_name, listener) => {
        listeners.add(listener);
        return { remove: () => { listeners.delete(listener); } };
      },
    },
    mount: (tag) => { mounted.add(tag); },
    unmount: (tag) => { mounted.delete(tag); drawn.delete(tag); },
    emit: (e) => { for (const l of [...listeners]) l(e); },
    calls: () => [...log],
    indents: () => new Map(drawn),
    listening: () => listeners.size,
    // (an answer can make the controller call again: wait until no new call came while waiting)
    settle: async () => {
      for (;;) {
        const n = log.length;
        await pending;
        await new Promise((r) => setTimeout(r, 0));
        if (log.length === n) return;
      }
    },
  };
}
