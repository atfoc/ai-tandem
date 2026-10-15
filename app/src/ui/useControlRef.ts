// What the web gives a control that react-native-web does not forward: the tooltip (its `title`, which the browser shows
// on hover) and the focus when it appears (`autoFocus`). Native has neither (touch has no hover, and a screen reader
// reads the control's accessibilityLabel everywhere), so this does nothing there. useControlRef.web.ts is the web's.
import type { RefCallback } from "react";

export function useControlRef(_title: string | undefined, _autoFocus?: boolean, _keepFocus?: boolean, _ariaDisabled?: boolean): RefCallback<any> | undefined {
  return undefined;
}
