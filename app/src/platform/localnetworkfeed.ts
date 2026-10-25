// The store's `localNetworkDenied` (goal 3.1.3, "Local network off"): iOS asks the person at the first connection to a device on the
// network, and a refusal keeps every server there unreachable. The feed reads the permission once at start and again each time the
// app comes back to the foreground (the person may have changed it in Settings). Apart from react-native so that a test can drive it
// with fakes; on every other target (the web build, Android) nothing is read and the field stays false.
import type { LocalNetwork } from "./localnetwork.types.ts";
import type { AppStatePort } from "./nativetransport.ts";

export type LocalNetworkFeed = {
  port: Pick<LocalNetwork, "state">;
  appState: AppStatePort;
  /** Whether this is iOS: the one platform where the permission can be refused. */
  ios: boolean;
  set(denied: boolean): void;
};

/** Starts the feed; answers the function that stops it. */
export function feedLocalNetwork({ port, appState, ios, set }: LocalNetworkFeed): () => void {
  if (!ios) return () => {};
  let latest = 0;
  const read = () => {
    const mine = ++latest; // a slow answer must not overwrite a newer one
    port.state().then((s) => { if (mine === latest) set(s === "denied"); }, () => {});
  };
  read();
  const sub = appState.addEventListener("change", (s) => { if (s === "active") read(); });
  return () => { latest++; sub.remove(); };
}
