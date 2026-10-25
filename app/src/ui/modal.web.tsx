// The `Modal` of the overlays on web, with the overlays' own focus rule instead of react-native-web's. Its `Modal` wraps what it draws in a focus trap
// (ModalFocusTrap) that does two things which broke the screens: while it is mounted, a `focus` listener pulls any focus that lands outside the modal back
// into it (so a field that took the focus in the very turn the overlay was asked to close lost it again); and when it unmounts it focuses the element that
// had the focus when the overlay opened, whatever has the focus by then (so a field or a row that took it as the overlay closed lost it to the menu's
// trigger). The screens had timers and microtasks to get around both. This file is the rule the old page's popups kept (the old page's source), and the one place it lives:
//
//   - an overlay that opens takes the focus: what the screen autofocuses inside it, else its first focusable. At the phone layout (read when it
//     opens) the focus goes to the overlay's own root instead (`tabIndex={-1}`, no outline), never to its first row: Chromium draws a ring on a
//     script's focus when nothing, or a control the keyboard focused, had the focus before, and the phone never draws one (goal 3.1.3). A screen
//     reader and Esc still land in the overlay, and Tab from the root goes to the first control;
//   - Tab and Shift+Tab cycle inside the top overlay only, never through the dimmed page (the keys are the only thing that moves the focus here: nothing
//     listens to `focus`, so nothing pulls a focus that a screen gave to an element outside);
//   - when it closes, the focus goes back to the control that had it when the overlay opened, only if the focus is still inside the overlay or nowhere
//     (`document.body`) at that moment. A screen that already focused something else (a field that opens as a menu closes) keeps that focus. The cleanup
//     runs in the commit that removes the overlay, before the layout phase in which the new field mounts and takes its focus, so a field that mounts in
//     that commit wins over the restore, and one that took it earlier is outside the overlay, so it is left alone. The control to go back to is the one that had the
//     focus when the overlay opened; if that is gone by then (it was in an overlay that closed first, like a menu's entry under the question it asked) it is the control
//     that opened that overlay, and if that is gone too (a chip drawn anew while its list was open) it is the popover's anchor (`returnTo`).
//
// The rest is what react-native-web's `Modal` is, minus the animation (the overlays use `animationType="none"`): a portal into a `div` of `document.body`,
// a fixed layer at z-index 9999 with `aria-modal` and the role `dialog`. Overlays over overlays (overlayhost.tsx) are separate portals; the one that mounted
// last is the top one. The native `Modal` is untouched (modal.tsx); Esc is useOverlayClose.web.ts's.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StyleSheet, View } from "react-native";

import { layoutOf } from "./breakpoints.ts";
import type { OverlayModalProps } from "./modal.types.ts";
import { webStyle } from "./webstyle.ts";

/** The roots of the modals that are open, in the order they opened: the last is the top one. */
const open: HTMLElement[] = [];

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const tabbables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0);
const nowhere = (a: Element | null) => !a || a === document.body;

/** What had the focus when each open overlay opened, by its root: when the control is gone by the time the overlay closes, because it was in an overlay that
 *  closed first (a confirm dialog over a menu, closed together with it), the control that opened that one is what it means. */
const openers = new WeakMap<Element, Element | null>();
function controlOf(opener: Element | null): HTMLElement | null {
  for (let i = 0; opener && i < 8; i++) {
    if (opener.isConnected) return opener instanceof HTMLElement ? opener : null;
    const gone = opener.closest('[aria-modal="true"]');
    opener = gone ? openers.get(gone) ?? null : null;
  }
  return null;
}

/** The control a popover hangs from, or the first one inside it (the anchor is often a wrapper of the button). */
function focusableIn(node: unknown): HTMLElement | null {
  if (!(node instanceof HTMLElement) || !node.isConnected) return null;
  return node.tabIndex >= 0 ? node : tabbables(node)[0] ?? null;
}

/** Tab inside the top overlay: from its last control to its first, and back, and from outside it in. Where the browser would go on inside it, it does. */
function onTab(e: KeyboardEvent) {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  const root = open[open.length - 1];
  if (!root) return;
  const els = tabbables(root);
  const at = document.activeElement, out = !at || !root.contains(at);
  const edge = e.shiftKey ? els[0] : els[els.length - 1];
  if (els.length && !out && at !== edge && at !== root) return; // (from the root itself, Shift+Tab goes to the last control, not out of the overlay)
  e.preventDefault();
  e.stopPropagation();
  (e.shiftKey ? els[els.length - 1] : els[0])?.focus({ preventScroll: true });
}

export function Modal({ visible = true, children, ...rest }: OverlayModalProps) {
  return visible ? <Layer {...rest}>{children}</Layer> : null;
}

function Layer({ children, returnTo, ...rest }: Omit<OverlayModalProps, "visible">) {
  // What had the focus when it opened, noted before anything inside it mounts (and so before a screen's autofocus). The container is in the document
  // before the children mount: a field cannot take the focus in a detached node.
  const [opener] = useState(() => (nowhere(document.activeElement) ? null : document.activeElement));
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) {
    host.current = document.createElement("div");
    document.body.appendChild(host.current);
  }
  const root = useRef<HTMLElement | null>(null);
  const [phone] = useState(() => layoutOf(window.innerWidth) === "phone");
  useLayoutEffect(() => {
    const layer = root.current, container = host.current!;
    if (layer) {
      open.push(layer);
      openers.set(layer, opener);
      if (open.length === 1) window.addEventListener("keydown", onTab, true);
      if (!layer.contains(document.activeElement)) (phone ? layer : tabbables(layer)[0])?.focus({ preventScroll: true });
    }
    return () => {
      const at = document.activeElement;
      if (layer) {
        const i = open.indexOf(layer);
        if (i >= 0) open.splice(i, 1);
        if (!open.length) window.removeEventListener("keydown", onTab, true);
        if (nowhere(at) || layer.contains(at)) {
          const to = controlOf(opener) ?? focusableIn(returnTo?.current);
          if (to && !layer.contains(to)) to.focus({ preventScroll: true });
          else if (open.length) { // (the control is gone: the overlay under this one has the focus; at the phone its root, as when it opened)
            const under = open[open.length - 1]!;
            (phone ? under : tabbables(under)[0])?.focus({ preventScroll: true });
          }
        }
      }
      container.remove();
      host.current = null;
    };
  }, [opener, phone]);
  return createPortal(
    <View {...rest} ref={root as never} aria-modal role="dialog" tabIndex={phone ? -1 : undefined}
      style={[styles.layer, webStyle({ position: "fixed", zIndex: 9999, ...(phone ? { outlineStyle: "none" } : {}) })]}>
      <View style={styles.container}>{children}</View>
    </View>,
    host.current,
  );
}

const styles = StyleSheet.create({
  layer: { top: 0, right: 0, bottom: 0, left: 0 },
  container: { flex: 1 },
});
