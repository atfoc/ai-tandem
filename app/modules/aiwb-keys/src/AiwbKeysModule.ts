import { requireOptionalNativeModule } from "expo";

import type { AiwbKeysModule } from "./AiwbKeys.ts";

// The native module (ios/AiwbKeysModule.swift, android/.../AiwbKeysModule.kt). Its contract is AiwbKeys.ts. Null in a build that was
// made before the module existed: the keys port then takes no key, as it did before the module.
export default requireOptionalNativeModule<AiwbKeysModule>("AiwbKeys");
