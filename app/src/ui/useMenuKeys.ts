// The arrow keys of a menu on web (the focus moves between its items); touch and Android's screen readers have their own
// ways, so native does nothing here. useMenuKeys.web.ts is the web's. Returns the ref to put on the menu.
import type { RefCallback } from "react";

export function useMenuKeys(): RefCallback<any> | undefined {
  return undefined;
}
