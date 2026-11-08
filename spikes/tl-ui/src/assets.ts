// Where tldraw finds its files: the folder `board-tl.js` was loaded from (as board-view's assetpath.ts does for Excalidraw),
// so the page loads nothing from a CDN, from file:// in the window and from the app's folder over http in tests.
// Only the fonts are shipped (fonts/, 1.3 MB of woff2). tldraw's icons and embed icons are for its own UI, which is not
// shown; tldraw preloads every icon it is given as a cross-origin <img>, which file:// refuses (CORS), so they are given
// as "" and tldraw skips them (AssetUrlsProvider: `if (!src) continue`).
import { getAssetUrls } from "@tldraw/assets/selfHosted";

function scriptFolder(): string {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  if (src) return src.slice(0, src.lastIndexOf("/") + 1);
  return new URL(".", document.baseURI).href;
}

// (read at load time: document.currentScript is the bundle only while it runs)
const all = getAssetUrls({ baseUrl: scriptFolder() });
const blank = (o: Record<string, string>) => Object.fromEntries(Object.keys(o).map((k) => [k, ""]));
export const ASSET_URLS = { ...all, icons: blank(all.icons), embedIcons: blank(all.embedIcons), translations: {} };
