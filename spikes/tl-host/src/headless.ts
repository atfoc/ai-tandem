// The headless editor of the board host: the jsdom page (dom.ts) installed first, then tldraw, then an Editor whose text
// measuring is the canvas one (measure.ts). Everything that imports tldraw is loaded dynamically, after the page.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installPage } from './dom.ts'
import { TLDRAW_FACES, tldrawFontDir } from './fonts.ts'
import type { Editor, TLStore } from 'tldraw'

const SUFFIX: Record<string, string> = { normal_normal: '', bold_normal: '_bold', normal_italic: '_italic', bold_italic: '_italic_bold' }

/** tldraw's font names (as DefaultFontFaces' src.url) → file: URLs of the files fonts.ts registers. */
export function fontAssetUrls(): Record<string, string> {
  const dir = tldrawFontDir()
  const out: Record<string, string> = {}
  for (const [family, faces] of Object.entries(TLDRAW_FACES)) {
    for (const [k, file] of Object.entries(faces)) out[family + SUFFIX[k]] = pathToFileURL(join(dir, file)).href
  }
  return out
}

export async function loadHost() {
  const page = installPage()
  // The SVG export embeds the fonts it used (FontManager → fetch → Blob → FileReader): file: URLs read from disk, as
  // jsdom Blobs so jsdom's FileReader can read them. Anything else goes to Node's fetch.
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
  const urls = fontAssetUrls()
  const [{ createEditor, createStore }, { installCanvasMeasure }] = await Promise.all([import('./editor.ts'), import('./measure.ts')])
  return {
    page,
    createStore,
    /** A headless editor with canvas measuring, on its own container (and store, unless one is given). */
    createHeadlessEditor(opts: { store?: TLStore } = {}): Editor {
      const container = page.container()
      const editor = createEditor({ container, store: opts.store, fontAssetUrls: urls })
      installCanvasMeasure(editor)
      editor.disposables.add(() => container.remove())
      return editor
    },
  }
}
