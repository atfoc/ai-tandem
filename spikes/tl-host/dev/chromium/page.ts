// The page side of the Chromium reference: the same Editor as in Node (src/editor.ts), real DOM text measuring, the
// tldraw fonts loaded from @tldraw/assets. run.mjs bundles this file and calls the functions put on `window`.
import 'tldraw/tldraw.css'
import { createEditor } from '../../src/editor.ts'
import { TEXTS, runCorpus } from '../../src/corpus.ts'
import { buildBoard } from '../../src/board.ts'
import type { Editor, TLShapeId } from 'tldraw'

declare global {
  interface Window {
    __ready: Promise<{ faces: { family: string; weight: string; style: string; status: string }[] }>
    runCorpus: () => ReturnType<typeof runCorpus>
    exportBoard: () => Promise<unknown>
    editor: Editor
    TEXTS: Record<string, string>
  }
}

window.TEXTS = TEXTS

const FAMILIES = ['tldraw_draw', 'tldraw_sans', 'tldraw_serif', 'tldraw_mono']

async function loadFonts() {
  const loads: Promise<unknown>[] = []
  for (const family of FAMILIES)
    for (const weight of ['normal', 'bold'])
      for (const style of ['normal', 'italic']) loads.push(document.fonts.load(`${style} ${weight} 16px "${family}"`))
  await Promise.all(loads)
  await document.fonts.ready
  return [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }))
}

// A container in the document, sized like a window, with the class the Tldraw component gives its container (the
// measuring div inherits from it).
const container = document.createElement('div')
container.className = 'tl-container tl-theme__light'
container.style.cssText = 'position: relative; width: 1080px; height: 720px; overflow: hidden;'
document.body.appendChild(container)

window.__ready = loadFonts().then((faces) => {
  const editor = createEditor({ container })
  window.editor = editor

  const clear = () => {
    const ids = [...editor.getCurrentPageShapeIds()]
    if (ids.length) editor.deleteShapes(ids)
  }

  window.runCorpus = () => {
    clear()
    return runCorpus(editor)
  }

  window.exportBoard = async () => {
    clear()
    buildBoard(editor)
    const ids: TLShapeId[] = [...editor.getCurrentPageShapeIds()]
    const opts = { padding: 32, background: true }
    const svg = await editor.getSvgString(ids, opts)
    // pixelRatio 1: toImage's default for png is 2; the page runs at deviceScaleFactor 1 and the Node side renders at 1.
    const image = await editor.toImage(ids, { ...opts, format: 'png', scale: 1, pixelRatio: 1 })
    const bytes = new Uint8Array(await image.blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const records = editor.getCurrentPageShapesSorted().map((s) => {
      const { richText: _richText, ...props } = s.props as Record<string, unknown>
      const b = editor.getShapePageBounds(s.id)!
      return { id: s.id, type: s.type, parentId: s.parentId, x: s.x, y: s.y, rotation: s.rotation, props, pageBounds: { x: b.x, y: b.y, w: b.w, h: b.h } }
    })
    return {
      svg: svg?.svg ?? null,
      svgSize: svg ? { width: svg.width, height: svg.height } : null,
      png: btoa(bin),
      pngSize: { width: image.width, height: image.height },
      records,
    }
  }
  return { faces }
})
