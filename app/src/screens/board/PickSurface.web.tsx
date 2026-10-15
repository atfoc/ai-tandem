// The pick surface on web: the pointer events of the box's DOM element, in the capture phase and left alone (the board below hears them
// as before: the wheel, a drag, a pinch). A tap is what `taps.ts` says it is; a press on the layer's own hint is none.
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { PICK_UI, type PickSurfaceProps } from "./PickSurface.types.ts";
import { tapWatch, type Spot } from "./taps.ts";

const CLASS = "aiwb-picking";
let sheet: HTMLStyleElement | null = null;

/** The crosshair over the board while a point is waited for: Excalidraw sets the cursor of its canvas itself, so the rule is stronger. */
function crosshair(): void {
  if (sheet?.isConnected) return;
  sheet = document.createElement("style");
  sheet.textContent = `.${CLASS}, .${CLASS} canvas, .${CLASS} .excalidraw { cursor: crosshair !important; }`;
  document.head.append(sheet);
}

export function PickSurface({ on, onTap, onHover, children }: PickSurfaceProps) {
  const box = useRef<View>(null);
  const latest = useRef({ onTap, onHover });
  latest.current = { onTap, onHover };

  useEffect(() => {
    const el = box.current as unknown as HTMLElement | null; // (on web a View's ref is the DOM element it draws)
    if (!on || !el) return;
    crosshair();
    el.classList.add(CLASS);
    const watch = tapWatch();
    const own = (e: Event) => e.target instanceof Element && !!e.target.closest(`[data-${PICK_UI}]`);
    const at = (e: PointerEvent): Spot => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e: PointerEvent) => { if (own(e) || (e.pointerType === "mouse" && e.button !== 0)) return; watch.down(e.pointerId, at(e)); };
    const move = (e: PointerEvent) => {
      if (own(e)) return;
      watch.move(e.pointerId, at(e));
      if (e.pointerType !== "touch") latest.current.onHover?.(at(e));
    };
    const up = (e: PointerEvent) => { const tap = watch.up(e.pointerId, at(e)); if (tap && !own(e)) latest.current.onTap(tap); };
    const cancel = (e: PointerEvent) => watch.cancel(e.pointerId);
    const leave = () => latest.current.onHover?.(null);
    const on_ = { capture: true } as const;
    el.addEventListener("pointerdown", down, on_);
    el.addEventListener("pointermove", move, on_);
    el.addEventListener("pointerup", up, on_);
    el.addEventListener("pointercancel", cancel, on_);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerdown", down, on_);
      el.removeEventListener("pointermove", move, on_);
      el.removeEventListener("pointerup", up, on_);
      el.removeEventListener("pointercancel", cancel, on_);
      el.removeEventListener("pointerleave", leave);
      el.classList.remove(CLASS);
      latest.current.onHover?.(null);
    };
  }, [on]);

  return <View ref={box} style={styles.fill}>{children}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
