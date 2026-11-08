// tldraw's own font files, registered with skia-canvas, and the CSS font matching a browser does for the family lists
// tldraw writes ("'tldraw_draw', sans-serif", "Inter, sans-serif" ...).
//
// - The 16 files are @tldraw/assets 5.6.0's (`fonts/`), declared as tldraw's DefaultFontFaces declares them: four
//   families, each normal/bold × normal/italic. The window must load the very same files (dev/chromium does).
// - Each face is registered under an alias of its own (`tldraw_sans__bold_normal`), because the files' own metadata does
//   not say what the @font-face rules say (Shantell Sans "Regular" reports weight 611 and italic), and a canvas that picks
//   by metadata would pick the wrong face or synthesize one. The CSS weight/style matching is done here instead.
// - Generic families and families that are not installed resolve as Chromium does on this machine (GENERIC below:
//   measured with CDP CSS.getPlatformFontsForNode by dev/chromium); characters no listed family has are left to
//   skia-canvas's system fallback (CoreText on macOS), which is the fallback Chromium uses too.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { FontLibrary } from 'skia-canvas'

const require = createRequire(import.meta.url)

/** The folder of tldraw's font files (an absolute path), from the installed @tldraw/assets. */
export function tldrawFontDir(): string {
  return join(dirname(require.resolve('@tldraw/assets/package.json')), 'fonts')
}

type Weight = 'normal' | 'bold'
type Style = 'normal' | 'italic'

/** tldraw's DefaultFontFaces + defaultEditorAssetUrls.fonts, as file names. */
export const TLDRAW_FACES: Record<string, Record<`${Weight}_${Style}`, string>> = {
  tldraw_draw: {
    normal_normal: 'Shantell_Sans-Informal_Regular.woff2',
    bold_normal: 'Shantell_Sans-Informal_Bold.woff2',
    normal_italic: 'Shantell_Sans-Informal_Regular_Italic.woff2',
    bold_italic: 'Shantell_Sans-Informal_Bold_Italic.woff2',
  },
  tldraw_sans: {
    normal_normal: 'IBMPlexSans-Medium.woff2',
    bold_normal: 'IBMPlexSans-Bold.woff2',
    normal_italic: 'IBMPlexSans-MediumItalic.woff2',
    bold_italic: 'IBMPlexSans-BoldItalic.woff2',
  },
  tldraw_serif: {
    normal_normal: 'IBMPlexSerif-Medium.woff2',
    bold_normal: 'IBMPlexSerif-Bold.woff2',
    normal_italic: 'IBMPlexSerif-MediumItalic.woff2',
    bold_italic: 'IBMPlexSerif-BoldItalic.woff2',
  },
  tldraw_mono: {
    normal_normal: 'IBMPlexMono-Medium.woff2',
    bold_normal: 'IBMPlexMono-Bold.woff2',
    normal_italic: 'IBMPlexMono-MediumItalic.woff2',
    bold_italic: 'IBMPlexMono-BoldItalic.woff2',
  },
}

/**
 * What Chromium uses for a generic family or a family that is not installed, per platform. macOS values measured
 * (dev/chromium, Chromium 156): sans-serif → Helvetica, serif → Times, monospace → Menlo... (see spike-host.md).
 */
const GENERIC: Record<string, Record<string, string | null>> = {
  darwin: { 'sans-serif': 'Helvetica', serif: 'Times', monospace: 'Menlo', 'system-ui': 'System Font', inter: null },
  linux: { 'sans-serif': 'DejaVu Sans', serif: 'DejaVu Serif', monospace: 'DejaVu Sans Mono', inter: null },
  win32: { 'sans-serif': 'Arial', serif: 'Times New Roman', monospace: 'Consolas', inter: null },
}

let registered = false

/** Registers every tldraw face with skia-canvas under its alias. Idempotent. */
export function registerTldrawFonts(dir = tldrawFontDir()): void {
  if (registered) return
  registered = true
  for (const [family, faces] of Object.entries(TLDRAW_FACES)) {
    for (const [key, file] of Object.entries(faces)) FontLibrary.use(`${family}__${key}`, [join(dir, file)])
  }
}

/** The CSS weight keyword tldraw passes ("normal", "bold", "500"...) → normal | bold, as @font-face matching would. */
function faceWeight(w: string): Weight {
  const n = w === 'bold' || w === 'bolder' ? 700 : w === 'normal' || w === 'lighter' ? 400 : Number(w) || 400
  return n >= 600 ? 'bold' : 'normal'
}

function cssWeight(w: string): number {
  return w === 'bold' || w === 'bolder' ? 700 : w === 'normal' || w === 'lighter' ? 400 : Number(w) || 400
}

/** Splits a CSS font-family list into unquoted names. */
export function parseFamilies(list: string): string[] {
  return list.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

export interface ResolvedFont {
  /** The font string for skia-canvas's ctx.font. */
  native: string
  /** The first family's alias or system name (for SVG output: the face a browser would pick first). */
  primary: string
  /** The CSS-level description, for the SVG export (family list as tldraw wrote it). */
  css: { family: string; weight: string; style: string; sizePx: number }
}

const cache = new Map<string, ResolvedFont>()

/** Resolves a CSS font (family list, weight, style, size) to a skia-canvas font string with the right faces. */
export function resolveFont(familyList: string, weight: string, style: string, sizePx: number): ResolvedFont {
  const key = `${familyList}|${weight}|${style}|${sizePx}`
  let r = cache.get(key)
  if (r) return r
  registerTldrawFonts()
  const generic = GENERIC[process.platform] ?? GENERIC.linux
  const names: string[] = []
  const st: Style = style === 'italic' || style === 'oblique' ? 'italic' : 'normal'
  for (const fam of parseFamilies(familyList)) {
    const faces = TLDRAW_FACES[fam]
    if (faces) {
      names.push(`${fam}__${faceWeight(weight)}_${st}`)
      continue
    }
    const g = generic[fam.toLowerCase()]
    if (g === null) continue // known to be absent here (Inter on macOS): the browser skips it
    if (g) names.push(g)
    else if (FontLibrary.has(fam)) names.push(fam)
  }
  if (!names.length) names.push(generic['sans-serif']!)
  // The aliases hold one face each, so asking the CSS weight and style picks that face without synthesis; the system
  // fallbacks after it get the CSS weight and style, as in a browser.
  const native = `${st} ${cssWeight(weight)} ${sizePx}px ${names.map((n) => `"${n}"`).join(', ')}`
  r = { native, primary: names[0], css: { family: familyList, weight, style, sizePx } }
  cache.set(key, r)
  return r
}
