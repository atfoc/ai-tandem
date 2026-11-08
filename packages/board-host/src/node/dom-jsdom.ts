// The jsdom fallback of the page (AIWB_BOARDHOST_DOM=jsdom; page.ts picks). Lifted from spikes/tl-host/src/dom.ts; jsdom is
// loaded with require inside installPage (it is CommonJS), so it is evaluated only when chosen and a bundler can leave it external.
// This is the only module that touches jsdom.
//
// The page tldraw runs on in Node: one jsdom window, installed on the global object before tldraw is imported, shared by
// every editor of the process. tldraw reaches for much more of the DOM than Excalidraw's element code did (TipTap's
// generateHTML serializes ProseMirror nodes with a real document, the TextManager keeps measuring divs in the container,
// the SVG export renders React components with react-dom/client into a div and reads them back as SVGSVGElement), so a
// hand-written stand-in page like packages/board-engine/src/page.ts would have to re-implement a DOM: jsdom is that DOM.
// Layout is what jsdom lacks (every box is 0x0); measure.ts supplies text layout from skia-canvas instead.
import { createRequire } from 'node:module'
import { copyGlobals, installCommonShims, makePage } from './dom-shims.ts'
import type { Page } from './dom-shims.ts'

type Any = any

import { GLOBALS } from './dom-globals.ts'

export type { Page }

let page: Page | null = null

/** Installs the jsdom page on the global object. Idempotent. Must run before `tldraw` is evaluated. */
export function installPage(): Page {
  if (page) return page
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: Any }
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true, // requestAnimationFrame
  })
  const w = dom.window as Any
  copyGlobals(w, GLOBALS)
  // Node's own Event/EventTarget/Blob/URL stay (tldraw's EventEmitter does not need jsdom's); requestAnimationFrame is
  // jsdom's (60 Hz timer). What jsdom has not got: dom-shims.ts.
  installCommonShims(w)
  page = makePage(w)
  return page
}
