// Browser-only text styles of the cards (the platform's own wrapping rule and selection): react-native-web draws them, native leaves them out.
import type { TextStyle } from "react-native";

import { webStyle } from "../../ui/webstyle.ts";

const text = (s: Record<string, string | number>) => webStyle(s) as TextStyle | undefined;

/** A name or a line with nowhere to break is cut where the box ends: nothing of a card is wider than its thread (B-TC-31). */
export const wrap = text({ overflowWrap: "anywhere" });
/** The sign of a change and the controls of a card are not part of what is selected and copied (B-TC-15). */
export const noSelect = text({ userSelect: "none" });
export const tabs = text({ overflowWrap: "anywhere", tabSize: 4 });
/** A line of code on one line: its leading blanks kept (the browser's `nowrap` of a one-line text folds them), cut where the box ends. */
export const pre = text({ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" });
