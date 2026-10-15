// A View that tells its width as it changes (the toolbar's row and its controls, AD-62), on web: a ResizeObserver on the element, which reports
// after the frame's layout and before its paint, with the border box's width as a fraction (react-native-web's onLayout reports the integer
// offsetWidth a task later, after the frame is painted). The report is applied at once (flushSync), so the toolbar is fitted to its row in the
// frame that shows the row, as the page's was. The width is of the border box.
import { useCallback, useRef, type RefCallback } from "react";
import { View, type ViewProps } from "react-native";
import { flushSync } from "react-dom";

export type SizedProps = ViewProps & { onWidth(width: number): void };

export function Sized({ onWidth, ...props }: SizedProps) {
  const now = useRef(onWidth);
  now.current = onWidth;
  const off = useRef<(() => void) | null>(null);
  const ref: RefCallback<View> = useCallback((el) => {
    off.current?.();
    off.current = null;
    const node = el as unknown as HTMLElement | null;
    if (!node?.getBoundingClientRect) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      const width = e.borderBoxSize?.[0]?.inlineSize ?? e.target.getBoundingClientRect().width;
      flushSync(() => now.current(width));
    });
    ro.observe(node);
    off.current = () => ro.disconnect();
  }, []);
  return <View ref={ref} {...props} />;
}
