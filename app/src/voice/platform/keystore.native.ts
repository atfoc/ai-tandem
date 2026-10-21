// The key on a phone: the platform's secure storage (Keychain; the Android Keystore), with the options of the server secrets' vault
// (`secretVault` in platform/serverstore.native.ts): after the first unlock, this device only, so it is in no backup or transfer.
import * as SecureStore from "expo-secure-store";

import type { Keystore } from "../ports.ts";
import { createKeystore } from "./keystore.core.ts";

const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const keystore: Keystore = createKeystore({
  get: (name) => SecureStore.getItemAsync(name, OPTIONS),
  set: (name, value) => SecureStore.setItemAsync(name, value, OPTIONS),
  delete: (name) => SecureStore.deleteItemAsync(name, OPTIONS),
});
