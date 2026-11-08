// dom.ts on linkedom instead of jsdom (risk 8.8 spike: a lighter DOM). Same Page interface; pick with TLHOST_DOM=linkedom.
import { parseHTML } from 'linkedom'
import { GLOBALS } from './dom-globals.ts'
import { blankIframeDocuments, copyGlobals, installCommonShims, makePage } from './dom-shims.ts'
import type { Page } from './dom-shims.ts'

type Any = any
export type { Page }
let page: Page | null = null

export function installPage(): Page {
  if (page) return page
  const w = parseHTML('<!doctype html><html><head></head><body></body></html>') as Any
  // linkedom's window is a proxy of the classes; what it lacks is shimmed here (each one listed in notes/dom.md).
  // requestAnimationFrame: linkedom has none (jsdom's pretendToBeVisual one is a 60 Hz timer; so is this).
  w.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16)
  w.cancelAnimationFrame = (id: Any) => clearTimeout(id)
  // location: none (react-dom reads window.location.protocol).
  w.location = new URL('http://localhost/')
  // document.implementation: none (TipTap's generateHTML makes a scratch HTML document to serialize into).
  if (!w.document.implementation) {
    const implementation = { createHTMLDocument: (title = '') => parseHTML(`<!doctype html><html><head><title>${title}</title></head><body></body></html>`).document }
    Object.defineProperty(w.document, 'implementation', { value: implementation, configurable: true })
  }
  // Blob/FileReader: none (the SVG export embeds its fonts as data: URLs via fetch → Blob → FileReader). Node's Blob,
  // and a FileReader that only reads data URLs.
  w.Blob ??= Blob
  w.FileReader ??= class FileReader {
    result: string | null = null; error: unknown = null
    onload: ((e: Any) => void) | null = null; onerror: ((e: Any) => void) | null = null; onloadend: ((e: Any) => void) | null = null
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then(
        (b) => { this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`; this.onload?.({ target: this }); this.onloadend?.({ target: this }) },
        (e) => { this.error = e; this.onerror?.({ target: this }); this.onloadend?.({ target: this }) })
    }
  }
  // SVGSVGElement/SVGGraphicsElement: linkedom has one SVGElement class for every SVG tag (exportToSvg asserts
  // `instanceof SVGSVGElement`): classes whose instanceof tests the tag.
  const SVGEl = w.SVGElement
  w.SVGSVGElement ??= class SVGSVGElement extends SVGEl { static [Symbol.hasInstance](x: Any) { return x instanceof SVGEl && x.localName === 'svg' } }
  w.SVGGraphicsElement ??= class SVGGraphicsElement extends SVGEl { static [Symbol.hasInstance](x: Any) { return x instanceof SVGEl } }
  // getComputedStyle: none. tldraw's StyleEmbedder copies computed styles that differ from the defaults into the
  // export; there is no cascade headless, so (as with jsdom, whose output carries only the inline styles) nothing.
  w.getComputedStyle ??= () => ({ color: '', getPropertyValue: () => '', getPropertyPriority: () => '', length: 0, item: () => '' })
  // <iframe>: no contentDocument (tldraw's StyleEmbedder needs one).
  blankIframeDocuments(w)
  // XMLSerializer: none (export.ts serializes the finished SVG). linkedom's outerHTML of an SVG subtree is XML enough for
  // resvg once the root has its xmlns (a real XMLSerializer adds it; no HTML is left inside after textToPaths).
  w.XMLSerializer ??= class XMLSerializer {
    serializeToString(n: Any) {
      if (n.localName === 'svg' && !n.hasAttribute('xmlns')) n.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      return n.outerHTML
    }
  }
  // document.styleSheets: none (tldraw's FontEmbedder looks for @font-face rules in it). No stylesheets headless.
  if (!w.document.styleSheets) Object.defineProperty(w.document, 'styleSheets', { value: [], configurable: true })
  copyGlobals(w, GLOBALS)
  installCommonShims(w)
  page = makePage(w)
  return page
}
