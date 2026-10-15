// The font families (AD-74): the page's stacks on web; native has no CSS stack, so it takes the system font and its
// own monospace.
import { Platform } from "react-native";

import { fontMono, fontSans } from "./tokens.ts";

export const SANS = Platform.select<string | undefined>({ web: fontSans, default: undefined });
export const MONO = Platform.select<string>({ web: fontMono, ios: "Menlo", default: "monospace" });
