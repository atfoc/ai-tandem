// Lifts a bottom bar above the soft keyboard (AD-62; native only): on web the browser does it, so this draws its children as they are.
import type { ReactNode } from "react";

export function KeyboardLift({ children }: { children: ReactNode; gap?: number; inside?: number }) {
  return <>{children}</>;
}

/** Whether the soft keyboard is up: the web build has no keyboard events of its own, so never (the phone's chip row stays). */
export function useKeyboardUp(): boolean {
  return false;
}
