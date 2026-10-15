// The one transport the page has, chosen once when the page starts (the app-as-client plan, A6): IPC when the
// window gave the page its bridge (`window.aiwbTransport`, desktop/preload.js; AD-22), HTTP when the page was loaded over http
// (the test host, the mock), native in the phone's app (which sets its transport itself, with useTransport), else none.
// Nothing outside this folder calls fetch, makes an EventSource or touches `window.aiwbTransport`.
import type { Transport } from "./types.ts";
import { httpTransport } from "./http.ts";
import { desktopTransport, type DesktopBridge } from "./desktop.ts";

export * from "./types.ts";

/** Which way this page has, by what it was loaded with: null when it has none (a file opened without the app). */
export function wayOf(
  w: { aiwbTransport?: unknown; location?: { protocol: string } } | undefined = typeof window === "undefined" ? undefined : window,
  nav: { product?: string } | undefined = typeof navigator === "undefined" ? undefined : navigator,
): "ipc" | "http" | "native" | null {
  if (nav?.product === "ReactNative") return "native";
  if (w?.aiwbTransport) return "ipc";
  return w?.location?.protocol === "http:" ? "http" : null;
}

let chosen: Transport | null = null;

/** The page's transport. Throws when the page has no way (see wayOf): main.tsx shows its fixed screen then. */
export function transport(): Transport {
  if (chosen) return chosen;
  const way = wayOf();
  if (!way) throw new Error("AI Whiteboard runs in its app.");
  if (way === "native") throw new Error("the native app sets its transport with useTransport before it starts.");
  const w = window as { aiwbTransport?: DesktopBridge };
  return (chosen = way === "ipc" ? desktopTransport(w.aiwbTransport!) : httpTransport());
}

/** Tests: puts a transport in the place of the chosen one; null takes it away. */
export function useTransport(t: Transport | null) {
  chosen = t;
}

