// An overlay of kind "screen" on the phone (ux-improvements goal 4.3, 4.8): its content is drawn as a screen pushed on the phone's
// native stack, with the place bar (the back naming the screen under it, the title centred), and Back, the edge swipe and
// Android's back close it (they call `onClose`). The stack is the shell's (screens/shell/screens.ts): it installs the presenter
// with `setScreenPresenter`, so the ui/ parts do not import the shell. Until one is installed (the gallery, a self-test) the
// content is drawn in a Sheet, as every phone popup is today.
//
// Contract of package F2 (plans/ux-improvements/PLAN.md). STUB: the presenter's interface; F2 implements it in the shell.
import type { ComponentType, ReactNode } from "react";

import { Sheet } from "./Sheet.tsx";

export type PushedScreenProps = {
  open: boolean;
  onClose(): void;
  label: string;
  title: string;
  testID?: string;
  children: ReactNode;
};

let presenter: ComponentType<PushedScreenProps> | null = null;

/** The shell installs what pushes the screen (once, at import of its stack). */
export function setScreenPresenter(p: ComponentType<PushedScreenProps>): void { presenter = p; }

export function PushedScreen(props: PushedScreenProps) {
  const P = presenter;
  if (P) return <P {...props} />;
  return <Sheet open={props.open} onClose={props.onClose} label={props.label} testID={props.testID}>{props.children}</Sheet>;
}
