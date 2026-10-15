// The local network port on a device: the module's `localNetwork()` (iOS reads the permission; Android answers "granted") and the system settings.
import { Linking } from "react-native";

import AiwbNetModule from "../../modules/aiwb-net/src/AiwbNetModule.ts";
import type { LocalNetwork } from "./localnetwork.types.ts";

export type { LocalNetwork, LocalNetworkState } from "./localnetwork.types.ts";

export const localNetwork: LocalNetwork = {
  state: () => AiwbNetModule.localNetwork().catch(() => "unknown" as const),
  canOpenSettings: true,
  openSettings: () => Linking.openSettings(),
};
