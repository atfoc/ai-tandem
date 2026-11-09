import { requireOptionalNativeModule } from "expo";

import type { AiwbIndentModule } from "./AiwbIndent.ts";

// The native module (ios/AiwbIndentModule.swift, android/.../AiwbIndentModule.kt). Its contract is AiwbIndent.ts. Null in a build that
// was made before the module existed: the box then wraps as React Native draws it (continuation lines at the left edge).
export default requireOptionalNativeModule<AiwbIndentModule>("AiwbIndent");
