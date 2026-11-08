// The 16 font faces of tldraw 5.6.0, as DefaultFontFaces (tldraw/src/lib/shapes/shared/defaultFonts.tsx) names them and
// the default asset URLs (tldraw/src/lib/utils/static-assets/assetUrls.ts) map them to the files of @tldraw/assets/fonts.
// `key` is the face's `src.url`: the server serves each file at `/<key>` too, for tldraw's own lookup (FontManager
// resolves `src.url` against the page when no asset URLs are given). The page's @font-face rules use `/fonts/<file>`:
// not the key, because the SVG export's font embedder swaps each rule's URL for a data URL by replacing the URL text,
// and `url("tldraw_draw")` equals the family name, so the family was replaced instead (a broken export).
const FILES = {
  tldraw_draw: 'Shantell_Sans-Informal_Regular',
  tldraw_sans: 'IBMPlexSans-Medium',
  tldraw_serif: 'IBMPlexSerif-Medium',
  tldraw_mono: 'IBMPlexMono-Medium',
}
const BOLD = { tldraw_draw: 'Shantell_Sans-Informal_Bold', tldraw_sans: 'IBMPlexSans-Bold', tldraw_serif: 'IBMPlexSerif-Bold', tldraw_mono: 'IBMPlexMono-Bold' }
const ITALIC = { tldraw_draw: 'Shantell_Sans-Informal_Regular_Italic', tldraw_sans: 'IBMPlexSans-MediumItalic', tldraw_serif: 'IBMPlexSerif-MediumItalic', tldraw_mono: 'IBMPlexMono-MediumItalic' }
const BOLD_ITALIC = { tldraw_draw: 'Shantell_Sans-Informal_Bold_Italic', tldraw_sans: 'IBMPlexSans-BoldItalic', tldraw_serif: 'IBMPlexSerif-BoldItalic', tldraw_mono: 'IBMPlexMono-BoldItalic' }

/** @type {{ key: string, family: string, weight: 'normal'|'bold', style: 'normal'|'italic', file: string }[]} */
export const FACES = Object.keys(FILES).flatMap((family) => [
  { key: family, family, weight: 'normal', style: 'normal', file: FILES[family] },
  { key: `${family}_bold`, family, weight: 'bold', style: 'normal', file: BOLD[family] },
  { key: `${family}_italic`, family, weight: 'normal', style: 'italic', file: ITALIC[family] },
  { key: `${family}_italic_bold`, family, weight: 'bold', style: 'italic', file: BOLD_ITALIC[family] },
].map((f) => ({ ...f, file: `${f.file}.woff2` })))

/** The @font-face rules, with the URL `/fonts/<file>`. */
export function fontFaceCss() {
  return FACES.map((f) => [
    '@font-face {',
    `  font-family: "${f.family}";`,
    `  font-style: ${f.style};`,
    `  font-weight: ${f.weight};`,
    `  src: url("/fonts/${f.file}") format("woff2");`,
    '}',
  ].join('\n')).join('\n')
}
