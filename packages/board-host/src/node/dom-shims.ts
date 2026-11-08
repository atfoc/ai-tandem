// What none of the DOMs (jsdom, happy-dom, linkedom) gives tldraw headless, or gives in a form tldraw cannot use:
// installed on the window and on globalThis after the window's names are copied. Shared by dom.ts, dom-happy.ts and
// dom-linkedom.ts so the variants differ only in what is specific to each DOM.
type Any = any
const g = globalThis as Any

/** Copies the window's names onto globalThis when Node does not already have them (navigator/location always). */
export function copyGlobals(w: Any, names: readonly string[]) {
  for (const k of names) {
    if (w[k] == null) continue
    if (k in g && k !== 'navigator' && k !== 'location') continue
    Object.defineProperty(g, k, { value: w[k], configurable: true, writable: true })
  }
}

export function installCommonShims(w: Any) {
  const mm = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.matchMedia = g.matchMedia = mm
  w.ResizeObserver = g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  w.IntersectionObserver = g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
  if (w.requestAnimationFrame) {
    g.requestAnimationFrame ??= w.requestAnimationFrame.bind(w)
    g.cancelAnimationFrame ??= w.cancelAnimationFrame.bind(w)
  }
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
}

export interface Page {
  window: Any
  document: Document
  /** A fresh container for one editor (a div in the body). Remove it when the editor is disposed. */
  container(): HTMLDivElement
}

export function makePage(w: Any): Page {
  return {
    window: w,
    document: w.document,
    container() {
      const el = w.document.createElement('div')
      el.tabIndex = 0
      w.document.body.appendChild(el)
      return el
    },
  }
}

/** tldraw's StyleEmbedder reads each tag's default styles inside a hidden <iframe>'s document; an iframe without src has
 *  none in happy-dom or linkedom. Give each one a blank HTML document of the same DOM (made once per iframe). */
export function blankIframeDocuments(w: Any) {
  const proto = w.HTMLIFrameElement.prototype
  let own: Any = null
  for (let p = proto; p && !own; p = Object.getPrototypeOf(p)) own = Object.getOwnPropertyDescriptor(p, 'contentDocument')
  const blank = new WeakMap<object, Any>()
  Object.defineProperty(proto, 'contentDocument', {
    configurable: true,
    get(this: Any) {
      const d = own?.get?.call(this)
      if (d) return d
      let b = blank.get(this)
      if (!b) { b = w.document.implementation.createHTMLDocument(''); blank.set(this, b) }
      return b
    },
  })
}
