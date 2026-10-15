// Whether the pointer is over a view (AD-70, the hover actions of a row): a mouse hovers, a finger does not, and native has only
// touch, so this says false there. Unlike react-native-web's Pressable (whose hover ends when the pointer enters a Pressable inside
// it), the view stays hovered while the pointer is over its own children. Returns the ref to put on the view and the answer.
// useHovered.web.ts is the web's.
import type { RefCallback } from "react";

export function useHovered(): [RefCallback<any> | undefined, boolean] {
  return [undefined, false];
}
