// The clipboard port on web: the browser's async clipboard.
import type { CopyText } from "./clipboard.types.ts";

export type { CopyText } from "./clipboard.types.ts";

export const copyText: CopyText = async (text) => {
  if (!navigator.clipboard) throw new Error("no clipboard");
  await navigator.clipboard.writeText(text);
};
