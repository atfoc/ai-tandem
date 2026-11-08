// The board host's headless tldraw (lifted from spikes/tl-host/src/headless.ts): the page installed first (page.ts), a fetch
// for file: URLs (the SVG export embeds its fonts), tldraw's fonts registered with skia-canvas from the font folder, then the
// editor and the canvas measuring. Everything that imports tldraw is loaded dynamically, after the page, so importing this
// module never evaluates tldraw.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Editor, TLStore } from 'tldraw'
import { TLDRAW_FACES, fontDir, registerTldrawFonts, setFontDir } from './fonts.ts'
import { installPage, type DomKind } from './page.ts'

export interface Runtime {
  /** A new store with the board's schema (src/schema.ts). */
  createStore(): TLStore
  /** A headless editor with the canvas measuring installed, on its own container (and store, unless one is given).
   *  Dispose it with editor.dispose(): its container goes with it. */
  createEditor(o?: { store?: TLStore }): Editor
  /** tldraw's font names (`tldraw_sans_bold`…) → file: URLs of the files the fonts were registered from. */
  fontAssetUrls(): Record<string, string>
  /** The DOM the page is made of. */
  dom: DomKind
  /** The font folder, and how many faces were registered from it. */
  fontDir: string
  fonts: number
}

const SUFFIX: Record<string, string> = { normal_normal: '', bold_normal: '_bold', normal_italic: '_italic', bold_italic: '_italic_bold' }

/** tldraw's font names (as DefaultFontFaces' src.url) → file: URLs in a folder. */
export function fontAssetUrlsIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [family, faces] of Object.entries(TLDRAW_FACES)) {
    for (const [k, file] of Object.entries(faces)) out[family + SUFFIX[k]] = pathToFileURL(join(dir, file)).href
  }
  return out
}

let loading: Promise<Runtime> | null = null

/** Loads the runtime once per process (later calls return the same one; a different `fontDir` after the first call throws). */
export function loadRuntime(o: { fontDir?: string } = {}): Promise<Runtime> {
  if (loading) {
    if (o.fontDir && o.fontDir !== fontDir()) return Promise.reject(new Error(`the runtime is loaded with the fonts of ${fontDir()} already`))
    return loading
  }
  loading = load(o)
  loading.catch(() => { loading = null })
  return loading
}

async function load(o: { fontDir?: string }): Promise<Runtime> {
  const { page, dom } = installPage()
  if (o.fontDir) setFontDir(o.fontDir)
  const dir = fontDir()
  // The SVG export embeds the fonts it used (FontManager → fetch → Blob → FileReader): file: URLs read from disk, as the
  // page's Blobs so the page's FileReader can read them. Anything else goes to Node's fetch.
  const w = page.window
  const nodeFetch = globalThis.fetch
  w.fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('file:')) {
      const buf = await readFile(fileURLToPath(url))
      const type = url.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'
      return { ok: true, status: 200, blob: async () => new w.Blob([buf], { type }), arrayBuffer: async () => buf }
    }
    return nodeFetch(input, init)
  }
  registerTldrawFonts(dir)
  const fonts = Object.values(TLDRAW_FACES).reduce((n, f) => n + Object.keys(f).length, 0)
  const urls = fontAssetUrlsIn(dir)
  const [{ createEditor, createStore }, { installCanvasMeasure }] = await Promise.all([import('./editor.ts'), import('./measure.ts')])
  return {
    dom,
    fontDir: dir,
    fonts,
    createStore,
    fontAssetUrls: () => ({ ...urls }),
    createEditor(opts: { store?: TLStore } = {}): Editor {
      const container = page.container()
      const editor = createEditor({ container, store: opts.store, fontAssetUrls: urls })
      installCanvasMeasure(editor)
      editor.disposables.add(() => container.remove())
      return editor
    },
  }
}
