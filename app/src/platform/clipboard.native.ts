// The clipboard port on a device: expo-clipboard.
import { setStringAsync } from "expo-clipboard";

import type { CopyText } from "./clipboard.types.ts";

export type { CopyText } from "./clipboard.types.ts";

export const copyText: CopyText = async (text) => {
  if (!(await setStringAsync(text))) throw new Error("the clipboard refused the text");
};
