// The clipboard port on web: the browser's async clipboard.
import type { CopyText, PeekText, ReadText } from "./clipboard.types.ts";

export type { CopyText, PeekText, ReadText } from "./clipboard.types.ts";

export const copyText: CopyText = async (text) => {
  if (!navigator.clipboard) throw new Error("no clipboard");
  await navigator.clipboard.writeText(text);
};

export const readText: ReadText = async () => {
  if (!navigator.clipboard?.readText) throw new Error("no clipboard");
  return navigator.clipboard.readText();
};

/** Reads only when the browser already granted `clipboard-read`: asking would put a prompt on the person's screen unasked. */
export const peekText: PeekText = async () => {
  try {
    const p = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    return p?.state === "granted" ? await readText() : null;
  } catch {
    return null;
  }
};
