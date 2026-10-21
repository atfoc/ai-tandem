// Hold Space for the pill (VC-28, goal 3.6): the keys port reports Space going down, `holdkeys` its release; `hold.ts` decides what each means for the
// session and this hook does it. It listens only while the board is the screen (the board on screen, and on the phone's stack the board's screen
// in front), and only where the focus leaves Space to the page (`spaceFocus`: not in a text box, not on a button that a Space presses).
import { NavigationContext } from "@react-navigation/native";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { onKey } from "../../../platform/keys";
import type { KeyLike } from "../../../platform/keys.types.ts";
import { useStore } from "../../../state/useStore.ts";
import type { Phase } from "../../../voice/index.ts";
import { onSpaceRelease, spaceFocus, type SpaceFocus } from "./holdkeys";
import { NO_HOLD, settle, spaceDown, spaceUp, wakeAt, type Hold, type HoldAct, type HoldStep } from "./hold.ts";

/** Whether the board's screen is the one in front: on the phone the stack keeps it mounted beneath a chat. */
function useScreenIsFront(board: string): boolean {
  const nav = useContext(NavigationContext); // (none on the wide layouts: the board is closed by the shell, which unmounts the pill)
  const [front, setFront] = useState(() => nav?.isFocused() ?? true);
  useEffect(() => {
    if (!nav) return;
    setFront(nav.isFocused());
    const offs = [nav.addListener("focus", () => setFront(true)), nav.addListener("blur", () => setFront(false))];
    return () => { for (const off of offs) off(); };
  }, [nav]);
  const shown = useStore((s) => s.sel.board === board);
  return front && shown;
}

/** `act` is what the orb, the ↑ badge and Cancel do. Answers whether Space is held now (for the pill's data and its look). */
export function useHoldSpace(board: string, session: { phase: Phase; words: boolean }, act: Record<HoldAct, () => void>): boolean {
  const usable = useScreenIsFront(board);
  const seen = useRef(session);
  seen.current = session;
  const acts = useRef(act);
  acts.current = act;
  const hold = useRef<Hold>(NO_HOLD);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taken = useRef<SpaceFocus>(null); // (how the key down was taken: its release is the pill's too, and when it was `take`n no one else hears either)
  const [held, setHeld] = useState(false);

  const arm = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    const at = wakeAt(hold.current);
    if (at !== null) timer.current = setTimeout(() => { timer.current = null; run(settle(hold.current, seen.current, Date.now())); }, Math.max(0, at - Date.now()));
  }, []);
  const run = useCallback((r: HoldStep) => {
    hold.current = r.hold;
    setHeld(r.hold.kind === "down");
    if (r.act) acts.current[r.act]();
    arm();
  }, [arm]);

  // The session moved on (listening began, a pause ran out, words came): a hold that waits for it goes on.
  useEffect(() => {
    if (hold.current.kind !== "off") run(settle(hold.current, session, Date.now()));
  }, [session.phase, session.words]);

  useEffect(() => {
    if (!usable) return;
    const down = (e: KeyLike) => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const where = spaceFocus();
      if (!where) return;
      if (where === "take") { e.preventDefault(); e.stopPropagation(); }
      if (e.repeat) return;
      taken.current = where;
      run(spaceDown(hold.current, seen.current, Date.now()));
    };
    const up = (e: { preventDefault(): void; stopPropagation(): void }) => {
      const how = taken.current;
      if (!how) return;
      taken.current = null;
      if (how === "take") { e.preventDefault(); e.stopPropagation(); }
      run(spaceUp(hold.current, seen.current, Date.now()));
    };
    // The window lost the focus with Space down: the release will not be heard. The hold is let go as a tap that was long: the session listens on as
    // one the orb started, and nothing is sent.
    const lost = () => { taken.current = null; if (hold.current.kind === "down") run({ hold: NO_HOLD, act: null }); };
    const offs = [onKey(down), onSpaceRelease(up, lost)];
    return () => {
      for (const off of offs) off();
      hold.current = NO_HOLD;
      taken.current = null;
      setHeld(false);
      arm();
    };
  }, [usable, run, arm]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return held;
}
