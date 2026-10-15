// The local network port on web: a browser asks no such permission and has no settings page of the app to open.
import type { LocalNetwork } from "./localnetwork.types.ts";

export type { LocalNetwork, LocalNetworkState } from "./localnetwork.types.ts";

export const localNetwork: LocalNetwork = {
  state: async () => "unknown",
  canOpenSettings: false,
  openSettings: async () => {},
};
