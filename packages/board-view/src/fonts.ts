// Where Excalidraw gets its fonts, and that it gets them from nowhere else. Import this module before Excalidraw's.
//
// Excalidraw makes a `FontFace` for each of its fonts when its module is evaluated, with the source list
// `url(<EXCALIDRAW_ASSET_PATH>/fonts/...), url(https://esm.sh/...)`: the fonts next to the page, then a CDN. The page ships
// the fonts and loads nothing from a network (its Content-Security-Policy has connect-src 'none', and the web view of a
// phone is the app's own file), so:
// - EXCALIDRAW_ASSET_PATH is set here, to the folder of the page, before Excalidraw reads it;
// - the CDN source is taken out of every FontFace it makes. Without this each font reports a policy violation (or, with no
//   policy, falls back to the CDN when a file is missing).
const g = globalThis as { EXCALIDRAW_ASSET_PATH?: string | string[]; FontFace?: typeof FontFace; __aiwbFonts?: boolean };

if (!g.EXCALIDRAW_ASSET_PATH && typeof location !== "undefined") g.EXCALIDRAW_ASSET_PATH = new URL("./", location.href).href;

/** A FontFace source list without its sources on the CDN. Nothing left: one empty data: source, which fails quietly and lets the text fall back. */
export function withoutCdn(source: string): string {
  const kept = source.split(/,\s*(?=url\()/).filter((s) => !/^\s*url\(\s*["']?https?:\/\/esm\.sh\//.test(s));
  return kept.length ? kept.join(", ") : "url(data:font/woff2;base64,)";
}

if (g.FontFace && !g.__aiwbFonts) {
  g.__aiwbFonts = true;
  const Native = g.FontFace;
  const Wrapped = function (this: unknown, family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    return new Native(family, typeof source === "string" ? withoutCdn(source) : source, descriptors);
  } as unknown as typeof FontFace;
  Wrapped.prototype = Native.prototype;
  g.FontFace = Wrapped;
}
