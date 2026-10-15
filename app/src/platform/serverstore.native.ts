// The phone's Store (AD-13): secrets in the platform's secure storage (Keychain, Android Keystore), the rest of the
// list in MMKV. The logic is serverstorecore.ts; this gives it the real storages.
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";

import { createServerStore, type SecretVault } from "./serverstorecore.ts";

export type { ServerStoreDeps, SecretVault, StoreKv } from "./serverstorecore.ts";
export { createServerStore } from "./serverstorecore.ts";

const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** The secure storage as the Store uses it (the device test's probe, src/dev/StorageProbe.tsx, reads the same keys with the same options). */
export const secretVault: SecretVault = {
  get: (key) => SecureStore.getItem(key, OPTIONS),
  set: (key, value) => SecureStore.setItem(key, value, OPTIONS),
  delete: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};

/** The Store of the app, made on first use (the MMKV instance `aiwb.servers` is opened then). */
export function serverStore() {
  return createServerStore({ kv: createMMKV({ id: "aiwb.servers" }), vault: secretVault, randomUUID });
}
