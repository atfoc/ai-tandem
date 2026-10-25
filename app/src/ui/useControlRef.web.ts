// The `title` attribute of the element a control draws, its focus on appearing, and (keepFocus) that a press on it leaves the focus
// where it is, and `aria-disabled` (ariaDisabled: for a control that stays focusable): react-native-web forwards none of them, so the element it gives as a ref is marked here. Returns the ref to put on
// the control. At the phone layout there is no `title`: a phone has no hover, and what a hover title said is the control's label (ux-improvements
// goal 3.1.3); the wide layouts keep theirs.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefCallback } from "react";

import { usePhone } from "./useLayout.ts";

function mark(el: HTMLElement | null, text: string | undefined) {
  if (!el?.setAttribute) return;
  if (text) el.setAttribute("title", text); else el.removeAttribute("title");
}

/** `aria-disabled` without the element's own `disabled`: react-native-web turns a Pressable's `disabled` into the button's, which takes no focus; a chip that
 *  opens nothing while a change is saved keeps the focus a pick gave it. */
function markDisabled(el: HTMLElement | null, on: boolean | undefined) {
  if (!el?.setAttribute) return;
  if (on) el.setAttribute("aria-disabled", "true"); else if (on === false) el.removeAttribute("aria-disabled");
}

const keep = (e: Event) => e.preventDefault();

export function useControlRef(tooltip: string | undefined, autoFocus?: boolean, keepFocus?: boolean, ariaDisabled?: boolean): RefCallback<any> | undefined {
  const title = usePhone() ? undefined : tooltip;
  const node = useRef<HTMLElement | null>(null);
  const at = useRef({ title, autoFocus, ariaDisabled });
  at.current = { title, autoFocus, ariaDisabled };
  const ref = useCallback((el: HTMLElement | null) => {
    if (node.current && node.current !== el) node.current.removeEventListener("mousedown", keep);
    node.current = el;
    // (the press leaves the focus where it is: a rename box that lost it to the control would save its text before the click)
    if (el && keepFocus) el.addEventListener("mousedown", keep);
    mark(el, at.current.title);
    markDisabled(el, at.current.ariaDisabled);
    if (el && at.current.autoFocus) el.focus?.({ preventScroll: true });
  }, [keepFocus]);
  // (in the commit that changes them, not after it: a read of the page between the two would see the old tooltip or the old `aria-disabled`)
  useLayoutEffect(() => mark(node.current, title), [title]);
  useLayoutEffect(() => markDisabled(node.current, ariaDisabled), [ariaDisabled]);
  return ref;
}
