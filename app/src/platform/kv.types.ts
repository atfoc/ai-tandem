// The kv port (AD-12): the page's small saved choices (`aiwb.theme`, `aiwb.widths`, …) as synchronous string storage.
// kv.native.ts and kv.web.ts each export a `kv` of this type; the app gives it to `setKv` before the store is read.
export type { Kv } from "@aiwb/core/state/ports.ts";
