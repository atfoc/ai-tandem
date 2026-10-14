// The one transport the page has, chosen once when the page starts (the app-as-client plan, A6): IPC when the
// window gave the page its functions, HTTP when the page was loaded over http (the test host, the mock), else none.
// Nothing outside this folder calls fetch, makes an EventSource or touches `window.aiwbApp`.
import type { Transport } from "./types.ts";
import { httpTransport } from "./http.ts";
import { ipcTransport } from "./ipc.ts";

export * from "./types.ts";

/** Which way this page has, by what it was loaded with: null when it has none (a file opened without the app). */
export function wayOf(w: { aiwbApp?: unknown; location?: { protocol: string } } | undefined = typeof window === "undefined" ? undefined : window): "ipc" | "http" | null {
  if (w?.aiwbApp) return "ipc";
  return w?.location?.protocol === "http:" ? "http" : null;
}

let chosen: Transport | null = null;

/** The page's transport. Throws when the page has no way (see wayOf): main.tsx shows its fixed screen then. */
export function transport(): Transport {
  if (chosen) return chosen;
  const way = wayOf();
  if (!way) throw new Error("AI Whiteboard runs in its app.");
  return (chosen = way === "ipc" ? ipcTransport() : httpTransport());
}

/** Tests: puts a transport in the place of the chosen one; null takes it away. */
export function useTransport(t: Transport | null) {
  chosen = t;
}

