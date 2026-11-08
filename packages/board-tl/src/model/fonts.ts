// tldraw's 16 font faces (decision O5): the files of `@tldraw/assets` 5.6.0, named once for both builds. `tl.js` inlines them
// as data: URLs into tldraw's `fontAssetUrls` (`key`); the board host registers the same files with skia-canvas under the
// family names (`family`). IBM Plex Sans (`tldraw_sans`) is the font of our elements. No font file is committed.
// Pure data: loads anywhere (the Node-only folder lookup is `fonts-node.ts`).

export type FontFace = {
  /** tldraw's family name (`DefaultFontFaces`, the theme's `fontFamily`). */
  family: "tldraw_sans" | "tldraw_serif" | "tldraw_mono" | "tldraw_draw";
  /** As tldraw asks for it. The files declare their own weights: Plex "normal" is the Medium file (500). */
  weight: "normal" | "bold";
  style: "normal" | "italic";
  /** The file name under `@tldraw/assets/fonts/`. */
  file: string;
  /** The key of tldraw's `fontAssetUrls` (`@tldraw/assets/selfHosted.js`), which is also the face's `src.url` in `DefaultFontFaces`. */
  key: string;
};

const PLEX = { tldraw_sans: "IBMPlexSans", tldraw_serif: "IBMPlexSerif", tldraw_mono: "IBMPlexMono" } as const;

function plex(family: keyof typeof PLEX): FontFace[] {
  const b = PLEX[family];
  return [
    { family, weight: "normal", style: "normal", file: `${b}-Medium.woff2`, key: family },
    { family, weight: "bold", style: "normal", file: `${b}-Bold.woff2`, key: `${family}_bold` },
    { family, weight: "normal", style: "italic", file: `${b}-MediumItalic.woff2`, key: `${family}_italic` },
    { family, weight: "bold", style: "italic", file: `${b}-BoldItalic.woff2`, key: `${family}_italic_bold` },
  ];
}

export const FONT_FACES: readonly FontFace[] = [
  ...plex("tldraw_sans"),
  ...plex("tldraw_serif"),
  ...plex("tldraw_mono"),
  { family: "tldraw_draw", weight: "normal", style: "normal", file: "Shantell_Sans-Informal_Regular.woff2", key: "tldraw_draw" },
  { family: "tldraw_draw", weight: "bold", style: "normal", file: "Shantell_Sans-Informal_Bold.woff2", key: "tldraw_draw_bold" },
  { family: "tldraw_draw", weight: "normal", style: "italic", file: "Shantell_Sans-Informal_Regular_Italic.woff2", key: "tldraw_draw_italic" },
  { family: "tldraw_draw", weight: "bold", style: "italic", file: "Shantell_Sans-Informal_Bold_Italic.woff2", key: "tldraw_draw_italic_bold" },
];

/** The family of our elements. */
export const ELEMENT_FONT_FAMILY = "tldraw_sans";
