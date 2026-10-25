// The link port (B-MD-03): the props that make a Text open an address outside the app. On web the Text is a real anchor that
// opens a new tab (so a middle click and the browser's own menu work too); on a device the press opens the system's browser.
export type LinkProps = (href: string) => object;

/** Opens an address outside the app, from a press that is not a link in a text (a cell's ↗ row): the system's browser on a device, a new tab on web. */
export type OpenLink = (url: string) => void;
