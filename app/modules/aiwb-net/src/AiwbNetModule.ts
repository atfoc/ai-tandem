import { requireNativeModule } from "expo";
import { Platform } from "react-native";

import type { AiwbNetModule, FetchArgs } from "./AiwbNet.ts";

// The native module (ios/AiwbNetModule.swift, android/.../AiwbNetModule.kt). Its contract is AiwbNet.ts.
const native = requireNativeModule<AiwbNetModule>("AiwbNet");

// Android: Expo's bridge cannot carry a Uint8Array inside an options object (it arrives as a map and the Kotlin
// record refuses it), only as an argument of its own. The Kotlin `fetch` takes the body as its second argument; the
// contract, and everything above this file, still has it in the options.
function androidFetch(o: FetchArgs) {
  const { body, ...rest } = o;
  return (native as unknown as { fetch(o: Omit<FetchArgs, "body">, body: Uint8Array | null): ReturnType<AiwbNetModule["fetch"]> }).fetch(rest, body);
}

const module: AiwbNetModule = Platform.OS === "android"
  ? new Proxy(native, {
    get(target, key) {
      if (key === "fetch") return androidFetch;
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  })
  : native;

export default module;
