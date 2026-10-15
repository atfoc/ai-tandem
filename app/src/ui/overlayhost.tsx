// Overlays that open over another overlay (a menu or a confirm dialog over a sheet, a dialog over a menu, a sheet over a sheet).
// Every overlay is an RN `Modal`, and on iOS a `Modal` mounted beside an open one cannot be presented: the system presents it from the
// view controller that is already presenting, and nothing shows. A `Modal` inside the open one's own tree is presented from it, so it
// shows. An overlay therefore draws itself inside the topmost open overlay (`OverlayHost`, which every overlay draws inside its
// `Modal`) whenever one is open when it opens: `InTopOverlay` wraps the overlay's `Modal` and puts it there. No screen has to know:
// a screen declares its popup where it likes (at the root of the shell, like the confirm dialog, or inside a sheet's own content).
// Only the overlay's `Modal` and what is inside it are drawn through the host (a portal): the overlay's own hooks stay where it is
// declared, and the React contexts its content sees are the host's, which are the same above both: the overlay primitives and the app's providers.
import { Fragment, useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";

type Item = { key: string; host: string; node: ReactNode };
type Snapshot = { hosts: readonly string[]; items: readonly Item[] };

let snap: Snapshot = { hosts: [], items: [] };
const listeners = new Set<() => void>();
const set = (next: Snapshot) => { snap = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

const useHosts = () => useSyncExternalStore(subscribe, () => snap.hosts, () => snap.hosts);
const useItems = () => useSyncExternalStore(subscribe, () => snap.items, () => snap.items);

/** Drawn inside the `Modal` of every overlay, after its content: registers as a place an overlay can draw itself, and draws those that chose it. */
export function OverlayHost() {
  const id = useId();
  useEffect(() => {
    set({ ...snap, hosts: [...snap.hosts, id] });
    return () => set({ hosts: snap.hosts.filter((h) => h !== id), items: snap.items.filter((i) => i.host !== id) });
  }, [id]);
  const items = useItems();
  return <>{items.filter((i) => i.host === id).map((i) => <Fragment key={i.key}>{i.node}</Fragment>)}</>;
}

/** The `Modal` of an overlay, wrapped: drawn in place while no other overlay is open when it opens, else inside the topmost one. */
export function InTopOverlay({ open, children }: { open: boolean; children: ReactNode }) {
  const key = useId();
  const hosts = useHosts(); // not the items: this overlay writes those on every render, and must not render again for them
  // The host is chosen when the overlay opens, and kept while it is open; if that overlay closes first, this one is drawn in place.
  const chosen = useRef<string | null>(null);
  if (!open) chosen.current = null;
  else if (chosen.current === null) chosen.current = hosts.length ? hosts[hosts.length - 1]! : "";
  const host = open && chosen.current && hosts.includes(chosen.current) ? chosen.current : null;
  useEffect(() => {
    if (!host) return;
    set({ ...snap, items: [...snap.items.filter((i) => i.key !== key), { key, host, node: children }] });
  });
  useEffect(() => {
    if (!host) return;
    return () => set({ ...snap, items: snap.items.filter((i) => i.key !== key) });
  }, [host, key]);
  return host ? null : <>{children}</>;
}
