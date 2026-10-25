// The one primitive every popup of a screen uses (AD-70): it takes the form the layout asks for (AD-72). On the phone
// layout every popup is a bottom Sheet; on tablet and desktop a menu-like popup (`kind="popover"`) is a Popover hung
// from its anchor and a dialog-like one (`kind="dialog"`) is a Dialog in the middle. The words, items, order and keys
// inside are the same component either way. A place-like one (`kind="screen"`: Servers, the library, Settings' pages) is a
// pushed screen of the phone's stack and a Dialog on the wide layouts (ux-improvements goal 4.3, board rule 6; package F2).
import type { ReactNode, RefObject } from "react";
import type { View } from "react-native";

import { Dialog } from "./Dialog.tsx";
import { Popover } from "./Popover.tsx";
import { PushedScreen } from "./pushedscreen.tsx";
import { Sheet } from "./Sheet.tsx";
import { useLayout } from "./useLayout.ts";

export type OverlayProps = {
  open: boolean;
  onClose(): void;
  /** Its name, for a screen reader. */
  label: string;
  /** What it is on the wide layouts: a popover (menus, the "+" menus, the insert popup, the theme menu, the usage popup)
   *  or a dialog (Servers, the library, the confirm dialog, the tree popup). */
  kind: "popover" | "dialog" | "screen";
  /** A pushed screen's title in its bar (kind "screen"); `label` when absent. */
  title?: string;
  /** The control a popover hangs from (needed for kind "popover"; a sheet and a dialog ignore it). */
  anchor?: RefObject<View | null>;
  align?: "left" | "right";
  up?: boolean;
  /** A dialog's width on the wide layouts. */
  width?: number;
  testID?: string;
  /** A press on the dimmed page closes a dialog or a sheet (default); false for one that holds a form. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
};

export function Overlay({ kind, anchor, align, up, width, closeOnBackdrop, title, children, ...common }: OverlayProps) {
  const layout = useLayout();
  if (layout === "phone" && kind === "screen") return <PushedScreen {...common} title={title ?? common.label}>{children}</PushedScreen>;
  if (kind === "screen") return <Dialog {...common} width={width} closeOnBackdrop={closeOnBackdrop}>{children}</Dialog>;
  if (layout === "phone") return <Sheet {...common} closeOnBackdrop={closeOnBackdrop}>{children}</Sheet>;
  if (kind === "dialog") return <Dialog {...common} width={width} closeOnBackdrop={closeOnBackdrop}>{children}</Dialog>;
  if (!anchor) throw new Error('Overlay kind="popover" needs an anchor');
  return <Popover {...common} anchor={anchor} align={align} up={up}>{children}</Popover>;
}
