// The link port (B-MD-03): the props that make a Text open an address outside the app. On web the Text is a real anchor that
// opens a new tab (so a middle click and the browser's own menu work too); on a device the press opens the system's browser.
export type LinkProps = (href: string) => object;

/** Opens an address outside the app, from a press that is not a link in a text (a cell's ↗ row): the system's browser on a device, a new tab on web. */
export type OpenLink = (url: string) => void;

/** Opens, once, an address that is known only after the press (a network call answers it): called with the address, as OpenLink;
 *  close(): it will not come (the call failed, or was cancelled), so what was readied for it goes. */
export type OpenURLLater = ((url: string) => void) & { close(): void };

/** Readies, during a press, the opening of an address that comes later. On web a plain browser blocks a window opened after the
 *  press's network call, so a placeholder window is opened now and pointed at the address when it comes; where none can be
 *  opened (a blocked pop-up, the desktop app, a device) the address is opened as OpenLink does. Call it synchronously in the
 *  press handler. */
export type OpenLater = () => OpenURLLater;
