// Where the keyboard focus is, by `testID` (react-native-web draws it as `data-testid`): what the shell needs to move the focus
// between the sidebar's hide control and the rail's show control (A-LY-11). A popup's focus (taking it, Tab inside, giving it back) is ui/modal.web.tsx's.
const withTid = (id: string) => `[data-testid=${JSON.stringify(id)}]`;

/** Whether the focus is inside the element with this testID (or on it). */
export function focusIn(id: string): boolean {
  const a = document.activeElement;
  return !!a && a !== document.body && !!a.closest(withTid(id));
}

/** Puts the focus on the (first) element with this testID, when it is drawn. */
export function focusTid(id: string): void {
  document.querySelector<HTMLElement>(withTid(id))?.focus();
}

/** Whether the focus is on nothing (the page itself): what had it went. */
export function focusNowhere(): boolean {
  const a = document.activeElement;
  return !a || a === document.body;
}
