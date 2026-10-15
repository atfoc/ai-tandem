import type { AiwbKeysModule } from "./AiwbKeys.ts";

// The web has the page's own keydown (platform/keys.web.ts): no native module.
const none: AiwbKeysModule | null = null;
export default none;
