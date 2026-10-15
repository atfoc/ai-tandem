// Lifts a bottom bar above the soft keyboard (AD-62; native only): on web the browser does it, so this draws its children as they are.
import type { ReactNode } from "react";

export function KeyboardLift({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
