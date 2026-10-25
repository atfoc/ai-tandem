// The clipboard port on a device: expo-clipboard.
import { getStringAsync, setStringAsync } from "expo-clipboard";

import type { CopyText, PeekText, ReadText } from "./clipboard.types.ts";

export type { CopyText, PeekText, ReadText } from "./clipboard.types.ts";

export const copyText: CopyText = async (text) => {
  if (!(await setStringAsync(text))) throw new Error("the clipboard refused the text");
};

/** Never reads: iOS shows its "pasted from" prompt on every read, so the clipboard is read only on a press (`readText`). */
export const peekText: PeekText = async () => null;

export const readText: ReadText = () => getStringAsync();
