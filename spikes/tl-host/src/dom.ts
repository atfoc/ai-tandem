// The page tldraw runs on in Node: one jsdom window, installed on the global object before tldraw is imported, shared by
// every editor of the process. tldraw reaches for much more of the DOM than Excalidraw's element code did (TipTap's
// generateHTML serializes ProseMirror nodes with a real document, the TextManager keeps measuring divs in the container,
// the SVG export renders React components with react-dom/client into a div and reads them back as SVGSVGElement), so a
// hand-written stand-in page like packages/board-engine/src/page.ts would have to re-implement a DOM: jsdom is that DOM.
// Layout is what jsdom lacks (every box is 0x0); measure.ts supplies text layout from skia-canvas instead.
import { JSDOM } from 'jsdom'

type Any = any
const g = globalThis as Any

/** Names copied from the jsdom window onto globalThis (when Node does not already have them). */
const GLOBALS = [
  'window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'HTMLDivElement', 'HTMLSpanElement',
  'HTMLImageElement', 'HTMLCanvasElement', 'HTMLStyleElement', 'HTMLAnchorElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'SVGElement', 'SVGSVGElement', 'SVGGraphicsElement', 'DocumentFragment', 'Document', 'Text', 'Comment', 'Range',
  'Selection', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'getComputedStyle', 'Image', 'FileReader',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'WheelEvent', 'UIEvent', 'CSSStyleDeclaration',
  'customElements', 'ShadowRoot', 'NodeFilter', 'TreeWalker', 'getSelection', 'StyleSheet', 'CSSStyleSheet',
]

export interface Page {
  window: Any
  document: Document
  /** A fresh container for one editor (a div in the body). Remove it when the editor is disposed. */
  container(): HTMLDivElement
}

let page: Page | null = null

/** Installs the jsdom page on the global object. Idempotent. Must run before `tldraw` is evaluated. */
export function installPage(): Page {
  if (page) return page
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true, // requestAnimationFrame
  })
  const w = dom.window as Any
  for (const k of GLOBALS) {
    if (!(k in w)) continue
    if (k in g && k !== 'navigator' && k !== 'location') continue
    Object.defineProperty(g, k, { value: w[k], configurable: true, writable: true })
  }
  // Node's own Event/EventTarget/Blob/URL stay (tldraw's EventEmitter does not need jsdom's); requestAnimationFrame is
  // jsdom's (60 Hz timer). What jsdom has not got:
  const mm = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.matchMedia = g.matchMedia = mm
  w.ResizeObserver = g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  w.IntersectionObserver = g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
  g.requestAnimationFrame ??= w.requestAnimationFrame.bind(w)
  g.cancelAnimationFrame ??= w.cancelAnimationFrame.bind(w)
  g.requestIdleCallback ??= (cb: () => void) => setTimeout(cb, 1)
  g.cancelIdleCallback ??= (id: Any) => clearTimeout(id)
  g.devicePixelRatio = w.devicePixelRatio = 1
  // tldraw reads clipboard and FontFace support; none is used headless.
  if (!g.FontFace) {
    class FontFace {
      family: string; status = 'loaded'; loaded: Promise<FontFace>
      constructor(family: string) { this.family = family; this.loaded = Promise.resolve(this) }
      load() { return Promise.resolve(this) }
    }
    g.FontFace = w.FontFace = FontFace
  }
  const fonts = new Set<Any>()
  const fontSet = {
    add: (f: Any) => fonts.add(f), delete: (f: Any) => fonts.delete(f), has: (f: Any) => fonts.has(f),
    check: () => true, load: async () => [], ready: Promise.resolve(), status: 'loaded',
    forEach: (cb: Any) => fonts.forEach(cb), [Symbol.iterator]: () => fonts.values(),
    addEventListener() {}, removeEventListener() {},
  }
  Object.defineProperty(w.document, 'fonts', { value: fontSet, configurable: true })
  page = {
    window: w,
    document: w.document,
    container() {
      const el = w.document.createElement('div')
      el.tabIndex = 0
      w.document.body.appendChild(el)
      return el
    },
  }
  return page
}
