// The kv port on the phone (AD-12): one MMKV instance, `aiwb.page`, synchronous. The keys are the page's own.
import { createMMKV } from "react-native-mmkv";

import type { Kv } from "./kv.types.ts";

export type { Kv } from "./kv.types.ts";

const mmkv = createMMKV({ id: "aiwb.page" });

export const kv: Kv = {
  get: (key) => mmkv.getString(key) ?? null,
  set: (key, value) => mmkv.set(key, value),
  remove: (key) => { mmkv.remove(key); },
  keys: () => mmkv.getAllKeys(),
};
