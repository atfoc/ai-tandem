// The keys port on web (AD-73): `window.addEventListener("keydown", …, true)` as the page does today, so the capture order
// of today's handlers is kept. The handler gets the KeyboardEvent itself.
import type { OnKey } from "./keys.types.ts";

export type { KeyHandler, KeyLike, OnKey } from "./keys.types.ts";

export const onKey: OnKey = (handler) => {
  const listener = (e: KeyboardEvent) => handler(e);
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
};
