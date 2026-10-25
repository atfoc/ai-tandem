// ArrowDown and ArrowUp move the focus to the next and the previous item of the menu (they wrap), Home and End to the
// first and the last; an item that is disabled is passed over. The menu's items are the elements with a role that starts
// with "menuitem" and the sliders (role "slider": the Subagents popover's "Running at once"), so the arrows reach them from the rows and
// leave them again; a slider keeps ←, →, Home, End, Page Up and Page Down for itself and, with verticalKeys off, leaves ↑ and ↓ to the menu.
import { useCallback, useRef, type RefCallback } from "react";

const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"]), [role="slider"]:not([aria-disabled="true"])';

export function useMenuKeys(): RefCallback<any> | undefined {
  const off = useRef<(() => void) | null>(null);
  return useCallback((menu: HTMLElement | null) => {
    off.current?.();
    off.current = null;
    if (!menu?.addEventListener) return;
    const key = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const to = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
      if (!to) return;
      const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = to === "first" ? 0 : to === "last" ? items.length - 1 : at < 0 ? (to === 1 ? 0 : items.length - 1) : (at + to + items.length) % items.length;
      items[next]?.focus();
    };
    menu.addEventListener("keydown", key);
    off.current = () => menu.removeEventListener("keydown", key);
  }, []);
}
