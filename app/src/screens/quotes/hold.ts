// The long press that opens the Quote sheet (AD-64, goal 4.2): the chat view asks `useMessageHold` for the touch handlers of every message it
// draws. Plain touch events on the message's view, not a gesture: they bubble from whatever is inside (a link, a button) without taking the
// press from it, and the thread scrolls under the finger as before. A finger that moves more than a few points, lifts, or is joined by another
// cancels the hold. Where the platform's own selection quotes (the wide layouts of the web build) a message has none.
import { useRef } from "react";
import type { GestureResponderEvent } from "react-native";

import { quotable } from "@aiwb/core/logic/quotes.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import type { MessageHold } from "../chat/parts.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { useSheetPath } from "./path.ts";
import { holdEnded, openPick } from "./sheetstore.ts";

/** How long a finger stays before the sheet opens (ms), and how far it may wander (points). */
export const HOLD_AFTER = 500, HOLD_SLOP = 10;

const NONE: MessageHold = { props: {} };
/** No selection starts under the finger (the sheet is how a message's words are selected), and no callout of the browser opens. */
const NO_SELECT = webStyle({ userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" });

/** Whether a long press on this item can open the sheet: a message of the user's or the agent's (a reply still being written opens it to say wait). */
export const holdable = (item: Pick<Item, "kind" | "done">): boolean => quotable(item) !== undefined;

/** Where the first finger is (the browser's touch event has its points in `touches`, as React Native's does). */
const pointOf = (e: GestureResponderEvent) => {
  const n = e.nativeEvent, p = n.touches?.[0] ?? n;
  return { x: p.pageX, y: p.pageY };
};

export function useMessageHold(chat: ChatView, index: number | undefined, item: Item): MessageHold {
  const sheet = useSheetPath();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const handlers = useRef<MessageHold>(NONE);
  const target = useRef({ chat: chat.id, index });
  target.current = { chat: chat.id, index };
  if (!handlers.current.props.onTouchStart) {
    const stop = () => { clearTimeout(timer.current); timer.current = undefined; };
    handlers.current = {
      props: {
        onTouchStart: (e: GestureResponderEvent) => {
          stop();
          const n = e.nativeEvent;
          if ((n.touches?.length ?? 1) > 1) return;
          from.current = pointOf(e);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            const { chat: c, index: i } = target.current;
            if (i !== undefined) openPick(c, i);
          }, HOLD_AFTER);
        },
        onTouchMove: (e: GestureResponderEvent) => {
          if (!timer.current) return;
          const p = pointOf(e);
          if (Math.abs(p.x - from.current.x) > HOLD_SLOP || Math.abs(p.y - from.current.y) > HOLD_SLOP) stop();
        },
        onTouchEnd: () => { stop(); holdEnded(); },
        onTouchCancel: () => { stop(); holdEnded(); },
      },
      style: NO_SELECT,
    };
  }
  return sheet && index !== undefined && holdable(item) ? handlers.current : NONE;
}
