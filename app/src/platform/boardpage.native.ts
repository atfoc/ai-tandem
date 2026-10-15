// Where the board's page is on the phone (AD-56): `@aiwb/board-view`'s `build:webview` makes one file, `board.html`, which
// Metro takes as an asset (`html` is in `assetExts`, metro.config.js) and `expo-asset` gives a file address inside the app.
// The file must exist when Metro bundles: `build:webview` runs before every app build (B5 wires that into the scripts).
// B5 changes this one function if Android needs another way (the page read into a string and given as `html`, or a copy in
// `android_asset`: AD-56 lists them in order).
import { Asset } from "expo-asset";

export type PageSource = {
  /** The address of the page's file. */
  uri: string;
  /** Its folder: the only place the web view may read from (iOS `allowingReadAccessToURL`). */
  dir: string;
};

let known: Promise<PageSource> | null = null;

/** The page's file in the app; the same answer every time (a failure is tried again). */
export function resolvePage(): Promise<PageSource> {
  if (!known) {
    known = (async () => {
      const asset = Asset.fromModule(require("@aiwb/board-view/dist-webview/board.html"));
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      if (!uri) throw new Error("the board page is not in the app");
      return { uri, dir: uri.slice(0, uri.lastIndexOf("/") + 1) };
    })();
    known.catch(() => { known = null; });
  }
  return known;
}
