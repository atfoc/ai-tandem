// The transport of the web build (AD-20, revised after package C3). Core's purity scan forbids `window.` in @aiwb/core, so
// `desktopTransport(bridge)` has no default bridge, and this is the place that reads the window: the way the page was loaded with
// decides the transport, once, at start.
//   ipc   the window of the desktop app gave the page `window.aiwbTransport`: desktopTransport(that)
//   http  the page was loaded over http (the test host, the mock): httpTransport()
//   none  a file opened without the app: no transport, the page says so
import { desktopTransport, type DesktopBridge } from "@aiwb/core/transport/desktop.ts";
import { httpTransport } from "@aiwb/core/transport/http.ts";
import { useTransport, wayOf, type Transport } from "@aiwb/core/transport/index.ts";

/** What the choice reads of the window (a fake window in the test). */
export type WebWindow = { aiwbTransport?: DesktopBridge; location?: { protocol: string } };

/** The transport the way of `w` gives, or null when the page has none. */
export function chooseTransport(
  w: WebWindow | undefined = typeof window === "undefined" ? undefined : (window as WebWindow),
  nav: { product?: string } | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Transport | null {
  switch (wayOf(w, nav)) {
    case "ipc": return w?.aiwbTransport ? desktopTransport(w.aiwbTransport) : null;
    case "http": return httpTransport();
    default: return null;
  }
}

/** Chooses and sets the app's transport (`useTransport`); false when the page has none. */
export function setUpTransport(): boolean {
  const t = chooseTransport();
  if (!t) return false;
  useTransport(t);
  return true;
}
