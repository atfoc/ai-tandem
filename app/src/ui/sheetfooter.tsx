// The footer of a sheet: the row of actions at the end of a form or a list (`DialogActions`) stays below the sheet's scroll view, in sight,
// whatever the height of what scrolls above it, so a form taller than what the on-screen keyboard leaves keeps its buttons in reach. The
// sheet provides a setter; the actions put themselves there. Everywhere else (a dialog, a popover, the web, whose layouts do not change) the
// actions stay in place, at the end of the content, as they are today.
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";

const FooterContext = createContext<((node: ReactNode) => void) | null>(null);

/** The sheet provides its setter to its content; a dialog or a popover provides null to its own, so its actions stay in place. */
export const SheetFooterProvider = FooterContext.Provider;

/** Draws `children` in the footer of the sheet around it, or `inPlace` where there is none. */
export function InSheetFooter({ children, inPlace }: { children: ReactNode; inPlace: ReactNode }) {
  const set = useContext(FooterContext);
  useLayoutEffect(() => { set?.(children); });
  useLayoutEffect(() => (set ? () => set(null) : undefined), [set]);
  return set ? null : <>{inPlace}</>;
}
