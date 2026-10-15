// What the board's web view may navigate to (AD-52, spike board-webview). The page is one file, loaded once; nothing it does
// takes it anywhere else. `originWhitelist` is no guard (react-native-webview hands a URL that fails it to `Linking.openURL`
// without asking the app, which opened Safari), so every request reaches the host's handler and this decides: the page's own
// address is allowed, an http(s) address is refused and offered to the user (a confirm dialog naming it, then the system's
// browser: nothing is opened without the user's yes), anything else is dropped. No React and no react-native here.

export type Navigation =
  | { allow: true }
  | { allow: false; open?: string; scheme: string };

/** The part of an address before the fragment. */
const bare = (u: string) => { const i = u.indexOf("#"); return i < 0 ? u : u.slice(0, i); };

/** The scheme of an address, lower case, "" when it has none. */
export const schemeOf = (url: string): string => /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase() ?? "";

/** Whether the web view may load `url` while it shows `page` (the address of the board's file). */
export function navigation(url: string, page: string): Navigation {
  if (url === page || bare(url) === bare(page)) return { allow: true };
  const scheme = schemeOf(url);
  return scheme === "http" || scheme === "https" ? { allow: false, open: url, scheme } : { allow: false, scheme };
}
