// The keyboard focus by testID is a web notion (a hardware keyboard on a tablet moves it by the system's own focus order): on the
// phone's platforms there is nothing to move, and these do nothing.
export function focusIn(_id: string): boolean { return false; }
export function focusTid(_id: string): void {}
export function focusNowhere(): boolean { return false; }
