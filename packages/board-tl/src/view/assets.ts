// Where tldraw finds its files. Only the fonts are used: `build.mjs` swaps `@tldraw/assets/selfHosted` for a module whose fonts
// are the 16 woff2 files of `model/fonts.ts` as data: URLs, so nothing is loaded from a folder or a CDN and the window's image
// export keeps the font under `connect-src 'none'` (decision U4). tldraw's icons and embed icons are for its own UI, which is
// not shown; tldraw preloads every icon it is given as a cross-origin <img>, which file:// refuses (CORS), so they are given
// as "" and tldraw skips them (AssetUrlsProvider: `if (!src) continue`). No translations: the locale is forced to `en`.
import { getAssetUrls } from "@tldraw/assets/selfHosted";

const all = getAssetUrls();
const blank = (o: Record<string, string>) => Object.fromEntries(Object.keys(o).map((k) => [k, ""]));
export const ASSET_URLS = { ...all, icons: blank(all.icons), embedIcons: blank(all.embedIcons), translations: {} };
