// tldraw's own font files, registered with skia-canvas, and the CSS font matching a browser does for the family lists
// tldraw writes ("'tldraw_draw', sans-serif", "Inter, sans-serif" ...).
//
// - The 16 files are @tldraw/assets 5.6.0's (`fonts/`), declared as tldraw's DefaultFontFaces declares them: four
//   families, each normal/bold × normal/italic. The window must load the very same files (dev/chromium does). The folder
//   is settable (setFontDir): the bundle carries its own copy.
// - Each face is registered under an alias of its own (`tldraw_sans__bold_normal`), because the files' own metadata does
//   not say what the @font-face rules say (Shantell Sans "Regular" reports weight 611 and italic), and a canvas that picks
//   by metadata would pick the wrong face or synthesize one. The CSS weight/style matching is done here instead.
// - Generic families and families that are not installed resolve as Chromium does on this machine (GENERIC below:
//   measured with CDP CSS.getPlatformFontsForNode by dev/chromium); characters no listed family has are left to
//   skia-canvas's system fallback (CoreText on macOS), which is the fallback Chromium uses too.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { FontLibrary } from 'skia-canvas'
import { FONT_FACES } from '@aiwb/board-tl/model/fonts.ts'

const require = createRequire(import.meta.url)

/** The folder of tldraw's font files (an absolute path), from the installed @tldraw/assets: the development default. */
export function tldrawFontDir(): string {
  return join(dirname(require.resolve('@tldraw/assets/package.json')), 'fonts')
}

// The board host's font folder: the bundle's copy of the 16 files (`dist/assets/fonts/`, package H4) or, in development,
// @tldraw/assets' `fonts/`. Set before the first measurement (runtime.ts loadRuntime does it).
let fontDirectory: string | null = null

/** Sets the folder the 16 files are read from. Only before the fonts are registered (a later different folder throws). */
export function setFontDir(dir: string): void {
  if (registered && dir !== fontDir()) throw new Error(`the fonts are registered from ${fontDir()} already`)
  fontDirectory = dir
}

/** The folder the fonts are (or will be) registered from. */
export function fontDir(): string {
  return (fontDirectory ??= tldrawFontDir())
}

type Weight = 'normal' | 'bold'
type Style = 'normal' | 'italic'

/** tldraw's DefaultFontFaces + defaultEditorAssetUrls.fonts, as file names: family → `weight_style` → file. Made from the one
 *  list both builds read, the shared model's `FONT_FACES` (packages/board-tl/src/model/fonts.ts; decision O5). */
export const TLDRAW_FACES: Record<string, Record<`${Weight}_${Style}`, string>> = (() => {
  const out: Record<string, Record<string, string>> = {}
  for (const f of FONT_FACES) (out[f.family] ??= {})[`${f.weight}_${f.style}`] = f.file
  return out as Record<string, Record<`${Weight}_${Style}`, string>>
})()

/**
 * What Chromium uses for a generic family or a family that is not installed, per platform. macOS values measured
 * (dev/chromium, Chromium 156): sans-serif → Helvetica, serif → Times, monospace → Menlo... (see spike-host.md).
 */
const GENERIC: Record<string, Record<string, string | null>> = {
  darwin: { 'sans-serif': 'Helvetica', serif: 'Times', monospace: 'Menlo', 'system-ui': 'System Font', inter: null },
  linux: { 'sans-serif': 'DejaVu Sans', serif: 'DejaVu Serif', monospace: 'DejaVu Sans Mono', inter: null },
  win32: { 'sans-serif': 'Arial', serif: 'Times New Roman', monospace: 'Consolas', inter: null },
}

/** Fonts Chromium picks per script for a generic family, put after it (the system fallback does the rest). */
const SCRIPT_FALLBACK: Record<string, Record<string, string[]>> = {
  darwin: { serif: ['Songti SC', 'AppleMyungjo'] },
}

let registered = false

/** Registers every tldraw face with skia-canvas under its alias. Idempotent. */
export function registerTldrawFonts(dir = fontDir()): void {
  if (registered) return
  fontDirectory = dir
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

const EMOJI_FONT: Record<string, string> = { darwin: 'Apple Color Emoji', linux: 'Noto Color Emoji', win32: 'Segoe UI Emoji' }

/**
 * A grapheme cluster a browser draws with the system's colour emoji font whatever the family list says: emoji
 * presentation by default, or asked for (VS16, ZWJ sequence, skin tone, keycap, flag). Chromium does this before the
 * family list (❤️ in IBM Plex Mono, which has a text ❤ of its own, measured 36 px in Chromium, 21.7 px by the list).
 */
export function isEmojiCluster(g: string): boolean {
  if (g.includes('\uFE0E')) return false
  return /\uFE0F|\u200D|\u20E3|[\u{1F3FB}-\u{1F3FF}]|\p{Regional_Indicator}/u.test(g) || /^\p{Emoji_Presentation}/u.test(g)
}

/** The colour emoji font at a size (for emoji clusters, see isEmojiCluster). */
export function emojiFont(sizePx: number, familyList: string, weight: string, style: string): ResolvedFont {
  const key = `emoji|${sizePx}`
  let r = cache.get(key)
  if (!r) {
    const name = EMOJI_FONT[process.platform] ?? EMOJI_FONT.linux
    r = { native: `normal 400 ${sizePx}px "${name}"`, primary: name, css: { family: familyList, weight, style, sizePx } }
    cache.set(key, r)
  }
  return r
}

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
  // Chromium's generic families are per script: for `serif`, Han and kana come from Songti SC and Hangul from
  // AppleMyungjo on macOS (measured, dev/chromium fonts), where the system fallback after Times would pick the sans ones.
  const last = parseFamilies(familyList).pop()?.toLowerCase()
  if (last && SCRIPT_FALLBACK[process.platform]?.[last]) names.push(...SCRIPT_FALLBACK[process.platform][last])
  // The aliases hold one face each, so asking the CSS weight and style picks that face without synthesis; the system
  // fallbacks after it get the CSS weight and style, as in a browser.
  const native = `${st} ${cssWeight(weight)} ${sizePx}px ${names.map((n) => `"${n}"`).join(', ')}`
  r = { native, primary: names[0], css: { family: familyList, weight, style, sizePx } }
  cache.set(key, r)
  return r
}
