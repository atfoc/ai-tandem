// The hanging indent of the native box (ChipInput.native.tsx), its JS side: when a line of a box that edits like code wraps, its
// continuation lines start at that line's indent (where its text starts after its leading tabs and spaces), not at the box's left
// edge, and a tab is drawn `tabWidth` columns wide. React Native's TextInput has no such style; the local module `aiwb-indent`
// (app/modules/aiwb-indent, contract in src/AiwbIndent.ts) puts it on the platform's own text view. This file is the controller
// that tells the module which view and which width, and takes the box's height back; it imports nothing of react-native, so the
// tests run it over the module's fake in Node (app/test/hangindent.test.ts).
//
// Why it looks like this (learned on the iOS simulator and the Android emulator):
//  - The module finds the view by its React tag (findNodeHandle). Taken in a mount effect the tag was there but the native lookup
//    failed: the view was not mounted yet. A call later worked. So the field attaches from its TextInput's onLayout (native has
//    mounted the view by then), and while the module answered false it asks again at each later onLayout.
//  - React Native measures the box's height itself, without the indent and with its own tab width, so with the indent a wrapped
//    indented line can need one more line than the box was given (seen: box 131 pt, text 156 pt, the last line hidden). The module
//    emits the height of the text as drawn (onDrawnHeight, padding included); while the indent is on and a height has come, the
//    field sets its height from it (clampHeight, between its variant's minimum and maximum), which overrides React Native's
//    measure. With the indent off, or before a height came, the box is sized by React Native as before.
//  - A new tag is a new native view (the TextInput was made anew): what was applied to the old one no longer counts.
// The web box draws its own indent (ChipInput.web.tsx); it does not use this. A build without the module (made before it existed:
// `hangOver(null)`) behaves as before: no call, no height, continuation lines at the left edge.
import type { AiwbIndentModule, Subscription } from "../../../modules/aiwb-indent/src/AiwbIndent.ts";

/** What the field tells its controller: its TextInput's tag at each onLayout (null when there is none), and the width it wants
 *  (`tabWidth` 2, 4 or 8; 0 = no indent). After `dispose` nothing it is told does anything. */
export type Hang = {
  layout(tag: number | null): void;
  width(tabWidth: number): void;
  dispose(): void;
};

/** The controllers over `module` (null: none, every method does nothing). Each one is made with `onHeight`: the box's height as
 *  drawn with the indent, or null when the box goes back to React Native's own size. */
export function hangOver(module: AiwbIndentModule | null): (onHeight: (h: number | null) => void) => Hang {
  return (onHeight) => {
    let tag: number | null = null;
    let wanted = 0;
    let applied: { tag: number; width: number } | null = null;
    let busy = false;
    let gone = false;
    let cleared: number | null = null; // the view dispose took the indent off
    let asking: { tag: number; width: number } | null = null; // the call in flight
    // A height that came for the view a call is putting the indent on, before the call answered: the module draws (and emits)
    // before its answer reaches JS, and may emit nothing more until the text changes, so it is given when the answer comes.
    let early: number | null = null;
    const sub: Subscription | null = module
      ? module.addListener("onDrawnHeight", (e) => {
        if (gone || wanted === 0) return;
        if (applied && applied.width > 0 && e.tag === applied.tag && !(asking && asking.tag === e.tag && asking.width !== applied.width)) onHeight(e.height);
        else if (asking && asking.width > 0 && e.tag === asking.tag) early = e.height;
      })
      : null;

    // One call in flight at a time; when it answers, again if what is wanted changed meanwhile. An answer of false applies
    // nothing: the next layout asks again (not at once, which would spin while the view is not there).
    const sync = (): void => {
      if (!module || gone || busy || tag === null) return;
      if (applied ? applied.tag === tag && applied.width === wanted : wanted === 0) return;
      const asked = { tag, width: wanted };
      busy = true;
      asking = asked;
      early = null;
      void module.setIndent(asked.tag, asked.width).then((found) => {
        busy = false;
        asking = null;
        const first = early;
        early = null;
        if (gone) {
          // (disposed while the call was on its way: an indent it put on a view is taken off again, unless dispose's own call
          // already went to that view after it)
          if (found && asked.width > 0 && cleared !== asked.tag) void module.setIndent(asked.tag, 0);
          return;
        }
        if (found) {
          applied = asked;
          if (asked.width === 0) onHeight(null);
          else if (first !== null && wanted > 0) onHeight(first);
          sync();
        }
      });
    };

    return {
      layout: (t) => {
        if (gone) return;
        if (t !== tag && applied && applied.tag !== t) applied = null;
        tag = t;
        sync();
      },
      width: (w) => {
        if (gone || w === wanted) return;
        wanted = w;
        if (w === 0) onHeight(null);
        sync();
      },
      dispose: () => {
        if (gone) return;
        gone = true;
        sub?.remove();
        if (module && applied && applied.width > 0) { cleared = applied.tag; void module.setIndent(applied.tag, 0); }
      },
    };
  };
}

/** The box's height from the drawn height `h`, kept between its variant's `min` and `max`. */
export const clampHeight = (h: number, min: number, max: number): number => Math.min(max, Math.max(min, h));
